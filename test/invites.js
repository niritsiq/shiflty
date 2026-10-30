/* Invite-link checks. No test framework.
   Run: node test/invites.js
   Spawns server.js against temp data dirs. Does not touch the repo's data files. */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIST_KEYS = ["createdAt", "createdBy", "expiresAt", "id", "revokedAt", "status", "usedAt", "usedBy"];

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
    const env = Object.assign({}, process.env, {
      PORT: String(port),
      SHIFTLY_DATA_DIR: dataDir,
      DATABASE_URL: "",
      AUTH_MOCK: "1",
      SMTP_USER: "",
      SMTP_PASS: "",
      REMINDER_DISABLE: "1"
    }, extraEnv || {});
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "RESEND_API_KEY")) delete env.RESEND_API_KEY;
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "RESEND_FROM")) delete env.RESEND_FROM;
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "APP_URL")) delete env.APP_URL;
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "INVITE_NOW")) delete env.INVITE_NOW;
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "INVITE_TTL_HOURS")) delete env.INVITE_TTL_HOURS;
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env,
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

async function signIn(port, email) {
  const start = await req(port, "POST", "/api/auth/start", { body: { email } });
  assert(start.status === 200 && start.json && start.json.mode === "mock" && start.json.token, "mock sign-in " + email);
  return start.json && start.json.token;
}

function tokenFrom(mint) {
  const url = new URL(mint.json.url);
  return { url, token: url.searchParams.get("invite") };
}

function listKeysOk(row) {
  return JSON.stringify(Object.keys(row).sort()) === JSON.stringify(LIST_KEYS);
}

function readAuth(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
}

function onRoster(stateRes, email) {
  const emps = stateRes.json && stateRes.json.state && stateRes.json.state.employees || [];
  return emps.find(e => e && e.email === email) || null;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-invite-"));
  const port = 39521;
  console.log("invites on", port);
  let server = await startServer(port, dir);
  let nir;
  let lotan;
  let happy;
  let spareToken;
  let spareId;
  try {
    const anonMint = await req(port, "POST", "/api/invites", { body: {} });
    assert(anonMint.status === 401 && anonMint.json.error === "auth_required", "mint requires a session");
    const anonList = await req(port, "GET", "/api/invites");
    assert(anonList.status === 401 && anonList.json.error === "auth_required", "list requires a session");

    nir = await signIn(port, "nir.itzik@cybereason.com");
    lotan = await signIn(port, "lotan.hadad@cybereason.com");

    const workerMint = await req(port, "POST", "/api/invites", { token: lotan, body: {} });
    assert(workerMint.status === 403 && workerMint.json.error === "admin_required", "non-admin cannot mint");
    const workerList = await req(port, "GET", "/api/invites", { token: lotan });
    assert(workerList.status === 403 && workerList.json.error === "admin_required", "non-admin cannot list");
    const workerDel = await req(port, "DELETE", "/api/invites/inv_abc", { token: lotan });
    assert(workerDel.status === 403 && workerDel.json.error === "admin_required", "non-admin cannot revoke");

    const withChannel = await req(port, "POST", "/api/invites", {
      token: nir,
      body: { channelId: "ch_other" }
    });
    assert(withChannel.status === 400 && withChannel.json.error === "channel_not_supported", "mint rejects channelId");
    const withQuery = await req(port, "POST", "/api/invites?channel=ch_other", { token: nir, body: {} });
    assert(withQuery.status === 400 && withQuery.json.error === "channel_not_supported", "mint rejects ?channel=");
    const method = await req(port, "PUT", "/api/invites", { token: nir, body: {} });
    assert(method.status === 405, "PUT /api/invites is not a mint");

    const empty = await req(port, "GET", "/api/invites", { token: nir });
    assert(empty.status === 200 && Array.isArray(empty.json.invites) && empty.json.invites.length === 0, "no invites yet");

    const minted = await req(port, "POST", "/api/invites", { token: nir, body: {} });
    assert(minted.status === 200, "admin can mint");
    assert(JSON.stringify(Object.keys(minted.json).sort()) === JSON.stringify(["expiresAt", "id", "url"]), "mint fields are id, url, expiresAt");
    assert(/^inv_[a-f0-9]+$/.test(minted.json.id), "mint id shape");
    happy = tokenFrom(minted);
    assert(happy.url.pathname === "/", "invite link is the app root");
    assert(happy.url.search === "?invite=" + encodeURIComponent(happy.token), "token is the invite query param");
    assert(!minted.json.url.includes("/invite/"), "token is not a path segment");
    assert(happy.url.origin === "http://127.0.0.1:" + port, "unset APP_URL uses the request host");
    const ttl = Date.parse(minted.json.expiresAt) - Date.now();
    assert(Math.abs(ttl - 48 * 3600 * 1000) < 5000, "default ttl is 48h");

    const forwarded = await req(port, "POST", "/api/invites", {
      token: nir,
      body: {},
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "shiflty.onrender.com" }
    });
    assert(forwarded.status === 200 && forwarded.json.url, "forwarded-host mint");
    const fwd = tokenFrom(forwarded);
    spareToken = fwd.token;
    spareId = forwarded.json.id;
    assert(fwd.url.origin === "https://shiflty.onrender.com" && fwd.url.pathname === "/", "forwarded host is the link origin when APP_URL is unset");

    const listed = await req(port, "GET", "/api/invites", { token: nir });
    assert(listed.status === 200 && listed.json.invites.length === 2, "list has both links");
    assert(listed.json.invites.every(listKeysOk), "list fields stay fixed");
    assert(listed.json.invites[0].createdAt >= listed.json.invites[1].createdAt, "newest invite first");
    const row = listed.json.invites.find(i => i.id === minted.json.id);
    assert(row && row.status === "pending" && row.createdBy === "nir.itzik@cybereason.com", "pending row names the admin");
    assert(row.usedAt === null && row.usedBy === null && row.revokedAt === null, "unused row has empty use and revoke times");
    const listText = JSON.stringify(listed.json);
    assert(!listText.includes(happy.token) && !listText.includes("tokenHash"), "list has no token and no hash");

    const stored = readAuth(dir);
    const rec = stored.invites[minted.json.id];
    assert(rec && rec.tokenHash === crypto.createHash("sha256").update(happy.token).digest("hex"), "sha256 at rest");
    assert(rec.channelId === null, "implicit team invite does not store a channel");
    assert(!JSON.stringify(stored).includes(happy.token), "raw token is not in auth.json");

    const badEmails = [
      "niritzik23@gmail.com",
      "first.last.extra@cybereason.com",
      "maya.levi+tag@cybereason.com",
      "maya@cybereason.com"
    ];
    for (const email of badEmails) {
      const bad = await req(port, "POST", "/api/invites/accept", { body: { token: happy.token, email } });
      assert(bad.status === 400 && bad.json.error === "invalid_email", "bad domain rejected: " + email);
    }
    const still = await req(port, "GET", "/api/invites", { token: nir });
    assert(still.json.invites.find(i => i.id === minted.json.id).status === "pending", "bad domain does not consume the link");

    const join = await req(port, "POST", "/api/auth/approve", { token: nir, body: { email: "someone.else@cybereason.com" } });
    assert(join.status === 403 && join.json.error === "join_closed", "approve route stays closed");
  } finally {
    await stopServer(server);
  }

  console.log("restart keeps the hash and still accepts");
  server = await startServer(port, dir);
  try {
    const listed = await req(port, "GET", "/api/invites", { token: nir });
    assert(listed.status === 200 && listed.json.invites.some(i => i.id && i.status === "pending"), "invites survive restart");
    const again = readAuth(dir).invites;
    const rec = Object.values(again).find(i => i && i.tokenHash === crypto.createHash("sha256").update(happy.token).digest("hex"));
    assert(rec && !rec.usedAt, "hash still matches after restart");

    const queryOnly = await req(port, "POST", "/api/invites/accept?invite=" + encodeURIComponent(happy.token), {
      body: { email: "maya.levi@cybereason.com" }
    });
    assert(queryOnly.status === 400 && queryOnly.json.error === "invalid_invite", "accept ignores a token in the query string");

    const taken = await req(port, "POST", "/api/invites/accept", {
      body: { token: happy.token, email: "Nir.Itzik@cybereason.com" }
    });
    assert(taken.status === 409 && taken.json.error === "already_on_team", "active member does not consume the link");

    const accepted = await req(port, "POST", "/api/invites/accept", {
      body: { token: "  " + happy.token + "  ", email: "  Maya.Levi@Cybereason.com " }
    });
    assert(accepted.status === 200, "accept adds the address");
    assert(JSON.stringify(Object.keys(accepted.json).sort()) === JSON.stringify(["email", "ok"]), "accept fields are ok and email");
    assert(accepted.json.ok === true && accepted.json.email === "maya.levi@cybereason.com", "accept returns the canonical email");
    assert(!("token" in accepted.json) && !("secret" in accepted.json), "accept does not issue a session or a secret");

    const asInvite = await req(port, "GET", "/api/state", { token: happy.token });
    assert(asInvite.status === 401, "the invite token is not a session");
    const anonState = await req(port, "GET", "/api/state");
    assert(anonState.status === 401, "accept did not sign anyone in");

    const state = await req(port, "GET", "/api/state", { token: nir });
    const maya = onRoster(state, "maya.levi@cybereason.com");
    assert(maya && maya.id === "e_maya_levi" && maya.name === "Maya Levi" && maya.admin === false && !maya.pending, "invitee is a normal roster row");

    const reuse = await req(port, "POST", "/api/invites/accept", {
      body: { token: happy.token, email: "noa.peretz@cybereason.com" }
    });
    assert(reuse.status === 409 && reuse.json.error === "already_used", "a used link cannot add someone else");
    const afterReuse = await req(port, "GET", "/api/state", { token: nir });
    assert(!onRoster(afterReuse, "noa.peretz@cybereason.com"), "reused link did not add the second email");
    const usedRow = (await req(port, "GET", "/api/invites", { token: nir })).json.invites.find(i => i.id === rec.id);
    assert(usedRow.status === "used" && usedRow.usedBy === "maya.levi@cybereason.com" && usedRow.usedAt, "list marks the link used");

    const spent = await req(port, "DELETE", "/api/invites/" + rec.id, { token: nir });
    assert(spent.status === 409 && spent.json.error === "already_used", "revoke does not apply to a used link");

    const mayaSession = await signIn(port, "maya.levi@cybereason.com");
    const mayaState = await req(port, "GET", "/api/state", { token: mayaSession });
    assert(mayaState.status === 200, "normal sign-in works after accept");

    const revokeMint = await req(port, "POST", "/api/invites", { token: nir, body: {} });
    const revokeTok = tokenFrom(revokeMint);
    const missing = await req(port, "DELETE", "/api/invites/inv_deadbeef", { token: nir });
    assert(missing.status === 404 && missing.json.error === "not_found", "unknown invite id");
    const revoked = await req(port, "DELETE", "/api/invites/" + revokeMint.json.id, { token: nir });
    assert(revoked.status === 200 && revoked.json.ok === true && revoked.json.status === "revoked" && revoked.json.revokedAt, "admin can revoke");
    const againRevoke = await req(port, "DELETE", "/api/invites/" + revokeMint.json.id, { token: nir });
    assert(againRevoke.status === 200 && againRevoke.json.revokedAt === revoked.json.revokedAt, "revoke again keeps the same time");
    const afterRevoke = await req(port, "POST", "/api/invites/accept", {
      body: { token: revokeTok.token, email: "noa.peretz@cybereason.com" }
    });
    assert(afterRevoke.status === 400 && afterRevoke.json.error === "revoked", "revoked link is refused");
    const roster = await req(port, "GET", "/api/state", { token: nir });
    assert(!onRoster(roster, "noa.peretz@cybereason.com"), "revoked link did not add anyone");

    let cur = await req(port, "GET", "/api/state", { token: nir });
    const pendingState = JSON.parse(JSON.stringify(cur.json.state));
    pendingState.employees.push({
      id: "e_roni_barak",
      name: "Temp",
      email: "roni.barak@cybereason.com",
      admin: true,
      pending: true,
      position: "Shift worker"
    });
    const saved = await req(port, "PUT", "/api/state", {
      token: nir,
      body: { version: cur.json.version, state: pendingState }
    });
    assert(saved.status === 200, "admin can save a pending row");
    const blocked = await req(port, "POST", "/api/auth/start", { body: { email: "roni.barak@cybereason.com" } });
    assert(blocked.status === 403 && blocked.json.error === "not_on_team", "pending row still cannot sign in");
    const pendMint = await req(port, "POST", "/api/invites", { token: nir, body: {} });
    const pendTok = tokenFrom(pendMint);
    const activated = await req(port, "POST", "/api/invites/accept", {
      body: { token: pendTok.token, email: "roni.barak@cybereason.com" }
    });
    assert(activated.status === 200 && activated.json.email === "roni.barak@cybereason.com", "accept activates a pending row");
    cur = await req(port, "GET", "/api/state", { token: nir });
    const roni = onRoster(cur, "roni.barak@cybereason.com");
    assert(roni && roni.id === "e_roni_barak" && !roni.pending && roni.admin === false && roni.name === "Temp", "pending flag cleared without a promotion");
    const roniSession = await signIn(port, "roni.barak@cybereason.com");
    assert(!!roniSession, "activated person uses normal sign-in");
  } finally {
    await stopServer(server);
  }

  console.log("expired invite on", port);
  server = await startServer(port, dir, { INVITE_NOW: "2099-01-01T00:00:00.000Z" });
  try {
    const old = (await req(port, "GET", "/api/invites", { token: nir })).json.invites.find(i => i.id === spareId);
    assert(old && old.status === "pending" && Date.parse(old.expiresAt) < Date.parse("2099-01-01T00:00:00.000Z"), "unused link is past its expiry and still pending");
    const expired = await req(port, "POST", "/api/invites/accept", {
      body: { token: spareToken, email: "noa.peretz@cybereason.com" }
    });
    assert(expired.status === 400 && expired.json.error === "expired", "expired link is refused");
    const roster = await req(port, "GET", "/api/state", { token: nir });
    assert(!onRoster(roster, "noa.peretz@cybereason.com"), "expired link did not add anyone");
    const still = (await req(port, "GET", "/api/invites", { token: nir })).json.invites.find(i => i.id === spareId);
    assert(still.status === "pending" && !still.usedAt, "expiry does not mark the link used");
    const revoked = await req(port, "DELETE", "/api/invites/" + spareId, { token: nir });
    assert(revoked.status === 200 && revoked.json.status === "revoked", "an expired unused link can be revoked");
  } finally {
    await stopServer(server);
  }

  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-invite-app-"));
  const appPort = 39523;
  console.log("APP_URL on", appPort);
  server = await startServer(appPort, appDir, { APP_URL: "https://shiflty.onrender.com/app/" });
  try {
    const admin = await signIn(appPort, "nir.itzik@cybereason.com");
    const minted = await req(appPort, "POST", "/api/invites", {
      token: admin,
      body: {},
      headers: { "x-forwarded-proto": "http", "x-forwarded-host": "evil.example" }
    });
    const link = tokenFrom(minted);
    assert(link.url.origin === "https://shiflty.onrender.com", "APP_URL origin wins over the request host");
    assert(link.url.pathname === "/" && link.url.searchParams.get("invite") === link.token, "APP_URL link is /?invite=<token>");
    assert(!minted.json.url.includes("/invite/"), "APP_URL link is not /invite/<token>");
  } finally {
    await stopServer(server);
  }

  const totpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-invite-totp-"));
  const totpPort = 39524;
  console.log("real TOTP on", totpPort);
  server = await startServer(totpPort, totpDir, { AUTH_MOCK: "" });
  try {
    await waitAwayFromTotpEdge();
    const start = await req(totpPort, "POST", "/api/auth/start", { body: { email: "nir.itzik@cybereason.com" } });
    assert(start.status === 200 && start.json.mode === "enroll" && start.json.secret, "admin enrolls with TOTP");
    const nirToken = (await req(totpPort, "POST", "/api/auth/verify", {
      body: { email: "nir.itzik@cybereason.com", code: totp(start.json.secret) }
    })).json.token;
    assert(nirToken, "admin session from a real code");
    const minted = await req(totpPort, "POST", "/api/invites", { token: nirToken, body: {} });
    const link = tokenFrom(minted);
    const accepted = await req(totpPort, "POST", "/api/invites/accept", {
      body: { token: link.token, email: "yael.mizrahi@cybereason.com" }
    });
    assert(accepted.status === 200 && accepted.json.email === "yael.mizrahi@cybereason.com" && !accepted.json.token, "accept still returns no session when TOTP is on");
    const early = await req(totpPort, "POST", "/api/auth/verify", {
      body: { email: "yael.mizrahi@cybereason.com", code: "000000" }
    });
    assert(early.status === 400 && early.json.error === "no_enrollment", "accept does not enroll an authenticator");
    const stored = readAuth(totpDir);
    assert(!stored.users["yael.mizrahi@cybereason.com"], "no TOTP secret is stored before enroll");
    assert(!Object.values(stored.sessions || {}).some(s => s && s.email === "yael.mizrahi@cybereason.com"), "no session is stored for the invitee");
    const enroll = await req(totpPort, "POST", "/api/auth/start", { body: { email: "yael.mizrahi@cybereason.com" } });
    assert(enroll.status === 200 && enroll.json.mode === "enroll" && enroll.json.secret && !enroll.json.token, "invitee still has to enroll");
    let wrong = "000000";
    if (wrong === totp(enroll.json.secret)) wrong = "000001";
    const badCode = await req(totpPort, "POST", "/api/auth/verify", {
      body: { email: "yael.mizrahi@cybereason.com", code: wrong }
    });
    assert(badCode.status === 401 && badCode.json.error === "bad_code", "a wrong code is still rejected");
    await waitAwayFromTotpEdge();
    const verified = await req(totpPort, "POST", "/api/auth/verify", {
      body: { email: "yael.mizrahi@cybereason.com", code: totp(enroll.json.secret) }
    });
    assert(verified.status === 200 && verified.json.token, "a matching code signs the invitee in");
    const home = await req(totpPort, "GET", "/api/state", { token: verified.json.token });
    const yael = onRoster(home, "yael.mizrahi@cybereason.com");
    assert(home.status === 200 && yael && yael.admin === false, "invitee session sees their roster row");
  } finally {
    await stopServer(server);
  }

  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-invite-team-"));
  fs.writeFileSync(path.join(teamDir, "state.json"), JSON.stringify({
    version: 3,
    rosterVersion: 1,
    state: {
      settings: {
        company: "Cybereason",
        shifts: [{ id: "morning", name: "Morning", start: "07:00", end: "15:00" }],
        required: { morning: 1 }
      },
      employees: [
        { id: "e_nir_itzik", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: true, position: "Manager" },
        { id: "e_lotan_hadad", name: "Lotan Hadad", email: "lotan.hadad@cybereason.com", admin: false, position: "Shift worker" },
        { id: "e_shoshana_avni", name: "Shoshana Avni", email: "shoshana.avni@cybereason.com", admin: false, position: "Shift worker" }
      ],
      weeks: {},
      notifications: [],
      channels: [
        { id: "ch_soc", name: "SOC", default: true, memberIds: ["e_nir_itzik", "e_lotan_hadad"] },
        { id: "ch_bridge", name: "Bridge", memberIds: ["e_nir_itzik", "e_shoshana_avni"] }
      ]
    }
  }));
  const teamPort = 39525;
  console.log("current team on", teamPort);
  server = await startServer(teamPort, teamDir);
  try {
    const admin = await signIn(teamPort, "nir.itzik@cybereason.com");
    const rejected = await req(teamPort, "POST", "/api/invites", {
      token: admin,
      body: { channelId: "ch_bridge" }
    });
    assert(rejected.status === 400 && rejected.json.error === "channel_not_supported", "team deploy still rejects channelId");
    const minted = await req(teamPort, "POST", "/api/invites", { token: admin, body: {} });
    assert(readAuth(teamDir).invites[minted.json.id].channelId === "ch_soc", "link is tied to the admin's default team");
    assert(!JSON.stringify(minted.json).includes("channel"), "mint response has no channel field");
    const link = tokenFrom(minted);
    const accepted = await req(teamPort, "POST", "/api/invites/accept", {
      body: { token: link.token, email: "omer.shalom@cybereason.com" }
    });
    assert(accepted.status === 200 && !accepted.json.token, "accept adds the person without a session");
    const soc = await req(teamPort, "GET", "/api/state?channel=ch_soc", { token: admin });
    assert(onRoster(soc, "omer.shalom@cybereason.com"), "invitee is on the admin's current team");
    const bridge = await req(teamPort, "GET", "/api/state?channel=ch_bridge", { token: admin });
    assert(!onRoster(bridge, "omer.shalom@cybereason.com"), "invitee is not added to the other team");
    const omer = await signIn(teamPort, "omer.shalom@cybereason.com");
    const mine = await req(teamPort, "GET", "/api/channels", { token: omer });
    assert((mine.json.channels || []).map(c => c.id).join() === "ch_soc", "invitee only belongs to that team");
  } finally {
    await stopServer(server);
  }

  const noneDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-invite-none-"));
  fs.writeFileSync(path.join(noneDir, "state.json"), JSON.stringify({
    version: 2,
    rosterVersion: 1,
    state: {
      settings: { company: "Cybereason", shifts: [], required: {} },
      employees: [
        { id: "e_nir_itzik", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: true, position: "Manager" }
      ],
      weeks: {},
      notifications: [],
      channels: [
        { id: "ch_soc", name: "SOC", default: true, memberIds: ["e_someone"] }
      ]
    }
  }));
  const nonePort = 39526;
  console.log("admin without a team on", nonePort);
  server = await startServer(nonePort, noneDir);
  try {
    const admin = await signIn(nonePort, "nir.itzik@cybereason.com");
    const minted = await req(nonePort, "POST", "/api/invites", { token: admin, body: {} });
    assert(minted.status === 400 && minted.json.error === "no_team", "mint fails when the admin is on no team");
    const listed = await req(nonePort, "GET", "/api/invites", { token: admin });
    assert(listed.status === 200 && listed.json.invites.length === 0, "failed mint is not stored");
  } finally {
    await stopServer(server);
  }

  const limitDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-invite-limit-"));
  const limitPort = 39527;
  console.log("accept rate limit on", limitPort);
  server = await startServer(limitPort, limitDir, { APP_URL: "javascript:alert(1)" });
  try {
    const admin = await signIn(limitPort, "nir.itzik@cybereason.com");
    const minted = await req(limitPort, "POST", "/api/invites", { token: admin, body: {} });
    const link = tokenFrom(minted);
    assert(link.url.origin === "http://127.0.0.1:" + limitPort, "a non-http APP_URL falls back to the request host");
    for (let i = 0; i < 10; i++) {
      const attempt = await req(limitPort, "POST", "/api/invites/accept", {
        body: { token: "not-a-real-token-" + i, email: "tal.gabbay@cybereason.com" }
      });
      assert(attempt.status === 400 && attempt.json.error === "invalid_invite", "accept attempt " + (i + 1) + " is counted");
    }
    const blocked = await req(limitPort, "POST", "/api/invites/accept", {
      body: { token: link.token, email: "tal.gabbay@cybereason.com" }
    });
    assert(blocked.status === 429 && blocked.json.error === "rate_limited", "the 11th accept attempt is limited");
    const roster = await req(limitPort, "GET", "/api/state", { token: admin });
    assert(!onRoster(roster, "tal.gabbay@cybereason.com"), "a limited accept does not add the address");
    const row = (await req(limitPort, "GET", "/api/invites", { token: admin })).json.invites.find(i => i.id === minted.json.id);
    assert(row && row.status === "pending", "a limited accept does not consume the link");
  } finally {
    await stopServer(server);
  }

  if (failed) {
    console.error("\n" + failed + " failed");
    process.exit(1);
  }
  console.log("\nall invite checks passed");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
