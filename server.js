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

const PORT = process.env.PORT || 3000;
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
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
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

server.listen(PORT, () => console.log("Shiftly server listening on :" + PORT + " (data: " + DATA_DIR + ")"));
