/*
 * Zoom and pan for the live board (CSS transform on the canvas; pixels are still drawn only by setPixel).
 *   Mouse:  wheel = zoom at cursor, drag = pan, click = place
 *   Touch:  pinch = zoom, one-finger drag = pan, tap = place
 *   Buttons: -, +, Reset
 */
(() => {
  "use strict";
  const PB = window.PB;
  const $ = id => document.getElementById(id);
  const stage = $("stage"), canvas = $("board");
  const MIN = 1, MAX = 16, DRAG_PX = 6;
  let z = 1, tx = 0, ty = 0;

  function apply() {
    const s = stage.clientWidth;
    tx = Math.min(0, Math.max(s - s * z, tx));
    ty = Math.min(0, Math.max(s - s * z, ty));
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    $("zoomLabel").textContent = (Math.round(z * 10) / 10) + "x";
  }
  function zoomAt(factor, cx, cy) {            // cx, cy: point relative to the stage
    const nz = Math.min(MAX, Math.max(MIN, z * factor));
    const k = nz / z;
    tx = cx - (cx - tx) * k;
    ty = cy - (cy - ty) * k;
    z = nz;
    apply();
  }
  const rel = (clientX, clientY) => {
    const r = stage.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  };

  const pointers = new Map();                  // id -> {x, y}
  let start = null, moved = false, multi = false;
  let lastDist = 0, lastMid = [0, 0];

  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  };

  stage.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { start = { x: e.clientX, y: e.clientY }; moved = false; multi = false; }
    else if (pointers.size === 2) {
      multi = true;
      const p = pinchState(); lastDist = p.dist; lastMid = p.mid;
    }
  });

  stage.addEventListener("pointermove", e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2) {
      const now = pinchState();
      const [mx, my] = rel(now.mid[0], now.mid[1]);
      if (lastDist > 0) zoomAt(now.dist / lastDist, mx, my);
      tx += now.mid[0] - lastMid[0]; ty += now.mid[1] - lastMid[1];
      lastDist = now.dist; lastMid = now.mid;
      apply();
    } else if (pointers.size === 1) {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_PX) moved = true;
      if (moved) { tx += dx; ty += dy; apply(); }
    }
  });

  function release(e) {
    if (!pointers.has(e.pointerId)) return;
    const wasTap = pointers.size === 1 && !moved && !multi && e.type === "pointerup";
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {                 // pinch ended: remaining finger must not place a pixel
      const [rest] = [...pointers.values()];
      start = { x: rest.x, y: rest.y }; moved = true;
    }
    if (wasTap) PB.place(e.clientX, e.clientY);
  }
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const [cx, cy] = rel(e.clientX, e.clientY);
    zoomAt(Math.exp(-e.deltaY * 0.0015), cx, cy);
  }, { passive: false });

  const mid = () => stage.clientWidth / 2;
  $("zIn").onclick = () => zoomAt(1.5, mid(), mid());
  $("zOut").onclick = () => zoomAt(1 / 1.5, mid(), mid());
  $("zReset").onclick = () => { z = 1; tx = ty = 0; apply(); };
  window.addEventListener("resize", apply);
  apply();
})();
