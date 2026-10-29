/* Shiftly sync server. Sign-in is email + Google Authenticator (TOTP, RFC 6238).
   Zero dependencies for auth — Node's crypto does the TOTP math.

   Who can sign in:
     The email must be firstname.lastname@cybereason.com (lowercase letters,
     exactly one dot in the local part) AND be on the team roster. Admins
     add and remove people in the app. Open join / self-request is closed.

   API:
     GET  /api/config                 -> {authMock, totpRequired, emailRule}
     GET  /api/health                 -> text "ok db|json" plus X-Auth-Mock: 0|1
     POST /api/auth/start  {email}    -> {mode:"code"} | {mode:"enroll", secret, otpauth}
                                        | {mode:"mock", token, email} when AUTH_MOCK=1
                                        | 400 invalid_email | 403 not_on_team
     POST /api/auth/verify {email, code} -> {token, email} | 401 bad_code | 400 no_enrollment
     POST /api/auth/reset  {email}    -> 200 (admin session) — clears that user's authenticator
     POST /api/auth/request|approve|decline, GET /api/auth/requests
                                      -> 403 join_closed
     GET  /api/state                  -> {version, state}            (session)
     PUT  /api/state {version, state} -> {ok, version} | 409 current (session)

   state.notifications and state.channels are reserved arrays (empty in v1)
   so a later notifications feature can append to them without a new store.

   AUTH_MOCK=1 skips the authenticator step (local demos only). Real TOTP
   is required when that variable is unset.

   Storage (SHIFTLY_DATA_DIR, else /data when that directory exists, else the app dir):
     state.json — shared app state (seeded from index.html on first boot)
     auth.json  — TOTP secrets + sessions (never sent to clients) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tls = require("tls");

const PORT = process.env.PORT || 3000;
/* Real Google Authenticator codes are required unless AUTH_MOCK=1. */
const AUTH_MOCK = process.env.AUTH_MOCK === "1" || process.env.AUTH_MOCK === "true";
const DATA_DIR = process.env.SHIFTLY_DATA_DIR
  ? path.resolve(process.env.SHIFTLY_DATA_DIR)
  : (fs.existsSync("/data") ? "/data" : __dirname);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, "state.json");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const INDEX = path.join(__dirname, "index.html");
const SESSION_DAYS = 60;
const ROSTER_VERSION = 1;
const AUTH_POLICY = "totp-v1";
/* firstname.lastname@cybereason.com — letters only, one dot, no plus-tags. */
const ROSTER_EMAIL = /^[a-z]+\.[a-z]+@cybereason\.com$/;
const LEGACY_ADMIN_EMAIL = "niritzik23@gmail.com";
const EMAIL_RULE = "firstname.lastname@cybereason.com";

/* Canonical v1 roster. Migration adds anyone missing once; admins may
   remove people later without them being re-added on the next boot.
   Nir is the admin. Privileges from niritzik23@gmail.com move here. */
const SEED_EMPLOYEES = [
  { id: "e_lotan_hadad", name: "Lotan Hadad", email: "lotan.hadad@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_avital_lioubchits", name: "Avital Lioubchits", email: "avital.lioubchits@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_gal_mamon", name: "Gal Mamon", email: "gal.mamon@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_matan_razon", name: "Matan Razon", email: "matan.razon@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_alon_shpilberg", name: "Alon Shpilberg", email: "alon.shpilberg@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_bar_belisha", name: "Bar Belisha", email: "bar.belisha@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_dana_balas", name: "Dana Balas", email: "dana.balas@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_dana_bardin", name: "Dana Bardin", email: "dana.bardin@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_ori_hai", name: "Ori Hai", email: "ori.hai@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_nir_itzik", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: true, position: "Manager" },
  { id: "e_alex_rivlis", name: "Alex Rivlis", email: "alex.rivlis@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_shoshana_avni", name: "Shoshana Avni", email: "shoshana.avni@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_ben_shalev", name: "Ben Shalev", email: "ben.shalev@cybereason.com", admin: false, position: "Shift worker" },
  { id: "e_shahar_eldar", name: "Shahar Eldar", email: "shahar.eldar@cybereason.com", admin: false, position: "Shift worker" }
];

/* ---------- state store ---------- */
function seedState() {
  try {
    const html = fs.readFileSync(INDEX, "utf8");
    const m = html.match(/<script id="state" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) return JSON.parse(m[1]);
  } catch (e) { console.error("seed failed", e); }
  return null;
}

/* ---------- database (Railway PostgreSQL via DATABASE_URL) ----------
   Primary storage when DATABASE_URL is set; the JSON files on the data
   dir remain a write-through backup and the fallback when no database
   is configured. On first boot with a database, existing JSON migrates. */
let db = null;
async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const { Pool } = require("pg");
  db = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1|railway\.internal/.test(url) ? false : { rejectUnauthorized: false }
  });
  await db.query("CREATE TABLE IF NOT EXISTS shiftly_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())");
  return true;
}
async function dbGet(key) {
  if (!db) return null;
  const r = await db.query("SELECT value FROM shiftly_kv WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].value : null;
}
function dbPut(key, value) {
  if (!db) return;
  db.query(
    "INSERT INTO shiftly_kv (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
    [key, JSON.stringify(value)]
  ).catch(e => console.error("db write failed:", key, e.message));
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
  dbPut("state", store);
}

/* ---------- auth store ---------- */
let auth;
try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); if (!auth.users) throw 0; }
catch (e) { auth = { users: {}, sessions: {}, requests: {} }; }
if (!auth.requests) auth.requests = {};
function persistAuth() {
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(auth)); }
  catch (e) { console.error("persist auth failed", e); }
  dbPut("auth", auth);
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
  const want = String(code == null ? "" : code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(want)) return false;
  const c = Math.floor(Date.now() / 30000);
  const wantBuf = Buffer.from(want);
  let ok = false;
  for (let w = -1; w <= 1; w++) {
    const got = Buffer.from(hotp(secretB32, c + w));
    if (got.length === wantBuf.length && crypto.timingSafeEqual(got, wantBuf)) ok = true;
  }
  return ok;
}

/* ---------- roster ---------- */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function isRosterEmail(email) {
  return ROSTER_EMAIL.test(normalizeEmail(email));
}
function ensureReservedArrays(state) {
  if (!state || typeof state !== "object") return false;
  let changed = false;
  /* Reserved for a later notifications feature. Items are not defined in v1. */
  if (!Array.isArray(state.notifications)) { state.notifications = []; changed = true; }
  if (!Array.isArray(state.channels)) { state.channels = []; changed = true; }
  if (!Array.isArray(state.employees)) { state.employees = []; changed = true; }
  return changed;
}
function dropPersonId(state, id) {
  if (!id || !state.weeks) return;
  for (const wk of Object.values(state.weeks)) {
    if (!wk || typeof wk !== "object") continue;
    if (wk.submissions) delete wk.submissions[id];
    if (!wk.assignments) continue;
    for (const key of Object.keys(wk.assignments)) {
      const list = wk.assignments[key];
      if (!Array.isArray(list)) continue;
      const next = list.filter(x => x !== id);
      if (next.length) wk.assignments[key] = next;
      else delete wk.assignments[key];
    }
  }
}
function submissionScore(sub) {
  if (!sub) return 0;
  if (sub.submittedAt) return 2;
  if (sub.cells && Object.keys(sub.cells).length) return 1;
  return 0;
}
function rewritePersonId(state, fromId, toId) {
  if (!fromId || !toId || fromId === toId || !state.weeks) return;
  for (const wk of Object.values(state.weeks)) {
    if (!wk || typeof wk !== "object") continue;
    if (wk.submissions && wk.submissions[fromId]) {
      const src = wk.submissions[fromId];
      const dst = wk.submissions[toId];
      if (!dst || submissionScore(src) > submissionScore(dst)) wk.submissions[toId] = src;
      delete wk.submissions[fromId];
    }
    if (!wk.assignments) continue;
    for (const key of Object.keys(wk.assignments)) {
      const list = wk.assignments[key];
      if (!Array.isArray(list)) continue;
      const next = [];
      for (const id of list) {
        const mapped = id === fromId ? toId : id;
        if (!next.includes(mapped)) next.push(mapped);
      }
      if (next.length) wk.assignments[key] = next;
      else delete wk.assignments[key];
    }
  }
}
function sweepUnknownIds(state) {
  const ids = new Set((state.employees || []).map(e => e && e.id).filter(Boolean));
  const weeks = state.weeks || {};
  const seen = new Set();
  for (const wk of Object.values(weeks)) {
    if (!wk || typeof wk !== "object") continue;
    if (wk.submissions) {
      for (const id of Object.keys(wk.submissions)) if (!ids.has(id)) seen.add(id);
    }
    if (wk.assignments) {
      for (const list of Object.values(wk.assignments)) {
        if (Array.isArray(list)) list.forEach(id => { if (!ids.has(id)) seen.add(id); });
      }
    }
  }
  for (const id of seen) dropPersonId(state, id);
}
/* One-time allowlist migration. Later admin edits stick (rosterVersion). */
function migrateRosterV1(state) {
  const emps = Array.isArray(state.employees) ? state.employees : [];
  const legacyWasAdmin = emps.some(e => e && normalizeEmail(e.email) === LEGACY_ADMIN_EMAIL && e.admin);
  const kept = new Map();
  for (const raw of emps) {
    if (!raw) continue;
    const email = normalizeEmail(raw.email);
    if (!isRosterEmail(email)) {
      if (raw.id) dropPersonId(state, raw.id);
      continue;
    }
    const prev = kept.get(email);
    if (!prev) {
      const rec = {
        id: raw.id || ("e" + crypto.randomBytes(3).toString("hex")),
        name: String(raw.name || "").trim() || email,
        email,
        admin: !!raw.admin,
        position: raw.position || "Shift worker"
      };
      if (raw.pending) rec.pending = true;
      kept.set(email, rec);
    } else {
      if (raw.admin) prev.admin = true;
      if (!raw.pending) delete prev.pending;
      if (raw.id) rewritePersonId(state, raw.id, prev.id);
    }
  }
  for (const seed of SEED_EMPLOYEES) {
    const cur = kept.get(seed.email);
    if (!cur) {
      kept.set(seed.email, {
        id: seed.id,
        name: seed.name,
        email: seed.email,
        admin: !!seed.admin,
        position: seed.position
      });
    } else {
      cur.name = seed.name;
      cur.email = seed.email;
      if (!cur.position) cur.position = seed.position;
      delete cur.pending;
      if (seed.admin) cur.admin = true;
    }
  }
  const nir = kept.get("nir.itzik@cybereason.com");
  if (nir && legacyWasAdmin) nir.admin = true;
  const seedEmails = new Set(SEED_EMPLOYEES.map(s => s.email));
  const extras = [];
  for (const [email, emp] of kept) {
    if (!seedEmails.has(email)) extras.push(emp);
  }
  state.employees = SEED_EMPLOYEES.map(s => kept.get(s.email)).concat(extras);
  sweepUnknownIds(state);
}
function applyRosterMigration() {
  if (!store || !store.state) return;
  const arraysChanged = ensureReservedArrays(store.state);
  let migrated = false;
  if ((store.rosterVersion || 0) < ROSTER_VERSION) {
    migrateRosterV1(store.state);
    store.rosterVersion = ROSTER_VERSION;
    migrated = true;
    console.log("roster migration v1 applied:", (store.state.employees || []).length, "people on the allowlist");
  }
  if (arraysChanged || migrated) persistState();
}
/* First boot on this policy signs everyone out so the next login enrolls
   a real authenticator. Existing TOTP secrets are kept. Join requests are dropped. */
function applyAuthPolicy() {
  if (!auth.users) auth.users = {};
  if (!auth.sessions) auth.sessions = {};
  if (!auth.requests) auth.requests = {};
  if (auth.policy === AUTH_POLICY) return;
  auth.sessions = {};
  auth.requests = {};
  auth.policy = AUTH_POLICY;
  persistAuth();
  console.log("auth policy", AUTH_POLICY, "— sessions cleared, open join requests dropped");
}

/* ---------- helpers ---------- */
function findEmployee(email) {
  const e = normalizeEmail(email);
  if (!isRosterEmail(e)) return null;
  const emps = (store.state && store.state.employees) || [];
  const emp = emps.find(x => x && normalizeEmail(x.email) === e) || null;
  if (!emp || emp.pending) return null;
  return emp;
}
function requireSession(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const s = auth.sessions[token];
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_DAYS * 864e5) { delete auth.sessions[token]; persistAuth(); return null; }
  const emp = findEmployee(s.email);
  if (!emp) return null; /* removed from team, pending, or email no longer allowed */
  return { token, email: emp.email, emp };
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
function rosterSignature(list) {
  return JSON.stringify((list || []).map(e => [
    e && e.id || "",
    normalizeEmail(e && e.email),
    !!(e && e.admin),
    !!(e && e.pending)
  ]).sort());
}
function rejectJoin(res) {
  return json(res, 403, { error: "join_closed" });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  try {
    if (url === "/api/config" && (req.method === "GET" || req.method === "HEAD")) {
      return json(res, 200, {
        authMock: AUTH_MOCK,
        totpRequired: !AUTH_MOCK,
        emailRule: EMAIL_RULE
      });
    }

    if (url === "/api/auth/start" && req.method === "POST") {
      const { email } = JSON.parse(await readBody(req) || "{}");
      const key = normalizeEmail(email);
      if (!isRosterEmail(key)) return json(res, 400, { error: "invalid_email" });
      const emp = findEmployee(key);
      if (!emp) return json(res, 403, { error: "not_on_team" });
      if (AUTH_MOCK) {
        const token = crypto.randomBytes(32).toString("hex");
        auth.sessions[token] = { email: emp.email, ts: Date.now() };
        persistAuth();
        return json(res, 200, { mode: "mock", token, email: emp.email });
      }
      let u = auth.users[key];
      if (u && u.confirmed) return json(res, 200, { mode: "code" });
      const secret = b32encode(crypto.randomBytes(20));
      auth.users[key] = { secret, confirmed: false };
      persistAuth();
      const label = encodeURIComponent("Shiftly:" + emp.email);
      return json(res, 200, {
        mode: "enroll",
        secret,
        otpauth: "otpauth://totp/" + label + "?secret=" + secret + "&issuer=Shiftly&algorithm=SHA1&digits=6&period=30"
      });
    }

    if (url === "/api/auth/verify" && req.method === "POST") {
      const { email, code } = JSON.parse(await readBody(req) || "{}");
      const key = normalizeEmail(email);
      if (!isRosterEmail(key)) return json(res, 400, { error: "invalid_email" });
      const emp = findEmployee(key);
      if (!emp) return json(res, 403, { error: "not_on_team" });
      const u = auth.users[key];
      if (!u || !u.secret) return json(res, 400, { error: "no_enrollment" });
      if (!totpCheck(u.secret, code)) return json(res, 401, { error: "bad_code" });
      u.confirmed = true;
      const token = crypto.randomBytes(32).toString("hex");
      auth.sessions[token] = { email: emp.email, ts: Date.now() };
      persistAuth();
      return json(res, 200, { token, email: emp.email });
    }

    /* Open join is closed. Admins add people from the team screen. */
    if ((url === "/api/auth/request" || url === "/api/auth/approve" || url === "/api/auth/decline") && req.method === "POST") {
      return rejectJoin(res);
    }
    if (url === "/api/auth/requests" && req.method === "GET") {
      return rejectJoin(res);
    }

    if (url === "/api/auth/reset" && req.method === "POST") {
      const sess = requireSession(req);
      if (!sess || !sess.emp.admin) return json(res, 403, { error: "admin_required" });
      const { email } = JSON.parse(await readBody(req) || "{}");
      const key = normalizeEmail(email);
      if (!key) return json(res, 400, { error: "invalid_email" });
      delete auth.users[key];
      for (const [t, s] of Object.entries(auth.sessions)) {
        if (normalizeEmail(s.email) === key) delete auth.sessions[t];
      }
      persistAuth();
      return json(res, 200, { ok: true });
    }

    if (url === "/api/health") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "X-Auth-Mock": AUTH_MOCK ? "1" : "0"
      });
      return res.end("ok " + (db ? "db" : "json"));
    }

    if (url === "/api/state") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      if (req.method === "GET") return json(res, 200, store);
      if (req.method === "PUT") {
        const parsed = JSON.parse(await readBody(req) || "{}");
        const st = parsed.state;
        if (!st || !Array.isArray(st.employees) || !st.weeks || !st.settings) {
          return json(res, 400, { error: "invalid_state" });
        }
        if (parsed.version !== store.version) return json(res, 409, store);
        const seen = new Set();
        for (const e of st.employees) {
          if (!e || typeof e !== "object") return json(res, 400, { error: "invalid_state" });
          const email = normalizeEmail(e.email);
          if (!isRosterEmail(email)) return json(res, 400, { error: "invalid_email", email: String(e.email || "") });
          if (seen.has(email)) return json(res, 400, { error: "duplicate_email", email });
          seen.add(email);
          e.email = email;
        }
        if (!st.employees.some(e => e.admin && !e.pending)) return json(res, 400, { error: "last_admin" });
        if (!sess.emp.admin && rosterSignature(st.employees) !== rosterSignature(store.state.employees)) {
          return json(res, 403, { error: "admin_required" });
        }
        if (!Array.isArray(st.notifications)) {
          st.notifications = Array.isArray(store.state.notifications) ? store.state.notifications : [];
        }
        if (!Array.isArray(st.channels)) {
          st.channels = Array.isArray(store.state.channels) ? store.state.channels : [];
        }
        store = { version: store.version + 1, state: st, rosterVersion: store.rosterVersion || ROSTER_VERSION };
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
    if (!isRosterEmail(e.email)) return false;
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
  dbPut("reminders", sentLog);
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

(async () => {
  let dbMode = false;
  try {
    dbMode = await initDb();
    if (dbMode) {
      const s = await dbGet("state");
      if (s && s.state && Array.isArray(s.state.employees)) {
        store = s;                                   /* database is the source of truth */
      } else {
        dbPut("state", store);                       /* first boot: migrate JSON -> db */
        console.log("migrated state.json into the database");
      }
      const a = await dbGet("auth");
      if (a && a.users) auth = a; else dbPut("auth", auth);
      const rl = await dbGet("reminders");
      if (rl && typeof rl === "object") sentLog = rl; else dbPut("reminders", sentLog);
    }
  } catch (e) {
    console.error("database unavailable, falling back to JSON files:", e.message);
    db = null;
    dbMode = false;
  }
  applyRosterMigration();
  applyAuthPolicy();
  server.listen(PORT, () => console.log("Shiftly server listening on :" + PORT +
    " | storage: " + (dbMode ? "PostgreSQL (json backup: " + DATA_DIR + ")" : "JSON files (" + DATA_DIR + ") — set DATABASE_URL for PostgreSQL") +
    " | auth: " + (AUTH_MOCK ? "MOCK (AUTH_MOCK=1, authenticator skipped)" : "TOTP") +
    (process.env.SMTP_USER ? " | email reminders ON" : " | email reminders OFF (set SMTP_USER + SMTP_PASS)")));
})();
