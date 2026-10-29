/* Bell + closed-channel checks. No test framework.
   Run: node test/notifications.js
   Spawns server.js against temp data dirs. Does not touch the repo's data files. */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok", msg); return; }
  failed++;
  console.error("  FAIL", msg);
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
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port),
        SHIFTLY_DATA_DIR: dataDir,
        DATABASE_URL: "",
        AUTH_MOCK: "1",
        SMTP_USER: "",
        SMTP_PASS: "",
        REMINDER_DISABLE: "1"
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

async function signIn(port, email) {
  const start = await req(port, "POST", "/api/auth/start", { body: { email } });
  assert(start.status === 200 && start.json && start.json.mode === "mock" && start.json.token, "mock sign-in " + email);
  return start.json && start.json.token;
}

function byId(list, id) {
  return (list || []).find(n => n.id === id) || null;
}

function fixture() {
  return {
    version: 3,
    rosterVersion: 1,
    state: {
      settings: {
        company: "Cybereason",
        shifts: [
          { id: "morning", name: "Morning", start: "07:00", end: "15:00" },
          { id: "night", name: "Night", start: "23:00", end: "07:00" }
        ],
        required: { morning: 1, night: 1 }
      },
      employees: [
        { id: "e_nir_itzik", name: "Nir Itzik", email: "nir.itzik@cybereason.com", admin: true, position: "Manager" },
        { id: "e_lotan_hadad", name: "Lotan Hadad", email: "lotan.hadad@cybereason.com", admin: false, position: "Shift worker" },
        { id: "e_shoshana_avni", name: "Shoshana Avni", email: "shoshana.avni@cybereason.com", admin: false, position: "Shift worker" },
        { id: "e_ori_hai", name: "Ori Hai", email: "ori.hai@cybereason.com", admin: false, position: "Shift worker" }
      ],
      weeks: {
        "2026-11-01": {
          channelId: "ch_soc",
          locked: false,
          published: true,
          assignments: { "1.night": ["e_nir_itzik"] },
          submissions: {},
          note: "soc-secret"
        },
        "2026-11-08": {
          channelId: "ch_bridge",
          locked: false,
          published: true,
          assignments: { "0.morning": ["e_shoshana_avni"] },
          submissions: {},
          note: "bridge-secret"
        }
      },
      notifications: [
        { id: "n_pub", type: "schedule_published", title: "SOC week is live", body: "Night shift posted", createdAt: "2026-10-01T10:00:00.000Z", readAt: null, channelId: "ch_soc", week: "2026-11-01", dayIdx: 1, shiftId: "night", recipientIds: ["e_nir_itzik"] },
        { id: "n_open", type: "open_shift", title: "Open night", body: "Cover needed", createdAt: "2026-10-02T10:00:00.000Z", readAt: null, channelId: "ch_soc", week: "2026-11-01", dayIdx: 1, shiftId: "night", recipientIds: [] },
        { id: "n_swap", type: "swap_request", title: "Swap Tuesday", body: "Lotan asked", createdAt: "2026-10-03T10:00:00.000Z", readAt: null, channelId: "ch_soc", week: "2026-11-01", dayIdx: 2, shiftId: "morning", recipientIds: ["e_lotan_hadad"] },
        { id: "n_rem", type: "availability_reminder", title: "Submit availability", body: "Due Monday", createdAt: "2026-10-04T10:00:00.000Z", readAt: "2026-10-04T12:00:00.000Z", channelId: "ch_soc", week: "2026-11-01", recipientIds: ["e_nir_itzik"] },
        { id: "n_bridge", type: "schedule_published", title: "Bridge posted", body: "Morning is up", createdAt: "2026-10-05T10:00:00.000Z", readAt: null, channelId: "ch_bridge", week: "2026-11-08", dayIdx: 0, shiftId: "morning", recipientIds: ["e_nir_itzik"] },
        { id: "n_bogus", type: "water_cooler", title: "Nope", body: "ignored", createdAt: "2026-10-06T10:00:00.000Z", readAt: null, recipientIds: [] }
      ],
      channels: [
        { id: "ch_soc", name: "SOC", default: true, memberIds: ["e_nir_itzik", "e_lotan_hadad"] },
        { id: "ch_bridge", name: "Bridge", memberIds: ["e_nir_itzik", "e_shoshana_avni"] }
      ]
    }
  };
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert(html.includes('aria-label="Team"'), "team switcher is in the chrome");
  assert(html.includes('aria-label="Notifications'), "bell button is in the chrome");
  assert(html.includes("You're all caught up"), "empty notification copy");
  assert(html.includes("/api/notifications") || html.includes("api/notifications"), "client calls /api/notifications");
  assert(html.includes("api/channels"), "client calls /api/channels");
  ["schedule_published", "swap_request", "availability_reminder", "open_shift"].forEach(type => {
    assert(html.includes(type), "client knows " + type);
  });
  assert(html.includes("A link on its own"), "closed-team empty state");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-notes-"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(fixture()));
  const port = 39111;
  console.log("channels + notifications on", port);
  let server = await startServer(port, dir);
  let nir;
  let lotan;
  try {
    const anon = await req(port, "GET", "/api/notifications");
    assert(anon.status === 401 && anon.json.error === "auth_required", "notifications require a session");
    const anonCh = await req(port, "GET", "/api/channels");
    assert(anonCh.status === 401, "channels require a session");

    nir = await signIn(port, "nir.itzik@cybereason.com");
    lotan = await signIn(port, "lotan.hadad@cybereason.com");
    const shosh = await signIn(port, "shoshana.avni@cybereason.com");
    const ori = await signIn(port, "ori.hai@cybereason.com");

    const nirCh = await req(port, "GET", "/api/channels", { token: nir });
    assert(nirCh.status === 200, "nir channel list");
    const nirIds = (nirCh.json.channels || []).map(c => c.id).sort();
    assert(JSON.stringify(nirIds) === JSON.stringify(["ch_bridge", "ch_soc"]), "nir sees only his teams");
    assert(nirCh.json.channels.every(c => c.role === "admin" && c.implicit === false), "nir is admin on both");

    const lotanCh = await req(port, "GET", "/api/channels", { token: lotan });
    assert((lotanCh.json.channels || []).map(c => c.id).join() === "ch_soc", "lotan does not see Bridge");
    assert(lotanCh.json.channels[0].role === "member", "lotan is a member");

    const oriCh = await req(port, "GET", "/api/channels", { token: ori });
    assert(oriCh.status === 200 && oriCh.json.channels.length === 0, "ori is on no team");

    const lotanBridge = await req(port, "GET", "/api/state?channel=ch_bridge", { token: lotan });
    assert(lotanBridge.status === 403 && lotanBridge.json.error === "not_a_member", "lotan cannot open Bridge");
    const missing = await req(port, "GET", "/api/state?channel=ch_nope", { token: nir });
    assert(missing.status === 404 && missing.json.error === "unknown_channel", "unknown channel is 404");

    const nirDefault = await req(port, "GET", "/api/state", { token: nir });
    assert(nirDefault.status === 200 && nirDefault.json.scoped === true && nirDefault.json.channelId === "ch_soc", "default state is nir's default team");
    assert(nirDefault.json.state.weeks["2026-11-01"] && nirDefault.json.state.weeks["2026-11-01"].note === "soc-secret", "soc week is in the default payload");
    assert(!nirDefault.json.state.weeks["2026-11-08"], "bridge week is not in the soc payload");
    assert(!nirDefault.text.includes("bridge-secret"), "bridge note is not in the soc body");
    const socEmails = nirDefault.json.state.employees.map(e => e.email).sort();
    assert(JSON.stringify(socEmails) === JSON.stringify(["lotan.hadad@cybereason.com", "nir.itzik@cybereason.com"]), "soc roster is just its members");

    const bridge = await req(port, "GET", "/api/state?channel=ch_bridge", { token: nir });
    assert(bridge.json.channelId === "ch_bridge" && bridge.json.state.weeks["2026-11-08"].note === "bridge-secret", "nir can open Bridge");
    assert(!bridge.text.includes("soc-secret"), "soc note stays off the bridge payload");

    const shoshState = await req(port, "GET", "/api/state", { token: shosh });
    assert(shoshState.json.channelId === "ch_bridge" && !shoshState.text.includes("soc-secret"), "shoshana lands on Bridge only");

    const oriState = await req(port, "GET", "/api/state", { token: ori });
    assert(oriState.json.scoped === true && oriState.json.channelId === null, "ori gets an empty scope");
    assert(oriState.json.state.employees.length === 1 && oriState.json.state.employees[0].email === "ori.hai@cybereason.com", "ori sees only himself");
    assert(!oriState.text.includes("soc-secret") && !oriState.text.includes("bridge-secret"), "ori cannot read either schedule");

    const barePut = await req(port, "PUT", "/api/state", { token: nir, body: { version: nirDefault.json.version, state: nirDefault.json.state } });
    assert(barePut.status === 400 && barePut.json.error === "channel_required", "unscoped save is refused once teams exist");

    const nirNotes = await req(port, "GET", "/api/notifications", { token: nir });
    const nirNoteIds = nirNotes.json.notifications.map(n => n.id);
    assert(JSON.stringify(nirNoteIds) === JSON.stringify(["n_bridge", "n_rem", "n_open", "n_pub"]), "nir's list is newest first and skips other people's items");
    assert(!nirNoteIds.includes("n_bogus") && !nirNoteIds.includes("n_swap"), "unknown types and other recipients stay hidden");
    assert(byId(nirNotes.json.notifications, "n_rem").readAt && !byId(nirNotes.json.notifications, "n_pub").readAt, "read flag is per item");
    assert(byId(nirNotes.json.notifications, "n_pub").week === "2026-11-01" && byId(nirNotes.json.notifications, "n_pub").dayIdx === 1 && byId(nirNotes.json.notifications, "n_pub").shiftId === "night", "navigation fields survive");
    assert(!("recipientIds" in byId(nirNotes.json.notifications, "n_open")), "recipient list is not sent to the client");

    const lotanNotes = await req(port, "GET", "/api/notifications", { token: lotan });
    assert(JSON.stringify(lotanNotes.json.notifications.map(n => n.id)) === JSON.stringify(["n_swap", "n_open"]), "lotan sees his swap and the open shift");

    const marked = await req(port, "POST", "/api/notifications/read", { token: lotan, body: { ids: ["n_open", "n_pub"] } });
    assert(marked.status === 200 && byId(marked.json.notifications, "n_open").readAt, "lotan marked the open shift");
    assert(!byId(marked.json.notifications, "n_swap").readAt, "the other row stays unread");
    const nirAfter = await req(port, "GET", "/api/notifications", { token: nir });
    assert(!byId(nirAfter.json.notifications, "n_open").readAt, "lotan's mark-read does not clear nir's copy");

    const one = await req(port, "POST", "/api/notifications/n_pub/read", { token: nir });
    assert(one.status === 200 && byId(one.json.notifications, "n_pub").readAt && !byId(one.json.notifications, "n_bridge").readAt, "single-id mark-read");

    const all = await req(port, "POST", "/api/notifications/read", { token: nir, body: { all: true } });
    assert(all.status === 200 && all.json.notifications.every(n => n.readAt), "mark all read");
    const bad = await req(port, "POST", "/api/notifications/read", { token: nir, body: {} });
    assert(bad.status === 400 && bad.json.error === "bad_request", "read needs ids or all");

    const beforeSave = await req(port, "GET", "/api/state?channel=ch_soc", { token: lotan });
    const edited = JSON.parse(JSON.stringify(beforeSave.json.state));
    edited.weeks["2026-11-01"].submissions.e_lotan_hadad = { cells: { "1.night": "yes" }, note: "lotan-edit", submittedAt: "2026-10-20T00:00:00.000Z" };
    const save = await req(port, "PUT", "/api/state?channel=ch_soc", {
      token: lotan,
      body: { version: beforeSave.json.version, state: edited }
    });
    assert(save.status === 200 && save.json.ok === true, "member can save their own team");
    const socNow = await req(port, "GET", "/api/state?channel=ch_soc", { token: nir });
    assert(socNow.json.state.weeks["2026-11-01"].submissions.e_lotan_hadad.note === "lotan-edit", "soc submission stuck");
    const bridgeNow = await req(port, "GET", "/api/state?channel=ch_bridge", { token: nir });
    assert(bridgeNow.json.state.weeks["2026-11-08"].note === "bridge-secret", "bridge week survived a soc save");
    const notesAfterSave = await req(port, "GET", "/api/notifications", { token: nir });
    assert(notesAfterSave.json.notifications.every(n => n.readAt), "a schedule save does not wipe read flags");

    const stale = JSON.parse(JSON.stringify(socNow.json.state));
    stale.employees.find(e => e.email === "nir.itzik@cybereason.com").admin = false;
    stale.employees.find(e => e.email === "lotan.hadad@cybereason.com").admin = true;
    const stalePut = await req(port, "PUT", "/api/state?channel=ch_soc", {
      token: nir,
      body: { version: socNow.json.version, state: stale }
    });
    assert(stalePut.status === 200, "scoped save with stale admin bits still stores");
    const afterStale = await req(port, "GET", "/api/state?channel=ch_soc", { token: nir });
    assert(afterStale.json.state.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "scoped save cannot demote nir");
    assert(afterStale.json.state.employees.find(e => e.email === "lotan.hadad@cybereason.com").admin === false, "scoped save cannot promote lotan without the team toggle");
    const bridgeAdmins = await req(port, "GET", "/api/state?channel=ch_bridge", { token: nir });
    assert(bridgeAdmins.json.state.weeks["2026-11-08"].note === "bridge-secret", "stale admin save leaves the other team");

    const selfOff = await req(port, "PUT", "/api/state?channel=ch_soc", {
      token: nir,
      body: {
        version: afterStale.json.version,
        state: afterStale.json.state,
        adminToggle: { email: "nir.itzik@cybereason.com", admin: false }
      }
    });
    assert(selfOff.status === 400 && selfOff.json.error === "canonical_admin", "team toggle cannot demote nir on a scoped save");

    const workerToggle = await req(port, "PUT", "/api/state?channel=ch_soc", {
      token: lotan,
      body: {
        version: afterStale.json.version,
        state: afterStale.json.state,
        adminToggle: { email: "lotan.hadad@cybereason.com", admin: true }
      }
    });
    assert(workerToggle.status === 403 && workerToggle.json.error === "admin_required", "worker cannot use the team toggle on a scoped save");

    const promote = await req(port, "PUT", "/api/state?channel=ch_soc", {
      token: nir,
      body: {
        version: afterStale.json.version,
        state: JSON.parse(JSON.stringify(afterStale.json.state)),
        adminToggle: { email: "lotan.hadad@cybereason.com", admin: true }
      }
    });
    assert(promote.status === 200 && promote.json.employees.find(e => e.email === "lotan.hadad@cybereason.com").admin === true, "scoped team toggle can promote a teammate");
    assert(promote.json.employees.find(e => e.email === "nir.itzik@cybereason.com").admin === true, "that toggle leaves nir admin");

    const demote = await req(port, "PUT", "/api/state?channel=ch_soc", {
      token: nir,
      body: {
        version: promote.json.version,
        state: JSON.parse(JSON.stringify(afterStale.json.state)),
        adminToggle: { email: "lotan.hadad@cybereason.com", admin: false }
      }
    });
    assert(demote.status === 200 && demote.json.employees.find(e => e.email === "lotan.hadad@cybereason.com").admin === false, "another admin can demote lotan on purpose");

    edited.employees.push({ id: "e_extra", name: "Extra Person", email: "extra.person@cybereason.com", admin: false, position: "Shift worker" });
    const add = await req(port, "PUT", "/api/state?channel=ch_soc", {
      token: lotan,
      body: { version: demote.json.version, state: edited }
    });
    assert(add.status === 403 && add.json.error === "admin_required", "worker cannot add a roster row from a team save");
  } finally {
    await stopServer(server);
  }

  console.log("restart keeps teams and read flags");
  server = await startServer(port, dir);
  try {
    const again = await req(port, "GET", "/api/notifications", { token: nir });
    assert(again.status === 200 && byId(again.json.notifications, "n_bridge").readAt, "read flags survive restart");
    const bridge = await req(port, "GET", "/api/state?channel=ch_bridge", { token: nir });
    assert(bridge.status === 200 && bridge.json.state.weeks["2026-11-08"].note === "bridge-secret", "other team survives restart");
  } finally {
    await stopServer(server);
  }

  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-notes-fresh-"));
  const freshPort = 39112;
  console.log("empty channels on", freshPort);
  server = await startServer(freshPort, freshDir);
  try {
    const token = await signIn(freshPort, "nir.itzik@cybereason.com");
    const channels = await req(freshPort, "GET", "/api/channels", { token });
    assert(channels.json.channels.length === 1 && channels.json.channels[0].id === "ch_default" && channels.json.channels[0].implicit === true, "no stored teams → one implicit team");
    assert(channels.json.channels[0].name === "Cybereason", "implicit team uses the company name");
    const notes = await req(freshPort, "GET", "/api/notifications", { token });
    assert(notes.status === 200 && notes.json.notifications.length === 0, "fresh bell is empty");
    const state = await req(freshPort, "GET", "/api/state", { token });
    assert(state.status === 200 && !state.json.scoped && state.json.state.employees.length === 14, "v1 state stays whole when channels is empty");
    const put = await req(freshPort, "PUT", "/api/state", {
      token,
      body: { version: state.json.version, state: state.json.state }
    });
    assert(put.status === 200, "v1 save still works without ?channel=");
  } finally {
    await stopServer(server);
  }

  if (failed) {
    console.error("\n" + failed + " failed");
    process.exit(1);
  }
  console.log("\nall notification and channel checks passed");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
