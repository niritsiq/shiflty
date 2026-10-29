/* Availability reminder checks. No test framework.
   Run: node test/reminders.js
   Slot math is in-process. The catch-up check spawns server.js in a temp dir. */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const reminders = require("../reminders");

const ROOT = path.join(__dirname, "..");
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok", msg); return; }
  failed++;
  console.error("  FAIL", msg);
}

function isRosterEmail(email) {
  return /^[a-z]+\.[a-z]+@cybereason\.com$/.test(String(email || "").trim().toLowerCase());
}

function iso(d) {
  return d.toISOString();
}

function slotMap(weekKey) {
  const out = {};
  for (const s of reminders.slotsForWeek(weekKey)) out[s.key] = iso(s.at);
  return out;
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

function startServer(port, dataDir, extraEnv) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PORT: String(port),
      SHIFTLY_DATA_DIR: dataDir,
      DATABASE_URL: "",
      AUTH_MOCK: "1",
      REMINDER_DISABLE: "",
      REMINDER_NOW: "2026-11-02T07:30:00.000Z",
      SMTP_USER: "reminder-test@example.com",
      SMTP_PASS: "not-a-real-password",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1"
    }, extraEnv || {});
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "RESEND_API_KEY")) delete env.RESEND_API_KEY;
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "RESEND_FROM")) delete env.RESEND_FROM;
    if (!extraEnv || !Object.prototype.hasOwnProperty.call(extraEnv, "APP_URL")) delete env.APP_URL;
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

function baseState() {
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
        submissions: {
          e_shosh: { cells: { "0.morning": "yes" }, note: "", submittedAt: "2026-11-01T12:00:00.000Z" }
        }
      }
    },
    notifications: [],
    channels: []
  };
}

async function signIn(port, email) {
  const start = await req(port, "POST", "/api/auth/start", { body: { email } });
  assert(start.status === 200 && start.json && start.json.mode === "mock" && start.json.token, "mock sign-in " + email);
  return start.json && start.json.token;
}

function reminderRows(state) {
  return (state.notifications || []).filter(n => n && n.type === "availability_reminder");
}

async function main() {
  const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const reminderSrc = fs.readFileSync(path.join(ROOT, "reminders.js"), "utf8");
  assert(!serverSrc.includes("sendMail") && !serverSrc.includes("tls.connect"), "server has no mail sender");
  assert(!/smtp/i.test(serverSrc) && !/smtp/i.test(reminderSrc), "reminder code does not mention a mail transport");
  assert(!serverSrc.includes("type: cron") && !serverSrc.includes("render.yaml"), "no cron service is declared from the server");
  assert(reminders.REMINDER_TZ === "Asia/Jerusalem", "zone is Asia/Jerusalem");
  assert(JSON.stringify(reminders.REMINDER_SLOTS.map(s => s.key)) === JSON.stringify(["morning", "evening", "hour"]), "exactly three slot keys");
  assert(!reminders.REMINDER_SLOTS.some(s => s.hour === 20), "Sunday 20:00 slot is gone");

  const summer = slotMap("2026-08-30");
  assert(summer.morning === "2026-08-23T06:00:00.000Z", "summer morning is Sunday 09:00 IDT");
  assert(summer.evening === "2026-08-23T14:00:00.000Z", "summer evening is Sunday 17:00 IDT");
  assert(summer.hour === "2026-08-24T06:00:00.000Z", "summer last call is Monday 09:00 IDT");
  assert(iso(reminders.deadlineForWeek("2026-08-30")) === "2026-08-24T07:00:00.000Z", "summer deadline is Monday 10:00 IDT");

  const winter = slotMap("2026-11-08");
  assert(winter.morning === "2026-11-01T07:00:00.000Z", "winter morning is Sunday 09:00 IST");
  assert(winter.evening === "2026-11-01T15:00:00.000Z", "winter evening is Sunday 17:00 IST");
  assert(winter.hour === "2026-11-02T07:00:00.000Z", "winter last call is Monday 09:00 IST");
  assert(iso(reminders.deadlineForWeek("2026-11-08")) === "2026-11-02T08:00:00.000Z", "winter deadline is Monday 10:00 IST");

  const dst = slotMap("2026-11-01");
  assert(dst.morning === "2026-10-25T07:00:00.000Z", "DST fallback morning uses IST");
  assert(dst.evening === "2026-10-25T15:00:00.000Z", "DST fallback evening uses IST");
  assert(dst.hour === "2026-10-26T07:00:00.000Z", "DST fallback last call uses IST");
  assert(iso(reminders.deadlineForWeek("2026-11-01")) === "2026-10-26T08:00:00.000Z", "DST fallback deadline is Monday 10:00 IST");

  const sundayEvening = reminders.activeReminderCycle(new Date("2026-11-01T16:00:00.000Z"));
  assert(sundayEvening.weekKey === "2026-11-08", "Sunday evening still targets the coming week");
  assert(JSON.stringify(sundayEvening.slots.map(s => s.key)) === JSON.stringify(["morning", "evening"]), "Sunday 18:00 has morning and evening, not the hour-before slot");

  const mondayHour = reminders.activeReminderCycle(new Date("2026-11-02T07:30:00.000Z"));
  assert(mondayHour.weekKey === "2026-11-08", "Monday 09:30 targets the coming Sunday");
  assert(JSON.stringify(mondayHour.slots.map(s => s.key)) === JSON.stringify(["morning", "evening", "hour"]), "Monday 09:30 catches up all three");

  const afterLock = reminders.activeReminderCycle(new Date("2026-11-02T12:00:00.000Z"));
  assert(afterLock.weekKey === "2026-11-08" && afterLock.slots.length === 3, "a wake after Monday 10:00 still owes the three slots");

  const beforeNext = reminders.activeReminderCycle(new Date("2026-11-08T06:59:00.000Z"));
  assert(beforeNext.weekKey === "2026-11-08" && beforeNext.slots.length === 3, "the cycle lasts until the next Sunday 09:00");
  const nextCycle = reminders.activeReminderCycle(new Date("2026-11-08T07:00:00.000Z"));
  assert(nextCycle.weekKey === "2026-11-15" && JSON.stringify(nextCycle.slots.map(s => s.key)) === JSON.stringify(["morning"]), "next Sunday 09:00 starts the next week");

  const when = new Date("2026-11-02T07:30:00.000Z");
  const state = baseState();
  const first = reminders.applyAvailabilityReminders(state, when, { isRosterEmail });
  assert(first.emailed === 0, "the pass reports no email");
  assert(first.created === 6 && reminderRows(state).length === 6, "admin and worker each get three; submitted, pending, and bad emails do not");
  const ids = reminderRows(state).map(n => n.id).sort();
  assert(new Set(ids).size === ids.length, "ids are unique");
  const lotan = reminderRows(state).filter(n => n.recipientIds[0] === "e_lotan");
  const nir = reminderRows(state).filter(n => n.recipientIds[0] === "e_nir");
  assert(lotan.length === 3 && nir.length === 3, "unsubmitted admin is reminded, same as a worker");
  assert(JSON.stringify(lotan.map(n => n.slot).sort()) === JSON.stringify(["evening", "hour", "morning"]), "worker slots are the three keys");
  assert(!reminderRows(state).some(n => n.recipientIds.includes("e_shosh") || n.recipientIds.includes("e_ron") || n.recipientIds.includes("e_bad") || n.recipientIds.includes("e_dup")), "submitted, pending, non-roster, and duplicate email are skipped");
  assert(lotan.every(n => n.type === "availability_reminder" && n.week === "2026-11-08" && n.readBy && !n.channelId), "rows match the bell shape");
  const second = reminders.applyAvailabilityReminders(state, when, { isRosterEmail });
  assert(second.created === 0 && reminderRows(state).length === 6, "a second pass does not duplicate a slot");

  const locked = baseState();
  locked.weeks["2026-11-08"].locked = true;
  const lockedPass = reminders.applyAvailabilityReminders(locked, when, { isRosterEmail });
  assert(lockedPass.created === 0, "an admin-closed week sends nothing");
  locked.weeks["2026-11-08"].lockOverride = "open";
  const reopened = reminders.applyAvailabilityReminders(locked, when, { isRosterEmail });
  assert(reopened.created === 6, "reopening the week allows the reminders");

  const teams = baseState();
  teams.channels = [
    { id: "ch_soc", name: "SOC", default: true, memberIds: ["e_nir", "e_lotan", "e_ron", "e_bad"] },
    { id: "ch_bridge", name: "Bridge", memberIds: ["e_shosh", "e_nir"] }
  ];
  teams.weeks["2026-11-08"].channelId = "ch_soc";
  teams.weeks["2026-11-08"].submissions = {
    e_lotan: { cells: {}, note: "", submittedAt: "2026-11-01T12:00:00.000Z" }
  };
  teams.weeks["ch_bridge|2026-11-08"] = { channelId: "ch_bridge", locked: false, submissions: {} };
  const teamPass = reminders.applyAvailabilityReminders(teams, when, { isRosterEmail });
  assert(teamPass.emailed === 0 && teamPass.created === 9, "each team reminds members who have not submitted on that team");
  const bridge = reminderRows(teams).filter(n => n.channelId === "ch_bridge");
  const soc = reminderRows(teams).filter(n => n.channelId === "ch_soc");
  assert(soc.length === 3 && soc.every(n => n.recipientIds[0] === "e_nir"), "soc skips lotan, who already submitted");
  const bridgeIds = bridge.map(n => n.recipientIds[0]).sort();
  assert(bridge.length === 6 && bridgeIds.filter(id => id === "e_nir").length === 3 && bridgeIds.filter(id => id === "e_shosh").length === 3, "bridge reminds nir and shoshana on their own week");
  const again = reminders.applyAvailabilityReminders(teams, when, { isRosterEmail });
  assert(again.created === 0 && reminderRows(teams).length === 9, "channel catch-up is idempotent");

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert(html.includes('availability_reminder: { label: "Reminder", worker: "submit", admin: "submit" }'), "a reminder opens My availability for an admin");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-remind-"));
  const fixture = {
    version: 4,
    rosterVersion: 1,
    state: baseState()
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(fixture));
  const port = 39241;
  console.log("catch-up on", port);
  let started = await startServer(port, dir);
  try {
    const log = started.log();
    assert(log.includes("[reminder] in-app 6"), "boot catch-up writes six in-app reminders (" + log.trim().split("\n").filter(l => l.includes("[reminder]")).join(" | ") + ")");
    assert(!/smtp|ECONNREFUSED|sendMail|tls/i.test(log), "boot log has no mail transport (" + log.trim().split("\n").filter(l => /smtp|ECONNREFUSED|sendMail|tls/i.test(l)).join(" | ") + ")");
    assert(!log.includes("[mail] reminder"), "boot does not send reminder email without a key");
    assert(log.includes("RESEND_API_KEY is unset"), "missing API key is logged and in-app rows still save");
    const lotanToken = await signIn(port, "lotan.hadad@cybereason.com");
    const shoshToken = await signIn(port, "shoshana.avni@cybereason.com");
    const nirToken = await signIn(port, "nir.itzik@cybereason.com");
    const pending = await req(port, "POST", "/api/auth/start", { body: { email: "ron.itzik@cybereason.com" } });
    assert(pending.status === 403, "pending employee still cannot sign in");
    const lotanNotes = await req(port, "GET", "/api/notifications", { token: lotanToken });
    assert(lotanNotes.status === 200 && lotanNotes.json.notifications.length === 3, "worker sees three reminders");
    assert(lotanNotes.json.notifications.every(n => n.type === "availability_reminder" && n.week === "2026-11-08" && !n.readAt), "worker rows are unread availability reminders for that week");
    const titles = lotanNotes.json.notifications.map(n => n.title).sort();
    assert(JSON.stringify(titles) === JSON.stringify([
      "Availability closes in an hour",
      "Availability still missing",
      "Submit your availability"
    ]), "the three titles are the morning, evening, and hour-before reminders");
    const shoshNotes = await req(port, "GET", "/api/notifications", { token: shoshToken });
    assert(shoshNotes.status === 200 && shoshNotes.json.notifications.length === 0, "submitted worker has no reminder");
    const nirNotes = await req(port, "GET", "/api/notifications", { token: nirToken });
    assert(nirNotes.json.notifications.length === 3, "admin who has not submitted sees three reminders");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert(reminderRows(saved.state).length === 6, "sent markers are stored on state.notifications");
  } finally {
    await stopServer(started.child);
  }

  console.log("second boot does not double-send");
  started = await startServer(port, dir);
  try {
    const log = started.log();
    assert(!log.includes("[reminder] in-app"), "restart catch-up adds nothing (" + log.trim().split("\n").filter(l => l.includes("[reminder]") || l.includes("listening")).join(" | ") + ")");
    assert(!/smtp|ECONNREFUSED|sendMail/i.test(log), "restart still does not send mail");
    const lotanToken = await signIn(port, "lotan.hadad@cybereason.com");
    const lotanNotes = await req(port, "GET", "/api/notifications", { token: lotanToken });
    assert(lotanNotes.json.notifications.length === 3, "worker still has three reminders after restart");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert(reminderRows(saved.state).length === 6, "state still has one row per employee per slot");
  } finally {
    await stopServer(started.child);
  }

  if (failed) {
    console.error("\n" + failed + " failed");
    process.exit(1);
  }
  console.log("\nall reminder checks passed");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
