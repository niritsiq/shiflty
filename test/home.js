/* Home stats and publish attribution. No test framework.
   Run: node test/home.js
   Hour math is in-process. The save checks spawn server.js in a temp dir. */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const home = require("../home");
const reminders = require("../reminders");

const ROOT = path.join(__dirname, "..");
const NOW = "2026-10-29T10:00:00.000Z"; /* Thu 29 Oct 2026 12:00 Asia/Jerusalem (UTC+2) */
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok", msg); return; }
  failed++;
  console.error("  FAIL", msg);
}

const SHIFTS = [
  { id: "morning", name: "Morning", start: "07:00", end: "15:00" },
  { id: "evening", name: "Evening", start: "14:30", end: "23:00" },
  { id: "night", name: "Night", start: "23:00", end: "07:00" }
];
const LOTAN = { id: "e_lotan_hadad", name: "Lotan Hadad", email: "lotan.hadad@cybereason.com", admin: false, position: "Shift worker" };
const NIR = { id: "e_nir_itzik", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: true, position: "Manager" };
const SHOSH = { id: "e_shoshana_avni", name: "Shoshana Avni", email: "shoshana.avni@cybereason.com", admin: false, position: "Shift worker" };

function rosterState(extra) {
  return Object.assign({
    settings: { company: "Cybereason", shifts: SHIFTS, required: { morning: 2, evening: 2, night: 2 } },
    employees: [LOTAN, NIR, SHOSH],
    weeks: {},
    notifications: [],
    channels: []
  }, extra || {});
}

/* Published assignments for Lotan around 29 Oct 2026, plus decoys. */
function lotanWeeks() {
  return {
    "2026-09-27": {
      locked: false,
      published: true,
      assignments: { "4.morning": ["e_lotan_hadad"] },
      submissions: {}
    },
    "2026-10-18": {
      locked: false,
      published: true,
      assignments: { "6.night": ["e_lotan_hadad"] },
      submissions: {}
    },
    "2026-10-25": {
      locked: false,
      published: true,
      assignments: {
        "0.morning": ["e_lotan_hadad"],
        "1.evening": ["e_nir_itzik"],
        "2.nope": ["e_lotan_hadad"],
        "4.morning": ["e_lotan_hadad", "e_lotan_hadad"],
        "4.evening": ["e_lotan_hadad"],
        "6.night": ["e_lotan_hadad"]
      },
      submissions: {}
    },
    "2026-11-01": {
      locked: false,
      published: true,
      assignments: { "0.morning": ["e_lotan_hadad"] },
      submissions: {}
    },
    "2026-11-08": {
      locked: false,
      published: false,
      assignments: { "1.morning": ["e_lotan_hadad"] },
      submissions: {}
    },
    "2026-11-15": {
      locked: false,
      published: false,
      assignments: {},
      submissions: {}
    }
  };
}

function storeDoc(state) {
  return { version: 3, rosterVersion: 1, state };
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
      SMTP_USER: "",
      SMTP_PASS: "",
      REMINDER_DISABLE: "1"
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
  assert(start.status === 200 && start.json && start.json.token, "mock sign-in " + email);
  return start.json && start.json.token;
}

function byShift(list, shiftId, date) {
  return (list || []).find(s => s.shiftId === shiftId && s.date === date) || null;
}

function mathChecks() {
  assert(home.shiftMinutes(SHIFTS[0]) === 8 * 60, "morning is 8 hours");
  assert(home.shiftMinutes(SHIFTS[1]) === 8 * 60 + 30, "evening is 8.5 hours");
  assert(home.shiftMinutes(SHIFTS[2]) === 8 * 60, "night is 8 hours across midnight, not the DST gap");
  assert(home.shiftMinutes({ start: "07:00", end: "bogus" }) == null, "a bad clock is skipped");

  const state = rosterState({
    weeks: lotanWeeks(),
    notifications: [
      {
        id: "n_old",
        type: "schedule_published",
        title: "Schedule published",
        body: "Schedule for 27 Sep – 3 Oct published by Nir Itzik.",
        createdAt: "2026-09-20T08:00:00.000Z",
        week: "2026-09-27",
        actor: { id: NIR.id, name: NIR.name, email: NIR.email },
        readBy: { e_lotan_hadad: "2026-09-20T09:00:00.000Z" }
      },
      {
        id: "n_rem",
        type: "availability_reminder",
        title: "Submit your availability",
        body: "Morning reminder",
        createdAt: "2026-10-25T06:00:00.000Z",
        week: "2026-11-01",
        recipientIds: ["e_lotan_hadad"],
        readBy: {}
      }
    ]
  });
  const view = home.buildHome(state, LOTAN, NOW);
  assert(view.timezone === "Asia/Jerusalem", "home clock is Asia/Jerusalem");
  assert(view.now === NOW, "home echoes the request clock");
  assert(view.employee.email === LOTAN.email && view.employee.admin === false, "home is the signed-in person");
  assert(view.thisWeek.week === "2026-10-25" && view.thisWeek.startsOn === "2026-10-25" && view.thisWeek.endsOn === "2026-10-31", "this week is the Israel Sunday");
  assert(view.thisWeek.shiftCount === 4, "this week counts four published shifts");
  assert(view.thisWeek.scheduledHours === 32.5, "this week scheduled hours are 32.5");
  assert(view.thisMonth.month === "2026-10", "this month is October");
  assert(view.thisMonth.scheduledHours === 48.5, "October scheduled hours include later shifts and the month boundary");
  assert(view.thisMonth.actualHours === 24, "actual hours are only shifts whose end has passed");
  assert(view.hoursNote.includes("already passed") && view.hoursNote.includes("clock-in"), "payload states the actual-hours rule");

  const next = view.nextShift;
  assert(next && next.status === "in_progress" && next.shiftId === "morning" && next.date === "2026-10-29", "next shift is the one in progress");
  assert(next.startsAt === "2026-10-29T05:00:00.000Z" && next.endsAt === "2026-10-29T13:00:00.000Z", "in-progress morning is 07:00–15:00 Jerusalem");
  assert(next.hours === 8 && next.dayIdx === 4 && next.week === "2026-10-25" && next.endsNextDay === false, "next shift carries the grid fields");
  assert(view.pastShifts.length === 3, "three shifts have already ended");
  assert(view.pastShifts[0].date === "2026-10-25" && view.pastShifts[0].shiftId === "morning" && view.pastShifts[0].status === "completed", "most recent past shift is Sunday morning");
  assert(view.pastShifts[1].date === "2026-10-24" && view.pastShifts[1].shiftId === "night" && view.pastShifts[1].hours === 8, "Saturday night stays 8 hours across the DST fallback");
  assert(view.pastShifts[1].startsAt === "2026-10-24T20:00:00.000Z" && view.pastShifts[1].endsAt === "2026-10-25T05:00:00.000Z", "Saturday night ends Sunday 07:00 Jerusalem");
  assert(view.pastShifts[1].week === "2026-10-18", "Saturday night belongs to the week it starts");
  assert(view.pastShifts[2].date === "2026-10-01" && view.pastShifts[2].endsAt === "2026-10-01T12:00:00.000Z", "1 Oct morning counts in October, not the September week key");
  assert(!view.pastShifts.some(s => s.date === "2026-11-01") && !view.pastShifts.some(s => s.shiftId === "evening"), "future and in-progress shifts stay out of the past list");
  assert(!view.pastShifts.some(s => s.date === "2026-10-26"), "another person's shift is not mine");
  assert(view.activity.length === 1 && view.activity[0].id === "n_old" && view.activity[0].actor.email === NIR.email, "activity is schedule published, with the actor");
  assert(view.activity[0].readAt === "2026-09-20T09:00:00.000Z", "activity read time is per person");
  assert(!view.activity.some(n => n.type === "availability_reminder"), "reminders are not home activity");

  const later = home.buildHome(state, LOTAN, "2026-10-29T14:00:00.000Z");
  assert(later.nextShift.shiftId === "evening" && later.nextShift.status === "in_progress" && later.nextShift.hours === 8.5, "after the morning ends, next is the evening shift");
  assert(later.nextShift.startsAt === "2026-10-29T12:30:00.000Z" && later.nextShift.endsAt === "2026-10-29T21:00:00.000Z", "evening is 14:30–23:00 Jerusalem");
  assert(later.thisWeek.shiftCount === 4 && later.thisWeek.scheduledHours === 32.5, "week scheduled hours do not drop after a shift ends");
  assert(later.thisMonth.scheduledHours === 48.5 && later.thisMonth.actualHours === 32, "ending the morning moves those hours into actual");
  assert(later.pastShifts[0].date === "2026-10-29" && later.pastShifts[0].shiftId === "morning", "the finished morning is the newest past shift");

  const overlap = home.buildHome(state, LOTAN, "2026-10-29T12:45:00.000Z");
  assert(overlap.nextShift.shiftId === "morning" && overlap.nextShift.status === "in_progress", "while two shifts overlap, next is the one that started earlier");

  const boundary = home.buildHome(rosterState({
    weeks: {
      "2026-09-27": {
        published: true,
        assignments: {
          "0.morning": ["e_lotan_hadad"],
          "4.morning": ["e_lotan_hadad"]
        }
      }
    }
  }), LOTAN, "2026-10-01T09:00:00.000Z");
  assert(boundary.thisWeek.week === "2026-09-27" && boundary.thisWeek.shiftCount === 2 && boundary.thisWeek.scheduledHours === 16, "a week that crosses the month still counts both shifts");
  assert(boundary.thisMonth.month === "2026-10" && boundary.thisMonth.scheduledHours === 8 && boundary.thisMonth.actualHours === 0, "only the October start counts toward this month, and it has not ended");

  const many = rosterState({ weeks: {} });
  for (let i = 0; i < 6; i++) {
    const sunday = reminders.formatYmd(reminders.addDays({ y: 2026, m: 6, d: 7 }, i * 7));
    many.weeks[sunday] = { published: true, assignments: { "0.morning": ["e_lotan_hadad"] } };
  }
  const capped = home.buildHome(many, LOTAN, NOW);
  assert(capped.pastShifts.length === home.PAST_LIMIT, "past shifts stop at five");
  assert(capped.pastShifts[0].date === "2026-07-12" && capped.pastShifts[4].date === "2026-06-14", "the five are the most recently ended");

  const noise = rosterState({ notifications: [] });
  for (let i = 0; i < 9; i++) {
    noise.notifications.push({
      id: "n" + i,
      type: "schedule_published",
      title: "Schedule published",
      body: "Schedule published by Nir Itzik.",
      createdAt: "2026-10-0" + (i + 1) + "T00:00:00.000Z",
      week: "2026-10-25",
      actor: { id: NIR.id, name: NIR.name, email: NIR.email },
      readBy: {}
    });
  }
  const feed = home.buildHome(noise, LOTAN, NOW);
  assert(feed.activity.length === home.ACTIVITY_LIMIT && feed.activity[0].id === "n8" && feed.activity[7].id === "n1", "activity keeps the eight newest publishes");

  const channeled = rosterState({
    channels: [
      { id: "ch_soc", name: "SOC", default: true, memberIds: [NIR.id, LOTAN.id] },
      { id: "ch_bridge", name: "Bridge", memberIds: [NIR.id, SHOSH.id] }
    ],
    weeks: {
      "2026-10-25": { channelId: "ch_soc", published: true, assignments: { "4.morning": [LOTAN.id] } },
      "ch_bridge|2026-11-01": { published: true, assignments: { "0.morning": [LOTAN.id, SHOSH.id] } },
      "2026-11-08": { channelId: "ch_bridge", published: true, assignments: { "1.evening": [NIR.id] } }
    },
    notifications: [
      { id: "n_soc", type: "schedule_published", title: "Schedule published", body: "Schedule published by Nir Itzik.", createdAt: "2026-10-20T00:00:00.000Z", channelId: "ch_soc", week: "2026-10-25", actor: { id: NIR.id, name: NIR.name, email: NIR.email }, readBy: {} },
      { id: "n_bridge", type: "schedule_published", title: "Schedule published", body: "Schedule published by Nir Itzik.", createdAt: "2026-10-21T00:00:00.000Z", channelId: "ch_bridge", week: "2026-11-01", actor: { id: NIR.id, name: NIR.name, email: NIR.email }, readBy: {} }
    ]
  });
  const lotanCh = home.buildHome(channeled, LOTAN, NOW);
  assert(lotanCh.thisWeek.shiftCount === 1 && lotanCh.nextShift.channelId === "ch_soc", "a worker only sees shifts on their team");
  assert(lotanCh.activity.length === 1 && lotanCh.activity[0].id === "n_soc", "bridge publish is not this worker's activity");
  const nirCh = home.buildHome(channeled, NIR, NOW);
  assert(nirCh.thisWeek.shiftCount === 0 && nirCh.nextShift.shiftId === "evening" && nirCh.nextShift.week === "2026-11-08", "nir's next shift is his own, not a teammate's");
  assert(nirCh.activity.map(n => n.id).join() === "n_bridge,n_soc", "an admin on both teams sees both publishes");
  const socOnly = home.buildHome(channeled, NIR, NOW, { channelId: "ch_soc" });
  assert(socOnly.activity.length === 1 && socOnly.activity[0].id === "n_soc", "?channel= keeps the other team's activity out");
  const outsider = home.buildHome(channeled, SHOSH, NOW);
  assert(outsider.nextShift && outsider.nextShift.week === "2026-11-01" && outsider.thisWeek.shiftCount === 0, "bridge shift is Shoshana's, and it is not this week");
}

function attributionChecks() {
  const prev = {
    "2026-11-15": { published: false, assignments: {}, submissions: {} },
    "2026-10-25": { published: true, assignments: { "0.morning": [LOTAN.id] }, submissions: {} }
  };
  const next = {
    "2026-11-15": { published: true, assignments: { "0.morning": [LOTAN.id] }, publishedBy: { name: "Hacker" } },
    "2026-10-25": { published: true, assignments: { "0.morning": [LOTAN.id] }, publishedBy: { name: "Hacker" }, publishedAt: "1999-01-01T00:00:00.000Z" },
    "2026-11-22": { published: true, assignments: {} }
  };
  const worker = home.attributePublishes(prev, next, LOTAN, "2026-10-29T10:00:00.000Z", []);
  assert(worker.length === 0, "a worker publish creates no event");
  assert(next["2026-11-15"].published === false && !next["2026-11-15"].publishedBy, "a worker cannot publish a draft");
  assert(next["2026-10-25"].published === true && !next["2026-10-25"].publishedBy && !next["2026-10-25"].publishedAt, "a worker cannot forge publishedBy on a legacy week");
  assert(next["2026-11-22"].published === false, "a worker cannot publish a week the server has not seen");

  const again = {
    "2026-11-15": { published: true, assignments: { "0.morning": [LOTAN.id] } },
    "2026-10-25": { published: true, publishedBy: { name: "Hacker" }, publishedAt: "1999-01-01T00:00:00.000Z" }
  };
  const stamped = "2026-10-29T11:00:00.000Z";
  const events = home.attributePublishes(prev, again, NIR, stamped, []);
  assert(events.length === 1 && events[0].week === "2026-11-15" && events[0].publishedBy.email === NIR.email, "admin publish records that admin");
  assert(again["2026-11-15"].publishedAt === stamped && again["2026-11-15"].publishedBy.name === NIR.name, "the week stores publishedBy and publishedAt");
  assert(events[0].channelId == null, "implicit team publish has no channel");
  assert(!again["2026-10-25"].publishedBy && !again["2026-10-25"].publishedAt, "saving a week that was already published does not invent an actor");

  const keep = {
    "2026-11-15": { published: true, assignments: {} }
  };
  const kept = home.attributePublishes({ "2026-11-15": again["2026-11-15"] }, keep, NIR, "2026-12-01T00:00:00.000Z", []);
  assert(kept.length === 0 && keep["2026-11-15"].publishedAt === stamped && keep["2026-11-15"].publishedBy.email === NIR.email, "a later save keeps the original publisher");

  const cleared = { "2026-11-15": { published: false, publishedBy: { name: NIR.name }, publishedAt: stamped } };
  const off = home.attributePublishes({ "2026-11-15": again["2026-11-15"] }, cleared, NIR, "2026-12-02T00:00:00.000Z", []);
  assert(off.length === 0 && cleared["2026-11-15"].published === false && !cleared["2026-11-15"].publishedBy, "unpublishing clears the actor");

  const other = { id: "e_shoshana_avni", name: "Shoshana Avni", email: SHOSH.email, admin: true };
  const republish = { "2026-11-15": { published: true } };
  const second = home.attributePublishes(cleared, republish, other, "2026-12-03T00:00:00.000Z", [
    { id: "ch_bridge", name: "Bridge", memberIds: [NIR.id, SHOSH.id] }
  ]);
  assert(second.length === 1 && second[0].publishedBy.email === SHOSH.email && second[0].channelId === "ch_bridge", "republish attributes the admin who published this time");
  assert(republish["2026-11-15"].publishedBy.email === SHOSH.email, "the week now names the new publisher");
}

async function main() {
  console.log("hour math");
  mathChecks();
  console.log("publish attribution");
  attributionChecks();

  const state = rosterState({
    weeks: lotanWeeks(),
    notifications: [{
      id: "n_old",
      type: "schedule_published",
      title: "Schedule published",
      body: "Schedule for 27 Sep – 3 Oct published by Nir Itzik.",
      createdAt: "2026-09-20T08:00:00.000Z",
      week: "2026-09-27",
      actor: { id: NIR.id, name: NIR.name, email: NIR.email },
      readBy: { e_lotan_hadad: "2026-09-20T09:00:00.000Z" }
    }]
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-home-"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(storeDoc(state)));
  const port = 39351;
  console.log("home route on", port);
  let server = await startServer(port, dir, { HOME_NOW: NOW });
  let nir;
  let lotan;
  try {
    const anon = await req(port, "GET", "/api/me/home");
    assert(anon.status === 401 && anon.json.error === "auth_required", "home requires a session");
    lotan = await signIn(port, LOTAN.email);
    nir = await signIn(port, NIR.email);
    const got = await req(port, "GET", "/api/me/home", { token: lotan });
    const expected = home.buildHome(state, LOTAN, NOW);
    assert(got.status === 200 && JSON.stringify(got.json) === JSON.stringify(expected), "GET /api/me/home matches the fixture");
    const implicit = await req(port, "GET", "/api/me/home?channel=ch_default", { token: lotan });
    assert(implicit.status === 200 && implicit.json.thisWeek.scheduledHours === expected.thisWeek.scheduledHours, "implicit ?channel=ch_default is the same home");
    const missing = await req(port, "GET", "/api/me/home?channel=ch_nope", { token: lotan });
    assert(missing.status === 404 && missing.json.error === "unknown_channel", "unknown team is 404");

    const before = await req(port, "GET", "/api/state", { token: nir });
    const unchanged = JSON.parse(JSON.stringify(before.json.state));
    const keep = await req(port, "PUT", "/api/state", { token: nir, body: { version: before.json.version, state: unchanged } });
    assert(keep.status === 200, "admin can save without publishing");
    const still = await req(port, "GET", "/api/state", { token: nir });
    assert(!still.json.state.weeks["2026-10-25"].publishedBy, "an already-published week does not gain an actor on an ordinary save");
    const notesBefore = await req(port, "GET", "/api/notifications", { token: lotan });
    assert(notesBefore.json.notifications.length === 1 && notesBefore.json.notifications[0].id === "n_old", "ordinary save does not add a publish notification");

    const publishing = JSON.parse(JSON.stringify(still.json.state));
    publishing.weeks["2026-11-15"].published = true;
    publishing.weeks["2026-11-15"].assignments = { "0.morning": [LOTAN.id] };
    const pub = await req(port, "PUT", "/api/state", { token: nir, body: { version: still.json.version, state: publishing } });
    assert(pub.status === 200, "admin publish saves");
    const after = await req(port, "GET", "/api/state", { token: nir });
    const week = after.json.state.weeks["2026-11-15"];
    assert(week.published === true && week.publishedBy.email === NIR.email && week.publishedBy.name === NIR.name, "publishedBy is the admin who published");
    assert(typeof week.publishedAt === "string" && week.publishedAt.length > 0, "publishedAt is stored");
    const notes = await req(port, "GET", "/api/notifications", { token: lotan });
    const fresh = notes.json.notifications.filter(n => n.id !== "n_old");
    assert(fresh.length === 1 && fresh[0].type === "schedule_published", "publish appends one schedule_published row");
    assert(fresh[0].actor.email === NIR.email && fresh[0].body === "Schedule for " + reminders.weekLabel("2026-11-15") + " published by Nir Itzik.", "the row says who published");
    assert(fresh[0].week === "2026-11-15" && fresh[0].id.indexOf("n_sp_") === 0 && !("recipientIds" in fresh[0]), "the row is a normal bell item");
    const homeAfter = await req(port, "GET", "/api/me/home", { token: lotan });
    assert(homeAfter.json.activity[0].id === fresh[0].id && homeAfter.json.activity[1].id === "n_old", "home activity lists the new publish first");
    assert(homeAfter.json.activity[1].readAt === "2026-09-20T09:00:00.000Z", "the older row keeps its read time");
    assert(homeAfter.json.nextShift.shiftId === "morning" && homeAfter.json.nextShift.date === "2026-10-29", "a November publish does not replace the in-progress shift");
    assert(homeAfter.json.thisMonth.actualHours === 24 && homeAfter.json.thisWeek.scheduledHours === 32.5, "the new shift is outside this week and this month");

    const againState = JSON.parse(JSON.stringify(after.json.state));
    delete againState.weeks["2026-11-15"].publishedBy;
    delete againState.weeks["2026-11-15"].publishedAt;
    const again = await req(port, "PUT", "/api/state", { token: nir, body: { version: after.json.version, state: againState } });
    assert(again.status === 200, "second save of a live week succeeds");
    const kept = await req(port, "GET", "/api/state", { token: nir });
    assert(kept.json.state.weeks["2026-11-15"].publishedAt === week.publishedAt && kept.json.state.weeks["2026-11-15"].publishedBy.email === NIR.email, "the original publisher stays");
    const notesKept = await req(port, "GET", "/api/notifications", { token: lotan });
    assert(notesKept.json.notifications.filter(n => n.type === "schedule_published").length === 2, "a second save does not publish again");

    const workerEdit = JSON.parse(JSON.stringify(kept.json.state));
    workerEdit.weeks["2026-11-15"].published = false;
    workerEdit.weeks["2026-11-15"].publishedBy = { id: LOTAN.id, name: "Hacker", email: LOTAN.email };
    workerEdit.weeks["2026-11-15"].submissions[LOTAN.id] = { cells: { "0.morning": "yes" }, note: "lotan", submittedAt: "2026-10-29T10:00:00.000Z" };
    workerEdit.weeks["2026-11-22"] = { published: true, locked: false, assignments: { "0.morning": [LOTAN.id] }, submissions: {} };
    const workerPut = await req(port, "PUT", "/api/state", { token: lotan, body: { version: kept.json.version, state: workerEdit } });
    assert(workerPut.status === 200, "worker can still save");
    const guarded = await req(port, "GET", "/api/state", { token: nir });
    const guardedWeek = guarded.json.state.weeks["2026-11-15"];
    assert(guardedWeek.published === true && guardedWeek.publishedBy.email === NIR.email, "worker save cannot unpublish or replace the actor");
    assert(guardedWeek.submissions[LOTAN.id].note === "lotan", "worker save still stores the submission");
    assert(guarded.json.state.weeks["2026-11-22"].published === false && !guarded.json.state.weeks["2026-11-22"].publishedBy, "worker cannot publish a new week");
  } finally {
    await stopServer(server);
  }

  console.log("publishedBy survives restart");
  server = await startServer(port, dir, { HOME_NOW: NOW });
  try {
    const token = await signIn(port, NIR.email);
    const again = await req(port, "GET", "/api/state", { token });
    assert(again.json.state.weeks["2026-11-15"].publishedBy.email === NIR.email, "publishedBy is still on the week after restart");
    const notes = await req(port, "GET", "/api/notifications", { token });
    assert(notes.json.notifications.some(n => n.actor && n.actor.email === NIR.email && n.week === "2026-11-15"), "the publish notification survived restart");
  } finally {
    await stopServer(server);
  }

  const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-home-ch-"));
  const channelState = rosterState({
    channels: [
      { id: "ch_soc", name: "SOC", default: true, memberIds: [NIR.id, LOTAN.id] },
      { id: "ch_bridge", name: "Bridge", memberIds: [NIR.id, SHOSH.id] }
    ],
    weeks: {
      "2026-10-25": {
        channelId: "ch_soc",
        locked: false,
        published: true,
        assignments: { "4.morning": [LOTAN.id], "4.evening": [NIR.id] },
        submissions: {}
      },
      "2026-11-01": {
        channelId: "ch_bridge",
        locked: false,
        published: false,
        assignments: { "0.morning": [SHOSH.id] },
        submissions: {}
      }
    }
  });
  fs.writeFileSync(path.join(channelDir, "state.json"), JSON.stringify(storeDoc(channelState)));
  const channelPort = 39361;
  console.log("team home on", channelPort);
  server = await startServer(channelPort, channelDir, { HOME_NOW: NOW });
  try {
    const lotanToken = await signIn(channelPort, LOTAN.email);
    const nirToken = await signIn(channelPort, NIR.email);
    const shoshToken = await signIn(channelPort, SHOSH.email);
    const lotanHome = await req(channelPort, "GET", "/api/me/home", { token: lotanToken });
    const lotanExpected = home.buildHome(channelState, LOTAN, NOW);
    assert(lotanHome.status === 200 && JSON.stringify(lotanHome.json) === JSON.stringify(lotanExpected), "team home matches the fixture for that member");
    assert(lotanHome.json.thisWeek.shiftCount === 1 && lotanHome.json.thisMonth.actualHours === 0, "Lotan's in-progress morning is scheduled, not actual");
    const forbidden = await req(channelPort, "GET", "/api/me/home?channel=ch_bridge", { token: lotanToken });
    assert(forbidden.status === 403 && forbidden.json.error === "not_a_member", "home refuses another team");
    const bridge = await req(channelPort, "GET", "/api/state?channel=ch_bridge", { token: nirToken });
    const editing = JSON.parse(JSON.stringify(bridge.json.state));
    editing.weeks["2026-11-01"].published = true;
    const pub = await req(channelPort, "PUT", "/api/state?channel=ch_bridge", {
      token: nirToken,
      body: { version: bridge.json.version, state: editing }
    });
    assert(pub.status === 200, "admin publishes the bridge week");
    const bridgeNow = await req(channelPort, "GET", "/api/state?channel=ch_bridge", { token: nirToken });
    assert(bridgeNow.json.state.weeks["2026-11-01"].publishedBy.email === NIR.email, "bridge week remembers who published");
    const shoshNotes = await req(channelPort, "GET", "/api/notifications", { token: shoshToken });
    assert(shoshNotes.json.notifications.length === 1 && shoshNotes.json.notifications[0].channelId === "ch_bridge", "bridge members get the publish row");
    assert(shoshNotes.json.notifications[0].body.indexOf("published by Nir Itzik") > 0, "bridge row names the publisher");
    const lotanNotes = await req(channelPort, "GET", "/api/notifications", { token: lotanToken });
    assert(lotanNotes.json.notifications.length === 0, "the other team does not see the publish");
    const shoshHome = await req(channelPort, "GET", "/api/me/home", { token: shoshToken });
    assert(shoshHome.json.activity.length === 1 && shoshHome.json.nextShift.date === "2026-11-01" && shoshHome.json.nextShift.hours === 8, "Shoshana's home shows the published morning");
    const lotanStill = await req(channelPort, "GET", "/api/me/home", { token: lotanToken });
    assert(lotanStill.json.activity.length === 0 && lotanStill.json.thisWeek.scheduledHours === 8, "Lotan's home ignores the other team");

    const soc = await req(channelPort, "GET", "/api/state?channel=ch_soc", { token: lotanToken });
    const tamper = JSON.parse(JSON.stringify(soc.json.state));
    tamper.weeks["2026-10-25"].published = false;
    tamper.weeks["2026-10-25"].publishedBy = { name: "Hacker", email: LOTAN.email };
    const tamperPut = await req(channelPort, "PUT", "/api/state?channel=ch_soc", {
      token: lotanToken,
      body: { version: soc.json.version, state: tamper }
    });
    assert(tamperPut.status === 200, "member save on a live week still stores");
    const socNow = await req(channelPort, "GET", "/api/state?channel=ch_soc", { token: nirToken });
    assert(socNow.json.state.weeks["2026-10-25"].published === true && !socNow.json.state.weeks["2026-10-25"].publishedBy, "member save cannot unpublish a legacy week or invent an actor");
  } finally {
    await stopServer(server);
  }

  if (failed) {
    console.error("\n" + failed + " failed");
    process.exit(1);
  }
  console.log("\nall home checks passed");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
