// ==UserScript==
// @name         IdleOn Fishing Helper
// @namespace    nativerobot
// @version      1.8
// @description  Draws where your cast will land, plus fish and hazard markers, for the IdleOn fishing minigame
// @match        https://www.legendsofidleon.com/*
// @grant        none
// @run-at       document-start
// @all-frames   true
// ==/UserScript==
(function () {
  'use strict';

  // ---------- make the game's backbuffer readable ----------
  // Same constraint as the hoops helper: OpenFL renders through WebGL, whose
  // drawing buffer is wiped after each compose unless preserveDrawingBuffer is
  // set, and getContext caches per canvas — so this has to land first.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/i.test(type)) attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    return origGetContext.call(this, type, attrs);
  };

  // ---------- persistence ----------
  const KEY = 'fish_cfg';
  const cfg = Object.assign({
    on: true,
    scale: 4,
    marks: true,       // ring the fish and the hazards
    aim: true,         // live landing marker while the power bar charges
    arc: true,         // dotted arc for a bobber already in the air
    ruler: true,       // numbered 0-8 graduations on the gauge and lane
    debug: false,
    // landing = a * powerFraction + b, both as a fraction along the lane.
    // v5: re-measured after the gauge-height bug below was fixed. Every sample
    // gathered before that is worthless — readMeter's top edge could latch onto
    // a speck of foliage a third of a gauge above the pole, so the same red bar
    // reported anywhere between 39% and 67% power, at random, from frame to
    // frame. Six casts off a 44-second recording, pairing the locked fill with
    // where the bobber came to rest: residuals within 3.2% of the lane, mean
    // 1.4%. The v4 pair (0.858 / 0.013) overshoots every one of them — mean
    // 2.5% of the lane long, worst 5.9% — which is the fit soaking up the
    // gauge error it was measured through.
    calVer: 5,         // bump to discard samples gathered in the old power scale
    aimA: 0.830, aimB: 0.004,
    samples: [],       // [powerFraction, landingFraction] pairs, newest last
    collapsed: false,
    hidden: false
  }, JSON.parse(localStorage.getItem(KEY) || '{}'));
  if (cfg.calVer !== 5) { cfg.calVer = 5; cfg.samples = []; cfg.aimA = 0.830; cfg.aimB = 0.004; }
  let saveAt = 0;
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));
  const saveSoon = () => { const t = performance.now(); if (t - saveAt > 1000) { saveAt = t; save(); } };

  const boot = () => {

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645';
  const root = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);

  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 12px/1.4 monospace; }
      canvas { position: fixed; left: 0; top: 0; pointer-events: none; }
      #p { position: fixed; top: 12px; left: 260px; width: 214px;
           background: #14171c; color: #cdd3da; border: 1px solid #2a2f37;
           border-radius: 8px; pointer-events: auto; user-select: none;
           box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      #hd { display:flex; align-items:center; justify-content:space-between;
            padding: 7px 9px; cursor: move; background:#1b1f26; border-radius:8px 8px 0 0; }
      #hd b { color:#8b95a3; font-weight:600; letter-spacing:.3px; }
      #dot { width:9px; height:9px; border-radius:50%; background:#4b5563; display:inline-block; }
      #dot.on { background:#38bdf8; box-shadow:0 0 8px #38bdf8; }
      .body { padding: 9px; display:flex; flex-direction:column; gap:7px; }
      .row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      label { color:#8b95a3; }
      input[type=checkbox] { accent-color:#0284c7; }
      .btn { width:100%; padding:6px; border:0; border-radius:5px; cursor:pointer;
             background:#2a2f37; color:#cdd3da; }
      .btn.go { background:#16a34a; color:#fff; }
      .btn.stop { background:#0284c7; color:#fff; }
      .btn.sm { padding:4px; font-size:11px; }
      #st { color:#6b7280; font-size:11px; white-space:pre-line; min-height:28px; }
      .hint { color:#4b5563; font-size:11px; text-align:center; }
      #min { cursor:pointer; color:#6b7280; padding:0 4px; }
      #nub { position: fixed; top: 6px; left: 28px; width: 13px; height: 13px;
             border-radius: 50%; background: #0284c7; opacity: .55; cursor: pointer;
             pointer-events: auto; display: none; }
      #nub:hover { opacity: 1; }
      details summary { color:#4b5563; cursor:pointer; font-size:11px; outline:none; }
      details .body { padding:7px 0 0; gap:6px; }
    </style>
    <canvas id="ov"></canvas>
    <div id="nub" title="Show Fishing Helper"></div>
    <div id="p">
      <div id="hd"><span><span id="dot"></span> <b>Fishing Helper</b></span><span id="min">–</span></div>
      <div class="body">
        <button class="btn go" id="run">Show helper  (F4)</button>
        <div class="row"><label>Aim marker</label><input id="aim" type="checkbox"></div>
        <div class="row"><label>Fish / hazards</label><input id="marks" type="checkbox"></div>
        <div class="row"><label>Cast arc</label><input id="arcx" type="checkbox"></div>
        <div class="row"><label>Ruler 0–8</label><input id="ruler" type="checkbox"></div>
        <div id="st">idle</div>
        <details>
          <summary>tuning</summary>
          <div class="body">
            <div class="row"><label>Debug blobs</label><input id="debug" type="checkbox"></div>
            <button class="btn sm" id="cal">Reset aim calibration</button>
          </div>
        </details>
        <div class="hint">F4 on/off · F3 hide panel</div>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  const ov = $('#ov'), octx = ov.getContext('2d');
  const dot = $('#dot'), runBtn = $('#run'), panel = $('#p'), stEl = $('#st'),
        nub = $('#nub'), body = $('#p > .body'), minBtn = $('#min');

  function sync() {
    $('#aim').checked = cfg.aim; $('#marks').checked = cfg.marks;
    $('#arcx').checked = cfg.arc; $('#ruler').checked = cfg.ruler;
    $('#debug').checked = cfg.debug;
    dot.classList.toggle('on', cfg.on);
    runBtn.textContent = cfg.on ? 'Hide helper  (F4)' : 'Show helper  (F4)';
    runBtn.className = 'btn ' + (cfg.on ? 'stop' : 'go');
    body.style.display = cfg.collapsed ? 'none' : '';
    minBtn.textContent = cfg.collapsed ? '+' : '–';
    panel.style.display = cfg.hidden ? 'none' : '';
    nub.style.display = cfg.hidden ? '' : 'none';
    if (!cfg.on) octx.clearRect(0, 0, ov.width, ov.height);
  }

  // ---------- pixel readback ----------
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  // The whole frame is read downscaled (cheap, enough to find the lane), but the
  // sprites sitting on the lane are small and spiky — at 4x the urchin breaks
  // into fragments too small to trust. The lane is only a thin strip, so it is
  // re-read at native resolution, which costs about as much as the whole
  // downscaled frame and makes the sprites solid.
  const strip = document.createElement('canvas');
  const stctx = strip.getContext('2d', { willReadFrequently: true });
  let readErr = '';

  function grabStrip(cv, laneYcss, Hcss) {
    const half = Math.max(12, Math.round(cv.height * 0.045));
    const cy = Math.round(laneYcss / Hcss * cv.height);
    const sy = Math.max(0, cy - half);
    const hh = Math.min(cv.height - sy, half * 2);
    if (hh < 4) return null;
    if (strip.width !== cv.width || strip.height !== hh) { strip.width = cv.width; strip.height = hh; }
    try {
      stctx.clearRect(0, 0, cv.width, hh);
      stctx.drawImage(cv, 0, sy, cv.width, hh, 0, 0, cv.width, hh);
      return { d: stctx.getImageData(0, 0, cv.width, hh).data, w: cv.width, h: hh, sy, cvH: cv.height };
    } catch (e) { return null; }
  }

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
      const d = sctx.getImageData(0, 0, sw, sh).data;
      readErr = '';
      return { d, sw, sh };
    } catch (e) {
      readErr = e && e.name === 'SecurityError' ? 'canvas not readable (tainted)' : 'pixel readback failed';
      return null;
    }
  }

  // ---------- colour helpers (measured off the real sprites) ----------
  function hsvAt(d, i) {
    const p = i * 4, r = d[p], g = d[p + 1], b = d[p + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const dd = mx - mn;
    let h = 0;
    if (dd) {
      if (mx === r) h = 60 * (((g - b) / dd) % 6);
      else if (mx === g) h = 60 * ((b - r) / dd + 2);
      else h = 60 * ((r - g) / dd + 4);
      if (h < 0) h += 360;
    }
    return [h, mx ? dd / mx : 0, mx / 255];
  }
  const inH = (h, lo, hi) => lo < hi ? (h >= lo && h <= hi) : (h >= lo || h <= hi);
  const isLane   = (h, s, v) => h > 193 && h < 216 && s > 0.35 && v > 0.48 && v < 0.76;
  const isBobber = (h, s, v) => inH(h, 345, 15) && s > 0.55 && v > 0.55;
  const isFish   = (h, s, v) => h > 118 && h < 175 && s > 0.22 && v > 0.55;
  // Hazard hue and brightness vary by fishing spot: the first one measured sat
  // at hue 320-340 / v.46-.54, another at hue ~350 / v up to .85. Too narrow a
  // window and the AVOID rings simply never appear.
  const isHazard = (h, s, v) => h > 315 && h <= 360 && s > 0.28 && v > 0.3;
  // Higher-tier catches unlocked by landing streaks (eel +2, squid +3, whale +5),
  // measured off the game's legend sprites. The squid's purple sits at 255-315,
  // just clear of the hazard window, which starts at 315. Only the whale's
  // dark-blue body is matched — its pale belly is the same desaturated blue as
  // the sky behind the lane, and its mid-blues would vanish into the lane.
  // The lane's own shadow edge reaches hue ~225 at s .6-.7, which a window
  // starting at 216 rang as a whale; the whale body is hue ~230 at s ~.4, so
  // both the hue floor and a saturation ceiling keep the shadow out.
  const isEel   = (h, s, v) => h > 30 && h < 55 && s > 0.35 && v > 0.55;
  const isSquid = (h, s, v) => h > 255 && h <= 315 && s > 0.22 && v > 0.35;
  const isWhale = (h, s, v) => h > 228 && h < 258 && s > 0.22 && s < 0.6 && v > 0.3;
  const SPECIES = [
    { name: 'FISH',  pts: 1, color: '#4ade80', test: isFish },
    { name: 'EEL',   pts: 2, color: '#facc15', test: isEel },
    { name: 'SQUID', pts: 3, color: '#e879f9', test: isSquid },
    { name: 'WHALE', pts: 5, color: '#60a5fa', test: isWhale },
  ];

  // ---------- the lane ----------
  // The fishing lane is a long flat blue bar. Its longest horizontal run is both
  // the geometry everything else is measured against and the "is this minigame
  // even open?" test — nothing in the overworld produces a run this long in this
  // narrow colour band.
  function findLane(d, w, h) {
    // Fish, hazards and the bobber sit ON the lane and break the colour run into
    // fragments; taking the longest fragment made the measured ends swing by
    // ~50px as things slid along. Bridging generously spans an obstacle, since
    // nothing else nearby shares this colour.
    const maxGap = Math.max(2, Math.round(w * 0.06));
    const edge = Math.max(2, Math.round(w * 0.015));
    let best = null;
    for (let y = Math.round(h * 0.25); y < Math.round(h * 0.70); y++) {
      let run = 0, start = 0, gap = 0;
      for (let x = 0; x <= w; x++) {
        const ok = x < w && isLane(...hsvAt(d, y * w + x));
        if (ok) { if (!run) start = x; run += gap + 1; gap = 0; }
        else if (run && gap < maxGap) gap++;
        else {
          // The open ocean is the same blue and spans the full width, so with
          // generous bridging it outruns the lane. It always reaches the screen
          // edges; the lane is a free-floating bar that never does.
          const x1 = x - gap - 1;
          if (run && start >= edge && x1 <= w - 1 - edge && (!best || run > best.run))
            best = { run, y, x0: start, x1 };
          run = 0; gap = 0;
        }
      }
    }
    if (!best || best.run <= w * 0.20) return null;
    // A long blue run alone is not enough: the Swishy Hoops night sky lands in
    // the same colour band and spans the whole screen. The lane is a thin bar
    // (~1.6% of height), so measuring how far the colour extends vertically
    // tells the two apart outright.
    const mid = (best.x0 + best.x1) >> 1;
    let up = 0, dn = 0;
    while (up < h && best.y - up - 1 >= 0 && isLane(...hsvAt(d, (best.y - up - 1) * w + mid))) up++;
    while (dn < h && best.y + dn + 1 < h && isLane(...hsvAt(d, (best.y + dn + 1) * w + mid))) dn++;
    return (up + dn + 1) <= Math.max(3, h * 0.08) ? best : null;
  }

  // The Swishy Hoops night sky is a dithered gradient, and at some canvas sizes
  // one of its bands is both long and thin enough to pass for a lane. That scene
  // is overwhelmingly dark navy (~93% of pixels) while the fishing spot is bright
  // open water and sky, so rejecting dark scenes outright settles it.
  function tooDark(d, w, h) {
    let navy = 0, tot = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const p = (y * w + x) * 4, r = d[p], g = d[p + 1], b = d[p + 2];
        tot++;
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        if (mx >= 140 || mx === 0 || mx !== b) continue;
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const dd = mx - mn;
        if (dd < 0.35 * mx) continue;
        let hu = 60 * ((r - g) / dd + 4);
        if (hu < 0) hu += 360;
        if (hu > 195 && hu < 255) navy++;
      }
    }
    return tot ? navy / tot > 0.30 : false;
  }

  // Obstacles can only ever make the detected lane look SHORTER than it is, so
  // holding the widest extent seen over a short window recovers the true ends,
  // and taking the median row kills the one-frame flyers. Everything downstream
  // (the aim marker especially) is measured against these, so any wobble here
  // shows up directly as a jittering line.
  let laneHist = [];
  function stableLane(raw, t, h) {
    if (raw) {
      const med = laneHist.length ? laneHist[laneHist.length >> 1].y : raw.y;
      // A row far from the settled one is a different object (usually the ocean).
      if (!laneHist.length || Math.abs(raw.y - med) <= h * 0.06) {
        laneHist.push({ t, x0: raw.x0, x1: raw.x1, y: raw.y });
      }
    }
    laneHist = laneHist.filter(o => t - o.t < 1500);
    if (laneHist.length < 2) return raw ? { x0: raw.x0, x1: raw.x1, y: raw.y } : null;
    const ys = laneHist.map(o => o.y).sort((a, b) => a - b);
    return {
      x0: Math.min(...laneHist.map(o => o.x0)),
      x1: Math.max(...laneHist.map(o => o.x1)),
      y: ys[ys.length >> 1]
    };
  }

  // ---------- the power meter ----------
  // A short vertical gauge just left of the lane that fills from the bottom as
  // you hold. Its fill fraction is what the aim marker is derived from.
  function readMeter(d, w, h, lane) {
    const x0 = Math.max(0, lane.x0 - Math.round(w * 0.10));
    const x1 = Math.max(1, lane.x0 - Math.round(w * 0.005));
    // The pole keeps going below the lane row, down to its base — the fill's
    // zero point. Cutting the scan at the lane line (as this used to) read the
    // gauge about a fifth short: the ruler's 0 floated above the pole's bottom
    // and every fill in the below-lane stretch measured as zero power.
    const yLo = Math.max(0, lane.y - Math.round(h * 0.22)), yHi = Math.min(h, lane.y + Math.round(h * 0.08));
    const isCase = (hu, s, v) => v < 0.55 && inH(hu, 5, 60) && s > 0.25;
    const part = (hu, s, v) => isBobber(hu, s, v) || isCase(hu, s, v);

    // Scanning the whole band and taking the topmost red row put a floor of
    // ~43% on every reading, because the striped beach umbrella beside the
    // meter is red too — so low-power casts could never be predicted. The
    // gauge is a tall thin column and the umbrella is squat, so the column
    // with the longest unbroken vertical run picks out the real meter.
    let bestX = -1, bestRun = 0;
    for (let x = x0; x < x1; x++) {
      let run = 0;
      for (let y = yLo; y < yHi; y++) {
        const [hu, s, v] = hsvAt(d, y * w + x);
        if (part(hu, s, v)) { run++; if (run > bestRun) { bestRun = run; bestX = x; } }
        else run = 0;
      }
    }
    if (bestX < 0 || bestRun < h * 0.05) return null;

    const pad = Math.max(1, Math.round(w * 0.006));
    const cx0 = Math.max(x0, bestX - pad), cx1 = Math.min(x1, bestX + pad + 1);
    // Per row: how many of the band's columns are pole, and how many are fill.
    const n = yHi - yLo;
    const rowN = new Uint8Array(n), rowRed = new Uint8Array(n);
    let peak = 0;
    for (let y = yLo; y < yHi; y++) {
      let c = 0, r = 0;
      for (let x = cx0; x < cx1; x++) {
        const [hu, s, v] = hsvAt(d, y * w + x);
        if (isBobber(hu, s, v)) { r++; c++; }
        else if (isCase(hu, s, v)) c++;
      }
      rowN[y - yLo] = c; rowRed[y - yLo] = r;
      if (c > peak) peak = c;
    }
    // A row is gauge only if enough of the band's WIDTH matches. The pole is a
    // solid 3-4 columns at this sampling; the dark specks of foliage above it
    // are one pixel wide. Taking simply the topmost matching row — which is
    // what this did — let one of those specks sit in for the top of the gauge
    // a third of a gauge too high, on the frames where it survived the
    // downscale. Power is read as fill/height, so the same red bar measured
    // 0.39 on one frame and 0.67 on the next, and the ruler drawn from the same
    // two ends stretched to match. Over a 44-second recording the measured
    // gauge height swung between 21 and 34 rows; with the width test and the
    // walk below it stays at 21 in 92% of frames and never leaves 19-22.
    const need = peak >= 2 ? Math.max(2, Math.ceil(peak / 2)) : 1;
    const on = i => i >= 0 && i < n && rowN[i] >= need;

    // Both ends are walked out from inside the pole rather than taken as the
    // first and last matching row. Two things break the run and have to be
    // stepped over: the row where the fill meets the track blends to a colour
    // that matches neither mask, and the game draws a green marker line across
    // the gauge. The gap to the foliage above is far longer than either, so
    // bridging a couple of rows separates them cleanly.
    const gapMax = Math.max(2, Math.round(h * 0.02));
    const walk = (from, dir) => {
      let cur = from;
      for (;;) {
        let next = -1;
        for (let g = 1; g <= gapMax; g++) {
          const y = cur + dir * g;
          if (y < yLo || y >= yHi) break;
          if (on(y - yLo)) { next = y; break; }
        }
        if (next < 0) return cur;
        cur = next;
      }
    };
    // The base is sought from the lane row down, not up: the dark PTS banner
    // sits lower in the same columns at some layouts.
    let bot = Math.min(lane.y, yHi - 1);
    while (bot > yLo && !on(bot - yLo)) bot--;
    if (!on(bot - yLo)) return null;
    bot = walk(bot, 1);
    const top = walk(bot, -1);
    if (bot - top < 4) return null;
    let fillTop = null;
    const redNeed = Math.max(1, need - 1);
    for (let y = top; y <= bot; y++) if (rowRed[y - yLo] >= redNeed) { fillTop = y; break; }
    const total = bot - top + 1;
    const fill = fillTop === null ? 0 : (bot - fillTop + 1);
    return { top, bot, total, x: bestX, fillTop, frac: Math.max(0, Math.min(1, fill / total)) };
  }

  // The gauge is fixed furniture — it cannot move between frames — so its ends
  // are held over a short window and the median taken, exactly as the lane is.
  // A splash or a floating "+1 FISH" can cover part of the pole for a frame or
  // two, and a gauge measured short reads the same red bar as far more power
  // than it is. Holding the geometry and re-deriving only the fill removed
  // every such outlier from the recording (worst case 6 rows for a 21-row
  // gauge, i.e. triple the true power, on 1% of frames).
  let meterHist = [];
  function stableMeter(m, t) {
    if (m) meterHist.push({ t, top: m.top, bot: m.bot });
    meterHist = meterHist.filter(o => t - o.t < 1500);
    if (!m || meterHist.length < 3) return m;
    const tops = meterHist.map(o => o.top).sort((a, b) => a - b);
    const bots = meterHist.map(o => o.bot).sort((a, b) => a - b);
    const top = tops[tops.length >> 1], bot = bots[bots.length >> 1];
    if (bot - top < 4) return m;
    const total = bot - top + 1;
    const fill = m.fillTop === null ? 0 : (bot - m.fillTop + 1);
    return { top, bot, total, x: m.x, fillTop: m.fillTop,
             frac: Math.max(0, Math.min(1, fill / total)) };
  }

  // ---------- blobs of a given colour on/near the lane ----------
  let mask = new Uint8Array(0), stack = new Int32Array(0);
  function blobs(d, w, h, test, y0, y1, x0, x1) {
    const n = w * h;
    if (mask.length !== n) { mask = new Uint8Array(n); stack = new Int32Array(n); }
    mask.fill(0);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (test(...hsvAt(d, i))) mask[i] = 1;
      }
    const out = [];
    for (let y = y0; y < y1 && out.length < 60; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (mask[i] !== 1) continue;
        let sp = 0; stack[sp++] = i; mask[i] = 2;
        let cnt = 0, sx = 0, sy = 0, ax = w, bx = 0, ay = h, by = 0;
        while (sp) {
          const q = stack[--sp], qx = q % w, qy = (q / w) | 0;
          cnt++; sx += qx; sy += qy;
          if (qx < ax) ax = qx; if (qx > bx) bx = qx;
          if (qy < ay) ay = qy; if (qy > by) by = qy;
          if (qx > x0 && mask[q - 1] === 1) { mask[q - 1] = 2; stack[sp++] = q - 1; }
          if (qx < x1 - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack[sp++] = q + 1; }
          if (qy > y0 && mask[q - w] === 1) { mask[q - w] = 2; stack[sp++] = q - w; }
          if (qy < y1 - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack[sp++] = q + w; }
        }
        if (cnt >= 3) out.push({ x: sx / cnt, y: sy / cnt, w: bx - ax + 1, h: by - ay + 1, n: cnt });
      }
    return out;
  }

  // A single sprite often breaks into a few blobs (the urchin's spikes especially),
  // which would draw a pile of overlapping rings. Merge anything close together.
  function merge(list, gap) {
    const out = [];
    for (const o of list.sort((a, b) => a.x - b.x)) {
      const last = out[out.length - 1];
      if (last && o.x - last.x < gap) {
        const n = last.n + o.n;
        last.x = (last.x * last.n + o.x * o.n) / n;
        last.y = (last.y * last.n + o.y * o.n) / n;
        last.n = n;
      } else out.push({ x: o.x, y: o.y, n: o.n });
    }
    return out;
  }

  // ---------- aim calibration ----------
  function refitAim() {
    const S = cfg.samples;
    if (S.length < 3) return;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [p, l] of S) { n++; sx += p; sy += l; sxx += p * p; sxy += p * l; }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-6) return;
    const a = (n * sxy - sx * sy) / den, b = (sy - a * sx) / n;
    if (a > 0.15 && a < 2.5 && b > -0.6 && b < 0.6) { cfg.aimA = a; cfg.aimB = b; }
  }
  const aimFrac = p => Math.max(0, Math.min(1, cfg.aimA * p + cfg.aimB));
  // Inverse of the mapping: what power lands ON a given lane fraction. Only as
  // good as the current calibration, same as the aim marker.
  const invAim = f => cfg.aimA > 0.05 ? Math.max(0, Math.min(1, (f - cfg.aimB) / cfg.aimA)) : null;

  // ---------- state ----------
  let frame = 0, lane = null, laneT = 0;
  let bob = null, bobHist = [], lastBobT = 0;
  let charge = 0, chargeSeen = 0, hold = null;

  function drawLaneMark(x, y, color, label, sub) {
    octx.save();
    octx.shadowColor = 'rgba(0,0,0,.6)'; octx.shadowBlur = 3;
    octx.strokeStyle = color; octx.lineWidth = 2.5;
    octx.beginPath(); octx.arc(x, y, 11, 0, Math.PI * 2); octx.stroke();
    octx.fillStyle = color; octx.font = 'bold 11px monospace';
    if (label) {
      octx.textAlign = 'center';
      octx.fillText(label, x, y - 15);
    }
    if (sub) {
      octx.textAlign = 'right';
      octx.fillText(sub, x - 16, y + 4);
    }
    octx.restore();
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

    const img = grab(cv);
    if (!img) { stEl.textContent = readErr; return; }
    const { d, sw, sh } = img;
    const kx = W / sw, ky = H / sh;
    const t = performance.now();

    const raw = tooDark(d, sw, sh) ? null : findLane(d, sw, sh);
    if (raw) laneT = t;
    const L = (t - laneT > 700) ? (laneHist = [], null) : stableLane(raw, t, sh);
    lane = L;
    if (!lane) {
      bobHist = []; hold = null; meterHist = [];
      if (frame % 15 === 0) stEl.textContent = 'idle\nnot at the fishing spot';
      return;
    }

    const laneX0 = lane.x0 * kx, laneX1 = lane.x1 * kx, laneY = lane.y * ky;
    const laneW = laneX1 - laneX0;

    // lane outline
    octx.save();
    octx.strokeStyle = 'rgba(56,189,248,.45)'; octx.lineWidth = 1.5;
    octx.setLineDash([4, 5]);
    octx.beginPath(); octx.moveTo(laneX0, laneY); octx.lineTo(laneX1, laneY); octx.stroke();
    octx.restore();

    // ---- fish and hazards sitting on the lane ----
    // On-lane sprites are found in the native-resolution strip, then mapped back
    // into CSS space. Thresholds are deliberately strict: a real fish measures
    // ~30x30px solid, while the lane's own highlight edge produces long 3px-tall
    // slivers. Better to ring nothing than to ring the wrong thing.
    const S = grabStrip(cv, laneY, H);
    let fish = [], haz = [], landed = null;
    if (S) {
      const toCss = o => ({ x: o.x / S.w * W, y: (S.sy + o.y) / S.cvH * H, w: o.w / S.w * W, h: o.h / S.cvH * H, n: o.n });
      const sx0 = Math.round(laneX0 / W * S.w), sx1 = Math.round(laneX1 / W * S.w);
      const px = S.w / W;                                    // native px per CSS px
      // The strip is tall enough that scenery pokes into it: the surfboard
      // rack at the spot's right edge matches both the hazard pink and the
      // bobber red, and wore a permanent AVOID ring. Everything the minigame
      // owns sits on the lane row, so blobs vertically off it are scenery.
      const onLane = o => Math.abs(o.y - laneY) < H * 0.03;
      const raw = (test, minN) => blobs(S.d, S.w, S.h, test, 0, S.h, Math.max(0, sx0), Math.min(S.w, sx1))
        .filter(o => o.n >= minN).map(toCss).filter(onLane);
      const clump = W * 0.025;
      // One pass per species, with two geometry screens:
      // - Sprites are solid and roughly square, while the lane's shading breaks
      //   into runs only a few px tall — a height floor kills those slivers in
      //   whatever colour band they fall, and lets the pixel-count floor sit
      //   lower than the old 200 (a real green fish measured ~190 matching px
      //   at a 713px-wide window, which is how it lost its ring).
      // - The sand mound shares the eel's gold and its centroid can clear a
      //   start margin, but it is anchored AT the lane's left end — so anything
      //   whose left edge touches the start is scenery, not a catch.
      const startX = laneX0 + laneW * 0.02;
      const minH = H * 0.02;
      fish = [];
      for (const sp of SPECIES)
        for (const o of raw(sp.test, 120 * px * px))
          if (o.w > W * 0.012 && o.h > minH && o.x - o.w / 2 > startX)
            fish.push({ ...o, name: sp.name, pts: sp.pts, color: sp.color });
      const bobs2 = raw(isBobber, 60 * px * px);
      landed = bobs2.sort((a, b) => b.n - a.n)[0] || null;
      // The bobber is red too, so it lands in the hazard mask. Drop clusters
      // that coincide with it, and require the rest to be urchin-sized.
      haz = merge(raw(isHazard, 30 * px * px), clump)
        .filter(o => o.n >= 110 * px * px)
        .filter(o => !landed || Math.abs(o.x - landed.x) > W * 0.02);
    }
    if (cfg.marks) {
      // Left of each catch, the power that would land the cast on it — the
      // number to release the gauge at. Recomputed every frame, so once the
      // fish start moving (later in a run) the label tracks them.
      for (const f of fish) {
        const p = invAim((f.x - laneX0) / laneW);
        drawLaneMark(f.x, f.y, f.color, `${f.name} +${f.pts}`, p !== null ? ((p * 100) | 0) + '%' : null);
      }
      for (const z of haz) drawLaneMark(z.x, z.y, '#f87171', 'AVOID');
    }

    // ---- power meter ----
    const m = stableMeter(readMeter(d, sw, sh, lane), t);
    if (m) {
      charge = m.frac;
      if (charge > 0.02) chargeSeen = t;
    }

    // Tick on the gauge at each catch's target power, in the species colour:
    // release when the fill reaches the mark.
    if (cfg.marks && m && fish.length) {
      octx.save();
      octx.lineWidth = 2;
      octx.shadowColor = 'rgba(0,0,0,.6)'; octx.shadowBlur = 3;
      for (const f of fish) {
        const p = invAim((f.x - laneX0) / laneW);
        if (p === null) continue;
        const tx = m.x * kx, ty = (m.bot - p * (m.bot - m.top)) * ky;
        octx.strokeStyle = f.color;
        octx.beginPath(); octx.moveTo(tx - 12, ty); octx.lineTo(tx + 8, ty); octx.stroke();
      }
      octx.restore();
    }

    // ---- ruler: numbered graduations tying the gauge to the lane ----
    // Same idea as se7enek's IdleonHelper static overlay (gauge mark N lands
    // at lane mark N), but generated from the learned mapping instead of a
    // stretched image, so the numbers stay honest as calibration refits.
    if (cfg.ruler) {
      octx.save();
      octx.font = 'bold 10px monospace';
      octx.shadowColor = 'rgba(0,0,0,.7)'; octx.shadowBlur = 3;
      octx.strokeStyle = 'rgba(255,255,255,.65)'; octx.fillStyle = 'rgba(255,255,255,.85)';
      octx.lineWidth = 1.5;
      for (let k = 0; k <= 8; k++) {
        const lx = laneX0 + aimFrac(k / 8) * laneW;
        octx.textAlign = 'center';
        octx.beginPath(); octx.moveTo(lx, laneY + 4); octx.lineTo(lx, laneY + 11); octx.stroke();
        octx.fillText(k, lx, laneY + 22);
        if (m) {
          const gx = m.x * kx, gy = (m.bot - (k / 8) * (m.bot - m.top)) * ky;
          octx.beginPath(); octx.moveTo(gx - 6, gy); octx.lineTo(gx + 6, gy); octx.stroke();
          octx.textAlign = 'right';
          octx.fillText(k, gx - 9, gy + 3);
        }
      }
      octx.restore();
    }

    // ---- bobber ----
    const above0 = Math.max(0, lane.y - Math.round(sh * 0.30));
    const bobs = blobs(d, sw, sh, isBobber, above0, Math.max(above0 + 1, lane.y - 2),
                       Math.round(lane.x0 - sw * 0.003), lane.x1)
      .filter(o => o.n >= 3 && o.w <= Math.round(sw * 0.05) && o.h <= Math.round(sh * 0.09));
    bob = bobs.sort((a, b) => b.n - a.n)[0] || null;
    if (cfg.debug && bob) {
      octx.strokeStyle = 'rgba(255,255,255,.8)'; octx.lineWidth = 1;
      octx.strokeRect(bob.x * kx - bob.w * kx / 2, bob.y * ky - bob.h * ky / 2, bob.w * kx, bob.h * ky);
    }

    if (bob) {
      const p = { t, x: bob.x * kx, y: bob.y * ky };
      if (bobHist.length && (t - lastBobT > 220 || Math.abs(p.x - bobHist[bobHist.length - 1].x) > W * 0.25)) bobHist = [];
      bobHist.push(p); if (bobHist.length > 30) bobHist.shift();
      lastBobT = t;
    } else if (t - lastBobT > 300) bobHist = [];

    // ---- arc + landing prediction for a bobber in the air ----
    let landX = null;
    if (bobHist.length >= 4) {
      const pts = bobHist.filter(q => bobHist[bobHist.length - 1].t - q.t <= 400);
      if (pts.length >= 4) {
        const t0 = pts[0].t, n = pts.length;
        let st = 0, s2 = 0, s3 = 0, s4 = 0, sx = 0, stx = 0, sy = 0, sty = 0, stty = 0;
        for (const q of pts) {
          const tt = (q.t - t0) / 1000, t2 = tt * tt;
          st += tt; s2 += t2; s3 += t2 * tt; s4 += t2 * t2;
          sx += q.x; stx += tt * q.x; sy += q.y; sty += tt * q.y; stty += t2 * q.y;
        }
        const den = n * s2 - st * st;
        if (Math.abs(den) > 1e-9) {
          const vx = (n * stx - st * sx) / den, x0 = (sx - vx * st) / n;
          const sol = solve3([[s4, s3, s2], [s3, s2, st], [s2, st, n]], [stty, sty, sy]);
          if (sol && sol[0] > 50) {
            const a = sol[0], b = sol[1], c = sol[2];
            // solve a t^2 + b t + c = laneY for the landing time
            const disc = b * b - 4 * a * (c - laneY);
            if (disc >= 0) {
              const tl = (-b + Math.sqrt(disc)) / (2 * a);
              const now = (t - t0) / 1000;
              if (tl > now - 0.1 && tl < now + 3) {
                landX = x0 + vx * tl;
                if (cfg.arc) {
                  octx.save();
                  octx.setLineDash([4, 5]); octx.lineWidth = 2;
                  octx.strokeStyle = '#ffd166';
                  octx.shadowColor = 'rgba(0,0,0,.6)'; octx.shadowBlur = 3;
                  octx.beginPath();
                  for (let tt = now; tt <= tl; tt += 0.016) {
                    const px = x0 + vx * tt, py = a * tt * tt + b * tt + c;
                    tt === now ? octx.moveTo(px, py) : octx.lineTo(px, py);
                  }
                  octx.lineTo(landX, laneY);
                  octx.stroke();
                  octx.restore();
                }
              }
            }
          }
        }
      }
    }

    // ---- learn power -> landing ----
    // The gauge sweeps up and back down while you hold; releasing LOCKS it at
    // the chosen value, where it stays until the bobber is reeled back in. That
    // plateau is the power actually used — sampling the peak instead paired the
    // wrong power with the wrong cast, which made the mapping look random.
    if (charge > 0.05) {
      if (!hold || Math.abs(charge - hold.power) > 0.03) hold = { power: charge, t, xs: [] };
      else if (landed && t - hold.t > 300) hold.xs.push(landed.x);
    } else if (hold) {
      if (hold.xs.length >= 6) {
        const xs = hold.xs.slice().sort((a, b) => a - b);
        const mid = xs[xs.length >> 1];
        const spread = xs[xs.length - 1] - xs[0];
        const landFrac = (mid - laneX0) / laneW;
        if (spread < W * 0.02 && landFrac > -0.05 && landFrac < 1.05) {
          cfg.samples.push([hold.power, landFrac]);
          if (cfg.samples.length > 20) cfg.samples.shift();
          refitAim(); saveSoon();
        }
      }
      hold = null;
    }

    // ---- live aim marker while charging ----
    let aimX = null;
    if (cfg.aim && charge > 0.02 && !bob) {
      aimX = laneX0 + aimFrac(charge) * laneW;
      const near = fish.some(f => Math.abs(f.x - aimX) < W * 0.02);
      const bad = haz.some(z => Math.abs(z.x - aimX) < W * 0.02);
      octx.save();
      // Landing on a fish counts as the fish even with a mine directly under
      // it, so the catch colour outranks the hazard colour.
      octx.strokeStyle = near ? '#4ade80' : (bad ? '#f87171' : '#ffd166');
      octx.lineWidth = 3;
      octx.beginPath(); octx.moveTo(aimX, laneY - 26); octx.lineTo(aimX, laneY + 12); octx.stroke();
      octx.beginPath();
      octx.moveTo(aimX - 6, laneY - 26); octx.lineTo(aimX + 6, laneY - 26); octx.lineTo(aimX, laneY - 16);
      octx.closePath(); octx.fillStyle = octx.strokeStyle; octx.fill();
      octx.restore();
    }
    if (landX !== null) {
      octx.save();
      octx.strokeStyle = '#ffd166'; octx.lineWidth = 2.5;
      octx.beginPath(); octx.arc(landX, laneY, 8, 0, Math.PI * 2); octx.stroke();
      octx.restore();
    }

    if (frame % 8 === 0) {
      const cal = `lane ${laneW | 0}px · ${cfg.samples.length} casts learned`;
      const line2 = bob ? (landX !== null ? `cast lands at ${((landX - laneX0) / laneW * 100) | 0}% of lane` : 'tracking cast')
                  : charge > 0.02 ? `power ${(charge * 100) | 0}% → ${(aimFrac(charge) * 100) | 0}% of lane`
                  : `${fish.length} fish · ${haz.length} hazards`;
      stEl.textContent = cal + '\n' + line2;
    }
  }

  function solve3(M, V) {
    const A = M.map((r, i) => r.concat(V[i]));
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      const tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
      }
    }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  }

  // ---------- wiring ----------
  const toggle = () => { cfg.on = !cfg.on; if (!cfg.on) bobHist = []; save(); sync(); };
  runBtn.onclick = toggle;
  $('#aim').onchange   = e => { cfg.aim = e.target.checked; save(); };
  $('#marks').onchange = e => { cfg.marks = e.target.checked; save(); };
  $('#arcx').onchange  = e => { cfg.arc = e.target.checked; save(); };
  $('#ruler').onchange = e => { cfg.ruler = e.target.checked; save(); };
  $('#debug').onchange = e => { cfg.debug = e.target.checked; save(); };
  $('#cal').onclick = () => { cfg.samples = []; cfg.aimA = 0.830; cfg.aimB = 0.004; save(); };
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
    if (e.key !== 'F3' && e.key !== 'F4') return;
    e.preventDefault();
    if (root.activeElement) root.activeElement.blur();
    if (e.key === 'F4') toggle();
    if (e.key === 'F3') { cfg.hidden = !cfg.hidden; save(); sync(); }
  }, true);

  sync();
  requestAnimationFrame(loop);
  };

  if (document.documentElement) boot();
  else document.addEventListener('readystatechange', function once() {
    if (document.documentElement) { document.removeEventListener('readystatechange', once); boot(); }
  });
})();
