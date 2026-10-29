/* Auth checks for the allowlist and real TOTP. No test framework.
   Run: node test/auth.js
   Spawns server.js against a temp data dir. Does not touch the repo's data files. */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SEED = [
  ["lotan.hadad@cybereason.com", false],
  ["avital.lioubchits@cybereason.com", false],
  ["gal.mamon@cybereason.com", false],
  ["matan.razon@cybereason.com", false],
  ["alon.shpilberg@cybereason.com", false],
  ["bar.belisha@cybereason.com", false],
  ["dana.balas@cybereason.com", false],
  ["dana.bardin@cybereason.com", false],
  ["ori.hai@cybereason.com", false],
  ["nir.itzik@cybereason.com", true],
  ["alex.rivlis@cybereason.com", false],
  ["shoshana.avni@cybereason.com", false],
  ["ben.shalev@cybereason.com", false],
  ["shahar.eldar@cybereason.com", false]
];

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
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
function totp(secret) {
  return hotp(secret, Math.floor(Date.now() / 30000));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitAwayFromTotpEdge() {
  const mod = Date.now() % 30000;
  if (mod > 26000) await sleep(30000 - mod + 400);
  else if (mod < 400) await sleep(500);
}

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok", msg); return; }
  failed++;
  console.error("  FAIL", msg);
}

function req(port, method, urlPath, { body, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (data) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = data.length;
    }
    if (token) h.Authorization = "Bearer " + token;
    const r = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers: h }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function startServer(port, dataDir, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port),
        SHIFTLY_DATA_DIR: dataDir,
        DATABASE_URL: "",
        AUTH_MOCK: "",
        SMTP_USER: "",
        SMTP_PASS: ""
      }, extraEnv || {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not listen\n" + log));
    }, 8000);
    function onData(buf) {
      log += buf.toString();
      if (log.includes("listening on")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(child);
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", code => {
      if (!log.includes("listening on")) {
        clearTimeout(timer);
        reject(new Error("server exited " + code + "\n" + log));
      }
    });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve();
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000);
  });
}

function fixtureState() {
  return {
    version: 4,
    state: {
      settings: {
        company: "Cybereason",
        shifts: [{ id: "morning", name: "Morning", start: "07:00", end: "15:00" }],
        required: { morning: 1 }
      },
      employees: [
        { id: "gmail", name: "Nirit", email: "niritzik23@gmail.com", admin: true, position: "Manager" },
        { id: "nir1", name: "nir123", email: "nir.itzik@cybereason.com", admin: false, position: "Shift worker" },
        { id: "nir2", name: "nir cyber", email: "Nir.Itzik@cybereason.com", admin: false, position: "Shift worker" },
        { id: "bad", name: "Nope", email: "fed@gmail.com", admin: false, position: "Shift worker" },
        { id: "ron", name: "Ron Itzik", email: "ron.itzik@cybereason.com", admin: false, pending: true, position: "Shift worker" },
        { id: "short", name: "nir short", email: "nir.itzik@cybereason", admin: false }
      ],
      weeks: {
        "2026-08-30": {
          locked: false,
          published: false,
          assignments: { "0.morning": ["gmail", "nir1", "nir2", "bad", "e3"] },
          submissions: {
            nir2: { cells: { "0.morning": "yes" }, note: "from duplicate", submittedAt: "2026-08-28T00:00:00Z" },
            gmail: { cells: {}, note: "", submittedAt: "2026-08-01T00:00:00Z" }
          }
        }
      }
    }
  };
}

async function enroll(port, email) {
  const start = await req(port, "POST", "/api/auth/start", { body: { email } });
  assert(start.status === 200 && start.json && start.json.mode === "enroll" && start.json.secret, "enroll " + email);
  const code = totp(start.json.secret);
  const verify = await req(port, "POST", "/api/auth/verify", { body: { email, code } });
  assert(verify.status === 200 && verify.json && verify.json.token, "verify " + email);
  return { secret: start.json.secret, token: verify.json.token, email: verify.json.email };
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const m = html.match(/<script id="state" type="application\/json">([\s\S]*?)<\/script>/);
  const embedded = JSON.parse(m[1]);
  assert(Array.isArray(embedded.notifications) && embedded.notifications.length === 0, "seed notifications[]");
  assert(Array.isArray(embedded.channels) && embedded.channels.length === 0, "seed channels[]");
  assert(embedded.employees.length === 14, "seed has 14 employees");
  SEED.forEach(([email, admin]) => {
    const emp = embedded.employees.find(e => e.email === email);
    assert(emp && emp.admin === admin, "seed " + email + " admin=" + admin);
  });
  assert(!html.includes("niritzik23@gmail.com"), "seed html has no legacy gmail admin");
  assert(/const banner = \(localOnly && !runtime && !serverMode\)/.test(html), "preview banner only when storage is local-only");
  assert(!html.includes("Request access"), "sign-in has no request-access step");
  assert(!html.includes("registerWorker"), "open self-register helper is gone");
  assert(html.includes("adminToggle"), "team role changes are sent separately from the roster");
  assert(html.includes("canonical_admin"), "client explains that Nir stays admin");
  assert(html.includes("self_demotion"), "client explains that you cannot drop your own admin flag");
  assert(html.includes("Enter a setup key"), "enroll tells people to type the key in Google Authenticator");
  assert(html.includes("Copy setup key"), "enroll shows a copy button for the setup key");
  assert(html.includes("Time based"), "enroll says the key is time based");
  assert(html.includes("Set up Google Authenticator again"), "a confirmed user can start setup again");
  assert(!html.includes("Tap to add directly"), "enroll has no otpauth tap-to-add link");
  assert(!html.includes('href="' + "otpauth:"), "page does not link an otpauth URL");
  assert(hotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", Math.floor(59 / 30)) === "287082", "rfc6238 sha1 6-digit vector");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-auth-"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(fixtureState()));
  const port = 38771;
  console.log("real TOTP on", port);
  let server = await startServer(port, dir);
  let nirToken = null;
  try {
    const health = await req(port, "GET", "/api/health");
    assert(health.status === 200 && health.text.startsWith("ok "), "health stays ok (" + health.text + ")");
    assert(health.headers["x-auth-mock"] === "0", "health X-Auth-Mock is 0");

    const config = await req(port, "GET", "/api/config");
    assert(config.status === 200 && config.json.authMock === false && config.json.totpRequired === true, "config says TOTP is required");
    assert(config.json.emailRule === "firstname.lastname@cybereason.com", "config email rule");

    const bad = await req(port, "POST", "/api/auth/start", { body: { email: "niritzik23@gmail.com" } });
    assert(bad.status === 400 && bad.json.error === "invalid_email", "gmail rejected");
    const reenrollGmail = await req(port, "POST", "/api/auth/start", { body: { email: "niritzik23@gmail.com", reenroll: true } });
    assert(reenrollGmail.status === 400 && reenrollGmail.json.error === "invalid_email", "reenroll does not bypass the email rule");
    const reenrollStranger = await req(port, "POST", "/api/auth/start", { body: { email: "someone.else@cybereason.com", reenroll: true } });
    assert(reenrollStranger.status === 403 && reenrollStranger.json.error === "not_on_team", "reenroll does not bypass the allowlist");
    const weird = await req(port, "POST", "/api/auth/start", { body: { email: "first.last.extra@cybereason.com" } });
    assert(weird.status === 400 && weird.json.error === "invalid_email", "extra dot rejected");
    const missing = await req(port, "POST", "/api/auth/start", { body: { email: "someone.else@cybereason.com" } });
    assert(missing.status === 403 && missing.json.error === "not_on_team", "unknown cybereason email rejected");
    const pending = await req(port, "POST", "/api/auth/start", { body: { email: "ron.itzik@cybereason.com" } });
    assert(pending.status === 403 && pending.json.error === "not_on_team", "pending roster row cannot sign in");

    const join = await req(port, "POST", "/api/auth/request", { body: { name: "A B", email: "a.b@cybereason.com" } });
    assert(join.status === 403 && join.json.error === "join_closed", "self-request closed");

    const nir = await enroll(port, "Nir.Itzik@Cybereason.com");
    nirToken = nir.token;
    assert(nir.email === "nir.itzik@cybereason.com", "session email is canonical");

    const upper = await req(port, "POST", "/api/auth/start", { body: { email: "  Lotan.Hadad@Cybereason.com " } });
    assert(upper.status === 200 && upper.json.mode === "enroll", "uppercase cybereason email can enroll");

    const state = await req(port, "GET", "/api/state", { token: nir.token });
    assert(state.status === 200, "admin session can read state");
    const emps = state.json.state.employees;
    assert(Array.isArray(state.json.state.notifications) && Array.isArray(state.json.state.channels), "reserved arrays present");
    SEED.forEach(([email, admin]) => {
      const emp = emps.find(e => e.email === email);
      assert(emp && emp.admin === admin && emp.name.indexOf("@") < 0, "roster " + email);
    });
    const nirs = emps.filter(e => e.email === "nir.itzik@cybereason.com");
    assert(nirs.length === 1 && nirs[0].id === "nir1" && nirs[0].name === "Nir Itzik", "duplicate nir rows collapsed, admin kept");
    assert(!emps.some(e => /gmail|example\.com|levelblue/.test(e.email)), "non-matching emails removed");
    const ron = emps.find(e => e.email === "ron.itzik@cybereason.com");
    assert(ron && ron.pending === true, "other valid roster member kept");
    const week = state.json.state.weeks["2026-08-30"];
    assert(JSON.stringify(week.assignments["0.morning"]) === JSON.stringify(["nir1"]), "shift refs point at the kept nir id");
    assert(week.submissions.nir1 && week.submissions.nir1.note === "from duplicate", "duplicate submission moved onto the kept id");
    assert(!week.submissions.gmail && !week.submissions.nir2, "dropped people lose submissions");

    const lotanStart = await req(port, "POST", "/api/auth/start", { body: { email: "lotan.hadad@cybereason.com" } });
    let wrong = "000000";
    if (lotanStart.json && wrong === totp(lotanStart.json.secret)) wrong = "000001";
    const badCode = await req(port, "POST", "/api/auth/verify", { body: { email: "lotan.hadad@cybereason.com", code: wrong } });
    assert(badCode.status === 401 && badCode.json.error === "bad_code", "wrong code rejected");
    const lotan = await req(port, "POST", "/api/auth/verify", {
      body: { email: "lotan.hadad@cybereason.com", code: totp(lotanStart.json.secret) }
    });
    assert(lotan.status === 200 && lotan.json.token, "good code after a bad one still works");

    const unauthReset = await req(port, "POST", "/api/auth/reset", { body: { email: "lotan.hadad@cybereason.com" } });
    assert(unauthReset.status === 403 && unauthReset.json.error === "admin_required", "reset requires an admin");
    const reset = await req(port, "POST", "/api/auth/reset", { token: nir.token, body: { email: "lotan.hadad@cybereason.com" } });
    assert(reset.status === 200 && reset.json.ok === true, "admin can reset TOTP");
    const afterReset = await req(port, "POST", "/api/auth/verify", {
      body: { email: "lotan.hadad@cybereason.com", code: totp(lotanStart.json.secret) }
    });
    assert(afterReset.status === 400 && afterReset.json.error === "no_enrollment", "old authenticator stops working");
    const again = await req(port, "POST", "/api/auth/start", { body: { email: "lotan.hadad@cybereason.com" } });
    assert(again.status === 200 && again.json.mode === "enroll" && again.json.secret !== lotanStart.json.secret, "reset starts a new enrollment");
    const lotan2 = await req(port, "POST", "/api/auth/verify", {
      body: { email: "lotan.hadad@cybereason.com", code: totp(again.json.secret) }
    });
    assert(lotan2.status === 200, "new authenticator signs in");

    const shoshanaEmail = "shoshana.avni@cybereason.com";
    const first = await req(port, "POST", "/api/auth/start", { body: { email: shoshanaEmail } });
    const second = await req(port, "POST", "/api/auth/start", { body: { email: "  Shoshana.Avni@Cybereason.com " } });
    assert(first.status === 200 && second.status === 200 && first.json.secret === second.json.secret, "unconfirmed setup keeps the same key");
    assert(second.json.email === shoshanaEmail, "enroll returns the canonical email");
    const uri = second.json.otpauth || "";
    assert(uri === "otpauth://totp/Shiftly:" + encodeURIComponent(shoshanaEmail) + "?secret=" + second.json.secret + "&issuer=Shiftly&algorithm=SHA1&digits=6&period=30", "otpauth uses a literal colon and sha1/6/30");
    assert(!uri.includes("Shiftly%3A"), "issuer colon is not percent-encoded");
    const replaced = await req(port, "POST", "/api/auth/start", { body: { email: shoshanaEmail, reenroll: true } });
    assert(replaced.status === 200 && replaced.json.mode === "enroll" && replaced.json.secret !== first.json.secret && !replaced.json.token, "new setup key does not sign the user in");
    await waitAwayFromTotpEdge();
    const step = Math.floor(Date.now() / 30000);
    let far = hotp(replaced.json.secret, step - 3);
    if (far === totp(replaced.json.secret)) far = "000000";
    const tooOld = await req(port, "POST", "/api/auth/verify", { body: { email: shoshanaEmail, code: far } });
    assert(tooOld.status === 401 && tooOld.json.error === "bad_code", "a code three steps old is rejected");
    const drifted = await req(port, "POST", "/api/auth/verify", { body: { email: shoshanaEmail, code: hotp(replaced.json.secret, step - 2) } });
    assert(drifted.status === 200 && drifted.json.token, "a code two steps old still matches");
    const back = await req(port, "POST", "/api/auth/start", { body: { email: shoshanaEmail } });
    assert(back.status === 200 && back.json.mode === "code", "confirmed authenticator asks for a code");
    const againKey = await req(port, "POST", "/api/auth/start", { body: { email: shoshanaEmail, reenroll: true } });
    assert(againKey.status === 200 && againKey.json.mode === "enroll" && againKey.json.secret !== replaced.json.secret && !againKey.json.token, "confirmed user can set up again without a session");
    const oldSession = await req(port, "GET", "/api/state", { token: drifted.json.token });
    assert(oldSession.status === 401, "setting up again ends the previous session");
    const stale = await req(port, "POST", "/api/auth/verify", { body: { email: shoshanaEmail, code: totp(replaced.json.secret) } });
    assert(stale.status === 401 && stale.json.error === "bad_code", "the previous authenticator stops matching");
    const spaced = totp(againKey.json.secret);
    const fresh = await req(port, "POST", "/api/auth/verify", {
      body: { email: shoshanaEmail, code: spaced.slice(0, 3) + " " + spaced.slice(3) }
    });
    assert(fresh.status === 200 && fresh.json.token, "spaced code from the new key signs in");

    const joinAsAdmin = await req(port, "POST", "/api/auth/approve", {
      token: nir.token, body: { email: "someone.else@cybereason.com" }
    });
    assert(joinAsAdmin.status === 403 && joinAsAdmin.json.error === "join_closed", "approve route cannot add people");

    let cur = await req(port, "GET", "/api/state", { token: lotan2.json.token });
    const workerState = JSON.parse(JSON.stringify(cur.json.state));
    workerState.settings.company = "Cybereason IL";
    const workerSave = await req(port, "PUT", "/api/state", {
      token: lotan2.json.token,
      body: { version: cur.json.version, state: workerState }
    });
    assert(workerSave.status === 200, "worker can save a non-roster change");
    workerState.employees.push({
      id: "e_extra", name: "Extra Person", email: "extra.person@cybereason.com", admin: false, position: "Shift worker"
    });
    const workerAdd = await req(port, "PUT", "/api/state", {
      token: lotan2.json.token,
      body: { version: workerSave.json.version, state: workerState }
    });
    assert(workerAdd.status === 403 && workerAdd.json.error === "admin_required", "worker cannot change the allowlist");

    cur = await req(port, "GET", "/api/state", { token: nir.token });
    const adminState = JSON.parse(JSON.stringify(cur.json.state));
    adminState.employees.push({
      id: "e_bad", name: "Bad", email: "not-an-email", admin: false, position: "Shift worker"
    });
    const badSave = await req(port, "PUT", "/api/state", {
      token: nir.token, body: { version: cur.json.version, state: adminState }
    });
    assert(badSave.status === 400 && badSave.json.error === "invalid_email", "admin cannot add a non-matching email");

    const staleRoster = JSON.parse(JSON.stringify(cur.json.state));
    staleRoster.employees.forEach(e => { e.admin = false; });
    staleRoster.settings.company = "Cybereason IL";
    const staleSave = await req(port, "PUT", "/api/state", {
      token: nir.token, body: { version: cur.json.version, state: staleRoster }
    });
    assert(staleSave.status === 200, "stale roster save still stores the other edits");
    assert(staleSave.json.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "save response keeps nir admin");
    let now = await req(port, "GET", "/api/state", { token: nir.token });
    assert(now.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "stale PUT cannot demote nir");
    assert(now.json.state.employees.find(e => e.email === "shahar.eldar@cybereason.com").admin === false, "stale PUT cannot promote someone else");
    assert(now.json.state.settings.company === "Cybereason IL", "non-roster edits from that save are kept");

    const stripped = JSON.parse(JSON.stringify(now.json.state));
    stripped.employees = stripped.employees.filter(e => e.email !== "nir.itzik@cybereason.com" && !e.admin);
    const last = await req(port, "PUT", "/api/state", {
      token: nir.token, body: { version: now.json.version, state: stripped }
    });
    assert(last.status === 400 && last.json.error === "last_admin", "cannot remove the last admin");
    now = await req(port, "GET", "/api/state", { token: nir.token });
    assert(now.json.state.employees.some(e => e.email === "nir.itzik@cybereason.com" && e.admin), "rejected save leaves nir in place");

    const workerStale = JSON.parse(JSON.stringify(now.json.state));
    workerStale.employees.find(e => e.email === "lotan.hadad@cybereason.com").admin = true;
    workerStale.employees.find(e => e.email === "nir.itzik@cybereason.com").admin = false;
    const workerFlags = await req(port, "PUT", "/api/state", {
      token: lotan2.json.token, body: { version: now.json.version, state: workerStale }
    });
    assert(workerFlags.status === 200, "worker save with stale admin bits is not treated as a roster edit");
    now = await req(port, "GET", "/api/state", { token: nir.token });
    assert(now.json.state.employees.find(e => e.email === "lotan.hadad@cybereason.com").admin === false, "worker cannot promote himself by saving state");
    assert(now.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "worker cannot demote nir by saving state");

    const workerToggle = await req(port, "PUT", "/api/state", {
      token: lotan2.json.token,
      body: {
        version: now.json.version,
        state: now.json.state,
        adminToggle: { email: "lotan.hadad@cybereason.com", admin: true }
      }
    });
    assert(workerToggle.status === 403 && workerToggle.json.error === "admin_required", "worker cannot use the team toggle");

    const promote = await req(port, "PUT", "/api/state", {
      token: nir.token,
      body: {
        version: now.json.version,
        state: JSON.parse(JSON.stringify(now.json.state)),
        adminToggle: { email: "shahar.eldar@cybereason.com", admin: true }
      }
    });
    assert(promote.status === 200, "team toggle can promote someone else");
    now = await req(port, "GET", "/api/state", { token: nir.token });
    assert(now.json.state.employees.find(e => e.email === "shahar.eldar@cybereason.com").admin === true, "shahar is admin after the toggle");
    assert(now.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "promoting someone else leaves nir admin");

    const shahar = await enroll(port, "shahar.eldar@cybereason.com");
    const selfOff = await req(port, "PUT", "/api/state", {
      token: shahar.token,
      body: {
        version: now.json.version,
        state: JSON.parse(JSON.stringify(now.json.state)),
        adminToggle: { email: "shahar.eldar@cybereason.com", admin: false }
      }
    });
    assert(selfOff.status === 400 && selfOff.json.error === "self_demotion", "session user cannot demote himself");
    const nirOff = await req(port, "PUT", "/api/state", {
      token: shahar.token,
      body: {
        version: now.json.version,
        state: JSON.parse(JSON.stringify(now.json.state)),
        adminToggle: { email: "nir.itzik@cybereason.com", admin: false }
      }
    });
    assert(nirOff.status === 400 && nirOff.json.error === "canonical_admin", "team toggle cannot demote nir");
    now = await req(port, "GET", "/api/state", { token: shahar.token });
    assert(now.json.state.employees.find(e => e.email === "shahar.eldar@cybereason.com").admin === true, "rejected toggles leave the session user admin");
    assert(now.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "rejected toggles leave nir admin");

    const bothOff = JSON.parse(JSON.stringify(now.json.state));
    bothOff.employees.forEach(e => {
      if (e.email === "nir.itzik@cybereason.com" || e.email === "shahar.eldar@cybereason.com") e.admin = false;
    });
    const sessionStale = await req(port, "PUT", "/api/state", {
      token: shahar.token, body: { version: now.json.version, state: bothOff }
    });
    assert(sessionStale.status === 200, "admin can save while their copy has admin:false");
    now = await req(port, "GET", "/api/state", { token: shahar.token });
    assert(now.json.state.employees.find(e => e.email === "shahar.eldar@cybereason.com").admin === true, "stale PUT cannot demote the session user");
    assert(now.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "that save cannot demote nir either");

    const demote = await req(port, "PUT", "/api/state", {
      token: nir.token,
      body: {
        version: now.json.version,
        state: JSON.parse(JSON.stringify(now.json.state)),
        adminToggle: { email: "Shahar.Eldar@cybereason.com", admin: false }
      }
    });
    assert(demote.status === 200, "another admin can demote shahar on purpose");
    now = await req(port, "GET", "/api/state", { token: nir.token });
    assert(now.json.state.employees.find(e => e.email === "shahar.eldar@cybereason.com").admin === false, "intentional toggle demoted shahar");
    assert(now.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "nir still admin after that toggle");

    const nirSelf = await req(port, "PUT", "/api/state", {
      token: nir.token,
      body: {
        version: now.json.version,
        state: JSON.parse(JSON.stringify(now.json.state)),
        adminToggle: { email: "nir.itzik@cybereason.com", admin: false }
      }
    });
    assert(nirSelf.status === 400 && nirSelf.json.error === "canonical_admin", "nir cannot demote himself");
    cur = await req(port, "GET", "/api/state", { token: nir.token });
    assert(cur.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "nir is still admin after the rejected self-toggle");

    const dup = JSON.parse(JSON.stringify(cur.json.state));
    dup.employees.push(Object.assign({}, dup.employees[0], { id: "e_dup" }));
    const dupSave = await req(port, "PUT", "/api/state", {
      token: nir.token, body: { version: cur.json.version, state: dup }
    });
    assert(dupSave.status === 400 && dupSave.json.error === "duplicate_email", "duplicate emails rejected");

    const removed = JSON.parse(JSON.stringify(cur.json.state));
    removed.employees = removed.employees.filter(e => e.email !== "lotan.hadad@cybereason.com" && e.email !== "ron.itzik@cybereason.com");
    const removeSave = await req(port, "PUT", "/api/state", {
      token: nir.token, body: { version: cur.json.version, state: removed }
    });
    assert(removeSave.status === 200, "admin can remove people");
  } finally {
    await stopServer(server);
  }

  console.log("second boot keeps admin edits and sessions");
  server = await startServer(port, dir);
  try {
    const still = await req(port, "GET", "/api/state", { token: nirToken });
    assert(still.status === 200, "session survives restart");
    const emails = still.json.state.employees.map(e => e.email);
    assert(!emails.includes("lotan.hadad@cybereason.com"), "removed seed person is not re-added");
    assert(!emails.includes("ron.itzik@cybereason.com"), "removed extra person stays removed");
    assert(emails.includes("nir.itzik@cybereason.com"), "nir still on the roster");
    assert(still.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "nir still admin");
    assert(still.json.rosterVersion === 1, "roster migration does not run again");
  } finally {
    await stopServer(server);
  }

  console.log("already-migrated store restores nir and ignores a stale demotion");
  const healedDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-heal-"));
  const healedPort = 38773;
  const healed = fixtureState();
  healed.rosterVersion = 1;
  healed.version = 4;
  healed.state.employees = [
    { id: "nir1", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: false, position: "Manager" },
    { id: "sha", name: "Shahar Eldar", email: "shahar.eldar@cybereason.com", admin: true, position: "Shift worker" },
    { id: "lot", name: "Lotan Hadad", email: "lotan.hadad@cybereason.com", admin: false, position: "Shift worker" }
  ];
  fs.writeFileSync(path.join(healedDir, "state.json"), JSON.stringify(healed));
  server = await startServer(healedPort, healedDir);
  try {
    const nirH = await enroll(healedPort, "nir.itzik@cybereason.com");
    const got = await req(healedPort, "GET", "/api/state", { token: nirH.token });
    assert(got.status === 200, "healed store is readable");
    assert(got.json.rosterVersion === 1, "healing does not re-run roster migration");
    assert(!got.json.state.employees.some(e => e.email === "alex.rivlis@cybereason.com"), "healing does not re-add people");
    assert(got.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "boot restores nir after a stored demotion");
    assert(got.json.state.employees.find(e => e.email === "shahar.eldar@cybereason.com").admin === true, "boot leaves other admins alone");
    assert(got.json.version === 5, "restoring nir bumps the version so open tabs refresh");
    const again = JSON.parse(JSON.stringify(got.json.state));
    again.employees.forEach(e => { e.admin = false; });
    const put = await req(healedPort, "PUT", "/api/state", {
      token: nirH.token, body: { version: got.json.version, state: again }
    });
    assert(put.status === 200, "stale demotion of a healed store still saves");
    const after = await req(healedPort, "GET", "/api/state", { token: nirH.token });
    assert(after.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "PUT cannot demote restored nir");
    assert(after.json.state.employees.find(e => e.email === "shahar.eldar@cybereason.com").admin === true, "PUT cannot demote the other admin with a stale roster");
    const onDisk = JSON.parse(fs.readFileSync(path.join(healedDir, "state.json"), "utf8"));
    assert(onDisk.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "persisted file keeps nir admin");
  } finally {
    await stopServer(server);
  }

  const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mock-"));
  const mockPort = 38772;
  console.log("AUTH_MOCK on", mockPort);
  server = await startServer(mockPort, mockDir, { AUTH_MOCK: "1" });
  try {
    const config = await req(mockPort, "GET", "/api/config");
    assert(config.json.authMock === true && config.json.totpRequired === false, "config reports AUTH_MOCK");
    const health = await req(mockPort, "GET", "/api/health");
    assert(health.headers["x-auth-mock"] === "1" && health.text.startsWith("ok "), "health reports mock");
    const no = await req(mockPort, "POST", "/api/auth/start", { body: { email: "nope@gmail.com" } });
    assert(no.status === 400 && no.json.error === "invalid_email", "mock mode still rejects bad emails");
    const start = await req(mockPort, "POST", "/api/auth/start", { body: { email: "nir.itzik@cybereason.com" } });
    assert(start.status === 200 && start.json.mode === "mock" && start.json.token, "mock mode issues a session without a code");
    const state = await req(mockPort, "GET", "/api/state", { token: start.json.token });
    assert(state.status === 200 && state.json.state.employees.length === 14, "fresh mock boot seeds the 14");
    assert(state.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "fresh seed nir is admin");
  } finally {
    await stopServer(server);
  }

  if (failed) {
    console.error("\n" + failed + " failed");
    process.exit(1);
  }
  console.log("\nall auth checks passed");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
