/* Resend email checks. No test framework. The HTTP API is mocked in-process
   and, for the server, by test/resend-mock.js. Nothing on the network.
   Run: node test/mail.js */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const reminders = require("../reminders");
const mail = require("../mail");

const ROOT = path.join(__dirname, "..");
const API_KEY = "re_test_key_not_secret";
const FROM_RENDER = "Shiflty <onboarding@resend.dev>";
const FROM_OTHER = "Desk <desk@example.com>";
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok", msg); return; }
  failed++;
  console.error("  FAIL", msg);
}

function isRosterEmail(email) {
  return /^[a-z]+\.[a-z]+@cybereason\.com$/.test(String(email || "").trim().toLowerCase());
}

function req(port, method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = data.length;
    }
    if (token) headers.Authorization = "Bearer " + token;
    const r = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function startServer(port, dataDir, extra) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PORT: String(port),
      SHIFTLY_DATA_DIR: dataDir,
      DATABASE_URL: "",
      AUTH_MOCK: "1",
      REMINDER_DISABLE: "1",
      RESEND_MOCK_STRICT: "1",
      RESEND_MOCK_MODE: ""
    }, extra || {});
    if (!extra || !Object.prototype.hasOwnProperty.call(extra, "RESEND_API_KEY")) delete env.RESEND_API_KEY;
    if (!extra || !Object.prototype.hasOwnProperty.call(extra, "RESEND_FROM")) delete env.RESEND_FROM;
    if (!extra || !Object.prototype.hasOwnProperty.call(extra, "APP_URL")) delete env.APP_URL;
    const child = spawn(process.execPath, ["-r", path.join(ROOT, "test/resend-mock.js"), "server.js"], {
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
        resolve({ child, log: () => log });
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", buf => { log += buf.toString(); });
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

function readMock(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeState(dir, state) {
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    version: 4,
    rosterVersion: 1,
    state
  }));
}

function reminderFixture() {
  return {
    settings: { company: "Cybereason", shifts: [], required: {} },
    employees: [
      { id: "e_nir", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: true, position: "Manager" },
      { id: "e_lotan", name: "Lotan Hadad", email: "lotan.hadad@cybereason.com", admin: false, position: "Shift worker" },
      { id: "e_shosh", name: "Shoshana Avni", email: "shoshana.avni@cybereason.com", admin: false, position: "Shift worker" },
      { id: "e_dup", name: "Lotan again", email: "Lotan.Hadad@cybereason.com", admin: false, position: "Shift worker" },
      { id: "e_ron", name: "Ron Itzik", email: "ron.itzik@cybereason.com", admin: false, pending: true, position: "Shift worker" },
      { id: "e_bad", name: "Nope", email: "nope@gmail.com", admin: false, position: "Shift worker" }
    ],
    weeks: {
      "2026-11-08": {
        locked: false,
        published: false,
        submissions: {
          e_shosh: { cells: { "0.morning": "yes" }, note: "", submittedAt: "2026-11-01T12:00:00.000Z" }
        }
      }
    },
    notifications: [],
    channels: []
  };
}

function publishFixture() {
  return {
    settings: { company: "Cybereason", shifts: [], required: {} },
    employees: [
      { id: "e_nir", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: true, position: "Manager" },
      { id: "e_lotan", name: "Lotan Hadad", email: "lotan.hadad@cybereason.com", admin: false, position: "Shift worker" },
      { id: "e_ron", name: "Ron Itzik", email: "ron.itzik@cybereason.com", admin: false, pending: true, position: "Shift worker" }
    ],
    weeks: {
      "2026-11-08": { locked: false, published: false, assignments: {}, submissions: {} }
    },
    notifications: [],
    channels: []
  };
}

async function signIn(port, email) {
  const start = await req(port, "POST", "/api/auth/start", { body: { email } });
  assert(start.status === 200 && start.json && start.json.token, "mock sign-in " + email);
  return start.json && start.json.token;
}

function addresses(rows) {
  return rows.map(r => (r.body && r.body.to && r.body.to[0]) || "").sort();
}

async function main() {
  const savedEnv = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM: process.env.RESEND_FROM,
    APP_URL: process.env.APP_URL
  };
  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const prod = ["server.js", "mail.js", "reminders.js"].map(name => fs.readFileSync(path.join(ROOT, name), "utf8")).join("\n");
  assert(!prod.includes("onboarding@resend.dev"), "From address is not hardcoded");
  assert(!prod.includes("nodemailer"), "no nodemailer");
  assert(!prod.includes(API_KEY), "the test key is not in the server");
  assert(mail.RESEND_EMAILS_URL === "https://api.resend.com/emails", "Resend HTTPS endpoint");
  assert(prod.includes("process.env.RESEND_FROM"), "From is read from the environment");
  assert(prod.includes("process.env.RESEND_API_KEY"), "API key is read from the environment");

  delete process.env.APP_URL;
  assert(mail.withLink("Hello") === "Hello", "no link without APP_URL");
  process.env.APP_URL = "https://shiflty.onrender.com/";
  assert(mail.withLink("Hello") === "Hello\n\nhttps://shiflty.onrender.com", "APP_URL is appended once");
  process.env.APP_URL = "javascript:alert(1)";
  assert(mail.withLink("Hello") === "Hello", "a non-http APP_URL is left off");
  delete process.env.APP_URL;

  const when = new Date("2026-11-02T07:30:00.000Z");
  const skipped = reminderFixture();
  const pass = reminders.applyAvailabilityReminders(skipped, when, { isRosterEmail });
  const pending = reminders.pendingReminderEmails(skipped, pass, isRosterEmail);
  assert(pass.created === 6 && pending.length === 6, "email targets match the in-app rows");
  assert(!pending.some(n => n.recipientIds.includes("e_shosh")), "submitted worker is not an email target");
  pending[0].emailAttemptedAt = "2026-11-02T07:30:01.000Z";
  const again = reminders.pendingReminderEmails(skipped, pass, isRosterEmail);
  assert(again.length === 5, "a stamped row is not emailed again");

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const mode = process.env.RESEND_MOCK_MODE;
    if (mode === "reject") {
      return new Response(JSON.stringify({
        name: "validation_error",
        message: "nope " + API_KEY
      }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "email_unit" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const origLog = console.log;
  const origErr = console.error;
  try {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    const noKey = await mail.sendResendEmail({ to: "nir.itzik@cybereason.com", subject: "n", text: "n" });
    assert(noKey.skipped === "RESEND_API_KEY" && calls.length === 0, "skip send when the API key is unset");
    process.env.RESEND_API_KEY = API_KEY;
    const noFrom = await mail.sendResendEmail({ to: "nir.itzik@cybereason.com", subject: "n", text: "n" });
    assert(noFrom.skipped === "RESEND_FROM" && calls.length === 0, "skip send when RESEND_FROM is unset");
    process.env.RESEND_FROM = FROM_OTHER;
    const other = await mail.sendResendEmail({ to: "lotan.hadad@cybereason.com", subject: "Other", text: "body" });
    assert(other.ok === true && other.id === "email_unit", "send returns the Resend id");
    const otherBody = JSON.parse(calls[0].opts.body);
    assert(otherBody.from === FROM_OTHER, "From is the env value, not a built-in address");
    assert(calls[0].opts.headers.Authorization === "Bearer " + API_KEY, "Authorization is the env key");
    assert(calls[0].url === "https://api.resend.com/emails", "unit send hits the Resend URL");
    process.env.RESEND_FROM = FROM_RENDER;
    await mail.sendResendEmail({ to: "nir.itzik@cybereason.com", subject: "Render", text: "body" });
    assert(JSON.parse(calls[1].opts.body).from === FROM_RENDER, "Render From is passed through unchanged");
    process.env.RESEND_MOCK_MODE = "reject";
    const lines = [];
    console.log = (...args) => { lines.push(args.map(String).join(" ")); };
    console.error = (...args) => { lines.push(args.map(String).join(" ")); };
    let rejected;
    try {
      rejected = await mail.sendResendEmail({ to: "nir.itzik@cybereason.com", subject: "x", text: "y" });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert(rejected.ok === false && rejected.status === 403 && rejected.name === "validation_error", "Resend's status and name are returned");
    assert(rejected.message === "nope [redacted]", "the API key is stripped from Resend's message");
    assert(!lines.join("\n").includes(API_KEY), "logs do not contain the API key");
    delete process.env.RESEND_MOCK_MODE;

    const row = { id: "n1", title: "t", body: "b" };
    let persists = 0;
    const sent = await mail.deliverJobs([{ row, to: "nir.itzik@cybereason.com", subject: "t", text: "b" }], "reminder", () => { persists++; });
    assert(sent === 1 && calls.length === 4 && row.emailedAt && row.emailAttemptedAt, "deliverJobs sends once and stamps the row");
    const second = await mail.deliverJobs([{ row, to: "nir.itzik@cybereason.com", subject: "t", text: "b" }], "reminder", () => { persists++; });
    assert(second === 0 && calls.length === 4 && persists === 2, "a second pass does not call Resend");
  } finally {
    global.fetch = origFetch;
    console.log = origLog;
    console.error = origErr;
    delete process.env.RESEND_MOCK_MODE;
    restoreEnv();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-"));
  const mockFile = path.join(dir, "resend-log.json");
  fs.writeFileSync(mockFile, "[]");
  writeState(dir, reminderFixture());
  console.log("reminder email on 39311");
  let started = await startServer(39311, dir, {
    REMINDER_DISABLE: "",
    REMINDER_NOW: "2026-11-02T07:30:00.000Z",
    RESEND_API_KEY: API_KEY,
    RESEND_FROM: FROM_RENDER,
    RESEND_MOCK_LOG: mockFile,
    APP_URL: "https://shiflty.onrender.com"
  });
  try {
    const log = started.log();
    assert(!log.includes(API_KEY), "server log does not contain the API key");
    assert(log.includes("[mail] reminder sent 6 rejected 0"), "six reminder emails (" + log.trim().split("\n").filter(l => l.includes("[mail]")).join(" | ") + ")");
    const sent = readMock(mockFile);
    assert(sent.length === 6, "Resend was called once per in-app row");
    assert(sent.every(r => r.body && r.body.from === FROM_RENDER), "every reminder uses RESEND_FROM");
    assert(sent.every(r => r.authorizationIsBearer && r.authorizationLength === ("Bearer " + API_KEY).length), "bearer token is sent and not stored");
    assert(!JSON.stringify(sent).includes(API_KEY), "mock log does not contain the API key");
    const tos = addresses(sent);
    assert(tos.filter(a => a === "lotan.hadad@cybereason.com").length === 3, "lotan gets three slots");
    assert(tos.filter(a => a === "nir.itzik@cybereason.com").length === 3, "nir gets three slots");
    assert(!tos.includes("shoshana.avni@cybereason.com"), "submitted worker is not emailed");
    assert(!tos.includes("ron.itzik@cybereason.com") && !tos.includes("nope@gmail.com"), "pending and non-roster are not emailed");
    assert(sent.every(r => String(r.body.text).includes("https://shiflty.onrender.com")), "APP_URL is included");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    const rows = saved.state.notifications.filter(n => n.type === "availability_reminder");
    assert(rows.length === 6 && rows.every(n => n.emailedAt && n.emailAttemptedAt), "email markers are stored on the notification rows");
    const lotan = await signIn(39311, "lotan.hadad@cybereason.com");
    const notes = await req(39311, "GET", "/api/notifications", { token: lotan });
    assert(notes.json.notifications.length === 3 && notes.json.notifications.every(n => !("emailedAt" in n) && !("emailAttemptedAt" in n)), "email markers stay off the bell payload");
  } finally {
    await stopServer(started.child);
  }

  console.log("second boot does not email again");
  started = await startServer(39312, dir, {
    REMINDER_DISABLE: "",
    REMINDER_NOW: "2026-11-02T07:30:00.000Z",
    RESEND_API_KEY: API_KEY,
    RESEND_FROM: FROM_RENDER,
    RESEND_MOCK_LOG: mockFile
  });
  try {
    assert(readMock(mockFile).length === 6, "catch-up does not send a second email per slot");
    assert(!started.log().includes("[mail] reminder sent"), "restart log has no new reminder send (" + started.log().trim().split("\n").filter(l => l.includes("[mail]") || l.includes("listening")).join(" | ") + ")");
  } finally {
    await stopServer(started.child);
  }

  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-nokey-"));
  const bareLog = path.join(bareDir, "resend-log.json");
  fs.writeFileSync(bareLog, "[]");
  writeState(bareDir, reminderFixture());
  console.log("no API key on 39313");
  started = await startServer(39313, bareDir, {
    REMINDER_DISABLE: "",
    REMINDER_NOW: "2026-11-02T07:30:00.000Z",
    RESEND_MOCK_LOG: bareLog
  });
  try {
    const log = started.log();
    assert(log.includes("RESEND_API_KEY is unset"), "missing API key is logged");
    assert(log.includes("[reminder] in-app 6"), "in-app reminders still save without a key");
    assert(readMock(bareLog).length === 0, "no Resend call without a key");
    const saved = JSON.parse(fs.readFileSync(path.join(bareDir, "state.json"), "utf8"));
    assert(saved.state.notifications.filter(n => n.type === "availability_reminder").every(n => !n.emailAttemptedAt), "a skipped send is not marked, so a later key can still send");
  } finally {
    await stopServer(started.child);
  }

  const noFromDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-nofrom-"));
  const noFromLog = path.join(noFromDir, "resend-log.json");
  fs.writeFileSync(noFromLog, "[]");
  writeState(noFromDir, reminderFixture());
  console.log("no From on 39314");
  started = await startServer(39314, noFromDir, {
    REMINDER_DISABLE: "",
    REMINDER_NOW: "2026-11-02T07:30:00.000Z",
    RESEND_API_KEY: API_KEY,
    RESEND_MOCK_LOG: noFromLog
  });
  try {
    const log = started.log();
    assert(log.includes("RESEND_FROM is unset"), "missing From is logged");
    assert(!log.includes(API_KEY), "the API key is not logged when From is missing");
    assert(log.includes("[reminder] in-app 6"), "in-app reminders still save without From");
    assert(readMock(noFromLog).length === 0, "no Resend call without From");
  } finally {
    await stopServer(started.child);
  }

  const pubDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-pub-"));
  const pubLog = path.join(pubDir, "resend-log.json");
  fs.writeFileSync(pubLog, "[]");
  writeState(pubDir, publishFixture());
  console.log("publish on 39315");
  started = await startServer(39315, pubDir, {
    RESEND_API_KEY: API_KEY,
    RESEND_FROM: FROM_RENDER,
    RESEND_MOCK_LOG: pubLog,
    APP_URL: "https://shiflty.onrender.com"
  });
  try {
    const nir = await signIn(39315, "nir.itzik@cybereason.com");
    const lotan = await signIn(39315, "lotan.hadad@cybereason.com");
    let cur = await req(39315, "GET", "/api/state", { token: nir });
    const workerState = JSON.parse(JSON.stringify(cur.json.state));
    workerState.weeks["2026-11-08"].published = true;
    const workerPut = await req(39315, "PUT", "/api/state", {
      token: lotan,
      body: { version: cur.json.version, state: workerState }
    });
    assert(workerPut.status === 200, "worker save is accepted");
    assert(readMock(pubLog).length === 0, "a worker flipping published does not send mail");

    cur = await req(39315, "GET", "/api/state", { token: nir });
    const draft = JSON.parse(JSON.stringify(cur.json.state));
    draft.weeks["2026-11-08"].published = false;
    const unpublish = await req(39315, "PUT", "/api/state", {
      token: nir,
      body: { version: cur.json.version, state: draft }
    });
    assert(unpublish.status === 200, "admin can unpublish the worker's flip");
    assert(readMock(pubLog).length === 0, "unpublish does not send mail");

    const live = JSON.parse(JSON.stringify(draft));
    live.weeks["2026-11-08"].published = true;
    const publish = await req(39315, "PUT", "/api/state", {
      token: nir,
      body: { version: unpublish.json.version, state: live }
    });
    assert(publish.status === 200, "admin publish saves");
    const sent = readMock(pubLog);
    assert(sent.length === 2, "publish emails the two active people (" + sent.length + ")");
    assert(addresses(sent).join() === "lotan.hadad@cybereason.com,nir.itzik@cybereason.com", "pending ron is not emailed");
    assert(sent.every(r => r.body.from === FROM_RENDER && r.body.subject === "Schedule published"), "publish subject and From");
    assert(sent.every(r => String(r.body.text).includes("8 Nov") && String(r.body.text).includes("published by Nir Itzik") && String(r.body.text).includes("https://shiflty.onrender.com")), "publish body names the week, the admin, and the link");
    const lotanNotes = await req(39315, "GET", "/api/notifications", { token: lotan });
    const publishedNotes = lotanNotes.json.notifications.filter(n => n.type === "schedule_published" && n.week === "2026-11-08");
    assert(publishedNotes.length === 1 && publishedNotes[0].actor && publishedNotes[0].actor.email === "nir.itzik@cybereason.com", "publish writes one bell row with the admin as actor");
    const ron = await req(39315, "POST", "/api/auth/start", { body: { email: "ron.itzik@cybereason.com" } });
    assert(ron.status === 403, "pending employee still cannot sign in");

    cur = await req(39315, "GET", "/api/state", { token: nir });
    const repeat = JSON.parse(JSON.stringify(cur.json.state));
    repeat.weeks["2026-11-08"].published = true;
    repeat.settings.company = "Cybereason SOC";
    const againSave = await req(39315, "PUT", "/api/state", {
      token: nir,
      body: { version: cur.json.version, state: repeat }
    });
    assert(againSave.status === 200 && readMock(pubLog).length === 2, "saving an already published week does not email again");

    const down = JSON.parse(JSON.stringify(repeat));
    down.weeks["2026-11-08"].published = false;
    const closed = await req(39315, "PUT", "/api/state", {
      token: nir,
      body: { version: againSave.json.version, state: down }
    });
    const up = JSON.parse(JSON.stringify(down));
    up.weeks["2026-11-08"].published = true;
    const republish = await req(39315, "PUT", "/api/state", {
      token: nir,
      body: { version: closed.json.version, state: up }
    });
    assert(republish.status === 200 && readMock(pubLog).length === 4, "unpublishing and publishing again emails once more");
    assert(!started.log().includes(API_KEY), "publish log does not contain the API key");
  } finally {
    await stopServer(started.child);
  }

  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-team-"));
  const teamLog = path.join(teamDir, "resend-log.json");
  fs.writeFileSync(teamLog, "[]");
  const team = publishFixture();
  team.employees.push({ id: "e_shosh", name: "Shoshana Avni", email: "shoshana.avni@cybereason.com", admin: false, position: "Shift worker" });
  team.channels = [
    { id: "ch_soc", name: "SOC", default: true, memberIds: ["e_nir", "e_lotan", "e_ron"] },
    { id: "ch_bridge", name: "Bridge", memberIds: ["e_nir", "e_shosh"] }
  ];
  team.weeks = {
    "2026-11-08": { channelId: "ch_soc", locked: false, published: false, assignments: {}, submissions: {} },
    "ch_bridge|2026-11-08": { channelId: "ch_bridge", locked: false, published: false, assignments: {}, submissions: {} }
  };
  writeState(teamDir, team);
  console.log("team publish on 39316");
  started = await startServer(39316, teamDir, {
    RESEND_API_KEY: API_KEY,
    RESEND_FROM: FROM_OTHER,
    RESEND_MOCK_LOG: teamLog
  });
  try {
    const nir = await signIn(39316, "nir.itzik@cybereason.com");
    const soc = await req(39316, "GET", "/api/state?channel=ch_soc", { token: nir });
    const next = JSON.parse(JSON.stringify(soc.json.state));
    next.weeks["2026-11-08"].published = true;
    const put = await req(39316, "PUT", "/api/state?channel=ch_soc", {
      token: nir,
      body: { version: soc.json.version, state: next }
    });
    assert(put.status === 200, "scoped publish saves");
    const sent = readMock(teamLog);
    assert(sent.length === 2 && addresses(sent).join() === "lotan.hadad@cybereason.com,nir.itzik@cybereason.com", "only the published team's active members are emailed");
    assert(sent.every(r => r.body.from === FROM_OTHER && String(r.body.text).includes("published by Nir Itzik")), "From is the env value and the body names the admin");
    const shosh = await signIn(39316, "shoshana.avni@cybereason.com");
    const shoshNotes = await req(39316, "GET", "/api/notifications", { token: shosh });
    assert(shoshNotes.json.notifications.length === 0, "the other team does not get the bell row");
    const repeat = await req(39316, "PUT", "/api/state?channel=ch_soc", {
      token: nir,
      body: { version: put.json.version, state: next }
    });
    assert(repeat.status === 200 && readMock(teamLog).length === 2, "a second team save does not email again");
  } finally {
    await stopServer(started.child);
  }

  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-smoke-"));
  const smokeLog = path.join(smokeDir, "resend-log.json");
  fs.writeFileSync(smokeLog, "[]");
  writeState(smokeDir, publishFixture());
  console.log("smoke on 39317");
  started = await startServer(39317, smokeDir, {
    RESEND_API_KEY: API_KEY,
    RESEND_FROM: FROM_RENDER,
    RESEND_MOCK_LOG: smokeLog
  });
  try {
    const anon = await req(39317, "POST", "/api/mail/smoke", { body: {} });
    assert(anon.status === 401 && anon.json.error === "auth_required", "smoke requires a session");
    const lotan = await signIn(39317, "lotan.hadad@cybereason.com");
    const worker = await req(39317, "POST", "/api/mail/smoke", { token: lotan, body: { to: "nir.itzik@cybereason.com" } });
    assert(worker.status === 403 && worker.json.error === "admin_required", "a worker cannot smoke mail");
    assert(readMock(smokeLog).length === 0, "rejected smoke does not call Resend");
    const nir = await signIn(39317, "nir.itzik@cybereason.com");
    const ok = await req(39317, "POST", "/api/mail/smoke", {
      token: nir,
      body: { to: "someone.else@cybereason.com" }
    });
    assert(ok.status === 200 && ok.json.ok === true && ok.json.id, "admin smoke returns the Resend id");
    const sent = readMock(smokeLog);
    assert(sent.length === 1 && sent[0].body.to[0] === "nir.itzik@cybereason.com", "smoke goes to the caller, not the body address");
    assert(sent[0].body.from === FROM_RENDER && sent[0].body.subject === "Shiftly test email", "smoke uses RESEND_FROM");
    assert(!ok.text.includes(API_KEY) && !started.log().includes(API_KEY), "smoke response and log omit the API key");
    const second = await req(39317, "POST", "/api/mail/smoke", { token: nir, body: {} });
    assert(second.status === 200 && second.json.ok === true && readMock(smokeLog).length === 2, "each smoke call sends one message");
  } finally {
    await stopServer(started.child);
  }

  const rejectDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-reject-"));
  const rejectLog = path.join(rejectDir, "resend-log.json");
  fs.writeFileSync(rejectLog, "[]");
  writeState(rejectDir, publishFixture());
  console.log("resend rejection on 39318");
  started = await startServer(39318, rejectDir, {
    RESEND_API_KEY: API_KEY,
    RESEND_FROM: FROM_RENDER,
    RESEND_MOCK_LOG: rejectLog,
    RESEND_MOCK_MODE: "reject"
  });
  try {
    const nir = await signIn(39318, "nir.itzik@cybereason.com");
    const denied = await req(39318, "POST", "/api/mail/smoke", { token: nir, body: {} });
    assert(denied.status === 403 && denied.json.ok === false, "a Resend rejection is returned to the admin");
    assert(denied.json.status === 403 && denied.json.name === "validation_error", "status and name come from Resend");
    assert(denied.json.message === "You can only send testing emails to your own email address.", "Resend's message is returned");
    assert(!denied.text.includes(API_KEY) && !started.log().includes(API_KEY), "rejection output omits the API key");
    assert(started.log().includes("validation_error") && started.log().includes("resend rejected 403"), "the rejection is logged");
    const cur = await req(39318, "GET", "/api/state", { token: nir });
    const live = JSON.parse(JSON.stringify(cur.json.state));
    live.weeks["2026-11-08"].published = true;
    const before = readMock(rejectLog).length;
    const publish = await req(39318, "PUT", "/api/state", {
      token: nir,
      body: { version: cur.json.version, state: live }
    });
    assert(publish.status === 200, "publish still saves when Resend rejects");
    const sent = readMock(rejectLog);
    assert(sent.length === before + 2, "publish still attempts each worker");
    const saved = JSON.parse(fs.readFileSync(path.join(rejectDir, "state.json"), "utf8"));
    const notes = saved.state.notifications.filter(n => n.type === "schedule_published");
    assert(notes.length === 1 && notes[0].emailAttemptedAt && !notes[0].emailedAt && notes[0].actor && notes[0].actor.email === "nir.itzik@cybereason.com", "the one publish row is marked attempted and keeps the actor");
    const repeat = await req(39318, "PUT", "/api/state", {
      token: nir,
      body: { version: publish.json.version, state: live }
    });
    assert(repeat.status === 200 && readMock(rejectLog).length === sent.length, "a rejected publish is not sent again on the next save");
  } finally {
    await stopServer(started.child);
  }

  const smokeOff = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-mail-smoke-off-"));
  const smokeOffLog = path.join(smokeOff, "resend-log.json");
  fs.writeFileSync(smokeOffLog, "[]");
  writeState(smokeOff, publishFixture());
  console.log("smoke without a key on 39319");
  started = await startServer(39319, smokeOff, { RESEND_MOCK_LOG: smokeOffLog });
  try {
    const nir = await signIn(39319, "nir.itzik@cybereason.com");
    const off = await req(39319, "POST", "/api/mail/smoke", { token: nir, body: {} });
    assert(off.status === 400 && off.json.ok === false && off.json.name === "missing_config", "smoke reports a missing key");
    assert(off.json.message === "RESEND_API_KEY is unset", "smoke names the missing variable");
    assert(readMock(smokeOffLog).length === 0, "smoke does not call Resend without a key");
    assert(started.log().includes("smoke skipped") && !started.log().includes(API_KEY), "the skip is logged without a secret");
  } finally {
    await stopServer(started.child);
  }

  restoreEnv();
  if (failed) {
    console.error("\n" + failed + " failed");
    process.exit(1);
  }
  console.log("\nall mail checks passed");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
