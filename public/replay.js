/*
 * Time-lapse replay of the whole battle from the server's stored action log.
 * Plays on its own canvas with its own setPixel, so the live board is never disturbed.
 */
(() => {
  "use strict";
  const W = 128, H = 128, BLANK = 255;
  const PB = window.PB;
  const $ = id => document.getElementById(id);
  const cv = $("replay"), ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H), data = img.data;

  let actions = [], collecting = false, isOpen = false;
  let idx = 0, playing = false, rate = 10, last = 0, acc = 0, dirty = true;
  const OUT = 512;                                   // exported video is 512x512 (nearest-neighbour upscale)
  let exporting = false, recorder = null, outCtx = null, chunks = [], saveOnStop = true;
  const status = t => { $("status").textContent = t; };

  function setPixel(x, y, ci) {
    const rgb = ci === BLANK ? [255, 255, 255] : PB.COLOURS[ci];
    const i = (y * W + x) * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    dirty = true;
  }
  function clear() {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(x, y, BLANK);
    idx = 0;
  }
  function applyOne(a) {
    const p = a.pixels;
    for (let i = 0; i < p.length; i += 2) setPixel(p[i], p[i + 1], a.colours ? a.colours[i / 2] : a.colour);
  }
  function seek(n) {
    if (n < idx) clear();
    while (idx < n) applyOne(actions[idx++]);
    updateUI();
  }
  function updateUI() {
    $("rpSlider").value = idx;
    const when = idx > 0 ? new Date(actions[idx - 1].t).toLocaleTimeString() : "start";
    $("rpLabel").textContent = `Action ${idx} / ${actions.length} (${when})`;
    $("rpPlay").textContent = playing ? "Pause" : "Play";
  }
  function tick(ts) {
    if (!isOpen) return;
    if (playing) {
      if (!last) last = ts;
      acc += (ts - last) / 1000 * (exporting ? Math.max(rate, actions.length / 60) : rate);   // exports last at most ~60 s
      last = ts;
      const step = Math.floor(acc);
      if (step > 0) {
        acc -= step;
        seek(Math.min(actions.length, idx + step));
        if (idx >= actions.length) { playing = false; updateUI(); if (exporting) setTimeout(finishExport, 600); }
      }
    } else last = 0;
    if (dirty) { ctx.putImageData(img, 0, 0); dirty = false; }
    if (exporting) outCtx.drawImage(cv, 0, 0, OUT, OUT);
    requestAnimationFrame(tick);
  }
  function open() {
    isOpen = true;
    $("stage").hidden = true; cv.hidden = false; $("rp").hidden = false;
    $("rpSlider").max = actions.length;
    clear(); idx = 0; playing = true; last = 0; acc = 0;
    updateUI();
    requestAnimationFrame(tick);
  }
  function finishExport() {
    if (exporting && recorder && recorder.state !== "inactive") recorder.stop();
  }
  function exportVideo() {
    if (exporting) return;
    if (!window.MediaRecorder || !cv.captureStream) { status("Video export is not supported in this browser."); return; }
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find(t => MediaRecorder.isTypeSupported(t));
    if (!mime) { status("Video export is not supported in this browser."); return; }
    const out = document.createElement("canvas");
    out.width = out.height = OUT;
    outCtx = out.getContext("2d");
    outCtx.imageSmoothingEnabled = false;
    recorder = new MediaRecorder(out.captureStream(30), { mimeType: mime });
    chunks = []; saveOnStop = true;
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      exporting = false;
      $("rpExport").textContent = "Export video"; $("rpExport").disabled = false; $("rpSlider").disabled = false;
      if (saveOnStop && chunks.length) {
        PB.download(new Blob(chunks, { type: mime.split(";")[0] }), `pixel-battle-replay.${mime.startsWith("video/mp4") ? "mp4" : "webm"}`);
        status("Video saved.");
      }
    };
    exporting = true;
    $("rpExport").textContent = "Recording..."; $("rpExport").disabled = true; $("rpSlider").disabled = true;
    seek(0); playing = true; last = 0; acc = 0;
    outCtx.drawImage(cv, 0, 0, OUT, OUT);
    recorder.start();
    updateUI();
  }
  function close() {
    saveOnStop = false; finishExport();
    isOpen = false; playing = false;
    cv.hidden = true; $("rp").hidden = true; $("stage").hidden = false;
  }

  PB.onReplay = m => {
    if (!collecting) return;
    actions.push(...m.actions);
    if (!m.done) return;
    collecting = false;
    if (actions.length === 0) { $("status").textContent = "No actions to replay yet."; return; }
    open();
  };

  PB.onNewGame = () => {                              // old history is gone: close any open replay
    actions = []; collecting = false;
    if (isOpen) close();
  };

  $("replayBtn").onclick = () => {
    if (isOpen) return;
    actions = []; collecting = true;
    $("status").textContent = "Loading replay...";
    PB.send({ type: "replay" });
  };
  $("rpExport").onclick = exportVideo;
  $("rpPlay").onclick = () => {
    if (exporting) return;
    if (idx >= actions.length) { seek(0); }
    playing = !playing; last = 0; updateUI();
  };
  $("rpRestart").onclick = () => { if (exporting) return; seek(0); playing = true; last = 0; acc = 0; updateUI(); };
  $("rpClose").onclick = close;
  $("rpSpeed").onchange = e => { rate = +e.target.value; };
  $("rpSlider").oninput = e => { playing = false; seek(+e.target.value); };
})();
