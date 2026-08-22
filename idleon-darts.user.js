// ==UserScript==
// @name         IdleOn Darts Helper
// @namespace    nativerobot
// @version      1.1
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
    hidden: false
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
      if (n < 10 || w < 3 || w > 16 || h < 8 || h > 18) continue;
      const g = new Uint8Array(w * h);
      for (const [cx, cy] of cells) g[(cy - y0) * w + (cx - x0)] = 1;
      glyphs.push({ x0, w, h, g });
    }
    glyphs.sort((a, b) => a.x0 - b.x0);
    if (!glyphs.length) return null;
    const digits = [];
    for (let i = 0; i < glyphs.length; i++) {
      if (i > 0 && glyphs[i].x0 - glyphs[i - 1].x0 > 16) break;   // gap before "mph"
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
  function findAim(B, W, H) {
    const sx = B.sx / B.cvW * W, sy = B.sy / B.cvH * H;
    const kx = W / B.cvW, ky = H / B.cvH;
    let gx = 0, gy = 0, gn = 0;
    for (let y = 0; y < B.h; y++) for (let x = 0; x < B.w; x++) {
      if (isGold(...px(B, x, y))) { gx += x; gy += y; gn++; }
    }
    if (gn < 8) return null;
    gx /= gn; gy /= gn;
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
    for (let deg = -75; deg <= 80; deg++) {
      const th = deg * Math.PI / 180, ux = Math.cos(th), uy = -Math.sin(th);
      let reach = R0, gap = 0;
      for (let r = R0; r <= R1; r++) {
        if (notWall(Math.round(gx + ux * r), Math.round(gy + uy * r))) { reach = r; gap = 0; }
        else if (++gap > 4) break;
      }
      ext.push({ deg, reach });
      if (!best || reach > best.reach) best = { deg, reach };
    }
    if (!best || best.reach < 40 * scale) return null;
    const near = ext.filter(e => e.reach >= best.reach - 4 * scale);
    if (near.length > 34) return null;              // a broad plateau is the body, not a dart
    let sw = 0, sd = 0;
    for (const e of near) { const w = e.reach - (best.reach - 5 * scale); sw += w; sd += w * e.deg; }
    return { x: sx + gx * kx, y: sy + gy * ky, deg: sd / sw, reach: best.reach / scale };
  }

  // ---------- state ----------
  let frame = 0, board = null, boardT = 0, wind = { key: 'none', deg: 0 };
  let aimDeg = null, aimT = 0, lastAim = null, lastAimF = -99;
  let dartPts = [], lastDartT = 0, flightWind = 'none', flightAim = null;

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
    const ax = A * Math.cos(wr), ay = -A * Math.sin(wr);
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
    if (!cv) { if (frame % 30 === 0) stEl.textContent = 'no game canvas'; return; }

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
    if (!I) { stEl.textContent = readErr; return; }

    if (wallFrac(I) < 0.35) {
      board = null; dartPts = []; aimDeg = null;
      if (frame % 15 === 0) stEl.textContent = 'idle\nnot in Throwy Darts';
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
    // and the HUD in the top one, so both are cut out; of what remains the
    // leftmost blob is the hand, since a thrown dart only ever travels right.
    const hand = (() => {
      const y0 = Math.round(I.h * 0.14), y1 = Math.round(I.h * 0.88);
      // The thrower stays in the left half (measured 331-560px of 1326); the
      // board is far right. Cutting there stops a dart already in flight from
      // being mistaken for the one in your hand.
      const x1 = Math.round(I.w * 0.62);
      const seen = new Uint8Array(I.w * I.h), stack = [];
      let best = null;
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
        if (!best || minx < best.minx) best = { x: sx / n * kx, y: sy / n * ky, n, minx };
      }
      return best;
    })();

    // ---- aim, measured in a native-resolution box around the player ----
    let aim = null;
    if (hand) {
      const B = grabBox(cv, hand.x, hand.y, Math.max(120, W * 0.13), W, H);
      if (B) aim = findAim(B, W, H);
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
    if (cfg.live && hand && dartPts.length) { /* hand still holds one; nothing to do */ }

    if (frame % 8 === 0) {
      const w = wind.key === 'none' ? 'no wind'
        : `wind ${wind.mph ? wind.mph + 'mph' : wind.key} ${wind.deg.toFixed(0)}°`;
      stEl.textContent = `${w} · ${board ? 'board ok' : 'NO BOARD'}\n` +
        (aimDeg !== null && t - aimT < 400
          ? `aim ${aimDeg.toFixed(0)}°${hitBand ? ` → ${hitBand.name}` : ''}`
          : 'no dart in hand');
    }
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
    window.addEventListener('mouseup', () => drag = false);
  })();

  window.addEventListener('keydown', e => {
    if (root.activeElement && root.activeElement.tagName === 'INPUT') return;
    if (e.key === 'F2') { e.preventDefault(); toggle(); }
    if (e.key === 'F1') { e.preventDefault(); cfg.hidden = !cfg.hidden; save(); sync(); }
  }, true);

  sync();
  requestAnimationFrame(loop);
  };

  if (document.documentElement) boot();
  else document.addEventListener('readystatechange', function once() {
    if (document.documentElement) { document.removeEventListener('readystatechange', once); boot(); }
  });
})();
