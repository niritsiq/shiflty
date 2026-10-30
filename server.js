/* Shiftly sync server. Sign-in is email + Google Authenticator (TOTP, RFC 6238).
   Zero dependencies for auth — Node's crypto does the TOTP math.

   Who can sign in:
     The email must be firstname.lastname@cybereason.com (lowercase letters,
     exactly one dot in the local part) AND be on the team roster. Admins
     add and remove people in the app. Open join / self-request is closed.

   API:
     GET  /api/config                 -> {authMock, totpRequired, emailRule}
     GET  /api/health                 -> text "ok db|json" plus X-Auth-Mock: 0|1
     POST /api/auth/start  {email, reenroll?}
                                      -> {mode:"code"} if authenticator is confirmed and reenroll is not true
                                      -> {mode:"enroll", email, secret, otpauth}
                                         The same unconfirmed secret is reused until it is confirmed
                                         or {reenroll:true} replaces it (confirmed secrets included).
                                         Replacing one does not return a session.
                                      | {mode:"mock", token, email} when AUTH_MOCK=1
                                      | 400 invalid_email | 403 not_on_team
     POST /api/auth/verify {email, code} -> {token, email} | 401 bad_code | 400 no_enrollment
     POST /api/auth/reset  {email}    -> 200 (admin session) — clears that user's authenticator
     POST /api/auth/request|approve|decline, GET /api/auth/requests
                                      -> 403 join_closed
     POST /api/invites     {}         -> admin session. {id, url, expiresAt}
                                      url is the APP_URL origin, or the request
                                      origin, plus /?invite=<token>. No channelId.
                                      The raw token is returned once. auth.json
                                      keeps SHA-256 only. TTL is INVITE_TTL_HOURS
                                      (default 48).
     GET  /api/invites                -> admin. pending / used / revoked, no token
     DELETE /api/invites/:id          -> admin. revoke an unused link
     POST /api/invites/accept {token, email}
                                      -> {ok, email}. Adds that Cybereason
                                      address to the roster and to the team
                                      the admin was on when the link was minted.
                                      Does not return a session. Sign-in is
                                      still /api/auth/start and /api/auth/verify.
     GET  /api/state[?channel=]       -> {version, state}            (session)
                                      When channels[] is empty this is the whole
                                      roster (v1). When channels exist, the body
                                      is scoped to one team the caller belongs to
                                      ({scoped:true, channelId}) — never another team.
     PUT  /api/state[?channel=] {version, state, adminToggle?}
                                      -> {ok, version, employees} | 409 current (session)
                                      With stored channels, ?channel= is required
                                      and the write merges that team only.
                                      Admin flags inside state are ignored.
                                      adminToggle {email, admin:boolean} is the Team button.
                                      400 canonical_admin — nir.itzik stays admin
                                      400 self_demotion — that admin cannot clear their own flag
     GET  /api/channels               -> {channels:[{id,name,role,memberIds,implicit,default}]}
     GET  /api/notifications[?channel=] -> {notifications:[]}
     POST /api/notifications/read     -> {all:true} | {ids:[]} marks read, returns the list
     POST /api/notifications/:id/read -> mark one read
     GET  /api/me/home[?channel=]     -> home stats for this session (see README)
                                      Same Bearer token. Weeks, shift lengths, and
                                      notifications already in state. No second login.
     POST /api/mail/smoke             -> admin session. One Resend test message
                                      to that admin's roster email.
                                      {ok:true, id} or {ok:false, status, name, message}

   Publishing: an admin save that flips a week to published stores
   publishedBy {id, name, email} and publishedAt on that week, and appends
   one schedule_published notification naming them (actor). That same
   publish is emailed once per active roster member. A worker save cannot
   change published or those fields. A later save that leaves the week
   published keeps the original actor and does not email again.

   STUB: /api/channels and /api/notifications read and write
   state.notifications and state.channels in the same store (JSON or
   shiftly_kv). Developer 1 replaces that persistence. Same Bearer session
   as the rest of the API. Schedule saves do not overwrite those arrays.

   Availability reminders are in-app rows on state.notifications
   (type availability_reminder). The process itself fires Sunday 09:00,
   Sunday 17:00, and Monday 09:00 Asia/Jerusalem, and catches up on boot.
   The same rows are emailed through Resend (HTTPS) when RESEND_API_KEY
   and RESEND_FROM are both set. Publishing a week does the same for
   schedule_published. POST /api/mail/smoke (admin session) sends one
   test message to that admin's roster email.

   AUTH_MOCK=1 skips the authenticator step (local demos only). Real TOTP
   is required when that variable is unset.

   Invite links are single-use. Accepting one adds a matching email to
   the allowlist. It does not enroll an authenticator and it does not
   issue a session. INVITE_NOW (ISO) freezes invite expiry for tests.

   Storage (SHIFTLY_DATA_DIR, else /data when that directory exists, else the app dir):
     state.json — shared app state (seeded from index.html on first boot)
     auth.json  — TOTP secrets, sessions, and invite hashes (never sent to clients) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const reminders = require("./reminders");
const home = require("./home");
const mail = require("./mail");

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
/* Seed admin. A full-state save must not clear this, including one that
   raced a direct edit in Postgres. The in-memory roster is what sessions
   read; it is only reloaded from the database at boot. */
const CANONICAL_ADMIN_EMAIL = "nir.itzik@cybereason.com";
const EMAIL_RULE = "firstname.lastname@cybereason.com";
/* New invite links last this many hours unless INVITE_TTL_HOURS is set. */
const INVITE_TTL_HOURS_DEFAULT = 48;
/* Accept posts per client address. One Node process on the free instance. */
const INVITE_ACCEPT_WINDOW_MS = 15 * 60 * 1000;
const INVITE_ACCEPT_MAX = 10;

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
  if (store && store.state && enforceCanonicalAdmin(store.state)) {
    store.version = (store.version || 1) + 1;
    console.log("restored admin for", CANONICAL_ADMIN_EMAIL);
  }
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(store)); }
  catch (e) { console.error("persist state failed", e); }
  dbPut("state", store);
}

/* ---------- auth store ---------- */
let auth;
try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); if (!auth.users) throw 0; }
catch (e) { auth = { users: {}, sessions: {}, requests: {}, invites: {} }; }
if (!auth.requests) auth.requests = {};
if (!auth.invites || typeof auth.invites !== "object" || Array.isArray(auth.invites)) auth.invites = {};
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
/* Two steps either side is about a minute of phone-clock drift. */
const TOTP_DRIFT_STEPS = 2;
function totpCheck(secretB32, code) {
  const want = String(code == null ? "" : code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(want)) return false;
  const c = Math.floor(Date.now() / 30000);
  const wantBuf = Buffer.from(want);
  let ok = false;
  for (let w = -TOTP_DRIFT_STEPS; w <= TOTP_DRIFT_STEPS; w++) {
    const got = Buffer.from(hotp(secretB32, c + w));
    if (got.length === wantBuf.length && crypto.timingSafeEqual(got, wantBuf)) ok = true;
  }
  return ok;
}
/* 6-digit form of the RFC 6238 SHA-1 vectors. A bad implementation should not boot. */
(function checkTotpVectors() {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const vectors = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"]
  ];
  for (const [sec, code] of vectors) {
    const got = hotp(secret, Math.floor(sec / 30));
    if (got !== code) {
      console.error("TOTP test vector failed at", sec, "got", got, "expected", code);
      process.exit(1);
    }
  }
})();

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
  /* Notification and channel items are defined next to the /api/notifications routes. */
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
  const nir = kept.get(CANONICAL_ADMIN_EMAIL);
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
  healCanonicalAdmin();
}
/* First boot on this policy signs everyone out so the next login enrolls
   a real authenticator. Existing TOTP secrets are kept. Join requests are dropped. */
function applyAuthPolicy() {
  if (!auth.users) auth.users = {};
  if (!auth.sessions) auth.sessions = {};
  if (!auth.requests) auth.requests = {};
  if (!auth.invites || typeof auth.invites !== "object" || Array.isArray(auth.invites)) auth.invites = {};
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
function dropSessionsFor(emailKey) {
  for (const [t, s] of Object.entries(auth.sessions)) {
    if (normalizeEmail(s.email) === emailKey) delete auth.sessions[t];
  }
}
function secretUsable(secret) {
  const raw = String(secret || "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z2-7]{16,}$/.test(raw) && b32decode(raw).length >= 10;
}
/* Key URI format: issuer and account are encoded separately, and the colon
   between them stays literal. Encoding the colon makes some authenticators
   mis-read the secret. */
function otpauthUri(email, secret) {
  const issuer = "Shiftly";
  const label = encodeURIComponent(issuer) + ":" + encodeURIComponent(email);
  return "otpauth://totp/" + label
    + "?secret=" + secret
    + "&issuer=" + encodeURIComponent(issuer)
    + "&algorithm=SHA1&digits=6&period=30";
}
function issueEnrollment(key, email, replace) {
  const current = auth.users[key];
  if (current && secretUsable(current.secret) && !current.confirmed && !replace) {
    return { mode: "enroll", email, secret: current.secret, otpauth: otpauthUri(email, current.secret) };
  }
  const secret = b32encode(crypto.randomBytes(20));
  if (current && current.confirmed) dropSessionsFor(key);
  auth.users[key] = { secret, confirmed: false };
  persistAuth();
  return { mode: "enroll", email, secret, otpauth: otpauthUri(email, secret) };
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
function enforceCanonicalAdmin(state) {
  if (!state || !Array.isArray(state.employees)) return false;
  let changed = false;
  for (const e of state.employees) {
    if (!e || normalizeEmail(e.email) !== CANONICAL_ADMIN_EMAIL || e.admin) continue;
    e.admin = true;
    changed = true;
  }
  return changed;
}
/* Bump the version when the flag actually flips so an open tab picks it up
   on the next poll instead of saving the old roster over it. */
function healCanonicalAdmin() {
  if (!store || !store.state || !Array.isArray(store.state.employees)) return false;
  const missing = store.state.employees.some(e => e && normalizeEmail(e.email) === CANONICAL_ADMIN_EMAIL && !e.admin);
  if (!missing) return false;
  persistState();
  return true;
}
function parseAdminToggle(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw) || typeof raw.admin !== "boolean") {
    return { error: "invalid_state" };
  }
  const email = normalizeEmail(raw.email);
  if (!isRosterEmail(email)) return { error: "invalid_email", email: String(raw.email || "") };
  return { email, admin: raw.admin };
}
/* Copy admin flags from the stored roster. The client puts the whole roster
   on every save, so a tab opened before a promotion still has admin:false.
   adminToggle is the Team button and changes one person. */
function reconcileAdmins(st, sess, toggle) {
  const stored = new Map();
  for (const e of (store.state && store.state.employees) || []) {
    if (!e) continue;
    const email = normalizeEmail(e.email);
    if (!email || stored.has(email)) continue;
    stored.set(email, !!e.admin);
  }
  for (const e of st.employees) {
    const email = normalizeEmail(e.email);
    e.admin = stored.has(email) ? stored.get(email) : false;
    if (email === CANONICAL_ADMIN_EMAIL) e.admin = true;
  }
  if (!toggle) return null;
  if (!sess.emp.admin) return { status: 403, error: "admin_required" };
  const target = st.employees.find(e => normalizeEmail(e.email) === toggle.email);
  if (!target || target.pending) return { status: 400, error: "not_on_team" };
  if (!toggle.admin && toggle.email === CANONICAL_ADMIN_EMAIL) {
    return { status: 400, error: "canonical_admin" };
  }
  if (!toggle.admin && toggle.email === normalizeEmail(sess.email)) {
    return { status: 400, error: "self_demotion" };
  }
  target.admin = toggle.admin;
  if (normalizeEmail(target.email) === CANONICAL_ADMIN_EMAIL) target.admin = true;
  return null;
}
function rejectJoin(res) {
  return json(res, 403, { error: "join_closed" });
}

/* ---------- invite links ----------
   Mint stores SHA-256 only. The raw token leaves in the one mint response,
   inside /?invite= on the app origin. Accept adds a roster row (and, when
   this deploy already has teams, that admin's current team). The caller
   still has to finish /api/auth/start and /api/auth/verify. */
function inviteTtlMs() {
  const raw = String(process.env.INVITE_TTL_HOURS == null ? "" : process.env.INVITE_TTL_HOURS).trim();
  if (!raw) return INVITE_TTL_HOURS_DEFAULT * 3600 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return INVITE_TTL_HOURS_DEFAULT * 3600 * 1000;
  return n * 3600 * 1000;
}
function inviteNowMs() {
  const raw = process.env.INVITE_NOW;
  if (raw) {
    const t = Date.parse(String(raw));
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
function hashInviteToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function appOrigin(req) {
  const configured = String(process.env.APP_URL || "").trim();
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    } catch (e) { /* fall through to the request host */ }
  }
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req.headers.host || "").trim();
  if (!host || !/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return "http://localhost";
  let proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (proto !== "http" && proto !== "https") proto = "http";
  return proto + "://" + host;
}
function inviteUrl(req, token) {
  return appOrigin(req) + "/?invite=" + encodeURIComponent(token);
}
function displayNameFromEmail(email) {
  return email.split("@")[0].split(".").filter(Boolean).map(part => {
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
}
function freshEmployeeId(email) {
  const base = "e_" + email.split("@")[0].replace(/\./g, "_");
  const used = new Set((store.state.employees || []).map(e => e && e.id).filter(Boolean));
  if (!used.has(base)) return base;
  let id = base;
  do { id = base + "_" + crypto.randomBytes(3).toString("hex"); } while (used.has(id));
  return id;
}
/* Same pick as GET /api/state with no ?channel=: the admin's default team,
   else the first team they belong to. No stored channels means the implicit
   roster, and the invite does not name a channel. */
function currentTeamId(emp) {
  if (!storedChannels().length) return { id: null };
  const mine = channelsFor(emp);
  const ch = mine.find(c => c.default) || mine[0];
  if (!ch) return { error: "no_team" };
  return { id: ch.id };
}
function inviteStatus(inv) {
  if (inv.usedAt) return "used";
  if (inv.revokedAt) return "revoked";
  return "pending";
}
function publicInvite(inv) {
  return {
    id: inv.id,
    status: inviteStatus(inv),
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    createdBy: inv.createdBy,
    usedAt: inv.usedAt || null,
    usedBy: inv.usedBy || null,
    revokedAt: inv.revokedAt || null
  };
}
function listInvites() {
  const rows = Object.values(auth.invites || {}).filter(inv => inv && inv.id);
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return rows.map(publicInvite);
}
function findInvite(token) {
  const want = Buffer.from(hashInviteToken(token), "hex");
  const list = Object.values(auth.invites || {});
  let found = null;
  for (const inv of list) {
    if (!inv || typeof inv.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(inv.tokenHash)) continue;
    const got = Buffer.from(inv.tokenHash, "hex");
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) found = inv;
  }
  return found;
}
function adminSession(req, res) {
  const sess = requireSession(req);
  if (!sess) { json(res, 401, { error: "auth_required" }); return null; }
  if (!sess.emp.admin) { json(res, 403, { error: "admin_required" }); return null; }
  return sess;
}
function mintInvite(sess, req) {
  const team = currentTeamId(sess.emp);
  if (team.error) return { status: 400, body: { error: team.error } };
  const token = crypto.randomBytes(32).toString("base64url");
  const id = "inv_" + crypto.randomBytes(9).toString("hex");
  const created = inviteNowMs();
  const rec = {
    id,
    tokenHash: hashInviteToken(token),
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + inviteTtlMs()).toISOString(),
    createdBy: sess.email,
    channelId: team.id,
    usedAt: null,
    usedBy: null,
    revokedAt: null
  };
  auth.invites[id] = rec;
  persistAuth();
  return { status: 200, body: { id, url: inviteUrl(req, token), expiresAt: rec.expiresAt } };
}
function revokeInvite(id) {
  const inv = auth.invites && auth.invites[id];
  if (!inv) return { status: 404, body: { error: "not_found" } };
  if (inv.usedAt) return { status: 409, body: { error: "already_used" } };
  if (!inv.revokedAt) {
    inv.revokedAt = new Date(inviteNowMs()).toISOString();
    persistAuth();
  }
  return { status: 200, body: { ok: true, id: inv.id, status: "revoked", revokedAt: inv.revokedAt } };
}
function inviteExpired(inv) {
  const exp = Date.parse(inv.expiresAt);
  return !Number.isFinite(exp) || exp <= inviteNowMs();
}
/* Adds the address or clears pending on a row that is already there.
   An active roster email does not consume the link. */
function acceptInvite(inv, email) {
  const emps = store.state.employees || (store.state.employees = []);
  const existing = emps.find(e => e && normalizeEmail(e.email) === email) || null;
  if (existing && !existing.pending) return { status: 409, body: { error: "already_on_team" } };
  let channel = null;
  if (inv.channelId) {
    channel = storedChannels().find(c => c.id === inv.channelId) || null;
    if (!channel) return { status: 400, body: { error: "unknown_channel" } };
  }
  let emp = existing;
  if (emp) {
    delete emp.pending;
    emp.email = email;
    if (!String(emp.name || "").trim()) emp.name = displayNameFromEmail(email);
    if (!emp.position) emp.position = "Shift worker";
    emp.admin = email === CANONICAL_ADMIN_EMAIL;
  } else {
    emp = {
      id: freshEmployeeId(email),
      name: displayNameFromEmail(email),
      email,
      admin: false,
      position: "Shift worker"
    };
    emps.push(emp);
  }
  if (channel && !channel.memberIds.includes(emp.id)) channel.memberIds.push(emp.id);
  inv.usedAt = new Date(inviteNowMs()).toISOString();
  inv.usedBy = email;
  store.version = (store.version || 1) + 1;
  persistState();
  persistAuth();
  return { status: 200, body: { ok: true, email } };
}
const inviteAcceptHits = new Map();
function allowInviteAccept(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || "unknown");
  const now = Date.now();
  const prev = inviteAcceptHits.get(ip) || [];
  const fresh = prev.filter(t => now - t < INVITE_ACCEPT_WINDOW_MS);
  if (fresh.length >= INVITE_ACCEPT_MAX) {
    inviteAcceptHits.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  inviteAcceptHits.set(ip, fresh);
  return true;
}

/* ---------- channels + notifications (stub) ----------
   Developer 1: replace the store.state reads/writes below with Supabase
   (shiftly_kv or tables). Keep the JSON shapes and the session check.
   Do not add a second sign-in. */
const NOTIFICATION_TYPES = new Set(["schedule_published", "swap_request", "availability_reminder", "open_shift"]);

function storedChannels() {
  const list = store.state && store.state.channels;
  if (!Array.isArray(list)) return [];
  return list.filter(c => c && typeof c.id === "string" && c.id && Array.isArray(c.memberIds));
}
function legacyChannelId(channels) {
  const marked = (channels || []).find(c => c && (c.default || c.id === "ch_default"));
  return marked ? marked.id : (channels && channels[0] ? channels[0].id : "ch_default");
}
function channelsFor(emp) {
  const stored = storedChannels();
  if (!stored.length) {
    const memberIds = (store.state.employees || []).filter(e => e && e.id && !e.pending).map(e => e.id);
    return [{
      id: "ch_default",
      name: (store.state.settings && store.state.settings.company) || "Cybereason",
      memberIds,
      implicit: true,
      default: true
    }];
  }
  return stored.filter(ch => ch.memberIds.includes(emp.id)).map(ch => ({
    id: ch.id,
    name: String(ch.name || "Team"),
    memberIds: ch.memberIds.slice(),
    implicit: false,
    default: !!(ch.default || ch.id === "ch_default")
  }));
}
function channelsPayload(emp) {
  return {
    channels: channelsFor(emp).map(c => ({
      id: c.id,
      name: c.name,
      role: emp.admin ? "admin" : "member",
      memberIds: c.memberIds,
      implicit: !!c.implicit,
      default: !!c.default
    }))
  };
}
function weekBelongs(key, wk, channel, legacyHome) {
  if (!wk || typeof wk !== "object") return false;
  if (wk.channelId) return wk.channelId === channel.id;
  if (typeof key === "string" && key.indexOf("|") >= 0) return key.indexOf(channel.id + "|") === 0;
  return channel.id === legacyHome;
}
function scopeState(channel) {
  const members = new Set(channel.memberIds);
  const legacyHome = legacyChannelId(storedChannels());
  const employees = (store.state.employees || []).filter(e => e && members.has(e.id));
  const weeks = {};
  for (const [k, wk] of Object.entries(store.state.weeks || {})) {
    if (weekBelongs(k, wk, channel, legacyHome)) weeks[k] = wk;
  }
  const live = storedChannels().find(c => c.id === channel.id);
  return {
    settings: store.state.settings,
    employees,
    weeks,
    notifications: [],
    channels: live ? [{ id: live.id, name: live.name, memberIds: live.memberIds.slice(), default: !!live.default }] : []
  };
}
/* What GET /api/state returns for this session.
   No stored channels → the whole v1 document (callers and tests depend on that).
   Stored channels → one team only. A roster member in no team gets themselves
   and an empty schedule, not someone else's weeks. */
function statePayload(sess, channelParam) {
  const stored = storedChannels();
  if (!stored.length) {
    if (channelParam && channelParam !== "ch_default") {
      return { status: 404, body: { error: "unknown_channel" } };
    }
    return { status: 200, body: store };
  }
  const mine = channelsFor(sess.emp);
  if (!mine.length) {
    return {
      status: 200,
      body: {
        version: store.version,
        rosterVersion: store.rosterVersion || ROSTER_VERSION,
        channelId: null,
        scoped: true,
        state: {
          settings: store.state.settings,
          employees: [sess.emp],
          weeks: {},
          notifications: [],
          channels: []
        }
      }
    };
  }
  let ch = null;
  if (!channelParam) ch = mine.find(c => c.default) || mine[0];
  else {
    ch = mine.find(c => c.id === channelParam);
    if (!ch) {
      const known = stored.some(c => c.id === channelParam);
      return { status: known ? 403 : 404, body: { error: known ? "not_a_member" : "unknown_channel" } };
    }
  }
  return {
    status: 200,
    body: {
      version: store.version,
      rosterVersion: store.rosterVersion || ROSTER_VERSION,
      channelId: ch.id,
      scoped: true,
      state: scopeState(ch)
    }
  };
}
function notificationTitle(type) {
  switch (type) {
    case "schedule_published": return "Schedule published";
    case "swap_request": return "Swap request";
    case "availability_reminder": return "Availability reminder";
    case "open_shift": return "Open shift";
    default: return "Notification";
  }
}
function visibleNotifications(emp) {
  const mine = new Set(channelsFor(emp).map(c => c.id));
  const implicit = !storedChannels().length;
  const list = Array.isArray(store.state.notifications) ? store.state.notifications : [];
  return list.filter(n => {
    if (!n || typeof n !== "object" || !n.id || !NOTIFICATION_TYPES.has(n.type)) return false;
    const recipients = Array.isArray(n.recipientIds) ? n.recipientIds : [];
    if (recipients.length && !recipients.includes(emp.id) && !recipients.includes(emp.email)) return false;
    if (n.channelId) {
      if (!implicit && !mine.has(n.channelId)) return false;
    } else if (!implicit && !recipients.length) {
      return false;
    }
    return true;
  });
}
function readAtFor(n, emp) {
  if (n.readBy && typeof n.readBy === "object" && n.readBy[emp.id]) return n.readBy[emp.id];
  return n.readAt || null;
}
function publicNotification(n, emp) {
  let day = null;
  if (Number.isInteger(n.dayIdx) && n.dayIdx >= 0 && n.dayIdx <= 6) day = n.dayIdx;
  return {
    id: String(n.id),
    type: n.type,
    title: String(n.title || notificationTitle(n.type)),
    body: String(n.body || ""),
    createdAt: n.createdAt || null,
    readAt: readAtFor(n, emp),
    channelId: n.channelId || null,
    week: typeof n.week === "string" ? n.week : null,
    dayIdx: day,
    shiftId: n.shiftId || null,
    actor: home.publicActor(n.actor)
  };
}
function publishRow(ev) {
  const who = ev.publishedBy.name || ev.publishedBy.email || "an admin";
  const label = ev.week ? reminders.weekLabel(ev.week) : "";
  const body = label
    ? "Schedule for " + label + " published by " + who + "."
    : "Schedule published by " + who + ".";
  const row = {
    id: "n_sp_" + crypto.randomBytes(6).toString("hex"),
    type: "schedule_published",
    title: "Schedule published",
    body,
    createdAt: ev.publishedAt,
    week: ev.week,
    actor: {
      id: ev.publishedBy.id,
      name: ev.publishedBy.name,
      email: ev.publishedBy.email
    },
    readBy: {}
  };
  if (ev.channelId) row.channelId = ev.channelId;
  return row;
}
function recordPublishEvents(events) {
  if (!events || !events.length || !store.state) return [];
  if (!Array.isArray(store.state.notifications)) store.state.notifications = [];
  const rows = [];
  for (const ev of events) {
    const row = publishRow(ev);
    store.state.notifications.push(row);
    rows.push(row);
  }
  return rows;
}
function homeChannelFilter(emp, channelParam) {
  const stored = storedChannels();
  if (!channelParam) return { channelId: null };
  if (!stored.length) {
    if (channelParam !== "ch_default") return { status: 404, error: "unknown_channel" };
    return { channelId: null };
  }
  const mine = channelsFor(emp);
  if (mine.some(c => c.id === channelParam)) return { channelId: channelParam };
  const known = stored.some(c => c.id === channelParam);
  return { status: known ? 403 : 404, error: known ? "not_a_member" : "unknown_channel" };
}
function notificationList(emp, channelParam) {
  let rows = visibleNotifications(emp);
  if (channelParam) {
    const allowed = channelsFor(emp).some(c => c.id === channelParam);
    if (!allowed) {
      const known = storedChannels().some(c => c.id === channelParam);
      return { status: known ? 403 : 404, body: { error: known ? "not_a_member" : "unknown_channel" } };
    }
    rows = rows.filter(n => !n.channelId || n.channelId === channelParam);
  }
  rows = rows.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { status: 200, body: { notifications: rows.map(n => publicNotification(n, emp)) } };
}
function markNotificationsRead(emp, ids, all) {
  if (!all && !ids) return { status: 400, body: { error: "bad_request" } };
  const want = ids ? new Set(ids.map(String)) : null;
  const now = new Date().toISOString();
  for (const n of visibleNotifications(emp)) {
    if (readAtFor(n, emp)) continue;
    if (!(all || want.has(String(n.id)))) continue;
    if (!n.readBy || typeof n.readBy !== "object" || Array.isArray(n.readBy)) n.readBy = {};
    n.readBy[emp.id] = now;
  }
  persistState();
  return notificationList(emp, null);
}
function putFullState(sess, st, toggle) {
  const seen = new Set();
  for (const e of st.employees) {
    if (!e || typeof e !== "object") return { status: 400, body: { error: "invalid_state" } };
    const email = normalizeEmail(e.email);
    if (!isRosterEmail(email)) return { status: 400, body: { error: "invalid_email", email: String(e.email || "") } };
    if (seen.has(email)) return { status: 400, body: { error: "duplicate_email", email } };
    seen.add(email);
    e.email = email;
  }
  const guard = reconcileAdmins(st, sess, toggle);
  if (guard) return { status: guard.status, body: { error: guard.error } };
  if (!st.employees.some(e => e.admin && !e.pending)) return { status: 400, body: { error: "last_admin" } };
  if (!sess.emp.admin && rosterSignature(st.employees) !== rosterSignature(store.state.employees)) {
    return { status: 403, body: { error: "admin_required" } };
  }
  const publishedAt = new Date().toISOString();
  const events = home.attributePublishes(store.state.weeks, st.weeks, sess.emp, publishedAt, storedChannels());
  const publishedRows = recordPublishEvents(events);
  /* Schedule saves must not clobber mark-read or team membership. */
  st.notifications = Array.isArray(store.state.notifications) ? store.state.notifications : [];
  st.channels = Array.isArray(store.state.channels) ? store.state.channels : [];
  store = { version: store.version + 1, state: st, rosterVersion: store.rosterVersion || ROSTER_VERSION };
  const mailJobs = publishMailJobs(events, publishedRows, null);
  persistState();
  return { status: 200, body: { ok: true, version: store.version, employees: st.employees }, mailJobs };
}
function normalizeIncomingEmployee(raw) {
  if (!raw || typeof raw !== "object") return { error: "invalid_state" };
  const email = normalizeEmail(raw.email);
  if (!isRosterEmail(email)) return { error: "invalid_email", email: String(raw.email || "") };
  const rec = {
    id: raw.id || ("e" + crypto.randomBytes(3).toString("hex")),
    name: String(raw.name || "").trim() || email,
    email,
    admin: !!raw.admin,
    position: raw.position || "Shift worker"
  };
  if (raw.pending) rec.pending = true;
  return { rec };
}
function putChannelState(sess, channel, st, toggle) {
  const stored = storedChannels();
  const live = stored.find(c => c.id === channel.id);
  if (!live) return { status: 404, body: { error: "unknown_channel" } };
  if (st.employees.some(e => !e || typeof e !== "object")) return { status: 400, body: { error: "invalid_state" } };
  /* Same admin rules as a full save: stale admin bits in the payload are
     ignored, and adminToggle is the only intentional change. */
  const guard = reconcileAdmins(st, sess, toggle);
  if (guard) return { status: guard.status, body: { error: guard.error } };
  const members = new Set(live.memberIds);
  const legacyHome = legacyChannelId(stored);
  const seen = new Set();
  const incoming = [];
  for (const raw of st.employees) {
    const norm = normalizeIncomingEmployee(raw);
    if (norm.error) return { status: 400, body: { error: norm.error, email: norm.email } };
    if (seen.has(norm.rec.email)) return { status: 400, body: { error: "duplicate_email", email: norm.rec.email } };
    seen.add(norm.rec.email);
    incoming.push(norm.rec);
  }
  for (const e of store.state.employees || []) {
    if (members.has(e.id)) continue;
    const email = normalizeEmail(e.email);
    if (seen.has(email)) return { status: 400, body: { error: "duplicate_email", email } };
  }
  const before = (store.state.employees || []).filter(e => members.has(e.id));
  if (!sess.emp.admin && rosterSignature(before) !== rosterSignature(incoming)) {
    return { status: 403, body: { error: "admin_required" } };
  }

  let nextEmployees = (store.state.employees || []).slice();
  let nextMemberIds = live.memberIds.slice();
  const removedIds = [];
  if (sess.emp.admin) {
    const incomingIds = new Set(incoming.map(e => e.id));
    const elsewhere = new Set();
    for (const c of stored) {
      if (c.id === live.id) continue;
      (c.memberIds || []).forEach(id => elsewhere.add(id));
    }
    const byId = new Map(nextEmployees.map(e => [e.id, Object.assign({}, e)]));
    for (const rec of incoming) {
      const prev = byId.get(rec.id);
      const next = Object.assign({}, prev || {}, rec);
      if (!rec.pending) delete next.pending;
      byId.set(rec.id, next);
    }
    const ordered = [];
    const kept = new Set();
    for (const e of nextEmployees) {
      const drop = members.has(e.id) && !incomingIds.has(e.id) && !elsewhere.has(e.id);
      if (drop) { removedIds.push(e.id); continue; }
      if (!byId.has(e.id)) continue;
      ordered.push(byId.get(e.id));
      kept.add(e.id);
    }
    for (const rec of incoming) {
      if (!kept.has(rec.id) && byId.has(rec.id)) ordered.push(byId.get(rec.id));
    }
    nextEmployees = ordered;
    nextMemberIds = incoming.map(e => e.id);
    if (!nextEmployees.some(e => e.admin && !e.pending)) return { status: 400, body: { error: "last_admin" } };
  }

  const prevWeeks = store.state.weeks || {};
  const nextWeeks = Object.assign({}, prevWeeks);
  for (const [k, wk] of Object.entries(nextWeeks)) {
    if (weekBelongs(k, wk, channel, legacyHome)) delete nextWeeks[k];
  }
  for (const wk of Object.values(st.weeks || {})) {
    if (!wk || typeof wk !== "object") continue;
    if (!wk.channelId && channel.id !== legacyHome) wk.channelId = channel.id;
  }
  const events = home.attributePublishes(
    store.state.weeks,
    st.weeks,
    sess.emp,
    new Date().toISOString(),
    stored
  );
  const publishedRows = recordPublishEvents(events);
  for (const [k, wk] of Object.entries(st.weeks || {})) {
    if (!wk || typeof wk !== "object") continue;
    nextWeeks[k] = wk;
  }
  store.state.employees = nextEmployees;
  store.state.weeks = nextWeeks;
  store.state.settings = st.settings;
  live.memberIds = nextMemberIds;
  for (const id of removedIds) dropPersonId(store.state, id);
  const mailJobs = publishMailJobs(events, publishedRows, {
    id: live.id,
    memberIds: live.memberIds
  });
  store.version += 1;
  persistState();
  return { status: 200, body: { ok: true, version: store.version, employees: incoming }, mailJobs };
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
  const url = reqUrl.pathname;

  try {
    if (url === "/api/config" && (req.method === "GET" || req.method === "HEAD")) {
      return json(res, 200, {
        authMock: AUTH_MOCK,
        totpRequired: !AUTH_MOCK,
        emailRule: EMAIL_RULE
      });
    }

    if (url === "/api/auth/start" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const key = normalizeEmail(body.email);
      const reenroll = body.reenroll === true;
      if (!isRosterEmail(key)) return json(res, 400, { error: "invalid_email" });
      const emp = findEmployee(key);
      if (!emp) return json(res, 403, { error: "not_on_team" });
      if (AUTH_MOCK) {
        const token = crypto.randomBytes(32).toString("hex");
        auth.sessions[token] = { email: emp.email, ts: Date.now() };
        persistAuth();
        return json(res, 200, { mode: "mock", token, email: emp.email });
      }
      const existing = auth.users[key];
      if (existing && existing.confirmed && secretUsable(existing.secret) && !reenroll) {
        return json(res, 200, { mode: "code" });
      }
      return json(res, 200, issueEnrollment(key, emp.email, reenroll));
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
      dropSessionsFor(key);
      persistAuth();
      return json(res, 200, { ok: true });
    }

    /* Token is a POST field. The browser link uses /?invite= so the page
       can read it; this route does not. */
    if (url === "/api/invites/accept") {
      if (req.method !== "POST") { res.writeHead(405); return res.end(); }
      if (!allowInviteAccept(req)) return json(res, 429, { error: "rate_limited" });
      const body = JSON.parse(await readBody(req) || "{}");
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "bad_request" });
      const email = normalizeEmail(body.email);
      if (!isRosterEmail(email)) return json(res, 400, { error: "invalid_email" });
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token || token.length > 200) return json(res, 400, { error: "invalid_invite" });
      const inv = findInvite(token);
      if (!inv) return json(res, 400, { error: "invalid_invite" });
      if (inv.usedAt) return json(res, 409, { error: "already_used" });
      if (inv.revokedAt) return json(res, 400, { error: "revoked" });
      if (inviteExpired(inv)) return json(res, 400, { error: "expired" });
      const accepted = acceptInvite(inv, email);
      return json(res, accepted.status, accepted.body);
    }

    if (url === "/api/invites") {
      const sess = adminSession(req, res);
      if (!sess) return;
      if (req.method === "GET") return json(res, 200, { invites: listInvites() });
      if (req.method === "POST") {
        if (reqUrl.searchParams.has("channel") || reqUrl.searchParams.has("channelId")) {
          return json(res, 400, { error: "channel_not_supported" });
        }
        const body = JSON.parse(await readBody(req) || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "bad_request" });
        if (Object.prototype.hasOwnProperty.call(body, "channelId")) {
          return json(res, 400, { error: "channel_not_supported" });
        }
        const minted = mintInvite(sess, req);
        return json(res, minted.status, minted.body);
      }
      res.writeHead(405); return res.end();
    }

    const invitePath = url.match(/^\/api\/invites\/(inv_[a-f0-9]+)$/);
    if (invitePath) {
      if (req.method !== "DELETE") { res.writeHead(405); return res.end(); }
      const sess = adminSession(req, res);
      if (!sess) return;
      const revoked = revokeInvite(invitePath[1]);
      return json(res, revoked.status, revoked.body);
    }

    if (url === "/api/health") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "X-Auth-Mock": AUTH_MOCK ? "1" : "0"
      });
      return res.end("ok " + (db ? "db" : "json"));
    }

    /* STUB routes — same Bearer session as /api/state. See channelsPayload. */
    if (url === "/api/channels" && req.method === "GET") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      return json(res, 200, channelsPayload(sess.emp));
    }

    if (url === "/api/notifications" && req.method === "GET") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      const listed = notificationList(sess.emp, reqUrl.searchParams.get("channel"));
      return json(res, listed.status, listed.body);
    }

    if (url === "/api/notifications/read" && req.method === "POST") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      const body = JSON.parse(await readBody(req) || "{}");
      const all = body.all === true;
      const ids = Array.isArray(body.ids) ? body.ids : null;
      const marked = markNotificationsRead(sess.emp, ids, all);
      return json(res, marked.status, marked.body);
    }

    const oneRead = url.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (oneRead && req.method === "POST") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      const marked = markNotificationsRead(sess.emp, [decodeURIComponent(oneRead[1])], false);
      return json(res, marked.status, marked.body);
    }

    if (url === "/api/me/home" && req.method === "GET") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      const filter = homeChannelFilter(sess.emp, reqUrl.searchParams.get("channel"));
      if (filter.error) return json(res, filter.status, { error: filter.error });
      return json(res, 200, home.buildHome(store.state, sess.emp, homeClock(), { channelId: filter.channelId }));
    }

    /* Admin-only. One message to the signed-in admin's roster email.
       The address comes from the session, not the body. */
    if (url === "/api/mail/smoke" && req.method === "POST") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      if (!sess.emp.admin) return json(res, 403, { error: "admin_required" });
      await readBody(req);
      const missing = mail.missingConfig();
      if (missing) {
        console.log("[mail] smoke skipped; " + missing + " is unset");
        return json(res, 400, {
          ok: false,
          status: 400,
          name: "missing_config",
          message: missing + " is unset"
        });
      }
      let result;
      try {
        result = await mail.sendResendEmail({
          to: sess.emp.email,
          subject: "Shiftly test email",
          text: mail.withLink("This is a Shiftly test email to " + sess.emp.email + ".")
        });
      } catch (err) {
        const message = mail.redact(err && err.message ? err.message : "request failed");
        console.error("[mail] smoke failed:", message);
        return json(res, 502, { ok: false, status: 502, name: "network_error", message });
      }
      if (result.ok) return json(res, 200, { ok: true, id: result.id });
      const status = result.status >= 400 && result.status <= 599 ? result.status : 502;
      return json(res, status, {
        ok: false,
        status: result.status || status,
        name: result.name || "resend_error",
        message: result.message || "Resend rejected the message"
      });
    }

    if (url === "/api/state") {
      const sess = requireSession(req);
      if (!sess) return json(res, 401, { error: "auth_required" });
      healCanonicalAdmin();
      const channelParam = reqUrl.searchParams.get("channel");
      if (req.method === "GET") {
        const got = statePayload(sess, channelParam);
        return json(res, got.status, got.body);
      }
      if (req.method === "PUT") {
        const parsed = JSON.parse(await readBody(req) || "{}");
        const st = parsed.state;
        if (!st || !Array.isArray(st.employees) || !st.weeks || !st.settings) {
          return json(res, 400, { error: "invalid_state" });
        }
        const stored = storedChannels();
        let channel = null;
        if (stored.length) {
          if (!channelParam) return json(res, 400, { error: "channel_required" });
          channel = channelsFor(sess.emp).find(c => c.id === channelParam) || null;
          if (!channel) {
            const known = stored.some(c => c.id === channelParam);
            return json(res, known ? 403 : 404, { error: known ? "not_a_member" : "unknown_channel" });
          }
        } else if (channelParam && channelParam !== "ch_default") {
          return json(res, 404, { error: "unknown_channel" });
        }
        if (parsed.version !== store.version) {
          const cur = statePayload(sess, channelParam);
          return json(res, 409, cur.body);
        }
        const toggle = parseAdminToggle(parsed.adminToggle);
        if (toggle && toggle.error) {
          const body = { error: toggle.error };
          if (toggle.email) body.email = toggle.email;
          return json(res, 400, body);
        }
        const saved = channel ? putChannelState(sess, channel, st, toggle) : putFullState(sess, st, toggle);
        if (saved.status === 200 && saved.mailJobs && saved.mailJobs.length) {
          try {
            await mail.deliverJobs(saved.mailJobs, "schedule", persistState);
          } catch (err) {
            console.error("[mail] schedule send failed:", mail.redact(err && err.message ? err.message : err));
          }
        }
        return json(res, saved.status, saved.body);
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

/* ---------- availability reminders ----------
   Three slots in Asia/Jerusalem for the week that locks Monday 10:00:
   Sunday 09:00, Sunday 17:00, Monday 09:00. Caught up on boot when the
   free instance was asleep. The notification id is the in-app marker.
   emailAttemptedAt on that row is the email marker (one send per person,
   per slot, per week). REMINDER_NOW (ISO) freezes the clock for tests.
   REMINDER_DISABLE=1 skips the pass. */
function reminderClock() {
  if (process.env.REMINDER_NOW) {
    const frozen = new Date(process.env.REMINDER_NOW);
    if (!isNaN(frozen.getTime())) return frozen;
  }
  return new Date();
}
/* HOME_NOW (ISO) freezes GET /api/me/home for tests. Unset in production. */
function homeClock() {
  if (process.env.HOME_NOW) {
    const frozen = new Date(process.env.HOME_NOW);
    if (!isNaN(frozen.getTime())) return frozen;
  }
  return new Date();
}
function rosterRecipients(employees, memberIds) {
  const members = memberIds ? new Set(memberIds) : null;
  const seen = new Set();
  const out = [];
  for (const emp of employees || []) {
    if (!emp || !emp.id || emp.pending) continue;
    if (members && !members.has(emp.id)) continue;
    const email = normalizeEmail(emp.email);
    if (!isRosterEmail(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ emp, email });
  }
  return out;
}
/* One mail job per active member, all stamped on the single publish row. */
function publishMailJobs(events, rows, scope) {
  const jobs = [];
  const channels = storedChannels();
  for (let i = 0; i < (events || []).length; i++) {
    const ev = events[i];
    const row = rows && rows[i];
    if (!ev || !row || row.emailedAt || row.emailAttemptedAt) continue;
    if (scope && ev.channelId && ev.channelId !== scope.id) continue;
    let memberIds = scope ? scope.memberIds : null;
    if (!memberIds && ev.channelId && channels.length) {
      const ch = channels.find(c => c.id === ev.channelId);
      if (!ch) continue;
      memberIds = ch.memberIds;
    }
    for (const person of rosterRecipients(store.state.employees, memberIds)) {
      jobs.push({
        row,
        to: person.email,
        subject: String(row.title || "Schedule published"),
        text: mail.withLink(String(row.body || ""))
      });
    }
  }
  return jobs;
}
function reminderJobs(rows) {
  const jobs = [];
  for (const row of rows) {
    const empId = row.recipientIds && row.recipientIds[0];
    const emp = (store.state.employees || []).find(e => e && e.id === empId);
    if (!emp) continue;
    const to = normalizeEmail(emp.email);
    if (!to) continue;
    jobs.push({
      row,
      to,
      subject: String(row.title || "Availability reminder"),
      text: mail.withLink(String(row.body || ""))
    });
  }
  return jobs;
}
function weekDateKey(key) {
  const m = /(\d{4}-\d{2}-\d{2})$/.exec(String(key || ""));
  return m ? m[1] : null;
}
function weekStillPublished(row) {
  const channels = storedChannels();
  const legacy = channels.length ? legacyChannelId(channels) : null;
  for (const [key, wk] of Object.entries((store.state && store.state.weeks) || {})) {
    if (!wk || wk.published !== true) continue;
    if (weekDateKey(key) !== row.week) continue;
    let cid = typeof wk.channelId === "string" && wk.channelId ? wk.channelId : null;
    if (!cid) {
      const pipe = String(key).indexOf("|");
      if (pipe >= 0) cid = String(key).slice(0, pipe);
      else if (legacy && row.channelId) cid = legacy;
    }
    if ((cid || null) !== (row.channelId || null)) continue;
    return true;
  }
  return false;
}
/* A publish that could not send (key or From missing) is tried on the next
   reminder pass. emailAttemptedAt on that one row blocks a second copy. */
function pendingPublishJobs() {
  const jobs = [];
  for (const row of (store.state && store.state.notifications) || []) {
    if (!row || row.type !== "schedule_published") continue;
    if (row.emailedAt || row.emailAttemptedAt) continue;
    if (!weekStillPublished(row)) continue;
    const explicit = Array.isArray(row.recipientIds) && row.recipientIds.length ? row.recipientIds : null;
    let memberIds = null;
    if (row.channelId && storedChannels().length) {
      const ch = storedChannels().find(c => c.id === row.channelId);
      if (!ch) continue;
      memberIds = ch.memberIds;
    }
    for (const person of rosterRecipients(store.state.employees, memberIds)) {
      if (explicit && !explicit.includes(person.emp.id) && !explicit.includes(person.email)) continue;
      jobs.push({
        row,
        to: person.email,
        subject: String(row.title || "Schedule published"),
        text: mail.withLink(String(row.body || ""))
      });
    }
  }
  return jobs;
}
let reminderRunning = false;
async function runAvailabilityReminders(now) {
  if (reminderRunning || !store || !store.state) return;
  reminderRunning = true;
  try {
    const result = reminders.applyAvailabilityReminders(store.state, now, { isRosterEmail });
    if (result.created) {
      store.version = (store.version || 0) + 1;
      persistState();
      console.log("[reminder] in-app", result.created, "week", result.weekKey, result.slots.join(","));
    }
    const pending = reminders.pendingReminderEmails(store.state, result, isRosterEmail);
    await mail.deliverJobs(reminderJobs(pending), "reminder", persistState);
    await mail.deliverJobs(pendingPublishJobs(), "schedule", persistState);
  } catch (err) {
    console.error("[reminder] pass failed:", mail.redact(err && err.message ? err.message : err));
  } finally {
    reminderRunning = false;
  }
}
async function startAvailabilityReminders() {
  if (process.env.REMINDER_DISABLE === "1") {
    console.log("[reminder] disabled");
    return;
  }
  await runAvailabilityReminders(reminderClock());
  /* A frozen clock is a single catch-up. The live process checks once a minute
     while it is awake; a cold start covers the slots it slept through. */
  if (!process.env.REMINDER_NOW) {
    setInterval(() => {
      runAvailabilityReminders(new Date()).catch(err => {
        console.error("[reminder] pass failed:", mail.redact(err && err.message ? err.message : err));
      });
    }, 60000);
  }
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
    }
  } catch (e) {
    console.error("database unavailable, falling back to JSON files:", e.message);
    db = null;
    dbMode = false;
  }
  applyRosterMigration();
  applyAuthPolicy();
  await startAvailabilityReminders();
  const mailNote = mail.statusLine();
  server.listen(PORT, () => console.log("Shiftly server listening on :" + PORT +
    " | storage: " + (dbMode ? "PostgreSQL (json backup: " + DATA_DIR + ")" : "JSON files (" + DATA_DIR + ") — set DATABASE_URL for PostgreSQL") +
    " | auth: " + (AUTH_MOCK ? "MOCK (AUTH_MOCK=1, authenticator skipped)" : "TOTP") +
    " | reminders: " + reminders.REMINDER_TZ + " Sun 09:00, Sun 17:00, Mon 09:00" +
    " | " + mailNote));
})();
