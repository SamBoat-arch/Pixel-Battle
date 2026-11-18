/*
 * Pixel Battle client: canvas buffer, setPixel, WebSocket sync.
 *
 * Hooks for the other work packages:
 *   PB.setPixel(x, y, colourIndex)   the only way pixels reach the canvas
 *   PB.getPixel(x, y)                read back a colour index (flood fill needs this)
 *   PB.TOOLS                         add rasterizer tools here (see "pen" below)
 *   PB.COLOURS                       RGB triples from palette.js (HSB-designed palette)
 *   PB.send(msg)                     send a raw message to the server
 *   PB.onReplay                      set to a function(msg) to receive replay chunks
 *   PB.onNewGame                     set to a function() called when anyone starts a new game
 */
(() => {
  "use strict";
  const W = 128, H = 128, BLANK = 255, TEAM_BASE = 16;

  // ---------- palette (defined in palette.js, designed in HSB) ----------
  const ENTRIES = window.Palette.ENTRIES;
  const COLOURS = ENTRIES.map(e => e.rgb);
  const TEAM_NAMES = ENTRIES.slice(TEAM_BASE).map(e => e.name);

  // ---------- canvas buffer and setPixel ----------
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const data = img.data;
  const grid = new Uint8Array(W * H).fill(BLANK);
  let dirty = true;

  function setPixel(x, y, ci) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const rgb = ci === BLANK ? [255, 255, 255] : COLOURS[ci];
    if (!rgb) return;
    const i = (y * W + x) * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    grid[y * W + x] = ci;
    dirty = true;
  }
  const getPixel = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : grid[y * W + x];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(x, y, BLANK);

  (function loop() {
    if (dirty) { ctx.putImageData(img, 0, 0); dirty = false; }
    requestAnimationFrame(loop);
  })();

  // ---------- tools ----------
  // A tool collects `points` clicks (polygon: any number, ended by Finish), then make(points)
  // returns a flat [x0,y0,x1,y1,...] pixel list built by our own rasterizer (rasterizer.js).
  const R = window.Raster;
  const TOOLS = {
    pen:     { points: 1, make: ([p]) => [p.x, p.y] },
    line:    { points: 2, make: ([a, b]) => R.line(a.x, a.y, b.x, b.y) },
    circle:  { points: 2, make: ([c, e]) => R.circle(c.x, c.y, Math.round(Math.hypot(e.x - c.x, e.y - c.y))) },
    polygon: { points: Infinity, minPoints: 3, make: pts => R.polygon(pts) },
    fill:    { points: 1, make: ([p]) => R.floodFill(getPixel, p.x, p.y, colour) },
  };
  let toolName = "pen", colour = 0, picked = [];

  // ---------- state ----------
  let ws = null, me = null, cooldownMs = 5000, nextAllowedAt = 0, retry = 500;
  let helloSent = false, teamSizes = [0, 0, 0, 0], newGameNotice = false;
  const $ = id => document.getElementById(id);
  const status = msg => { $("status").textContent = msg; };

  // ---------- networking ----------
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => {
      retry = 500;
      helloSent = false;
      let saved = null, savedTeam = null;
      try { saved = localStorage.getItem("pb-player"); savedTeam = parseInt(localStorage.getItem("pb-team"), 10); } catch (_) {}
      if (saved) hello(saved, Number.isInteger(savedTeam) ? savedTeam : undefined);   // returning player: keeps their team
      else showPicker();                                                              // first join: choose a team
    };
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = () => {
      status("Disconnected. Reconnecting...");
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    };
  }
  const send = msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  // ---------- team picker (first join only) ----------
  function hello(playerId, team) {
    if (helloSent) return;
    helloSent = true;
    send({ type: "hello", playerId: playerId || null, team });
  }
  function showPicker() {
    const box = $("teamBtns");
    box.innerHTML = "";
    TEAM_NAMES.forEach((name, t) => {
      const b = document.createElement("button");
      b.className = "teamBtn";
      b.innerHTML = `<i style="background:rgb(${COLOURS[TEAM_BASE + t].join(",")})"></i>${name}<span>${teamSizes[t]} player${teamSizes[t] === 1 ? "" : "s"}</span>`;
      b.onclick = () => { $("picker").hidden = true; hello(null, t); };
      box.appendChild(b);
    });
    $("autoTeam").onclick = () => { $("picker").hidden = true; hello(null, undefined); };
    $("picker").hidden = false;
  }

  function handle(m) {
    if (m.type === "init") {
      me = m.you;
      $("picker").hidden = true;
      try { localStorage.setItem("pb-player", me.id); localStorage.setItem("pb-team", String(me.team)); } catch (_) {}
      cooldownMs = m.cooldownMs;
      nextAllowedAt = Date.now() + m.retryInMs;
      const bin = atob(m.canvas);
      for (let i = 0; i < bin.length; i++) setPixel(i % W, (i / W) | 0, bin.charCodeAt(i));
      if (colour < TEAM_BASE) selectColour(TEAM_BASE + me.team);
      status(newGameNotice ? `A new game was started. The canvas is clear. You are team ${TEAM_NAMES[me.team]}.`
                           : `Connected. You are team ${TEAM_NAMES[me.team]}.`);
      newGameNotice = false;
      drawScores(m.scores, m.online);
    } else if (m.type === "action") {
      for (let i = 0; i < m.pixels.length; i += 2) setPixel(m.pixels[i], m.pixels[i + 1], m.colour);
      if (me && m.player === me.id) nextAllowedAt = Date.now() + cooldownMs;
    } else if (m.type === "undo") {
      for (let i = 0; i < m.pixels.length; i += 2) setPixel(m.pixels[i], m.pixels[i + 1], m.colours[i / 2]);
      if (me && m.player === me.id) status("Undid your last action.");
    } else if (m.type === "teams") {
      teamSizes = m.sizes;
      if (!$("picker").hidden) showPicker();
    } else if (m.type === "newgame") {
      picked = [];
      if (PB.onNewGame) PB.onNewGame();
      newGameNotice = true;       // shown by the init message that follows
    } else if (m.type === "score") {
      drawScores(m.scores, m.online);
    } else if (m.type === "rejected") {
      if (m.retryInMs && m.reason === "cooldown") nextAllowedAt = Date.now() + m.retryInMs;   // only drawing cooldowns block drawing
      status(m.reason === "a new game was started recently"
        ? `A new game was started recently. Try again in ${Math.ceil(m.retryInMs / 1000)}s.`
        : `Rejected: ${m.reason}`);
    } else if (m.type === "replay" && PB.onReplay) {
      PB.onReplay(m);
    }
  }

  // ---------- input (mouse and touch via pointer events) ----------
  // Called by viewport.js on a tap/click (not a drag). The canvas rect already reflects zoom and pan.
  function place(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left) / r.width * W);
    const y = Math.floor((clientY - r.top) / r.height * H);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const tool = TOOLS[toolName];
    picked.push({ x, y });
    if (picked.length < tool.points) {
      status(tool.points === Infinity ? `${picked.length} point(s) added. Press Finish when done.`
                                      : `Pick point ${picked.length + 1} of ${tool.points}`);
      return;
    }
    submit();
  }

  function submit() {
    const tool = TOOLS[toolName];
    if (picked.length < (tool.minPoints || tool.points)) { status(`Need at least ${tool.minPoints || tool.points} points`); return; }
    if (Date.now() < nextAllowedAt) { status("Cooling down. Your points are kept."); return; }
    const pixels = tool.make(picked);
    picked = [];
    if (pixels.length === 0) { status("Nothing to draw there"); return; }
    send({ type: "action", tool: toolName, colour, pixels });
  }
  $("undo").onclick = () => send({ type: "undo" });
  $("newGame").onclick = () => {
    if (confirm("Start a new game?\n\nThis clears the canvas and the whole history for EVERY player. It cannot be undone.")) {
      send({ type: "newgame", confirm: true });
    }
  };

  // PNG export: the board buffer is 128x128, saved at that original size.
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("savePng").onclick = () => requestAnimationFrame(() =>      // wait one frame so the latest pixels are flushed
    canvas.toBlob(b => b ? download(b, "pixel-battle.png") : status("PNG export failed"), "image/png"));
  $("finish").onclick = submit;
  $("cancel").onclick = () => { picked = []; status("Cancelled"); };

  // ---------- UI ----------
  const rgbCss = c => `rgb(${c[0]},${c[1]},${c[2]})`;
  function swatch(i) {
    const d = document.createElement("div");
    d.className = "sw"; d.style.background = rgbCss(COLOURS[i]); d.dataset.i = i;
    d.title = ENTRIES[i].name;
    d.onclick = () => selectColour(i);
    return d;
  }
  function buildPalette() {
    for (let i = 0; i < TEAM_BASE; i++) $("palette").appendChild(swatch(i));
    for (let i = TEAM_BASE; i < ENTRIES.length; i++) $("teams").appendChild(swatch(i));
  }
  function selectColour(i) {
    colour = i;
    document.querySelectorAll(".sw").forEach(s => s.classList.toggle("sel", +s.dataset.i === i));
    const e = ENTRIES[i];
    $("info").innerHTML = `<i style="background:${e.hex}"></i><b>${e.name}</b>` +
      `<span>H ${e.h}&deg; &nbsp;S ${e.s}% &nbsp;B ${e.b}%</span>` +
      `<span>RGB ${e.rgb.join(", ")} &nbsp;${e.hex}</span>`;
  }
  function buildTools() {
    const box = $("tools");
    box.innerHTML = "";
    Object.keys(TOOLS).forEach(name => {
      const b = document.createElement("button");
      b.textContent = name; b.className = name === toolName ? "sel" : "";
      b.onclick = () => { toolName = name; picked = []; buildTools(); };
      box.appendChild(b);
    });
    $("poly").hidden = toolName !== "polygon";
  }
  function drawScores(scores, online) {
    $("scores").innerHTML = scores.map((n, t) =>
      `<span class="score"><i style="background:${rgbCss(COLOURS[TEAM_BASE + t])}"></i>${TEAM_NAMES[t]}: ${n}</span>`
    ).join("") + `<span class="score">Online: ${online}</span>`;
  }
  setInterval(() => {
    const left = Math.max(0, nextAllowedAt - Date.now());
    $("fill").style.width = (100 - Math.min(100, left / cooldownMs * 100)) + "%";
  }, 100);

  buildPalette(); buildTools(); selectColour(0);
  const PB = window.PB = { setPixel, getPixel, TOOLS, COLOURS, send, place, download, onReplay: null, onNewGame: null, rebuildTools: buildTools };
  connect();
})();
