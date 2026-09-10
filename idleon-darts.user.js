// ==UserScript==
// @name         IdleOn Darts Helper
// @namespace    nativerobot
// @version      1.10
// @downloadURL https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-darts.user.js
// @updateURL   https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-darts.user.js
// @description  Draws the predicted dart path and where it lands on the board, wind included, for the Throwy Darts minigame
// @match        https://www.legendsofidleon.com/*
// @grant        none
// @run-at       document-start
// @all-frames   true
// ==/UserScript==
(function () {
  'use strict';

  // ---------- make the game's backbuffer readable ----------
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/i.test(type)) attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    return origGetContext.call(this, type, attrs);
  };

  // ---------- persistence ----------
  const KEY = 'darts_cfg';
  const cfg = Object.assign({
    on: true,
    scale: 4,
    path: true,        // dotted flight path
    band: true,        // name the band you would hit
    live: true,        // track a dart already in the air
    debug: false,
    calVer: 4,
    // Measured from 16 tracked throws. Speed is normalised by canvas width,
    // gravity and wind by width too (the game keeps its aspect ratio).
    vN: 0.548,         // launch speed / width, per second
    gN: 0.612,         // gravity / height
    // v4: windK re-measured from a recording holding two wind states — four
    // throws at 6mph blowing up-right and six at 9mph blowing down-right, same
    // session, same aim style. The vertical acceleration difference between
    // the clusters solves for the wind strength independently of the v/g/land
    // degeneracy, and both clusters agree: 0.0158 up, 0.0157 down. Symmetric
    // and well-determined, unlike the old 0.0135 (fit tangled with landN).
    windK: 0.0158,     // acceleration per mph, as a fraction of canvas width
    // The landing residual soaked up part of the wind error while windK was
    // low — the old -0.074 predicted ~30px high on every throw once windK is
    // right. Re-fit with the wind term fixed at its measured value: 9 of the
    // 10 recorded throws land within half a band (the 10th misses by 44px,
    // just over). The unexplained leftover splits +-20px WITH the wind sign,
    // so some vertical wind coupling is still not understood — but it is well
    // inside the 77px band and not worth chasing on 10 throws.
    landN: -0.023,     // landing correction / height
    // Magenta wind stays gated to zero in predict(): its arrow glyph is a
    // third the size of cyan's and its direction read is unreliable — see v3
    // history in git. Zero measures best; not a claim that magenta does nothing.
    collapsed: false,
    hidden: false,
    px: null, py: null // dragged panel position, viewport px
  }, JSON.parse(localStorage.getItem(KEY) || '{}'));
  if (cfg.calVer !== 4) {
    cfg.calVer = 4; cfg.vN = 0.548; cfg.gN = 0.612; cfg.landN = -0.023;
    cfg.windK = 0.0158;
  }
  let saveAt = 0;
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));
  const saveSoon = () => { const t = performance.now(); if (t - saveAt > 1000) { saveAt = t; save(); } };

  const boot = () => {

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483644';
  const root = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);

  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 12px/1.4 monospace; }
      canvas { position: fixed; left: 0; top: 0; pointer-events: none; }
      #p { position: fixed; top: 12px; left: 500px; width: 216px;
           background: #14171c; color: #cdd3da; border: 1px solid #2a2f37;
           border-radius: 8px; pointer-events: auto; user-select: none;
           box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      #hd { display:flex; align-items:center; justify-content:space-between;
            padding: 7px 9px; cursor: move; background:#1b1f26; border-radius:8px 8px 0 0; }
      #hd b { color:#8b95a3; font-weight:600; letter-spacing:.3px; }
      #dot { width:9px; height:9px; border-radius:50%; background:#4b5563; display:inline-block; }
      #dot.on { background:#fbbf24; box-shadow:0 0 8px #fbbf24; }
      .body { padding: 9px; display:flex; flex-direction:column; gap:7px; }
      .row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      label { color:#8b95a3; }
      input[type=checkbox] { accent-color:#d97706; }
      .btn { width:100%; padding:6px; border:0; border-radius:5px; cursor:pointer;
             background:#2a2f37; color:#cdd3da; }
      .btn.go { background:#16a34a; color:#fff; }
      .btn.stop { background:#d97706; color:#fff; }
      .btn.sm { padding:4px; font-size:11px; }
      #st { color:#6b7280; font-size:11px; white-space:pre-line; min-height:28px; }
      .hint { color:#4b5563; font-size:11px; text-align:center; }
      #min { cursor:pointer; color:#6b7280; padding:0 4px; }
      #nub { position: fixed; top: 6px; left: 50px; width: 13px; height: 13px;
             border-radius: 50%; background: #d97706; opacity: .55; cursor: pointer;
             pointer-events: auto; display: none; }
      #nub:hover { opacity: 1; }
      details summary { color:#4b5563; cursor:pointer; font-size:11px; outline:none; }
      details .body { padding:7px 0 0; gap:6px; }
    </style>
    <canvas id="ov"></canvas>
    <div id="nub" title="Show Darts Helper"></div>
    <div id="p">
      <div id="hd"><span><span id="dot"></span> <b>Darts Helper</b></span><span id="min">–</span></div>
      <div class="body">
        <button class="btn go" id="run">Show path  (F2)</button>
        <div class="row"><label>Aim path</label><input id="path" type="checkbox"></div>
        <div class="row"><label>Name the band</label><input id="band" type="checkbox"></div>
        <div class="row"><label>Track thrown dart</label><input id="live" type="checkbox"></div>
        <div id="st">idle</div>
        <details>
          <summary>tuning</summary>
          <div class="body">
            <div class="row"><label>Debug</label><input id="debug" type="checkbox"></div>
            <button class="btn sm" id="cal">Reset calibration</button>
          </div>
        </details>
        <div class="hint">F2 on/off · F1 hide panel</div>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  const ov = $('#ov'), octx = ov.getContext('2d');
  const dot = $('#dot'), runBtn = $('#run'), panel = $('#p'), stEl = $('#st'),
        nub = $('#nub'), body = $('#p > .body'), minBtn = $('#min');

  // ---------- remembered panel position ----------
  // Where the panel was dragged to is kept in the same config as everything
  // else, so it comes back there on the next load instead of jumping to the
  // corner it was built in. Clamped on the way in: a position saved on a wider
  // window would otherwise put the panel off-screen, where the only way back is
  // clearing localStorage.
  if (cfg.px != null && cfg.py != null) {
    const w = panel.offsetWidth || 220, h = 40;
    panel.style.right = 'auto';
    panel.style.left = Math.max(0, Math.min(cfg.px, window.innerWidth  - w)) + 'px';
    panel.style.top  = Math.max(0, Math.min(cfg.py, window.innerHeight - h)) + 'px';
  }

  function sync() {
    $('#path').checked = cfg.path; $('#band').checked = cfg.band;
    $('#live').checked = cfg.live; $('#debug').checked = cfg.debug;
    dot.classList.toggle('on', cfg.on);
    runBtn.textContent = cfg.on ? 'Hide path  (F2)' : 'Show path  (F2)';
    runBtn.className = 'btn ' + (cfg.on ? 'stop' : 'go');
    body.style.display = cfg.collapsed ? 'none' : '';
    minBtn.textContent = cfg.collapsed ? '+' : '–';
    panel.style.display = cfg.hidden ? 'none' : '';
    nub.style.display = cfg.hidden ? '' : 'none';
    if (!cfg.on) octx.clearRect(0, 0, ov.width, ov.height);
  }

  // ---------- readback ----------
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  // The dart is a ~4px-wide sprite; at 4x it is a smear. The area around the
  // player is re-read at native resolution so the aim can be measured.
  const aimC = document.createElement('canvas');
  const actx = aimC.getContext('2d', { willReadFrequently: true });
  let readErr = '';

  function gameCanvas() {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const a = c.clientWidth * c.clientHeight;
      if (a > area) { area = a; best = c; }
    }
    return area > 160000 ? best : null;
  }
  function grab(cv) {
    const sw = Math.max(1, Math.round(cv.width / cfg.scale));
    const sh = Math.max(1, Math.round(cv.height / cfg.scale));
    if (scratch.width !== sw || scratch.height !== sh) { scratch.width = sw; scratch.height = sh; }
    try {
      sctx.clearRect(0, 0, sw, sh);
      sctx.drawImage(cv, 0, 0, sw, sh);
      readErr = '';
      return { d: sctx.getImageData(0, 0, sw, sh).data, w: sw, h: sh };
    } catch (e) {
      readErr = e && e.name === 'SecurityError' ? 'canvas not readable (tainted)' : 'pixel readback failed';
      return null;
    }
  }
  function grabBox(cv, cx, cy, half, W, H) {
    const sx = Math.max(0, Math.round((cx - half) / W * cv.width));
    const sy = Math.max(0, Math.round((cy - half) / H * cv.height));
    const sw = Math.min(cv.width - sx, Math.round(half * 2 / W * cv.width));
    const sh = Math.min(cv.height - sy, Math.round(half * 2 / H * cv.height));
    if (sw < 8 || sh < 8) return null;
    if (aimC.width !== sw || aimC.height !== sh) { aimC.width = sw; aimC.height = sh; }
    try {
      actx.clearRect(0, 0, sw, sh);
      actx.drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh);
      return { d: actx.getImageData(0, 0, sw, sh).data, w: sw, h: sh, sx, sy, cvW: cv.width, cvH: cv.height };
    } catch (e) { return null; }
  }

  // A tall narrow native-resolution slice through the board, for reading bands.
  const bandC = document.createElement('canvas');
  const bctx = bandC.getContext('2d', { willReadFrequently: true });
  function grabBoard(cv, xCss, W) {
    const cx = Math.round(xCss / W * cv.width);
    const half = Math.max(4, Math.round(cv.width * 0.012));
    const sx = Math.max(0, cx - half);
    const sw = Math.min(cv.width - sx, half * 2);
    if (sw < 3) return null;
    if (bandC.width !== sw || bandC.height !== cv.height) { bandC.width = sw; bandC.height = cv.height; }
    try {
      bctx.clearRect(0, 0, sw, cv.height);
      bctx.drawImage(cv, sx, 0, sw, cv.height, 0, 0, sw, cv.height);
      return { d: bctx.getImageData(0, 0, sw, cv.height).data, w: sw, h: cv.height, sy: 0, cvH: cv.height };
    } catch (e) { return null; }
  }

  // Native-resolution crop of the "N mph" text, for the digit reader.
  const mphC = document.createElement('canvas');
  const mctx = mphC.getContext('2d', { willReadFrequently: true });
  function grabMph(cv) {
    const sx = Math.round(cv.width * 0.489), sw = Math.round(cv.width * 0.106);
    const sy = Math.round(cv.height * 0.037), sh = Math.round(cv.height * 0.067);
    if (sw < 8 || sh < 8) return null;
    if (mphC.width !== sw || mphC.height !== sh) { mphC.width = sw; mphC.height = sh; }
    try {
      mctx.clearRect(0, 0, sw, sh);
      mctx.drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh);
      return { d: mctx.getImageData(0, 0, sw, sh).data, w: sw, h: sh };
    } catch (e) { return null; }
  }

  function hsv(r, g, b) {
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx / 255];
  }
  const px = (I, x, y) => { const p = (y * I.w + x) * 4; return hsv(I.d[p], I.d[p + 1], I.d[p + 2]); };

  const isGold = (h, s, v) => h > 38 && h < 62 && s > 0.5 && v > 0.7;

  // ---------- is the darts screen up? ----------
  // The whole backdrop is a dark red-brown plank wall. Measured at ~70% of
  // sampled pixels here and essentially absent elsewhere.
  function wallFrac(I) {
    let n = 0, tot = 0;
    for (let y = 0; y < I.h; y += 3) for (let x = 0; x < I.w; x += 3) {
      const [h, s, v] = px(I, x, y);
      tot++;
      if (h >= 0 && h < 32 && s > 0.30 && s < 0.75 && v > 0.20 && v < 0.72) n++;
    }
    return tot ? n / tot : 0;
  }

  // ---------- the target board ----------
  // A tall column of saturated bands on the right. Found as the column with the
  // most strongly-coloured pixels; its bands then give the score for a hit.
  function findBoard(I, W, H) {
    const kx = W / I.w, ky = H / I.h;
    const x0 = Math.round(I.w * 0.80);
    let bestX = -1, bestN = 0;
    for (let x = x0; x < I.w; x++) {
      let n = 0;
      for (let y = Math.round(I.h * 0.12); y < Math.round(I.h * 0.95); y++) {
        const [h, s, v] = px(I, x, y);
        if (s > 0.35 && v > 0.35 && !(h < 32 && s < 0.75)) n++;
      }
      if (n > bestN) { bestN = n; bestX = x; }
    }
    if (bestX < 0 || bestN < I.h * 0.35) return null;
    let top = null, bot = null;
    for (let y = 0; y < I.h; y++) {
      const [h, s, v] = px(I, bestX, y);
      if (s > 0.35 && v > 0.35) { if (top === null) top = y; bot = y; }
    }
    if (top === null || bot - top < I.h * 0.3) return null;
    return { x: bestX * kx, top: top * ky, bot: bot * ky, col: bestX };
  }
  // Read the band at NATIVE resolution. The board is a narrow strip, so at 4x it
  // blends with the reddish wall behind it and the blend reads as red — which
  // reported "+5" while the dart was actually heading for the purple band at the
  // bottom. Measured band colours: purple hue 220-236 at only s=0.19-0.30, tan
  // 48-54, green 113-127, red 352-358. Purple's low saturation is why the old
  // s>0.25 cutoff also threw it away.
  function bandAt(S, yCss, H) {
    if (!S) return null;
    const y = Math.round(yCss / H * S.cvH) - S.sy;
    if (y < 1 || y >= S.h - 1) return null;
    const votes = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let x = 0; x < S.w; x++) {
        const [h, s, v] = px(S, x, y + dy);
        if (v < 0.35) continue;
        if (h >= 100 && h < 175 && s > 0.55) votes.push('+3');
        else if ((h > 335 || h < 12) && s > 0.55 && v > 0.55) votes.push('+5');
        else if (h >= 30 && h < 75 && s > 0.25 && v > 0.65) votes.push('+2');
        else if (h >= 195 && h < 275 && s > 0.12) votes.push('+1');
      }
    if (votes.length < 4) return null;
    const tally = {};
    for (const v of votes) tally[v] = (tally[v] || 0) + 1;
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (best[1] < votes.length * 0.4) return null;
    const col = { '+5': '#ef4444', '+2': '#e5c07b', '+3': '#4ade80', '+1': '#93a4d4' }[best[0]];
    return { name: best[0], col };
  }

  // ---------- wind ----------
  // Read from the colour of the HUD arrow rather than the "N mph" text: cyan and
  // magenta are unmistakable and need no OCR.
  // The arrow ROTATES — the same 9 mph shows pointing up-right, level, and
  // down-right — so wind has a 2D direction, not just a strength. Its principal
  // axis gives that direction; every arrow observed so far points rightward, so
  // the axis is resolved toward +x. Colour is only a coarse strength band: 4 mph
  // and 9 mph are both cyan, so colour cannot stand in for speed.
  function readWind(I) {
    const pts = [];
    for (let y = Math.round(I.h * 0.02); y < Math.round(I.h * 0.12); y++)
      for (let x = Math.round(I.w * 0.56); x < Math.round(I.w * 0.68); x++) {
        const [h, s, v] = px(I, x, y);
        if (s > 0.35 && v > 0.6 && ((h > 165 && h < 215) || (h > 270 && h < 335))) pts.push({ x, y, h });
      }
    if (pts.length < 8) return { key: 'none', deg: 0 };
    const n = pts.length;
    let mx = 0, my = 0;
    for (const q of pts) { mx += q.x; my += q.y; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const q of pts) { const a = q.x - mx, b = q.y - my; sxx += a * a; syy += b * b; sxy += a * b; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ux = Math.cos(th), uy = Math.sin(th);
    if (ux < 0) { ux = -ux; uy = -uy; }
    const hue = pts.reduce((p, c) => p + c.h, 0) / n;
    return { key: hue < 240 ? 'cyan' : 'magenta', deg: Math.atan2(-uy, ux) * 180 / Math.PI };
  }


  // ---------- reading the wind speed ----------
  // Colour only gives a band (4mph and 9mph are both cyan), so the number is
  // read directly. Digit shapes were harvested from lossless screenshots; the
  // mph readout and the HUD score use the SAME font, which was verified glyph
  // by glyph, so templates from either work. Each digit is described by ink
  // density over a 3x5 grid plus aspect ratio — tolerant of the odd edge pixel,
  // unlike exact bitmap matching.
  const DIGITS = {"0":[{"z":[0.0732,0.0488,0.0854,0.0366,0.0732,0,0.0244,0.0488,0.0732,0,0.0244,0.0488,0.0732,0,0.0244,0.0488,0.0732,0,0.0244,0.0488,0.0366,0.0488,0.0732,0.0122],"ar":0.769}],"1":[{"z":[0,0.08,0.12,0,0.04,0.04,0.08,0,0,0.04,0.08,0,0,0.04,0.08,0,0,0.04,0.08,0,0.04,0.08,0.08,0.08],"ar":0.615},{"z":[0.0465,0.0465,0.0233,0,0,0.093,0.093,0,0,0.0465,0.0465,0,0,0.093,0.0465,0,0.0698,0.093,0.0698,0.0465,0.0465,0.0465,0.0465,0.0465],"ar":0.9},{"z":[0.0732,0.0488,0,0,0,0.0976,0.0488,0,0,0.0488,0.0244,0,0,0.0976,0.0488,0,0.0732,0.0976,0.0732,0.0488,0.0732,0.0488,0.0488,0.0488],"ar":0.9}],"2":[{"z":[0.0833,0.0556,0.0972,0.0417,0.0417,0,0.0417,0.0556,0,0.0139,0.0833,0.0139,0.0139,0.0556,0.0417,0,0.0694,0.0417,0,0,0.0833,0.0556,0.0833,0.0278],"ar":0.769},{"z":[0.08,0.0533,0.0933,0.0667,0.04,0,0.04,0.0533,0,0.0133,0.08,0.0133,0.0133,0.0533,0.04,0,0.0667,0.0533,0,0,0.0667,0.0533,0.08,0.04],"ar":0.769},{"z":[0.08,0.0533,0.0933,0.0667,0.04,0,0.04,0.0533,0,0.0133,0.08,0.0133,0.0133,0.0533,0.04,0,0.0667,0.0533,0,0,0.0667,0.0533,0.08,0.04],"ar":0.769}],"3":[{"z":[0.0811,0.0541,0.0946,0.0676,0.0405,0,0.027,0.0541,0,0,0.0811,0.0405,0.027,0,0.027,0.0541,0.0811,0,0.027,0.0541,0.0405,0.0541,0.0811,0.0135],"ar":0.769},{"z":[0.0882,0.0588,0.1029,0.0441,0.0441,0,0.0294,0.0588,0,0.0147,0.0588,0.0294,0,0,0.0294,0.0588,0.0882,0,0.0294,0.0588,0.0441,0.0588,0.0882,0.0147],"ar":0.769},{"z":[0.0946,0.0541,0.0676,0.0676,0.0676,0,0,0.0541,0,0.0135,0.0405,0.0541,0.027,0.0135,0.0405,0.0541,0.0811,0,0,0.0541,0.0676,0.0541,0.0541,0.0405],"ar":0.692}],"4":[{"z":[0.1311,0,0.1311,0,0.0984,0,0.0984,0,0.0984,0.0328,0.0984,0.0328,0,0,0.0984,0,0,0,0.0984,0,0,0,0.082,0],"ar":0.769}],"5":[{"z":[0.1034,0.0345,0.0345,0.0345,0.069,0,0,0,0.1034,0.069,0.069,0.0517,0.0345,0,0,0.069,0.069,0,0,0.069,0.069,0.0345,0.0345,0.0517],"ar":0.75},{"z":[0.1034,0.0345,0.0345,0.0345,0.069,0,0,0,0.1034,0.069,0.069,0.0517,0.0345,0,0,0.069,0.069,0,0,0.069,0.069,0.0345,0.0345,0.0517],"ar":0.75},{"z":[0.0615,0.0769,0.0462,0.0308,0.0923,0.0308,0,0,0.0462,0.0923,0.0923,0.0462,0.0154,0.0154,0,0.0615,0.0308,0.0308,0,0.0615,0.0154,0.0615,0.0462,0.0462],"ar":0.917}],"6":[{"z":[0.0698,0.0465,0.0814,0.0349,0.0698,0.0233,0.0349,0.0233,0.0698,0.0233,0.0465,0.0349,0.0698,0,0.0233,0.0465,0.0698,0,0.0233,0.0465,0.0349,0.0465,0.0698,0.0116],"ar":0.769}],"7":[{"z":[0.12,0.08,0.14,0.1,0,0,0.06,0.06,0,0,0.12,0,0,0.04,0.08,0,0,0.06,0.06,0,0,0.08,0,0],"ar":0.769},{"z":[0.1176,0.0784,0.098,0.1176,0,0,0.0196,0.0784,0,0,0.0784,0.0588,0,0.0392,0.0784,0.0196,0,0.0588,0.0588,0,0,0.0784,0.0196,0],"ar":0.692}],"8":[{"z":[0.0741,0.0494,0.0864,0.037,0.0741,0,0.0247,0.0494,0.0617,0.0247,0.0494,0.0123,0.0741,0,0.0247,0.037,0.0741,0,0.0247,0.0494,0.037,0.0494,0.0741,0.0123],"ar":0.769},{"z":[0.0805,0.046,0.0575,0.0575,0.069,0,0,0.046,0.069,0.023,0.0345,0.046,0.069,0.023,0.0345,0.046,0.069,0,0,0.046,0.0575,0.046,0.046,0.0345],"ar":0.692}],"9":[{"z":[0.0698,0.0465,0.0814,0.0349,0.0698,0,0.0233,0.0465,0.0698,0,0.0233,0.0465,0.0465,0.0465,0.0698,0.0465,0.0465,0,0.0233,0.0465,0.0349,0.0465,0.0698,0.0116],"ar":0.769},{"z":[0.0814,0.0465,0.0581,0.0581,0.0698,0,0,0.0465,0.0698,0,0,0.0465,0.0698,0.0465,0.0465,0.0465,0.0698,0,0.0116,0.0465,0.0581,0.0465,0.0465,0.0349],"ar":0.692}]};
  // All ten digits are covered: 0 and 1 came from a "Score: 103" screenshot,
  // after an earlier guess at which glyph in "+1 Life" was the digit turned out
  // to be wrong — which silently broke every two-digit reading (10/11/12).
  function glyphSig(g) {
    // 4x6 zoning. A 3x5 grid could not tell '3' from '8' — both have a top and
    // bottom bowl, and only a finer grid sees that a '3' is open on the left.
    const z = new Float64Array(24);
    let tot = 0;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.g[y * g.w + x]) {
      z[Math.min(5, (y / g.h * 6) | 0) * 4 + Math.min(3, (x / g.w * 4) | 0)]++; tot++;
    }
    for (let i = 0; i < 24; i++) z[i] /= tot || 1;
    return { z, ar: g.w / g.h };
  }
  function sigDist(a, b) {
    let s = 0;
    for (let i = 0; i < 24; i++) { const d = a.z[i] - b.z[i]; s += d * d; }
    return Math.sqrt(s) + Math.abs(a.ar - b.ar) * 0.5;
  }
  function readMph(S) {
    if (!S) return null;
    const ink = (x, y) => {
      const p = (y * S.w + x) * 4, r = S.d[p], g = S.d[p + 1], b = S.d[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mx > 110 && (mx - mn) > 45;
    };
    // Glyph size gates, as fractions of the crop height rather than raw pixels.
    // They used to be absolute -- n<10, w 3..16, h 8..18 -- harvested from a
    // 1326-wide canvas where this crop comes out 51px tall. On a 960-wide
    // canvas the same crop is 36px and every glyph is 28% smaller, so the "11"
    // in "11 mph" measured w=6 h=6 n=16 and BOTH digits fell through the h<8
    // floor. Worse than losing the number: two letterforms out of "mph"
    // (w=7 h=8 n=30, and w=8 h=13 n=57) sailed past the same gates, so the
    // reader went on to match leftover letters against digit templates and
    // could return a confident wrong answer instead of null. Yesterday's cyan
    // winds reading "6mph" and "7mph" on this canvas are suspect for exactly
    // that reason, and mph feeds straight into A = windK * mph * W.
    //
    // The reference is the 51px crop the templates were harvested at, so the
    // ratios below are the old constants over 51 (and over 51^2 for the pixel
    // count, which scales with area). At S.h=36 that gives h 5.7..12.7,
    // w 2.1..11.3, n>=5: the digits at h=6 are kept, the h=13 ascender of "h"
    // is now correctly rejected, and the gap rule below still cuts before the
    // rest of "mph".
    const REF_H = 51;
    const k = S.h / REF_H;
    const G = {
      nMin: 10 * k * k,
      wMin: 3 * k, wMax: 16 * k,
      hMin: 8 * k, hMax: 18 * k,
      gap: 16 * k          // the space before "mph" starts
    };
    const seen = new Uint8Array(S.w * S.h), glyphs = [], st = [];
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
      const i = y * S.w + x;
      if (seen[i] || !ink(x, y)) continue;
      st.length = 0; st.push(i); seen[i] = 1;
      let n = 0, x0 = S.w, x1 = 0, y0 = S.h, y1 = 0; const cells = [];
      while (st.length) {
        const q = st.pop(), qx = q % S.w, qy = (q / S.w) | 0;
        n++; cells.push([qx, qy]);
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
        if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= S.w || ny >= S.h) continue;
          const nb = ny * S.w + nx;
          if (!seen[nb] && ink(nx, ny)) { seen[nb] = 1; st.push(nb); }
        }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (n < G.nMin || w < G.wMin || w > G.wMax || h < G.hMin || h > G.hMax) continue;
      const g = new Uint8Array(w * h);
      for (const [cx, cy] of cells) g[(cy - y0) * w + (cx - x0)] = 1;
      glyphs.push({ x0, w, h, g });
    }
    glyphs.sort((a, b) => a.x0 - b.x0);
    if (!glyphs.length) return null;
    const digits = [];
    for (let i = 0; i < glyphs.length; i++) {
      if (i > 0 && glyphs[i].x0 - glyphs[i - 1].x0 > G.gap) break;   // gap before "mph"
      digits.push(glyphs[i]);
    }
    if (!digits.length || digits.length > 2) return null;
    let out = '';
    for (const d of digits) {
      const s = glyphSig(d);
      let best = 9e9, bch = null;
      for (const ch in DIGITS) for (const t of DIGITS[ch]) {
        const dd = sigDist(s, t); if (dd < best) { best = dd; bch = ch; }
      }
      if (bch === null || best > 0.22) { if (out === '1') { out += '0'; continue; } return null; }
      out += bch;
    }
    const v = parseInt(out, 10);
    return (v >= 1 && v <= 40) ? v : null;
  }

  // ---------- aim ----------
  // The dart's own colours are useless: the character's body is white and so is
  // the shaft (s=.02 vs s=.03). What separates them is shape — the dart is a
  // long thin protrusion ahead of the hand. So march outward from the gold
  // fletching through anything that is NOT the reddish wall, and take the angle
  // that reaches furthest. Validated against 16 real throws: r = 0.97 against
  // the launch angle actually flown.
  // hx, hy are the fletching in CSS pixels, as picked out of the downscaled
  // frame by the blob search in the loop. They are only accurate to a /scale
  // cell, which is why the centroid is re-taken here at native resolution —
  // but they are accurate enough to say WHICH gold blob is the fletching, and
  // that is the part the average used to get wrong. Averaging every gold pixel
  // in the box put the origin between the fletching and whatever else the
  // character had on: with the gold helmet the origin landed in the head, and
  // the march then found the torso rather than the dart. See the hand blob
  // search for the measurements.
  function findAim(B, W, H, hx, hy) {
    const sx = B.sx / B.cvW * W, sy = B.sy / B.cvH * H;
    const kx = W / B.cvW, ky = H / B.cvH;
    const ox = hx / W * B.cvW - B.sx, oy = hy / H * B.cvH - B.sy;
    const seen = new Uint8Array(B.w * B.h), stack = [];
    let gx = 0, gy = 0, gn = 0, bestD = Infinity;
    for (let y = 0; y < B.h; y++) for (let x = 0; x < B.w; x++) {
      const i = y * B.w + x;
      if (seen[i] || !isGold(...px(B, x, y))) continue;
      stack.length = 0; stack.push(i); seen[i] = 1;
      let n = 0, ax = 0, ay = 0;
      while (stack.length) {
        const q = stack.pop(), qx = q % B.w, qy = (q / B.w) | 0;
        n++; ax += qx; ay += qy;
        for (const nb of [q - 1, q + 1, q - B.w, q + B.w]) {
          if (nb < 0 || nb >= B.w * B.h || seen[nb]) continue;
          if (Math.abs((nb % B.w) - qx) > 1) continue;   // no wrap at the edges
          if (isGold(...px(B, nb % B.w, (nb / B.w) | 0))) { seen[nb] = 1; stack.push(nb); }
        }
      }
      if (n < 8) continue;
      const cx = ax / n, cy = ay / n;
      const d = (cx - ox) * (cx - ox) + (cy - oy) * (cy - oy);
      if (d < bestD) { bestD = d; gx = cx; gy = cy; gn = n; }
    }
    if (!gn) return null;
    const notWall = (x, y) => {
      if (x < 0 || y < 0 || x >= B.w || y >= B.h) return false;
      const [h, s, v] = px(B, x, y);
      if (v < 0.25) return true;                    // the dart's dark outline
      return !(s > 0.28 && h >= 0 && h < 38);       // wall, skin and hair are reddish
    };
    const scale = B.cvW / W;                        // native px per css px
    const R0 = Math.round(18 * scale), R1 = Math.round(100 * scale);
    const ext = [];
    let best = null;
    // The scan used to start at -75, roughly 50 degrees below anything the
    // game can actually produce, and that dead zone is where the aim went to
    // die. Marching down from the fletching runs along the character's own
    // torso, legs and the platform, which is a longer clear run than the dart
    // ever offers, so whenever the dart read was weak the winner was whatever
    // angle pointed at the floor — and the drawn line dived off the bottom of
    // the screen.
    //
    // The real sweep was measured from five independent sources - four
    // recordings replayed through this same code and one live capture:
    //
    //   2026-08-14  1214px canvas   1032 frames   -25.4 .. +65.3
    //   2026-07-28 16-43  1312px    2938 frames   -25.4 .. +64.6
    //   2026-07-28 17-14  1312px    2370 frames   -28.0 .. +65.7
    //   2026-07-28 19-26  1312px    3044 frames   -25.9 .. +65.0
    //   live        1327.9px         125 frames   -25.5 .. +64.8
    //
    // ~11,200 accepted aims, and not one below -30 in any of them. The floor
    // is NOT a tight constant: four sources cluster at -25.4..-25.9 and the
    // fifth sits 2.6 degrees lower at -28.0, so treat -28 as the observed
    // worst case rather than the true limit. In the live capture 38 further
    // frames sat at -75.0 .. -70.8 - jammed against the old scan floor, with
    // 44.5 degrees of empty space between them and the nearest real reading.
    // Nothing legitimate lives down there.
    //
    // SWEEP_LO is set 12 degrees under the worst observed floor rather than
    // hugging it. An earlier draft used -35, which left only 2 degrees of
    // clearance against that -28.0 clip; since a fifth source moved the floor
    // once, a sixth could move it again, and widening costs nothing because
    // the boundary test below still catches a march that runs out of range. Angles are resolution independent, which is why this is
    // the axis to guard on: reach looked like a perfect separator within one
    // session (real 83-85.8 against dives at 59.5/73.3/80.2/99.6) but the same
    // measurement off the recording spread to 82-100, and normalised by canvas
    // width the two disagreed by 10%. A reach window wide enough for both lets
    // the dives back in, so it is deliberately not used here.
    const SWEEP_LO = -40;
    for (let deg = SWEEP_LO; deg <= 80; deg++) {
      const th = deg * Math.PI / 180, ux = Math.cos(th), uy = -Math.sin(th);
      let reach = R0, gap = 0;
      for (let r = R0; r <= R1; r++) {
        if (notWall(Math.round(gx + ux * r), Math.round(gy + uy * r))) { reach = r; gap = 0; }
        else if (++gap > 4) break;
      }
      ext.push({ deg, reach });
      if (!best || reach > best.reach) best = { deg, reach };
    }
    // A march has to run at least as far as a dart does, or it did not find a
    // dart. This floor used to be 40 CSS px flat -- absolute pixels again, and
    // set at less than half of what a real dart actually produces, so it caught
    // almost nothing. Measured reach for a genuine in-hand dart:
    //
    //   live         W=1327.9   83.0 .. 85.8   ->  0.0625 .. 0.0646 W
    //   08-14        W=1214     82   .. 100    ->  0.0675 .. 0.0824 W
    //   07-28 16-43  W=1312     66   .. 100    ->  0.0503 .. 0.0762 W
    //   07-28 17-14  W=1312     66   .. 100    ->  0.0503 .. 0.0762 W
    //   07-28 19-26  W=1312     69   .. 100    ->  0.0526 .. 0.0762 W
    //
    // and on the game-over screen, where the character holds nothing and the
    // march ran off a 5-pixel scrap of helmet, it was 42.9 css -> 0.0323 W.
    // The old floor let that through by 2.9px and the helper drew a confident
    // "+1" from it.
    //
    // Do NOT set this by looking at the minimum reach a recording reports:
    // that minimum is an artifact of wherever the floor already is, because
    // the floor censors the very tail you are trying to measure. Lowering it
    // from 0.05 to 0.040 "discovered" reaches of 54-64 that the 0.05 floor had
    // been hiding, which is circular and nearly shipped a threshold sitting
    // 0.4px off real data.
    //
    // Measured properly, with the floor disabled entirely, the distribution is
    // bimodal and the gap is obvious (bins are reach in css px on W=1312):
    //
    //            17-14              19-26
    //   30-80     32 (2.5%)          51 (5.5%)    sparse scatter
    //   80-105  1264 (97.5%)        873 (94.5%)   the dart, sharply from 80
    //
    // 2220 accepted frames across the two clips, and the real mode begins at
    // 80 css = 0.0610 W in both. Live agrees: 83.0-85.8 on W=1327.9 = 0.0625
    // -0.0646 W. The one measured no-dart march was 42.9 css = 0.0323 W, well
    // inside the scatter. 0.055 sits in the empty region between the modes --
    // 11% under the real mode's edge and 41% over the bogus reading -- rather
    // than being fitted to either edge. It discards the sub-mode scatter too,
    // which costs nothing: that is 2-5% of frames and the aim survives 400ms
    // of staleness anyway.
    //
    // Note this is a floor, NOT the reach window rejected earlier in this file:
    // that needed an upper bound too, and the upper end did not transfer across
    // resolutions. A floor is set from the real distribution, which is well
    // sampled at both resolutions, and does not care what the top end does.
    // Caveat for whoever tunes this next: the real side has 800+ samples, the
    // no-dart side has exactly one.
    const REACH_MIN_W = 0.055;     // fraction of canvas width
    if (!best || best.reach < REACH_MIN_W * B.cvW) return null;
    // Narrowing the scan alone only moves the problem: a march that wants to
    // point at the floor now pins at SWEEP_LO instead of -75. But that is the
    // tell. A real aim is an interior maximum — the reach falls away on both
    // sides of it — whereas a march that ran out of range is still climbing
    // when the scan stops, so it sits hard against the boundary. Every one of
    // the 38 dive frames measured was within 4.2 degrees of the floor, so a
    // 5-degree boundary band catches them all; the lowest real reading in
    // ~11,200 aims was -28.0, which is 7 degrees clear of the -35 cutoff.
    // Rejecting the boundary costs nothing real and removes what the clamp
    // leaves behind.
    if (best.deg <= SWEEP_LO + 5) return null;
    const near = ext.filter(e => e.reach >= best.reach - 4 * scale);
    if (near.length > 34) return null;              // a broad plateau is the body, not a dart
    let sw = 0, sd = 0;
    for (const e of near) { const w = e.reach - (best.reach - 5 * scale); sw += w; sd += w * e.deg; }
    return { x: sx + gx * kx, y: sy + gy * ky, deg: sd / sw, reach: best.reach / scale };
  }

  // ---------- debug probe ----------
  // With tuning > Debug on, the measured values behind the drawing are
  // published on window.__idleon.darts, refreshed every frame. That is what
  // tools/replay reads back when replaying a recording, and what to look at in
  // the console when the overlay is wrong but the status line looks fine — the
  // status line rounds, and the numbers that decide everything — the board and the wind — never
  // appear in it at all. Costs nothing while debug is off.
  const probe = o => {
    if (!cfg.debug) return;
    (window.__idleon = window.__idleon || {}).darts = o;
  };

  // ---------- state ----------
  let frame = 0, board = null, boardT = 0, wind = { key: 'none', deg: 0 };
  let aimDeg = null, aimT = 0, lastAim = null, lastAimF = -99;
  let dartPts = [], lastDartT = 0, flightWind = 'none', flightAim = null;
  let prevFly = [], lastFlight = null, flightT0 = 0;

  // Every gold blob inside a rectangle of the downscaled frame, in css coords.
  // The hand search does its own copy of this over the LEFT of the screen; this
  // one exists for the right, where a thrown dart lives. Kept separate rather
  // than shared because the two want different rejection rules: the hand search
  // has to pick one blob out of a cluster on the character, this one wants all
  // of them so motion can be matched frame to frame.
  function goldBlobs(I, xa, xb, ya, yb, kx, ky) {
    xa = Math.max(0, xa | 0); xb = Math.min(I.w, xb | 0);
    ya = Math.max(0, ya | 0); yb = Math.min(I.h, yb | 0);
    const seen = new Uint8Array(I.w * I.h), stack = [], out = [];
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
      const i = y * I.w + x;
      if (seen[i] || !isGold(...px(I, x, y))) continue;
      stack.length = 0; stack.push(i); seen[i] = 1;
      let n = 0, sx = 0, sy = 0;
      while (stack.length) {
        const q = stack.pop(), qx = q % I.w, qy = (q / I.w) | 0;
        n++; sx += qx; sy += qy;
        for (const nb of [q - 1, q + 1, q - I.w, q + I.w]) {
          const nx = nb % I.w, ny = (nb / I.w) | 0;
          if (ny < ya || ny >= yb || nx < xa || nx >= xb || seen[nb]) continue;
          if (isGold(...px(I, nx, ny))) { seen[nb] = 1; stack.push(nb); }
        }
      }
      if (n >= 4) out.push({ x: sx / n * kx, y: sy / n * ky, n });
    }
    return out;
  }

  // Predict the flight from a launch point and angle.
  function predict(x0, y0, deg, W, H, wnd) {
    const v = cfg.vN * W, g = cfg.gN * H;
    // Wind pushes ALONG the arrow, so it has a vertical component too — the old
    // model only pushed sideways. Strength scales with the speed the game
    // states, not with the colour band. The vertical component is the part
    // that matters for the board and is where cfg.windK is actually measured
    // (see its comment); the horizontal push is the same constant applied to
    // the arrow's x-component, which the per-throw x-fits are too noisy to
    // confirm (+-300px/s^2 scatter) but too small to matter (~1/4 of a band).
    // Magenta stays suppressed: its arrow glyph is a third the size of cyan's,
    // its direction reads unreliably, and every magenta throw measured was
    // 32-99px out in the same direction. Scaling magnitude up while the
    // direction is wrong only makes it worse, so it is gated until fixed.
    const trust = wnd.key === 'cyan' ? 1 : 0;
    const A = trust * cfg.windK * (wnd.mph || 6) * W;
    const wr = (wnd.deg || 0) * Math.PI / 180;
    // The wind is ONE vector, but the game does not push equally hard along
    // both axes with it. Read out of N.js, the shipped bundle: the minigame
    // builds the wind as 30*cos(phi) and 30*sin(phi) into two slots, then each
    // flight tick adds the horizontal slot over 600 and the vertical slot over
    // 750. Same vector, different divisors — so the horizontal acceleration is
    // 750/600 = 1.25x the vertical one, and a model using a single coefficient
    // for both is wrong on the horizontal axis by exactly that factor.
    //
    // Which axis is the correct one is settled by how windK was measured: it
    // was solved from the vertical acceleration difference between two wind
    // clusters (see its comment), so 0.0158 is the /750 term and it stays. The
    // horizontal is the one that was never independently confirmed — the
    // per-throw x-fits scattered +-300px/s^2 — and it is the one that moves.
    //
    // This should also account for the residual recorded against landN: "the
    // unexplained leftover splits +-20px WITH the wind sign". A horizontal
    // wind error does exactly that. It changes how long the dart takes to
    // reach the board, so it lands at the wrong point on an otherwise correct
    // vertical curve, and the error flips sign when the wind does. landN was
    // fitted with the horizontal term 20% light and is therefore carrying some
    // of it; it wants re-measuring on throws recorded after this change.
    const HV = 1.25;
    const ax = A * HV * Math.cos(wr), ay = -A * Math.sin(wr);
    const th = deg * Math.PI / 180;
    const vx = v * Math.cos(th), vy = -v * Math.sin(th);
    // The residual is eased in over the flight so the line still starts at the
    // dart rather than jumping away from it.
    const off = cfg.landN * H;
    return t => {
      const x = x0 + vx * t + 0.5 * ax * t * t;
      const frac = Math.min(1, Math.max(0, (x - x0) / Math.max(1, W * 0.55)));
      return { x, y: y0 + vy * t + 0.5 * (g + ay) * t * t + off * frac };
    };
  }

  function loop() {
    requestAnimationFrame(loop);
    frame++;
    if (!cfg.on) return;
    const cv = gameCanvas();
    if (!cv) { if (frame % 30 === 0) stEl.textContent = 'no game canvas'; probe({ frame, idle: 'no game canvas' }); return; }

    const rect = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = rect.width, H = rect.height;
    if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) {
      ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr);
      ov.style.width = W + 'px'; ov.style.height = H + 'px';
    }
    ov.style.left = rect.left + 'px'; ov.style.top = rect.top + 'px';
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);

    const I = grab(cv);
    if (!I) { stEl.textContent = readErr; probe({ frame, idle: readErr }); return; }

    if (wallFrac(I) < 0.35) {
      board = null; dartPts = []; aimDeg = null; prevFly = [];
      if (frame % 15 === 0) stEl.textContent = 'idle\nnot in Throwy Darts';
      probe({ frame, idle: 'gated out: wall < 35%' });
      return;
    }

    const b = findBoard(I, W, H);
    if (b) { board = b; boardT = performance.now(); }
    else if (performance.now() - boardT > 900) board = null;
    wind = readWind(I);
    if (wind.key !== 'none') wind.mph = readMph(grabMph(cv));

    const t = performance.now();
    const kx = W / I.w, ky = H / I.h;

    // The dart's gold fletching — found as a BLOB, not as an average of every
    // gold pixel on screen. Averaging dragged the "hand" into the bottom-left
    // corner whenever the "Get 9 Bullseye in a row" trophy hint was showing,
    // because its trophy icons are gold too. The hint sits in the bottom band
    // and the HUD in the top one, so both are cut out.
    //
    // Which of the remaining blobs is the fletching used to be answered with
    // "the leftmost one, since a thrown dart only ever travels right". That is
    // wrong whenever the character is WEARING something gold. Measured on the
    // gold helmet, in the 250x250 native box around the player: the helmet is
    // 261 gold pixels (h 42.0, s 0.57) against the fletching's 156 (h 46.9,
    // s 0.80), and it fragments into seven blobs because the sprite's dark
    // outline runs between the strands. The leftmost of those sits at x=116
    // where the fletching is at x=142, so the "hand" latched onto the helmet,
    // findAim marched from the character's head instead of the chest, and the
    // longest clear run from there is straight DOWN the torso and legs — which
    // is why the predicted line dived off the bottom of the screen at
    // aimDeg -56.8 while the dart was plainly held at about +40.
    //
    // Colour cannot separate them: helmets change colour with gear, so any
    // hue or saturation window that excludes this helmet is only waiting for
    // the next one. The separation that holds is structural — a helmet is worn
    // on the head, the dart is held at chest height, so of the gold on the
    // character the fletching is the LOWEST. The leftmost blob still picks the
    // character out of the scene (a dart in flight is right of the thrower, and
    // is what the x cut below is for); we then keep only blobs within a
    // sprite's width of it and take the lowest of those, so a gold helmet
    // anchors the search and no longer wins it.
    const hand = (() => {
      const y0 = Math.round(I.h * 0.14), y1 = Math.round(I.h * 0.88);
      // The thrower stays in the left half (measured 331-560px of 1326); the
      // board is far right. Cutting there stops a dart already in flight from
      // being mistaken for the one in your hand.
      const x1 = Math.round(I.w * 0.62);
      const seen = new Uint8Array(I.w * I.h), stack = [];
      const blobs = [];
      for (let y = y0; y < y1; y++) for (let x = 0; x < x1; x++) {
        const i = y * I.w + x;
        if (seen[i] || !isGold(...px(I, x, y))) continue;
        stack.length = 0; stack.push(i); seen[i] = 1;
        let n = 0, sx = 0, sy = 0, minx = I.w;
        while (stack.length) {
          const q = stack.pop(), qx = q % I.w, qy = (q / I.w) | 0;
          n++; sx += qx; sy += qy;
          if (qx < minx) minx = qx;
          for (const nb of [q - 1, q + 1, q - I.w, q + I.w]) {
            const nx = nb % I.w, ny = (nb / I.w) | 0;
            if (ny < y0 || ny >= y1 || nx < 0 || nx >= x1 || seen[nb]) continue;
            if (isGold(...px(I, nx, ny))) { seen[nb] = 1; stack.push(nb); }
          }
        }
        if (n < 4) continue;
        blobs.push({ x: sx / n * kx, y: sy / n * ky, n, minx, cy: sy / n });
      }
      if (!blobs.length) return null;
      // The character sprite measured 55 native px wide of 960 (0.057 of the
      // canvas). 0.08 gives room for a wide helmet either side of the body
      // without reaching the next thing on screen.
      const anchor = Math.min(...blobs.map(b => b.minx));
      const near = blobs.filter(b => b.minx - anchor <= I.w * 0.08);
      let best = null;
      for (const b of near) if (!best || b.cy > best.cy) best = b;
      return best;
    })();

    // ---- aim, measured in a native-resolution box around the player ----
    let aim = null;
    if (hand) {
      const B = grabBox(cv, hand.x, hand.y, Math.max(120, W * 0.13), W, H);
      if (B) aim = findAim(B, W, H, hand.x, hand.y);
    }
    if (aim) {
      // The sweep is smooth at roughly 3 deg per frame; anything wilder is the
      // detector latching onto scenery. Without this, occasional readings came
      // out 40 deg wrong and would have drawn a confident, wrong line.
      const df = frame - lastAimF;
      if (lastAim === null || df > 6 || Math.abs(aim.deg - lastAim) <= 12 * df) {
        aimDeg = aim.deg; aimT = t; lastAim = aim.deg; lastAimF = frame;
      } else aim = null;
    }

    // ---- predicted path from the current aim ----
    let hitY = null, hitBand = null;
    if (cfg.path && aim && board && t - aimT < 400) {
      const f = predict(aim.x, aim.y, aimDeg, W, H, wind);
      const pts = [];
      for (let tt = 0; tt <= 3; tt += 0.012) {
        const p = f(tt);
        pts.push(p);
        if (p.x >= board.x) { hitY = p.y; break; }
        if (p.y > H + 40 || p.x > W + 40) break;
      }
      if (pts.length > 1) {
        octx.save();
        octx.setLineDash([4, 6]); octx.lineWidth = 2.2;
        hitBand = hitY !== null ? bandAt(grabBoard(cv, board.x, W), hitY, H) : null;
        octx.strokeStyle = hitBand ? hitBand.col : '#fbbf24';
        octx.shadowColor = 'rgba(0,0,0,.7)'; octx.shadowBlur = 3;
        octx.beginPath(); octx.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) octx.lineTo(p.x, p.y);
        octx.stroke();
        octx.setLineDash([]);
        if (hitY !== null) {
          octx.beginPath(); octx.arc(board.x, hitY, 8, 0, Math.PI * 2); octx.stroke();
          if (cfg.band && hitBand) {
            octx.fillStyle = hitBand.col;
            octx.font = 'bold 15px monospace'; octx.textAlign = 'right';
            octx.fillText(hitBand.name, board.x - 14, hitY - 12);
          }
        }
        octx.restore();
      }
    }

    // ---- a dart already in the air ----
    // This used to be a stub: dartPts was declared, cleared once, and never
    // written, so "Track thrown dart" did nothing and the probe reported
    // dart:0 forever. It matters because the flight is the only place the
    // model can actually be checked -- comparing predicted to observed
    // positions measures vN and gN directly, where a landing point alone
    // cannot separate them from landN.
    //
    // The corridor: left edge past the thrower, right edge short of the board,
    // because darts already stuck in it keep their fletchings and would look
    // like a permanent crowd of candidates. Measured on the live canvas, stuck
    // fletchings sit at css x 1191 against a board at 1272.6, i.e. 0.061 W
    // clear of it, so 0.08 W excludes them with room to spare. The cost is
    // that the last stretch of flight is not seen; that is fine, the fit does
    // not need the impact point.
    if (cfg.live && board) {
      const xa = 0.30 * W, xb = board.x - 0.08 * W;
      const fly = goldBlobs(I, xa / kx, xb / kx, I.h * 0.14, I.h * 0.88, kx, ky);
      // A dart in flight MOVES; the helmet and the stuck darts do not. Launch
      // speed is cfg.vN*W ~ 728 css px/s on this canvas, so at rAF rates a
      // real dart steps roughly 12px per frame. Anything that reappears within
      // a few px of where it sat last frame is scenery.
      const STILL = 0.004 * W;               // ~5px, below one frame of travel
      const STEP  = 0.06 * W;                // ~80px, well over one frame
      if (dartPts.length) {
        const last = dartPts[dartPts.length - 1];
        let pick = null, bd = Infinity;
        for (const f of fly) {
          // Forward progress is REQUIRED, not just "not backwards". There is no
          // drag on the horizontal axis, so a real dart advances by the same
          // amount every frame for the whole flight -- cfg.vN*W ~ 728 css px/s,
          // which is ~12px at rAF rates and more in a 30fps replay, always well
          // over STILL. Accepting a same-place match instead let a finished
          // track latch onto a stationary fletching and never time out: flights
          // of 3.2 and 3.7 seconds, and a dart reported in the air for 63% of
          // all frames when the real duty cycle is nearer a third.
          if (f.x < last.x + STILL) continue;
          const d = Math.hypot(f.x - last.x, f.y - last.y);
          if (d < bd && d <= STEP) { bd = d; pick = f; }
        }
        if (pick) { dartPts.push({ t, x: pick.x, y: pick.y }); lastDartT = t; }
        else if (t - lastDartT > 250) {
          // Flight over: hand the whole thing to the probe in one piece, with
          // the aim and wind captured at RELEASE rather than whatever the
          // sweep has moved on to since.
          if (dartPts.length >= 4) {
            lastFlight = {
              n: dartPts.length, t0: flightT0, dur: +((lastDartT - flightT0) / 1000).toFixed(3),
              aim: flightAim, wind: flightWind,
              x0: +dartPts[0].x.toFixed(1), y0: +dartPts[0].y.toFixed(1),
              pts: dartPts.map(p => ({ dt: +((p.t - flightT0) / 1000).toFixed(3),
                                       x: +p.x.toFixed(1), y: +p.y.toFixed(1) }))
            };
          }
          dartPts = [];
        }
      } else {
        // No flight in progress: a dart is one that was NOT sitting there last
        // frame. Matching against the previous frame is what separates a
        // launch from the scenery, without needing to know where the hand is —
        // which matters because the moment the dart leaves, the hand search
        // has no fletching left to find and falls back to the helmet.
        for (const f of fly) {
          const wasThere = prevFly.some(p => Math.hypot(p.x - f.x, p.y - f.y) <= STILL);
          if (wasThere) continue;
          dartPts = [{ t, x: f.x, y: f.y }];
          flightT0 = t; lastDartT = t;
          flightAim = aimDeg !== null ? +aimDeg.toFixed(2) : null;
          flightWind = { key: wind.key, deg: +(wind.deg || 0).toFixed(1), mph: wind.mph || null };
          break;
        }
      }
      prevFly = fly;
      // Draw what was actually observed, so the checkbox does something
      // visible and a wrong track is obvious rather than silent.
      if (dartPts.length > 1) {
        octx.save();
        octx.strokeStyle = '#38bdf8'; octx.lineWidth = 2;
        octx.shadowColor = 'rgba(0,0,0,.7)'; octx.shadowBlur = 3;
        octx.beginPath(); octx.moveTo(dartPts[0].x, dartPts[0].y);
        for (const p of dartPts) octx.lineTo(p.x, p.y);
        octx.stroke();
        octx.restore();
      }
    } else { prevFly = []; }

    if (frame % 8 === 0) {
      const w = wind.key === 'none' ? 'no wind'
        : `wind ${wind.mph ? wind.mph + 'mph' : wind.key} ${wind.deg.toFixed(0)}°`;
      stEl.textContent = `${w} · ${board ? 'board ok' : 'NO BOARD'}\n` +
        (aimDeg !== null && t - aimT < 400
          ? `aim ${aimDeg.toFixed(0)}°${hitBand ? ` → ${hitBand.name}` : ''}`
          : 'no dart in hand');
    }

    probe({
      frame, board, wind, aimDeg, hand, hitBand, hitY, dart: dartPts.length,
      // The finished flight, published once and then left in place until the
      // next one replaces it: how long it took, where it started, the aim and
      // wind AT RELEASE, and every observed position. This is what a residual
      // is computed from -- predicted vs observed at matching dt -- instead of
      // guessing the release moment backwards from a landing.
      flight: lastFlight,
      // How far the winning march actually got, in css px. Published because
      // it is the value that says whether findAim followed a DART or just ran
      // off the end of its own search: a dart is a protrusion of finite length,
      // the character's torso is not, so a march down the body only stops when
      // it hits the R1 ceiling. Without this in the probe there is no way to
      // tell those two apart after the fact.
      aimReach: aim ? +aim.reach.toFixed(1) : null,
      aimR1: 100,
      cal: { vN: cfg.vN, gN: cfg.gN, windK: cfg.windK, landN: cfg.landN }
    });
  }

  // ---------- wiring ----------
  const toggle = () => { cfg.on = !cfg.on; save(); sync(); };
  runBtn.onclick = toggle;
  $('#path').onchange  = e => { cfg.path = e.target.checked; save(); };
  $('#band').onchange  = e => { cfg.band = e.target.checked; save(); };
  $('#live').onchange  = e => { cfg.live = e.target.checked; save(); };
  $('#debug').onchange = e => { cfg.debug = e.target.checked; save(); };
  $('#cal').onclick = () => {
    cfg.vN = 0.548; cfg.gN = 0.612; cfg.landN = -0.023;
    cfg.windK = 0.0158;
    save();
  };
  minBtn.onclick = () => { cfg.collapsed = !cfg.collapsed; save(); sync(); };
  nub.onclick = () => { cfg.hidden = false; save(); sync(); };

  (() => {
    let dx, dy, drag = false;
    $('#hd').addEventListener('mousedown', e => {
      if (e.target.id === 'min') return;
      drag = true; const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = false;
      const r = panel.getBoundingClientRect();
      cfg.px = Math.round(r.left); cfg.py = Math.round(r.top);
      save();
    });
  })();

  // Keep every control out of the tab order and drop focus as soon as it is
  // released, so a Space or Enter aimed at the game can't re-fire whichever
  // control was touched last.
  root.querySelectorAll('button, input[type=checkbox], summary').forEach(el => {
    el.setAttribute('tabindex', '-1');
    el.addEventListener('mouseup', () => el.blur());
  });
  root.querySelectorAll('input[type=number]').forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') el.blur();
  }));

  // hotkeys (capture phase). These fire even while a number input holds focus:
  // a function key is never typed into a field, and the game canvas swallows
  // the mousedown that would otherwise blur it — so a field left focused used
  // to strand the hotkeys with no way back except the mouse. Whatever is
  // focused is blurred on the way through, committing a half-typed value.
  window.addEventListener('keydown', e => {
    if (e.key !== 'F1' && e.key !== 'F2') return;
    e.preventDefault();
    if (root.activeElement) root.activeElement.blur();
    if (e.key === 'F2') toggle();
    if (e.key === 'F1') { cfg.hidden = !cfg.hidden; save(); sync(); }
  }, true);

  sync();
  requestAnimationFrame(loop);
  };

  if (document.documentElement) boot();
  else document.addEventListener('readystatechange', function once() {
    if (document.documentElement) { document.removeEventListener('readystatechange', once); boot(); }
  });
})();
