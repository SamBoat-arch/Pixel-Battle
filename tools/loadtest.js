/*
 * Pixel Battle load test.
 * Usage:  node tools/loadtest.js [--url=ws://localhost:3000] [--players=15] [--duration=30]
 *
 * Simulates N players that each draw with a random tool every time their cooldown ends, then reports:
 *   - echo latency:        sender's send -> sender's own broadcast received
 *   - propagation latency: server receive time -> arrival at each client (target: well under 1 s)
 *   - consistency:         every client's canvas must equal the canvas a brand-new player receives
 * Exit code 1 if p95 propagation > 1000 ms or the canvases differ.
 */
const WebSocket = require("ws");
const R = require("../public/rasterizer.js");

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v === undefined ? true : v];
}));
const URL = args.url || "ws://localhost:3000";
const N = +args.players || 15;
const DURATION = (+args.duration || 30) * 1000;
const W = 128;

const echo = [], prop = [];
const stats = { connected: 0, sent: 0, accepted: 0, rejected: 0, reasons: {} };
let stopping = false;

const rnd = n => Math.floor(Math.random() * n);
const pt = () => ({ x: rnd(W), y: rnd(W) });
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : 0;

function applyTo(grid, m) {
  for (let i = 0; i < m.pixels.length; i += 2) grid[m.pixels[i + 1] * W + m.pixels[i]] = m.colour;
}

function randomAction(c) {
  const tool = ["pen", "line", "circle", "polygon", "fill"][rnd(5)];
  const colour = rnd(20);
  let pixels = [];
  if (tool === "pen") { const p = pt(); pixels = [p.x, p.y]; }
  else if (tool === "line") { const a = pt(), b = pt(); pixels = R.line(a.x, a.y, b.x, b.y); }
  else if (tool === "circle") { const a = pt(); pixels = R.circle(a.x, a.y, 2 + rnd(14)); }
  else if (tool === "polygon") { pixels = R.polygon(Array.from({ length: 3 + rnd(3) }, pt)); }
  else { const p = pt(); pixels = R.floodFill((x, y) => c.grid[y * W + x], p.x, p.y, colour); }
  return pixels.length ? { type: "action", tool, colour, pixels } : null;
}

function makeClient(i) {
  const c = { i, grid: new Uint8Array(W * W).fill(255), id: null, sentAt: 0, cooldown: 5000, ws: new WebSocket(URL) };
  const loop = () => {
    if (stopping) return;
    const a = randomAction(c);
    if (a) { c.sentAt = Date.now(); stats.sent++; c.ws.send(JSON.stringify(a)); }
    setTimeout(loop, c.cooldown + 100 + rnd(400));
  };
  c.ws.on("open", () => c.ws.send(JSON.stringify({ type: "hello" })));
  c.ws.on("message", raw => {
    const now = Date.now(), m = JSON.parse(raw);
    if (m.type === "init") {
      c.id = m.you.id; c.cooldown = m.cooldownMs;
      Buffer.from(m.canvas, "base64").copy(c.grid);
      stats.connected++;
      setTimeout(loop, rnd(c.cooldown));
    } else if (m.type === "action") {
      applyTo(c.grid, m);
      prop.push(now - m.t);
      if (m.player === c.id) { echo.push(now - c.sentAt); stats.accepted++; }
    } else if (m.type === "rejected") {
      stats.rejected++; stats.reasons[m.reason] = (stats.reasons[m.reason] || 0) + 1;
    }
  });
  c.ws.on("error", e => console.error(`client ${i} error: ${e.message}`));
  return c;
}

function freshCanvas() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.on("message", raw => {
      const m = JSON.parse(raw);
      if (m.type === "init") { ws.close(); resolve(Buffer.from(m.canvas, "base64")); }
    });
    ws.on("error", reject);
  });
}

(async () => {
  console.log(`Load test: ${N} players for ${DURATION / 1000}s against ${URL}`);
  const clients = Array.from({ length: N }, (_, i) => makeClient(i));
  await new Promise(r => setTimeout(r, DURATION));
  stopping = true;
  await new Promise(r => setTimeout(r, 2000));            // let in-flight broadcasts land

  const server = await freshCanvas();
  const mismatched = clients.filter(c => !Buffer.from(c.grid).equals(server)).length;
  clients.forEach(c => c.ws.close());

  const within = prop.length ? (prop.filter(v => v <= 1000).length / prop.length * 100).toFixed(2) : "0";
  console.log(`Connected:            ${stats.connected}/${N}`);
  console.log(`Actions sent:         ${stats.sent}  accepted: ${stats.accepted}  rejected: ${stats.rejected} ${JSON.stringify(stats.reasons)}`);
  console.log(`Echo latency ms:      p50 ${pct(echo, 50)}  p95 ${pct(echo, 95)}  max ${pct(echo, 100)}`);
  console.log(`Propagation ms:       p50 ${pct(prop, 50)}  p95 ${pct(prop, 95)}  max ${pct(prop, 100)}  (${prop.length} deliveries)`);
  console.log(`Delivered within 1 s: ${within}%`);
  console.log(`Canvas consistency:   ${N - mismatched}/${N} clients match the server canvas`);
  const ok = stats.connected === N && mismatched === 0 && pct(prop, 95) <= 1000;
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
})();
