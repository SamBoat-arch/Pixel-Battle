/*
 * Pixel Battle server (Node.js + ws)
 *
 * PROTOCOL (all messages are JSON)
 *
 * Client -> Server
 *   {type:"hello", playerId?:string}      first message; reuse a saved playerId to keep team and cooldown
 *   {type:"action", tool, colour, pixels} tool: pen|line|circle|polygon|fill
 *                                         colour: integer 0..19 (0-15 palette, 16-19 team colours)
 *                                         pixels: flat array [x0,y0,x1,y1,...] computed by the client's own tools
 *   {type:"undo"}                         revert your own last action (free, no cooldown). Pixels someone else has
 *                                         since overwritten are left alone.
 *   {type:"replay"}                       request the full action log
 *
 * Server -> Client
 *   {type:"init", you:{id,team}, width, height, blank, canvas(base64), scores, online, cooldownMs, retryInMs}
 *   {type:"action", id, t, player, team, tool, colour, pixels}   broadcast to everyone, sender included
 *   {type:"undo", id, t, player, team, target, pixels, colours}   pixels [x,y,...] with one restored colour each
 *   {type:"score", scores:[n0,n1,n2,n3], online}
 *   {type:"rejected", reason, retryInMs?}
 *   {type:"replay", actions:[...], done:boolean}                 sent in chunks
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const WIDTH = 128, HEIGHT = 128;
const BLANK = 255;
const NUM_COLOURS = 20;          // 16 palette + 4 team colours
const TEAM_BASE = 16, NUM_TEAMS = 4;
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS) || 5000;   // override only for load testing
const MAX_PIXELS_PER_ACTION = WIDTH * HEIGHT;
const TOOLS = new Set(["pen", "line", "circle", "polygon", "fill"]);
const LOG_FILE = path.join(__dirname, "actions.jsonl");
const REPLAY_CHUNK = 200;

// ---------- state ----------
const canvas = new Uint8Array(WIDTH * HEIGHT).fill(BLANK);
const counts = new Array(256).fill(0);
const actionLog = [];
const players = new Map();       // playerId -> {id, team, lastActionAt}
const teamSizes = new Array(NUM_TEAMS).fill(0);
let nextActionId = 1;

function setPx(idx, colour) {
  const old = canvas[idx];
  if (old === colour) return;
  if (old !== BLANK) counts[old]--;
  if (colour !== BLANK) counts[colour]++;
  canvas[idx] = colour;
}
// Applies a logged entry. Normal actions paint one colour; undo entries carry one colour per pixel.
// Returns the previous colour of every pixel (used to build undo data for normal actions).
function applyAction(a) {
  const p = a.pixels, prev = [];
  for (let i = 0; i < p.length; i += 2) {
    const idx = p[i + 1] * WIDTH + p[i];
    prev.push(canvas[idx]);
    setPx(idx, a.colours ? a.colours[i / 2] : a.colour);
  }
  return prev;
}
const scores = () => Array.from({ length: NUM_TEAMS }, (_, t) => counts[TEAM_BASE + t]);

// ---------- persistence ----------
// With DATABASE_URL set, every action is stored in Postgres and the canvas is rebuilt from it on startup.
// Without it (local development) the same log is kept in actions.jsonl.
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null, logStream = null;

function restore(entry) {
  applyAction(entry);
  actionLog.push(entry);
  nextActionId = Math.max(nextActionId, entry.id + 1);
}

async function loadHistory() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL, ssl: local ? undefined : { rejectUnauthorized: false } });
    await pool.query("CREATE TABLE IF NOT EXISTS entries (id BIGINT PRIMARY KEY, data JSONB NOT NULL)");
    const { rows } = await pool.query("SELECT data FROM entries ORDER BY id");
    rows.forEach(r => restore(r.data));
    console.log(`Restored ${rows.length} actions from Postgres`);
  } else {
    if (fs.existsSync(LOG_FILE)) {
      for (const line of fs.readFileSync(LOG_FILE, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { restore(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
      }
      console.log(`Restored ${actionLog.length} actions from log file`);
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }
}

function persist(entry) {
  if (pool) {
    pool.query("INSERT INTO entries (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [entry.id, JSON.stringify(entry)])
      .catch(err => console.error("Failed to store action", entry.id, err.message));
  } else {
    logStream.write(JSON.stringify(entry) + "\n");
  }
}

// ---------- http (static files) ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const PUBLIC = path.join(__dirname, "public");
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- websocket ----------
const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
const online = () => wss.clients.size;

function getPlayer(requestedId) {
  if (requestedId && players.has(requestedId)) return players.get(requestedId);
  let team = 0;
  for (let t = 1; t < NUM_TEAMS; t++) if (teamSizes[t] < teamSizes[team]) team = t;
  teamSizes[team]++;
  const p = { id: crypto.randomUUID(), team, lastActionAt: 0 };
  players.set(p.id, p);
  return p;
}

function validate(msg) {
  if (!TOOLS.has(msg.tool)) return "bad tool";
  if (!Number.isInteger(msg.colour) || msg.colour < 0 || msg.colour >= NUM_COLOURS) return "bad colour";
  const p = msg.pixels;
  if (!Array.isArray(p) || p.length === 0 || p.length % 2 !== 0 || p.length / 2 > MAX_PIXELS_PER_ACTION) return "bad pixels";
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return "pixel out of bounds";
  }
  return null;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.player = null;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: "rejected", reason: "bad json" }); }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "hello") {
      if (ws.player) return;
      ws.player = getPlayer(typeof msg.playerId === "string" ? msg.playerId : null);
      const retryInMs = Math.max(0, ws.player.lastActionAt + COOLDOWN_MS - Date.now());
      send(ws, { type: "init", you: { id: ws.player.id, team: ws.player.team },
        width: WIDTH, height: HEIGHT, blank: BLANK,
        canvas: Buffer.from(canvas).toString("base64"),
        scores: scores(), online: online(), cooldownMs: COOLDOWN_MS, retryInMs });
      broadcast({ type: "score", scores: scores(), online: online() });
      return;
    }

    if (!ws.player) return send(ws, { type: "rejected", reason: "send hello first" });

    if (msg.type === "action") {
      const now = Date.now();
      const wait = ws.player.lastActionAt + COOLDOWN_MS - now;
      if (wait > 0) return send(ws, { type: "rejected", reason: "cooldown", retryInMs: wait });
      const err = validate(msg);
      if (err) return send(ws, { type: "rejected", reason: err });
      ws.player.lastActionAt = now;
      const action = { id: nextActionId++, t: now, player: ws.player.id, team: ws.player.team,
        tool: msg.tool, colour: msg.colour, pixels: msg.pixels };
      const prev = applyAction(action);
      ws.player.last = { id: action.id, pixels: action.pixels, colour: action.colour, prev };
      actionLog.push(action);
      persist(action);
      broadcast({ type: "action", ...action });
      scoreDirty = true;
      return;
    }

    if (msg.type === "undo") {
      const L = ws.player.last;
      ws.player.last = null;
      if (!L) return send(ws, { type: "rejected", reason: "nothing to undo" });
      const px = [], cols = [];
      for (let i = L.pixels.length - 2; i >= 0; i -= 2) {      // reverse order handles repeated pixels
        const idx = L.pixels[i + 1] * WIDTH + L.pixels[i];
        const restore = L.prev[i / 2];
        if (canvas[idx] === L.colour && restore !== L.colour) {  // skip pixels someone else has overwritten
          setPx(idx, restore);
          px.push(L.pixels[i], L.pixels[i + 1]); cols.push(restore);
        }
      }
      if (px.length === 0) return send(ws, { type: "rejected", reason: "nothing left to undo (pixels were overwritten)" });
      const entry = { id: nextActionId++, t: Date.now(), player: ws.player.id, team: ws.player.team,
        tool: "undo", target: L.id, pixels: px, colours: cols };
      actionLog.push(entry);
      persist(entry);
      broadcast({ type: "undo", ...entry });
      scoreDirty = true;
      return;
    }

    if (msg.type === "replay") {
      for (let i = 0; i < actionLog.length; i += REPLAY_CHUNK) {
        send(ws, { type: "replay", actions: actionLog.slice(i, i + REPLAY_CHUNK), done: i + REPLAY_CHUNK >= actionLog.length });
      }
      if (actionLog.length === 0) send(ws, { type: "replay", actions: [], done: true });
    }
  });

  ws.on("close", () => { broadcast({ type: "score", scores: scores(), online: online() }); });
});

// throttled score broadcast (at most every 500 ms)
let scoreDirty = false;
setInterval(() => {
  if (scoreDirty) { scoreDirty = false; broadcast({ type: "score", scores: scores(), online: online() }); }
}, 500);

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

loadHistory()
  .then(() => server.listen(PORT, () => console.log(`Pixel Battle on http://localhost:${PORT}`)))
  .catch(err => { console.error("Startup failed:", err.message); process.exit(1); });
