/*
 * Own rasterizer algorithms (no canvas drawing APIs).
 * Every function returns a flat, de-duplicated, in-bounds pixel list [x0,y0,x1,y1,...].
 *   Raster.line(x0,y0,x1,y1)                 Bresenham
 *   Raster.circle(cx,cy,r)                   midpoint circle (outline)
 *   Raster.polygon(points)                   scan-line fill plus Bresenham outline; points = [{x,y},...]
 *   Raster.floodFill(getPixel,x,y,colour)    queue-based, 4-connected
 */
(() => {
  "use strict";
  const W = 128, H = 128;

  function clean(list) {
    const seen = new Set(), out = [];
    for (let i = 0; i < list.length; i += 2) {
      const x = list[i], y = list[i + 1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const k = y * W + x;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x, y);
    }
    return out;
  }

  function lineRaw(x0, y0, x1, y1) {
    const out = [];
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      out.push(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return out;
  }
  const line = (x0, y0, x1, y1) => clean(lineRaw(x0, y0, x1, y1));

  function circle(cx, cy, r) {
    const out = [];
    let x = r, y = 0, d = 1 - r;
    while (x >= y) {
      out.push(cx + x, cy + y, cx - x, cy + y, cx + x, cy - y, cx - x, cy - y,
               cx + y, cy + x, cx - y, cy + x, cx + y, cy - x, cx - y, cy - x);
      y++;
      if (d <= 0) d += 2 * y + 1;
      else { x--; d += 2 * (y - x) + 1; }
    }
    return clean(out);
  }

  function polygon(points) {
    const n = points.length;
    if (n < 3) return [];
    let minY = Infinity, maxY = -Infinity;
    for (const p of points) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const out = [];
    for (let y = minY; y <= maxY; y++) {
      const xs = [];
      for (let i = 0; i < n; i++) {
        const a = points[i], b = points[(i + 1) % n];
        if (a.y === b.y) continue;                        // skip horizontal edges
        const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
        if (y >= lo && y < hi) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) out.push(x, y);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
      out.push(...lineRaw(a.x, a.y, b.x, b.y));
    }
    return clean(out);
  }

  function floodFill(getPixel, sx, sy, colour) {
    const target = getPixel(sx, sy);
    if (target < 0 || target === colour) return [];
    const seen = new Uint8Array(W * H);
    const queue = [sx, sy];
    seen[sy * W + sx] = 1;
    const out = [];
    for (let head = 0; head < queue.length; head += 2) {
      const x = queue[head], y = queue[head + 1];
      out.push(x, y);
      const nb = [x + 1, y, x - 1, y, x, y + 1, x, y - 1];
      for (let i = 0; i < 8; i += 2) {
        const nx = nb[i], ny = nb[i + 1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (seen[k] || getPixel(nx, ny) !== target) continue;
        seen[k] = 1;
        queue.push(nx, ny);
      }
    }
    return out;
  }

  const Raster = { line, circle, polygon, floodFill };
  if (typeof window !== "undefined") window.Raster = Raster;
  if (typeof module !== "undefined") module.exports = Raster;
})();
