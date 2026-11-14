/*
 * Palette designed in HSB (H 0-360 degrees, S 0-100 %, B 0-100 %).
 * Indices 0-15 are the 16-colour palette, 16-19 are the four team colours (the server relies on this order).
 * RGB and HEX are derived from H, S, B by our own conversion below.
 */
(() => {
  "use strict";

  function hsbToRgb(h, s, b) {
    s /= 100; b /= 100;
    const k = n => (n + h / 60) % 6;
    const f = n => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
    return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
  }
  const toHex = rgb => "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();

  // name, H, S, B
  const SPEC = [
    ["White",       0,   0, 100],
    ["Light grey",  0,   0,  75],
    ["Dark grey",   0,   0,  40],
    ["Black",       0,   0,  10],
    ["Red",         0,  85,  90],
    ["Orange",     25,  90,  95],
    ["Yellow",     58,  55, 100],
    ["Lime",       90,  75,  85],
    ["Green",     140,  75,  65],
    ["Teal",      175,  80,  70],
    ["Sky",       200,  70,  95],
    ["Blue",      225,  80,  85],
    ["Purple",    270,  65,  80],
    ["Magenta",   310,  70,  85],
    ["Pink",      340,  35, 100],
    ["Brown",      25,  65,  45],
    // team colours
    ["Crimson",   350,  90,  80],
    ["Royal Blue",230,  90,  75],
    ["Emerald",   150,  90,  65],
    ["Gold",       45,  95, 100],
  ];

  const ENTRIES = SPEC.map(([name, h, s, b]) => {
    const rgb = hsbToRgb(h, s, b);
    return { name, h, s, b, rgb, hex: toHex(rgb) };
  });

  const Palette = { ENTRIES, TEAM_BASE: 16, hsbToRgb, toHex };
  if (typeof window !== "undefined") window.Palette = Palette;
  if (typeof module !== "undefined") module.exports = Palette;
})();
