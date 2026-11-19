/*
 * Pixel Battle server (Node.js + ws)
 *
 * PROTOCOL (all messages are JSON)
 *
 * Client -> Server
 *   {type:"hello", playerId?:string, team?:0..3}
 *                                         first message; reuse a saved playerId to keep team and cooldown.
 *                                         team = the team the player picked. Only used the first time (when the
 *                                         server does not already know this player); a returning player keeps
 *                                         their team. Without a valid team, the smallest team is assigned.
 *   {type:"newgame", confirm:true}        wipe the canvas, the whole history and ALL teams (any player; rate
 *                                         limited). Every player must pick a team again. The client must show its
 *                                         own "are you sure?" prompt.
 *   hello also carries game:string        the gameId the client was told in "teams"/"init"; a stale one is refused
 *   {type:"action", tool, colour, pixels} tool: pen|line|circle|polygon|fill
 *                                         colour: integer 0..19 (0-15 palette, 16-19 team colours)
 *                                         pixels: flat array [x0,y0,x1,y1,...] computed by the client's own tools
 *   {type:"undo"}                         revert your own last action (free, no cooldown). Pixels someone else has
 *                                         since overwritten are left alone.
 *   {type:"replay"}                       request the full action log
 *
 * Server -> Client
 *   {type:"teams", sizes, gameId}         sent on connect (before hello) and whenever someone joins, so the client
 *                                         can show the team picker with live sizes
 *   {type:"newgame", t, gameId, sizes}    the game was reset: clear the board, everyone picks a team again, then hello
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
const NEWGAME_COOLDOWN_MS = Number(process.env.NEWGAME_COOLDOWN_MS) || 30000;  // min gap between resets (global)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validTeam = (t) => Number.isInteger(t) && t >= 0 && t < NUM_TEAMS;

// ---------- state ----------
const canvas = new Uint8Array(WIDTH * HEIGHT).fill(BLANK);
const counts = new Array(256).fill(0);
const actionLog = [];
const players = new Map();       // playerId -> {id, team, lastActionAt}
const teamSizes = new Array(NUM_TEAMS).fill(0);
let nextActionId = 1;
let lastNewGameAt = 0;
let gameId = "0";                // changes on every new game; "0" for a game that began before new-game existed

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
  if (entry.tool === "newgame") gameId = String(entry.t);   // marker entry written at the start of each new game
  applyAction(entry);
  actionLog.push(entry);
  nextActionId = Math.max(nextActionId, entry.id + 1);
  // rebuild the player list (team + cooldown) from the log
  if (entry.player && validTeam(entry.team)) {
    let p = players.get(entry.player);
    if (!p) { p = { id: entry.player, team: entry.team, lastActionAt: 0 }; players.set(p.id, p); teamSizes[p.team]++; }
    if (entry.tool !== "undo") p.lastActionAt = Math.max(p.lastActionAt, entry.t || 0);
  }
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

// Database writes go through one queue so that a wipe can never overtake (or be overtaken by) earlier inserts.
let dbQueue = Promise.resolve();
function persist(entry) {
  if (pool) {
    dbQueue = dbQueue
      .then(() => pool.query("INSERT INTO entries (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [entry.id, JSON.stringify(entry)]))
      .catch(err => console.error("Failed to store action", entry.id, err.message));
  } else {
    logStream.write(JSON.stringify(entry) + "\n");
  }
}
function wipeStorage() {
  if (pool) {
    dbQueue = dbQueue
      .then(() => pool.query("DELETE FROM entries"))
      .catch(err => console.error("Failed to wipe stored history", err.message));
  } else {
    logStream.end();
    fs.writeFileSync(LOG_FILE, "");
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
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

// Known player (same id) -> keep their team. New player -> the team they picked, or the smallest team if none given.
function getPlayer(requestedId, requestedTeam) {
  if (requestedId && players.has(requestedId)) return players.get(requestedId);
  let team = 0;
  if (validTeam(requestedTeam)) team = requestedTeam;
  else for (let t = 1; t < NUM_TEAMS; t++) if (teamSizes[t] < teamSizes[team]) team = t;
  teamSizes[team]++;
  // keep the client's saved id (e.g. after a server restart) so old actions still belong to them
  const id = typeof requestedId === "string" && UUID_RE.test(requestedId) ? requestedId : crypto.randomUUID();
  const p = { id, team, lastActionAt: 0 };
  players.set(p.id, p);
  return p;
}

const teamsMsg = () => ({ type: "teams", sizes: teamSizes.slice(), gameId });

function sendInit(ws) {
  const retryInMs = Math.max(0, ws.player.lastActionAt + COOLDOWN_MS - Date.now());
  send(ws, { type: "init", gameId, you: { id: ws.player.id, team: ws.player.team },
    width: WIDTH, height: HEIGHT, blank: BLANK,
    canvas: Buffer.from(canvas).toString("base64"),
    scores: scores(), online: online(), cooldownMs: COOLDOWN_MS, retryInMs });
}

function newGame() {
  canvas.fill(BLANK);
  counts.fill(0);
  actionLog.length = 0;
  nextActionId = 1;
  players.clear();                                  // every player picks a team again
  teamSizes.fill(0);
  for (const c of wss.clients) c.player = null;
  wipeStorage();
  // the first entry of the new log marks the game, so the game id survives a restart
  const marker = { id: nextActionId++, t: Date.now(), player: null, team: null, tool: "newgame", colour: 0, pixels: [] };
  actionLog.push(marker);
  persist(marker);
  gameId = String(marker.t);
  lastNewGameAt = marker.t;
  broadcast({ type: "newgame", t: marker.t, gameId, sizes: teamSizes.slice() });
  broadcast({ type: "score", scores: scores(), online: online() });
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
  send(ws, teamsMsg());

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: "rejected", reason: "bad json" }); }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "hello") {
      if (ws.player) return;
      if (msg.game !== undefined && String(msg.game) !== gameId) return send(ws, teamsMsg());   // stale: pick again
      ws.player = getPlayer(typeof msg.playerId === "string" ? msg.playerId : null, msg.team);
      sendInit(ws);
      broadcast({ type: "score", scores: scores(), online: online() });
      broadcast(teamsMsg());                          // keeps open team pickers up to date
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

    if (msg.type === "newgame") {
      if (msg.confirm !== true) return send(ws, { type: "rejected", reason: "new game needs confirmation" });
      const wait = lastNewGameAt + NEWGAME_COOLDOWN_MS - Date.now();
      if (wait > 0) return send(ws, { type: "rejected", reason: "a new game was started recently", retryInMs: wait });
      return newGame();
    }

    if (msg.type === "replay") {
      const log = actionLog.filter(a => a.tool !== "newgame");
      for (let i = 0; i < log.length; i += REPLAY_CHUNK) {
        send(ws, { type: "replay", actions: log.slice(i, i + REPLAY_CHUNK), done: i + REPLAY_CHUNK >= log.length });
      }
      if (log.length === 0) send(ws, { type: "replay", actions: [], done: true });
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
