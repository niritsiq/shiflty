/* Shiftly sync server with authenticator-app (TOTP) two-step sign-in.
   Zero dependencies — Node's crypto does the TOTP math (RFC 6238).

   API:
     POST /api/auth/start  {email}        -> 200 {mode:"code"} | {mode:"enroll", secret, otpauth} | 404 not on team
     POST /api/auth/verify {email, code}  -> 200 {token, email} | 401 bad code
     POST /api/auth/reset  {email}        -> 200 (admin session required) — clears a user's authenticator
     GET  /api/state                      -> 200 {version, state}   (session required)
     PUT  /api/state {version, state}     -> 200 {ok, version} | 409 current   (session required)

   Storage (on /data when a Railway volume is mounted, else the app dir):
     state.json — the shared app state (seeded from index.html on first boot)
     auth.json  — TOTP secrets + sessions (never sent to clients) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tls = require("tls");

const PORT = process.env.PORT || 3000;
/* TEMPORARY: authenticator step is mocked — approved emails sign in without a
   TOTP code. Set AUTH_MOCK=0 in the environment to turn real 2FA back on. */
const AUTH_MOCK = process.env.AUTH_MOCK !== "0";
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const INDEX = path.join(__dirname, "index.html");
const SESSION_DAYS = 60;

/* ---------- state store ---------- */
function seedState() {
  try {
    const html = fs.readFileSync(INDEX, "utf8");
    const m = html.match(/<script id="state" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) return JSON.parse(m[1]);
  } catch (e) { console.error("seed failed", e); }
  return null;
}

let store;
try {
  store = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (!store || !store.state) throw new Error("empty store");
} catch (e) {
  store = { version: 1, state: seedState() };
  persistState();
}
function persistState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(store)); }
  catch (e) { console.error("persist state failed", e); }
}

/* ---------- auth store ---------- */
let auth;
try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); if (!auth.users) throw 0; }
catch (e) { auth = { users: {}, sessions: {}, requests: {} }; }
if (!auth.requests) auth.requests = {};
function persistAuth() {
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(auth)); }
  catch (e) { console.error("persist auth failed", e); }
}

/* ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30s) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(buf) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(str).replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(c); if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretB32, counter) {
  const key = b32decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  return String(code).padStart(6, "0");
}
function totpCheck(secretB32, code) {
  const c = Math.floor(Date.now() / 30000);
  const want = String(code).trim();
  for (let w = -1; w <= 1; w++) if (hotp(secretB32, c + w) === want) return true;
  return false;
}

/* ---------- helpers ---------- */
function findEmployee(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const emps = (store.state && store.state.employees) || [];
  return emps.find(x => String(x.email).toLowerCase() === e) || null;
}
function requireSession(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const s = auth.sessions[token];
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_DAYS * 864e5) { delete auth.sessions[token]; persistAuth(); return null; }
  const emp = findEmployee(s.email);
  if (!emp) return null; /* removed from team -> session dies */
  return { token, email: s.email, emp };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 5e6) { req.destroy(); reject(new Error("too big")); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
function json(res, status, obj) {
  /* Clear-Site-Data purges stale cached copies of the app the moment an old
     page talks to this API, so nobody keeps running a pre-security version. */
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Clear-Site-Data": '"cache"' });
  res.end(JSON.stringify(obj));
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  try {
    if (url === "/api/auth/start" && req.method === "POST") {
      const { email } = JSON.parse(await readBody(req) || "{}");
      const emp = findEmployee(email);
      if (!emp) {
        const key = String(email || "").trim().toLowerCase();
        const reqRec = auth.requests[key];
        if (reqRec && reqRec.status === "pending") return json(res, 403, { error: "pending" });
        if (reqRec && reqRec.status === "declined") return json(res, 403, { error: "declined" });
        return json(res, 404, { error: "not_on_team", canRequest: true });
      }
      if (AUTH_MOCK) {
        const token = crypto.randomBytes(32).toString("hex");
        auth.sessions[token] = { email: emp.email, ts: Date.now() };
        persistAuth();
        return json(res, 200, { mode: "mock", token, email: emp.email });
      }
      const key = String(emp.email).toLowerCase();
      let u = auth.users[key];
      if (u && u.confirmed) return json(res, 200, { mode: "code" });
      const secret = b32encode(crypto.randomBytes(20));
      auth.users[key] = { secret, confirmed: false };
      persistAuth();
      const label = encodeURIComponent("Shiftly:" + emp.email);
      return json(res, 200, {
        mode: "enroll",
        secret,
        otpauth: "otpauth://totp/" + label + "?secret=" + secret + "&issuer=Shiftly"
      });
    }

    if (url === "/api/auth/verify" && req.method === "POST") {
      const { email, code } = JSON.parse(await readBody(req) || "{}");
      const emp = findEmployee(email);
      const key = emp && String(emp.email).toLowerCase();
      const u = key && auth.users[key];
      if (!u) return json(res, 400, { error: "no_enrollment" });
      if (!totpCheck(u.secret, code)) return json(res, 401, { error: "bad_code" });
      u.confirmed = true;
      const token = crypto.randomBytes(32).toString("hex");
      auth.sessions[token] = { email: emp.email, ts: Date.now() };
      persistAuth();
      return json(res, 200, { token, email: emp.email });
    }

    if (url === "/api/auth/request" && req.method === "POST") {
      const { name, email } = JSON.parse(await readBody(req) || "{}");
      const cleanName = String(name || "").trim();
      const cleanEmail = String(email || "").trim();
      if (!cleanName || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) return json(res, 400, { error: "invalid" });
      if (findEmployee(cleanEmail)) return json(res, 200, { ok: true, already: true });
      const key = cleanEmail.toLowerCase();
      const existing = auth.requests[key];
      if (existing && existing.status === "declined") return json(res, 403, { error: "declined" });
      auth.requests[key] = { name: cleanName.slice(0, 80), email: cleanEmail, ts: Date.now(), status: "pending" };
      persistAuth();
      return json(res, 200, { ok: true });
    }

    if (url === "/api/auth/requests" && req.method === "GET") {
      const sess = requireSession(req);
      if (!sess || !sess.emp.admin) return json(res, 401, { error: "admin_required" });
      const pending = Object.values(auth.requests)
        .filter(q => q.status === "pending")
        .sort((a, b) => a.ts - b.ts)
        .map(q => ({ name: q.name, email: q.email, ts: q.ts }));
      return json(res, 200, pending);
    }

    if (url === "/api/auth/approve" && req.method === "POST") {
      const sess = requireSession(req);
      if (!sess || !sess.emp.admin) return json(res, 401, { error: "admin_required" });
      const { email } = JSON.parse(await readBody(req) || "{}");
      const key = String(email || "").trim().toLowerCase();
      const reqRec = auth.requests[key];
      if (!reqRec) return json(res, 404, { error: "no_request" });
      if (!findEmployee(reqRec.email)) {
        const id = "e" + crypto.randomBytes(4).toString("hex").slice(0, 6);
        store.state.employees.push({ id, name: reqRec.name, email: reqRec.email, admin: false, position: "Shift worker" });
        store = { version: store.version + 1, state: store.state };
        persistState();
      }
      delete auth.requests[key];
      persistAuth();
      return json(res, 200, { ok: true, version: store.version });
    }

    if (url === "/api/auth/decline" && req.method === "POST") {
      const sess = requireSession(req);
      if (!sess || !sess.emp.admin) return json(res, 401, { error: "admin_required" });
      const { email } = JSON.parse(await readBody(req) || "{}");
      const key = String(email || "").trim().toLowerCase();
      if (auth.requests[key]) { auth.requests[key].status = "declined"; persistAuth(); }
      return json(res, 200, { ok: true });
    }

    if (url === "/api/auth/reset" && req.method === "POST") {
      const sess = requireSession(req);
      if (!sess || !sess.emp.admin) return json(res, 401, { error: "admin_required" });
      const { email } = JSON.parse(await readBody(req) || "{}");
      const key = String(email || "").trim().toLowerCase();
      delete auth.users[key];
      for (const [t, s] of Object.entries(auth.sessions)) {
        if (String(s.email).toLowerCase() === key) delete auth.sessions[t];
      }
      persistAuth();
      return json(res, 200, { ok: true });
    }

    if (url === "/api/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    if (url === "/api/state") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      if (req.method === "GET") return json(res, 200, store);
      if (req.method === "PUT") {
        const parsed = JSON.parse(await readBody(req) || "{}");
        const st = parsed.state;
        if (!st || !Array.isArray(st.employees) || !st.weeks || !st.settings) return json(res, 400, { error: "invalid body" });
        if (parsed.version !== store.version) return json(res, 409, store);
        store = { version: store.version + 1, state: st };
        persistState();
        return json(res, 200, { ok: true, version: store.version });
      }
      res.writeHead(405); return res.end();
    }

    if (url === "/" || url === "/index.html") {
      const html = fs.readFileSync(INDEX);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(html);
    }

    res.writeHead(404); res.end("Not found");
  } catch (e) {
    json(res, 400, { error: "bad_request" });
  }
});

/* ---------- availability email reminders ----------
   Sends "submit your shifts" emails to workers who haven't submitted for the
   upcoming week, at (Israel time): Sunday 09:00, 17:00, 20:00 and Monday 09:00
   — just before the Monday 10:00 auto-lock.
   Requires env vars: SMTP_USER + SMTP_PASS (e.g. Gmail address + app password).
   Optional: SMTP_HOST (default smtp.gmail.com), SMTP_PORT (465),
             APP_URL (link in the email), REMINDER_TZ (default Asia/Jerusalem). */
const REMINDER_SLOTS = [{ d: 0, h: 9 }, { d: 0, h: 17 }, { d: 0, h: 20 }, { d: 1, h: 9 }];
const TZ = process.env.REMINDER_TZ || "Asia/Jerusalem";
const SENT_FILE = path.join(DATA_DIR, "reminders-sent.json");
let sentLog;
try { sentLog = JSON.parse(fs.readFileSync(SENT_FILE, "utf8")); } catch (e) { sentLog = {}; }

function sendMail(to, subject, text) {
  return new Promise((resolve, reject) => {
    const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
    if (!user || !pass) return reject(new Error("smtp_not_configured"));
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = +(process.env.SMTP_PORT || 465);
    const socket = tls.connect(port, host, { servername: host });
    const steps = [
      ["220", "EHLO shiftly"],
      ["250", "AUTH LOGIN"],
      ["334", Buffer.from(user).toString("base64")],
      ["334", Buffer.from(pass).toString("base64")],
      ["235", "MAIL FROM:<" + user + ">"],
      ["250", "RCPT TO:<" + to + ">"],
      ["250", "DATA"],
      ["354", ["From: Shiftly <" + user + ">", "To: <" + to + ">", "Subject: " + subject,
               "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text, "."].join("\r\n")],
      ["250", "QUIT"]
    ];
    let i = 0, buf = "";
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error("smtp_timeout")); });
    socket.on("data", chunk => {
      buf += chunk.toString();
      if (!/\r?\n$/.test(buf)) return;
      const last = buf.trim().split(/\r?\n/).pop();
      buf = "";
      if (i >= steps.length) { socket.end(); return resolve(true); }
      if (!last.startsWith(steps[i][0])) { socket.destroy(); return reject(new Error("smtp: " + last.slice(0, 120))); }
      socket.write(steps[i][1] + "\r\n");
      i++;
    });
    socket.on("error", reject);
    socket.on("close", () => { if (i >= steps.length) resolve(true); });
  });
}

function nowInTZ() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = t => (parts.find(x => x.type === t) || {}).value;
  return {
    d: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    h: (+get("hour")) % 24,
    m: +get("minute"),
    date: get("year") + "-" + get("month") + "-" + get("day")
  };
}

function upcomingWeekKey(n) {
  const [y, mo, da] = n.date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, da));
  dt.setUTCDate(dt.getUTCDate() + (7 - n.d)); /* the next Sunday */
  return dt.toISOString().slice(0, 10);
}

function reminderTargets(weekKey) {
  const wk = (store.state && store.state.weeks && store.state.weeks[weekKey]) || {};
  if (wk.locked) return [];
  const subs = wk.submissions || {};
  const seen = new Set();
  return (store.state.employees || []).filter(e => {
    if (e.admin || e.pending) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.email) || /@example\.com$/i.test(e.email)) return false;
    if (subs[e.id] && subs[e.id].submittedAt) return false;
    const k = e.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function reminderTick() {
  const n = nowInTZ();
  const slot = REMINDER_SLOTS.find(s => s.d === n.d && s.h === n.h && n.m < 5);
  if (!slot) return;
  const key = n.date + "@" + slot.h;
  if (sentLog[key]) return;
  sentLog[key] = Date.now();
  try { fs.writeFileSync(SENT_FILE, JSON.stringify(sentLog)); } catch (e) {}
  const weekKey = upcomingWeekKey(n);
  const targets = reminderTargets(weekKey);
  const appUrl = process.env.APP_URL || "https://shiflty-production.up.railway.app/";
  console.log("[reminder]", key, "week", weekKey, "->", targets.length, "worker(s)");
  for (const t of targets) {
    try {
      await sendMail(t.email, "Reminder: submit your shifts for next week",
        "Hi " + t.name + ",\n\n" +
        "You haven't submitted your availability for the week starting " + weekKey + " yet.\n" +
        "Submissions close Monday at 10:00.\n\n" +
        "Submit here: " + appUrl + "\n\n" +
        "— Shiftly" + (store.state.settings && store.state.settings.company ? " · " + store.state.settings.company : ""));
      console.log("[reminder] sent to", t.email);
    } catch (e) { console.error("[reminder] failed for", t.email + ":", String(e.message || e)); }
  }
}
setInterval(reminderTick, 60000);
if (process.env.REMINDER_DRY) {
  const n = nowInTZ();
  console.log("[reminder dry-run] now:", JSON.stringify(n), "week:", upcomingWeekKey(n),
    "targets:", reminderTargets(upcomingWeekKey(n)).map(t => t.email).join(", ") || "(none)");
}

server.listen(PORT, () => console.log("Shiftly server listening on :" + PORT + " (data: " + DATA_DIR + ")" +
  (process.env.SMTP_USER ? " | email reminders ON" : " | email reminders OFF (set SMTP_USER + SMTP_PASS)")));
