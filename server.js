/* Shiftly sync server — zero-dependency Node.
   Serves index.html and a tiny shared-state API:
     GET  /api/state              -> { version, state }
     PUT  /api/state {version, state} -> 200 {ok, version} | 409 current {version, state}
   State lives in state.json (on /data when a Railway volume is mounted, so it
   survives redeploys). First boot seeds from the state embedded in index.html. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const INDEX = path.join(__dirname, "index.html");

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
  persist();
}

function persist() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(store)); }
  catch (e) { console.error("persist failed", e); }
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/api/state") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(store));
    }
    if (req.method === "PUT") {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const st = parsed.state;
          if (!st || !Array.isArray(st.employees) || !st.weeks || !st.settings) throw new Error("bad state");
          if (parsed.version !== store.version) {
            res.writeHead(409, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(store));
          }
          store = { version: store.version + 1, state: st };
          persist();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, version: store.version }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid body" }));
        }
      });
      return;
    }
    res.writeHead(405); return res.end();
  }

  if (url === "/" || url === "/index.html") {
    try {
      const html = fs.readFileSync(INDEX);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(html);
    } catch (e) {
      res.writeHead(500); return res.end("index.html missing");
    }
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log("Shiftly server listening on :" + PORT + " (data: " + STATE_FILE + ")"));
