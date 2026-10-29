/* Home screen reads GET /api/me/home. Run: node test/home-ui.js
   Needs Google Chrome. Does not replace test/home.js. */
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
function startServer(port, dataDir) {
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
      }),
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
  });
}
function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve();
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 2000);
  });
}
function startChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-chrome-"));
  return new Promise((resolve, reject) => {
    const child = spawn("google-chrome", [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
      "--remote-debugging-port=0", "--user-data-dir=" + dir, "about:blank"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("chrome did not start\n" + log));
    }, 10000);
    function onData(buf) {
      log += buf.toString();
      const m = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolve({ child, port: +m[1] });
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}
function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathname }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    }).on("error", reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connectChrome(port) {
  let page = null;
  for (let i = 0; i < 20 && !page; i++) {
    const list = await getJson(port, "/json/list");
    page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) await sleep(100);
  }
  if (!page) throw new Error("no chrome page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  });
  function send(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || "eval failed");
    }
    return result.result && result.result.value;
  }
  async function waitFor(expression, ms) {
    const start = Date.now();
    while (Date.now() - start < (ms || 8000)) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (e) {}
      await sleep(150);
    }
    const text = await evaluate("document.body ? document.body.innerText.slice(0, 600) : ''").catch(() => "");
    throw new Error("timed out\n" + text);
  }
  return { send, evaluate, waitFor };
}

function htmlHas(html, text) {
  assert(html.includes(text), "index has " + text);
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  htmlHas(html, "api/me/home");
  htmlHas(html, "Hours this month (scheduled)");
  htmlHas(html, "Actual hours this month");
  htmlHas(html, "Home isn't available on this server");
  htmlHas(html, "Couldn't load your home");
  htmlHas(html, '["home","Home"]');
  htmlHas(html, '["submit","My availability"]');
  assert(!html.includes("function homeSummary"), "page does not recompute home hours");
  assert(!html.includes("function shiftLengthHours"), "page does not measure shifts itself");

  if (!fs.existsSync("/usr/local/bin/google-chrome") && !fs.existsSync("/usr/bin/google-chrome")) {
    console.log("  skip browser");
    if (failed) process.exit(1);
    console.log("home ui ok");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftly-home-ui-"));
  const port = 39471;
  const server = await startServer(port, dir);
  let chrome = null;
  const shots = path.join(os.tmpdir(), "shiftly-shots");
  fs.mkdirSync(shots, { recursive: true });
  try {
    chrome = await startChrome();
    const cdp = await connectChrome(chrome.port);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    async function setViewport(width, height) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: width < 700
      });
    }
    async function shot(name) {
      const metrics = await cdp.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize || { width: 1280, height: 900 };
      const result = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(2200, Math.ceil(size.height)), scale: 1 }
      });
      const file = path.join(shots, name);
      fs.writeFileSync(file, Buffer.from(result.data, "base64"));
      console.log("  shot", file);
    }
    async function signIn(email, greeting) {
      const onForm = await cdp.evaluate("!!document.getElementById('si-email')").catch(() => false);
      if (!onForm) {
        await cdp.evaluate("document.documentElement.dataset.nav='old'").catch(() => {});
        await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + port + "/" });
        await cdp.waitFor("document.documentElement.dataset.nav !== 'old' && !!document.getElementById('si-email')");
      }
      await cdp.evaluate(`
        document.getElementById("si-email").value = ${JSON.stringify(email)};
        document.querySelector(".signin-card form").requestSubmit();
      `);
      await cdp.waitFor("document.body && document.body.innerText.includes(" + JSON.stringify(greeting) + ")");
    }
    async function clickTab(label) {
      const ok = await cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll(".seg button")].find(b => b.textContent === ${JSON.stringify(label)});
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(ok, "click " + label);
    }
    function hoursText(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      return String(Math.round(n * 100) / 100);
    }

    await setViewport(1280, 900);
    await signIn("nir.itzik@cybereason.com", "Hi, Nir");
    await cdp.waitFor("document.body.innerText.includes('Shiftly does not record clock-in.')");
    const token = await cdp.evaluate("localStorage.getItem('shiftly.token')");
    const api = await req(port, "GET", "/api/me/home", { token });
    assert(api.status === 200 && api.json && api.json.hoursNote, "home API responds for the admin");
    const shown = await cdp.evaluate(`(() => {
      const stats = [...document.querySelectorAll(".home-stats .stat")].map(el => [el.querySelector(".k").textContent, el.querySelector(".v").textContent]);
      const text = document.body.innerText;
      const cards = [...document.querySelectorAll(".home-split .card")].map(el => el.getBoundingClientRect());
      return {
        byK: Object.fromEntries(stats),
        note: text.includes(${JSON.stringify(api.json.hoursNote)}),
        tabs: [...document.querySelectorAll(".seg button")].map(b => b.textContent),
        weeknav: !!document.querySelector(".weeknav"),
        sideBySide: cards.length === 2 && cards[1].left >= cards[0].right - 2,
        next: text.includes("Next shift")
      };
    })()`);
    const week = api.json.thisWeek || {};
    const month = api.json.thisMonth || {};
    assert(JSON.stringify(shown.tabs) === JSON.stringify(["Home", "Availability", "My availability", "Schedule", "Team", "Settings"]), "admin tabs keep the old set and add Home");
    assert(shown.weeknav === false, "home hides the week arrows");
    assert(shown.byK["Shifts this week"] === String(week.shiftCount), "week count is the API value");
    assert(shown.byK["Scheduled hours this week"] === hoursText(week.scheduledHours), "week hours are the API value");
    assert(shown.byK["Hours this month (scheduled)"] === hoursText(month.scheduledHours), "scheduled month hours are the API value");
    assert(shown.byK["Actual hours this month"] === hoursText(month.actualHours), "actual month hours are the API value");
    assert(shown.note, "hoursNote is shown as returned");
    assert(shown.next, "next shift card is on the page");
    assert(shown.sideBySide, "recent and activity sit side by side");
    const pastName = api.json.pastShifts && api.json.pastShifts[0] && api.json.pastShifts[0].name;
    if (pastName) {
      const hasPast = await cdp.evaluate("document.body.innerText.includes(" + JSON.stringify(pastName) + ")");
      assert(hasPast, "a completed shift from the API is listed");
    }

    async function waitHome(pred, label) {
      const start = Date.now();
      let last = null;
      while (Date.now() - start < 8000) {
        const got = await req(port, "GET", "/api/me/home", { token });
        last = got.json;
        if (last && pred(last)) return last;
        await sleep(200);
      }
      throw new Error(label + " " + JSON.stringify(last && last.activity));
    }
    await cdp.evaluate("getWeek('2026-08-30').published = false; scheduleSave(true);");
    await waitHome(data => !data.pastShifts.length, "unpublish did not clear past shifts");
    /* The home route updates before doServerSave clears `saving`. A second
       scheduleSave in that window is dropped, so wait until the save is idle. */
    await cdp.waitFor("saving === false", 8000);
    await cdp.evaluate("getWeek('2026-08-30').published = true; scheduleSave(true);");
    await waitHome(data => (data.activity || []).some(n => /published by/i.test(n.body || "")), "publish did not record an actor");
    await cdp.evaluate("loadHome(true)");
    await cdp.waitFor("document.body.innerText.toLowerCase().includes('published by')", 8000);
    const after = await req(port, "GET", "/api/me/home", { token });
    const line = (after.json.activity || []).map(n => n.body || "").join(" ");
    assert(/published by/i.test(line), "activity body names who published");
    const onPage = await cdp.evaluate("document.body.innerText.includes(" + JSON.stringify((after.json.activity[0] && after.json.activity[0].body) || "published by") + ")");
    assert(onPage, "the activity sentence from the API is on the home screen");
    await shot("admin_home_desktop.png");

    await cdp.evaluate(`(() => {
      const orig = window.fetch;
      window.__homeFetch = orig;
      window.fetch = function(url, opts) {
        if (String(url).indexOf("api/me/home") >= 0) {
          return Promise.resolve({ status: 404, ok: false, json: async () => { throw new Error("not json"); } });
        }
        return orig.apply(this, arguments);
      };
      loadHome(true);
    })()`);
    await cdp.waitFor("document.body.innerText.includes(\"Home isn't available on this server\")");
    assert(true, "a 404 shows the empty state instead of invented hours");
    await cdp.evaluate("window.fetch = window.__homeFetch; loadHome(true);");
    await cdp.waitFor("document.body.innerText.includes('Shiftly does not record clock-in.')");

    await clickTab("Availability");
    await cdp.waitFor("document.body.innerText.includes('Availability submissions')");
    await clickTab("My availability");
    await cdp.waitFor("document.body.innerText.includes('Your availability')");
    await clickTab("Schedule");
    await cdp.waitFor("document.body.innerText.includes('Build the schedule')");
    await clickTab("Team");
    await cdp.waitFor("document.body.innerText.includes('firstname.lastname@cybereason.com')");
    await clickTab("Settings");
    await cdp.waitFor("document.body.innerText.includes('Shift hours')");
    await clickTab("Home");
    await cdp.waitFor("document.body.innerText.includes('Actual hours this month')");

    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent === "Sign out");
      btn.click();
    })()`);
    await cdp.waitFor("!!document.getElementById('si-email')");
    await signIn("lotan.hadad@cybereason.com", "Hi, Lotan");
    await cdp.waitFor("document.body.innerText.includes('Shiftly does not record clock-in.')");
    const lotanToken = await cdp.evaluate("localStorage.getItem('shiftly.token')");
    const lotanApi = await req(port, "GET", "/api/me/home", { token: lotanToken });
    const lotanShown = await cdp.evaluate(`(() => {
      const stats = [...document.querySelectorAll(".home-stats .stat")].map(el => [el.querySelector(".k").textContent, el.querySelector(".v").textContent]);
      return {
        tabs: [...document.querySelectorAll(".seg button")].map(b => b.textContent),
        byK: Object.fromEntries(stats)
      };
    })()`);
    assert(JSON.stringify(lotanShown.tabs) === JSON.stringify(["Home", "Submit availability", "Schedule"]), "worker tabs are Home, Submit, Schedule");
    assert(lotanShown.byK["Shifts this week"] === String(lotanApi.json.thisWeek.shiftCount), "worker week count matches their API");
    assert(lotanShown.byK["Actual hours this month"] === hoursText(lotanApi.json.thisMonth.actualHours), "worker actual hours match their API");
    assert(lotanShown.byK["Scheduled hours this week"] !== shown.byK["Scheduled hours this week"] || lotanApi.json.pastShifts.length !== (api.json.pastShifts || []).length, "worker home is not a copy of the admin home");
    await shot("worker_home_desktop.png");

    await setViewport(390, 844);
    const stacked = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll(".home-split .card")].map(el => el.getBoundingClientRect());
      return cards.length === 2 && cards[1].top >= cards[0].bottom - 2;
    })()`);
    assert(stacked, "home cards stack on a phone width");
    await shot("worker_home_mobile.png");

    await clickTab("Submit availability");
    await cdp.waitFor("document.body.innerText.includes('Your availability')");
    await clickTab("Schedule");
    await cdp.waitFor("document.body.innerText.includes('Your shifts this week') || document.body.innerText.includes('Schedule not published yet')");
  } finally {
    if (chrome) await stopChild(chrome.child);
    await stopChild(server);
  }
  if (failed) {
    console.error(failed + " failed");
    process.exit(1);
  }
  console.log("home ui ok");
}
main().catch(err => {
  console.error(err);
  process.exit(1);
});
