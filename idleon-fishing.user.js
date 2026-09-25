// ==UserScript==
// @name         IdleOn Fishing Helper
// @namespace    nativerobot
// @version      2.13
// @downloadURL https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-fishing.user.js
// @updateURL   https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-fishing.user.js
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
    ink: true,         // draw the species marks in the dark palette, not the neon one
    aim: true,         // live landing marker while the power bar charges
    arc: true,         // dotted arc for a bobber already in the air
    ruler: true,       // numbered 0-8 graduations on the gauge and lane
    bob: true,         // predict where the fish will be when the cast lands
    debug: false,
    // Where a cast lands is not fitted any more. The SHAPE of the curve is the
    // game's own — see "the game's own cast law" below — and the only thing
    // learned from your casts is where the lane sprite the helper found sits in
    // the game's units: landing = (castU(p) - aimU0) / aimUW along the lane.
    //
    // The parabola this replaces was measured, and is still the anchor. 19
    // casts across two fishing spots, powers 0.09 to 1.00, each pairing the
    // locked gauge fill with where the bobber came to rest:
    //
    //   line       mean 2.2% of the lane, worst 3.9%, residuals still curved
    //   parabola   mean 1.1% of the lane, worst 2.2%, no pattern left
    //
    // These two seeds are the affine fit that reproduces that parabola most
    // closely across the whole gauge: 0.58% of the lane on average, 1.65% at
    // worst, comfortably inside the parabola's own 1.1% residual against the
    // casts it was fitted to. The independent route in the catch-size comment
    // — lane ends at game x 11 and 311 — lands 1.1% of the lane from these,
    // which is the same agreement from a third direction.
    //
    // The parabola is gone rather than kept as a fallback because its error was
    // never noise, it was SHAPE: positive at both ends, -1.9% of the lane
    // through the middle, against a fish window only ±5% of the lane wide. No
    // amount of refitting a parabola removes that. Only the right curve does,
    // and now there is one.
    calVer: 6,         // bump to discard samples gathered under an older gauge
    aimU0: 8.96,       // the lane's near end, in the game's own cast units
    aimUW: 296.85,     // and how many of them the lane spans
    samples: [],       // [powerFraction, landingFraction] pairs, newest last
    // Milliseconds between you deciding to let go and the game locking the
    // power in — your reaction, the browser's event, the frame you were
    // looking at already being a frame old, all of it. It is worth a mark of
    // its own because the gauge moves FAST: a release 30 ms late lands 3 lane
    // units further out at the bottom of the gauge and 18 at the top, against
    // catch windows of 15 to 23. That is the whole of "I have to aim under the
    // mark or I sail past it".
    //
    // Seeded at 0 because it is yours, not the game's, and nobody else's number
    // would be honest here. The status line measures what your casts are
    // actually doing against the marks; tuning > lead is where to put it.
    lead: 0,           // ms
    leadObs: [],       // recent signed release errors, in rungs, newest last
    collapsed: false,
    hidden: false,
    px: null, py: null // dragged panel position, viewport px
  }, JSON.parse(localStorage.getItem(KEY) || '{}'));
  // Samples are (power, landing) pairs and would survive a change of model —
  // but not a change of what "power" meant. Everything learned before v6 was
  // paired with a gauge reading that could collapse. Everything learned before
  // v7 was paired with a gauge read through the 4x downscale, where one row of
  // the ~21-row gauge was ~5% of it and the reading could not resolve the
  // game's own step at all — so those pairs carry the readback error in the
  // power axis, and refitting on them fits the error. They go too.
  if (cfg.calVer !== 7) {
    cfg.calVer = 7; cfg.samples = [];
  }
  // 2.6 replaced the fitted parabola with the game's own cast curve, and that
  // is NOT a calVer bump: a sample is a gauge reading paired with a landing,
  // measured exactly as before, and nothing about what either number means has
  // changed. Throwing them away would cost you your calibration to buy nothing.
  // So the coefficients go and the samples stay, to be refitted into the new
  // pair on load. With them goes the aim2 = 0 case the old straight-line
  // fallback could leave behind, which cannot arise any more — no shape is
  // being fitted at all now.
  delete cfg.aim2; delete cfg.aim1; delete cfg.aim0;
  delete cfg.aimA; delete cfg.aimB;
  if (!(cfg.aimUW > 0)) { cfg.aimU0 = 8.96; cfg.aimUW = 296.85; }
  if (!Array.isArray(cfg.leadObs)) cfg.leadObs = [];
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
        <div class="row"><label>Dark marks</label><input id="ink" type="checkbox"></div>
        <div class="row"><label>Cast arc</label><input id="arcx" type="checkbox"></div>
        <div class="row"><label>Ruler 0–8</label><input id="ruler" type="checkbox"></div>
        <div class="row"><label>Lead the fish</label><input id="bob" type="checkbox"></div>
        <div id="st">idle</div>
        <details>
          <summary>tuning</summary>
          <div class="body">
            <div class="row"><label>Release lead</label>
              <span><input id="lead" type="number" min="0" max="300" step="10" style="width:52px">ms</span></div>
            <button class="btn sm" id="takelead">Use the measured lead</button>
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
    $('#aim').checked = cfg.aim; $('#marks').checked = cfg.marks;
    $('#ink').checked = cfg.ink;
    $('#arcx').checked = cfg.arc; $('#ruler').checked = cfg.ruler;
    $('#bob').checked = cfg.bob;
    $('#debug').checked = cfg.debug; $('#lead').value = cfg.lead | 0;
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

  // The gauge is read at NATIVE resolution, in its own narrow grab. Everything
  // else works off the 4x-downscaled frame, which is fine for finding a lane
  // 20% of the screen wide and hopeless for a gauge ~64px tall: see the power
  // meter section for what that cost. The band is ~10% of the width by 30% of
  // the height, so this reads about a fortieth of the frame — cheaper than the
  // downscaled grab it corrects, and it only runs once a lane has been found.
  const gauge = document.createElement('canvas');
  const gctx = gauge.getContext('2d', { willReadFrequently: true });

  function grabGauge(cv, lane, sw, sh) {
    // lane is in downscaled coordinates; nx/ny carry back to native ones.
    const nx = cv.width / sw, ny = cv.height / sh;
    const sx = Math.max(0, Math.floor((lane.x0 - sw * 0.10) * nx));
    const ex = Math.min(cv.width, Math.ceil((lane.x0 - sw * 0.005) * nx));
    const sy = Math.max(0, Math.floor((lane.y - sh * 0.22) * ny));
    const ey = Math.min(cv.height, Math.ceil((lane.y + sh * 0.08) * ny));
    const w = ex - sx, h = ey - sy;
    if (w < 4 || h < 16) return null;
    if (gauge.width !== w || gauge.height !== h) { gauge.width = w; gauge.height = h; }
    try {
      gctx.clearRect(0, 0, w, h);
      gctx.drawImage(cv, sx, sy, w, h, 0, 0, w, h);
      return { d: gctx.getImageData(0, 0, w, h).data, w, h, sx, sy, nx, ny,
               cvW: cv.width, cvH: cv.height };
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
  //
  // The window also has to WRAP, and it never did. Written as 315..360 it
  // stops dead at the top of the circle, and hsvAt returns hue 0 — not 360 —
  // for pure red. A colour census of the Blunder Hills lane read off the live
  // canvas found the urchin's two strongest tones sitting at exactly hue 0:
  // rgb(240,66,66) s.73 v.94, 96px of outline, and rgb(125,93,93) s.26 v.49,
  // 96px of body. Both were outside 315..360, so not one of the sprite's 456
  // pixels could ever match and the AVOID ring never appeared at that spot at
  // all. inH wraps the same way isBobber's 345..15 does; +5 is enough to cover
  // hue 0 without letting the window drift towards the sand's orange.
  const isHazard = (h, s, v) => inH(h, 315, 5) && s > 0.28 && v > 0.3;
  // Higher-tier catches unlocked by landing streaks (eel +2, squid +3, whale +5),
  // measured off the game's legend sprites. The squid's purple sits at 255-315,
  // just clear of the hazard window, which starts at 315. Only the whale's
  // dark-blue body is matched — its pale belly is the same desaturated blue as
  // the sky behind the lane, and its mid-blues would vanish into the lane.
  // The lane's own shadow edge reaches hue ~225 at s .6-.7, which a window
  // starting at 216 rang as a whale; the whale body is hue ~230 at s ~.4, so
  // both the hue floor and a saturation ceiling keep the shadow out.
  //
  // The squid's saturation floor came off that legend icon and was far too high
  // for the sprite swimming in the lane. Read off the live canvas, the sprite is
  // three flat tones and only ONE of them cleared s > .22:
  //
  //   rgb(237,204,240)  h295 s.150 v.94  138px   body — the bulk of it
  //   rgb(147,89,161)   h288 s.447 v.63   63px   mid shading
  //   rgb(49,24,60)     h282 s.600 v.24   77px   outline (below the v floor)
  //
  // Keeping only the 63 shading pixels left them scattered as single dots
  // through the body they outline, so nothing connected: no component reached
  // even a 21px floor, let alone the 63px the count screen wanted, and the
  // squid was never ringed once. At s > .12 the sprite comes back as a single
  // 173px, 22x24 blob. The floor is set .03 below the body's exact .15 rather
  // than snug against it because that .15 is a palette entry, and a sprite
  // drawn at another scale blends its edges. A whole-canvas sweep at s > .10
  // turned up no new component anywhere, so there is room below to spend.
  const isEel   = (h, s, v) => h > 30 && h < 55 && s > 0.35 && v > 0.55;
  const isSquid = (h, s, v) => h > 255 && h <= 315 && s > 0.12 && v > 0.35;
  const isWhale = (h, s, v) => h > 228 && h < 258 && s > 0.22 && s < 0.6 && v > 0.3;
  // How close the bobber has to land, per species, in the game's lane units.
  // The catch test is
  //     |fishX - bobberX| < 6 + SIZE[type]
  // with SIZE = [6,6,9,10,12,13,17,17] and the 6 being the bobber's own
  // half-width. Points identify the type: 1pt is type 2, 2pt is type 3, 3pt is
  // type 4 and 5pt is type 6, so the tolerances come out at 15, 16, 18 and 23
  // lane units. The pufferfish is type 5, size 13, so 19.
  //
  // It is a REGION, not a point, and a wide one: a whale is forgiving over
  // nearly a sixth of the lane, half again as much as a fish, which the sprite
  // sizes do not suggest at all. Everything that draws these draws both edges.
  //
  // These stay in the game's units and are turned into a fraction of the lane
  // at the point of use, dividing by the same learned cfg.aimUW the cast curve
  // is read through — one number describing how wide this lane is, used for
  // both, instead of a constant here that could disagree with it. A fraction is
  // what survives a resize; raw pixels would not.
  //
  // Two sets of colours to draw them in. The species marks are the one thing
  // here drawn across BOTH of the minigame's backgrounds: the band and the ring
  // sit on the lane, which is dark water, while the gauge band and the labels
  // climb into the bright sky above it. No single colour wins on both, which is
  // why this is two sets and a halo rather than one set of colours.
  //
  // WCAG contrast of each fill against the two backgrounds it is drawn over,
  // sampled off a Blunder Hills frame (sky ~#9fd8f0, L .63; lane water
  // ~#2a6f97, L .14) and against the halo behind it:
  //
  //             on sky   on water   on white
  //   neon  FISH   1.12     3.16       1.74
  //         EEL    1.01     3.59       1.53   <- the worst of them: yellow at
  //         SQUID  1.59     2.23       2.46      L .64 is the sky's own
  //         WHALE  1.64     2.16       2.54      luminance, to two decimals
  //   ink   FISH   3.24     1.10       5.02
  //         EEL    3.18     1.12       4.92
  //         SQUID  4.08     1.15       6.32
  //         WHALE  4.33     1.22       6.70
  //
  // The neon set is Tailwind's 400 weights, and the table says what is wrong
  // with it: over the sky every one of them is between 1.0 and 1.7, and 1.0 is
  // the number for "not there". The gauge band and the species label are the
  // two marks you actually read while charging, and both live up there.
  //
  // The ink set is the 700 weights, which buys 3.2-4.3 over the sky - roughly
  // triple the separation - and gives up the water in exchange, dropping to
  // 1.10-1.22. That trade is only survivable because the halo flips with the
  // palette: dark ink gets a WHITE halo instead of the neon set's black one.
  // The last column is why that works and why it had to come with the colours -
  // the ink set reads 4.9 to 6.7 against white, where the neon set manages 1.5
  // to 2.5, so a white halo under neon would have been no halo at all. Ink
  // alone would have moved the problem from the sky to the lane; ink plus the
  // halo puts a 5.5:1 edge (white on water) around every mark that needs one.
  //
  // Hues stay distinct after the darkening, which is the other thing that could
  // have broken: green 142 deg, amber 36, magenta 295, blue 224.
  const PALETTE = {
    neon: { FISH: '#4ade80', EEL: '#facc15', SQUID: '#e879f9', WHALE: '#60a5fa',
            halo: 'rgba(0,0,0,.6)' },
    ink:  { FISH: '#15803d', EEL: '#a16207', SQUID: '#a21caf', WHALE: '#1d4ed8',
            halo: 'rgba(255,255,255,.85)' },
  };
  const spCol = name => PALETTE[cfg.ink ? 'ink' : 'neon'][name];
  const spHalo = () => PALETTE[cfg.ink ? 'ink' : 'neon'].halo;
  // The alphas below were all chosen for the neon set, where the fill is bright
  // and a 0.16 wash still glows. Half the luminance needs more of it to read as
  // the same weight of mark, so every species alpha goes through here. 1.75 is
  // taste, not measurement - it is where the two sets look like the same mark
  // side by side - but it is applied in one place so it stays adjustable.
  const inkA = a => cfg.ink ? Math.min(1, a * 1.75) : a;

  const SPECIES = [
    { name: 'FISH',  pts: 1, test: isFish,  catchU: 15 },
    { name: 'EEL',   pts: 2, test: isEel,   catchU: 16 },
    { name: 'SQUID', pts: 3, test: isSquid, catchU: 18 },
    { name: 'WHALE', pts: 5, test: isWhale, catchU: 23 },
  ];
  const HAZARD_U = 19;                 // pufferfish, type 5, size 13
  const tolFrac = u => u / cfg.aimUW;

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
  //
  // The gauge is read at NATIVE resolution, out of its own grab, while the lane
  // and everything else come off the 4x-downscaled frame. That split is the
  // whole point of this section, so it is worth writing down why.
  //
  // The game sets the fill sprite's vertical scale to round(64 * power) — read
  // out of N.js, the shipped bundle, where _event_Minigames1 does
  //
  //     theta += 1                          (starts at 90, one step per tick)
  //     power  = 1 - |sin(theta degrees)|
  //     AdjustImgInst("height", fillSprite, 100 * round(64 * power))
  //
  // and AdjustImgInst("height", img, e) is set_scaleY(SCALE * e / 100). So the
  // fill takes exactly 65 heights and one step is the game's SCALE in pixels.
  //
  // Read through the 4x downscale the whole gauge came to ~21 rows, so a step
  // was under a third of a row: the reading could not resolve the game's own
  // quantum, and a one-row error in either the fill or the track was ~5% of the
  // gauge. The aim curve's slope near full charge is ~1.18 lane-fractions per
  // unit of power, so that single row arrived as ~6% of the lane — four times
  // the error of the curve it was feeding. That is why long casts were far off
  // while short ones looked fine: the same row is worth ~6% at full charge and
  // very little near zero, because the charge law is flattest at the bottom.
  const RUNGS = 64;

  function readMeter(G, lane) {
    const { d, w, h, sx, sy, nx, ny, cvW, cvH } = G;
    const isCase = (hu, s, v) => v < 0.55 && inH(hu, 5, 60) && s > 0.25;
    const part = (hu, s, v) => isBobber(hu, s, v) || isCase(hu, s, v);

    // Scanning the whole band and taking the topmost red row put a floor of
    // ~43% on every reading, because the striped beach umbrella beside the
    // meter is red too — so low-power casts could never be predicted. The
    // gauge is a tall thin column and the umbrella is squat, so the column
    // with the longest vertical run picks out the real meter.
    //
    // The run BRIDGES small gaps, as findLane does. It did not have to when
    // this ran on the downscaled frame: the 4x box filter blurred the pole's
    // own texture, the fill/track seam and the green marker line into pixels
    // that passed, so an unbroken run was easy to come by. At native
    // resolution those gaps are real, and a strict run measured 16-32 rows
    // against the 38 this test demands — every frame above about a third
    // charge failed outright and the meter read nothing at all. Bridging is
    // also what keeps the test meaningful rather than merely looser: what
    // separates the gauge from the umbrella is that the gauge is LONG, and a
    // run broken into thirds cannot show that.
    const bridge = Math.max(2, Math.round(cvH * 0.006));
    let bestX = -1, bestRun = 0;
    for (let x = 0; x < w; x++) {
      let run = 0, gap = 0, longest = 0;
      for (let y = 0; y < h; y++) {
        const [hu, s, v] = hsvAt(d, y * w + x);
        if (part(hu, s, v)) { run += gap + 1; gap = 0; if (run > longest) longest = run; }
        else if (run && gap < bridge) gap++;
        else { run = 0; gap = 0; }
      }
      if (longest > bestRun) { bestRun = longest; bestX = x; }
    }
    if (bestX < 0 || bestRun < cvH * 0.05) return null;

    const pad = Math.max(1, Math.round(cvW * 0.006));
    const cx0 = Math.max(0, bestX - pad), cx1 = Math.min(w, bestX + pad + 1);
    // Per row: how many of the band's columns are pole, and how many are fill.
    const rowN = new Uint8Array(h), rowRed = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0, r = 0;
      for (let x = cx0; x < cx1; x++) {
        const [hu, s, v] = hsvAt(d, y * w + x);
        if (isBobber(hu, s, v)) { r++; c++; }
        else if (isCase(hu, s, v)) c++;
      }
      rowN[y] = c; rowRed[y] = r;
    }
    // One matching pixel in the row is enough. There WAS a width test here —
    // "at least half as many columns as the widest row" — to keep single-pixel
    // foliage specks from standing in for the top of the gauge. It was wrong,
    // and it took a second fishing spot to show why: it measured the fill's
    // apparent width against a peak taken from the TRACK, and the two masks
    // are not comparable. isCase is loose (v<.55, s>.25) so a blended edge
    // pixel still counts as track, while isBobber wants s>.55 and a blended
    // edge pixel does not count as fill. The track therefore always looks
    // wider than the fill, by about a column.
    //
    // On the spot it was tuned against, the fill was 2 columns and the test
    // demanded 2 — it passed with nothing to spare. On a spot where the camera
    // sits closer the gauge is narrower, the fill downscales to a SINGLE
    // column, and every fill row failed: the gauge collapsed from 22 rows to 6
    // and the power read 1.00 for a bar that was three-quarters full.
    //
    // What actually separates a gauge from a speck is not width, it is that a
    // gauge is a long unbroken run and a speck is one or two isolated rows.
    // The walk below tests exactly that, and it was already doing the work.
    const on = i => i >= 0 && i < h && rowN[i] > 0;

    // Both ends are walked out from inside the pole rather than taken as the
    // first and last matching row. Two things break the run and have to be
    // stepped over: the row where the fill meets the track blends to a colour
    // that matches neither mask, and the game draws a green marker line across
    // the gauge. The gap to the foliage above is far longer than either, so
    // bridging a couple of rows separates them cleanly.
    const gapMax = Math.max(2, Math.round(cvH * 0.02));
    const walk = (from, dir) => {
      let cur = from;
      for (;;) {
        let next = -1;
        for (let g = 1; g <= gapMax; g++) {
          const y = cur + dir * g;
          if (y < 0 || y >= h) break;
          if (on(y)) { next = y; break; }
        }
        if (next < 0) return cur;
        cur = next;
      }
    };
    // The base is sought from the lane row down, not up: the dark PTS banner
    // sits lower in the same columns at some layouts.
    let bot = Math.min(Math.round(lane.y * ny) - sy, h - 1);
    if (bot < 0) return null;
    while (bot > 0 && !on(bot)) bot--;
    if (!on(bot)) return null;
    bot = walk(bot, 1);
    const top = walk(bot, -1);
    // Four rows of the OLD downscaled gauge, which is 4*ny native rows now.
    if (bot - top < 4 * ny) return null;
    let fillTop = null;
    for (let y = top; y <= bot; y++) if (rowRed[y] > 0) { fillTop = y; break; }
    // Ends come back in native canvas pixels, which is the space the geometry
    // is held in — the band offset sy moves with the lane row and must not
    // leak into a value that is supposed to be fixed furniture.
    return {
      x: (sx + bestX) / nx,
      topAbs: sy + top, botAbs: sy + bot,
      fillTopAbs: fillTop === null ? null : sy + fillTop,
      nx, ny
    };
  }

  // The gauge is fixed furniture — it cannot move between frames, and the game
  // never resizes it — so its two ends are settled ONCE and then held, instead
  // of being re-derived every frame. A splash or a floating "+1 FISH" can cover
  // part of the pole for a frame or two, and a gauge measured short reads the
  // same red bar as far more power than it is. The previous version took a
  // rolling median over 1500ms, which removed the outliers (worst case 6 rows
  // for a 21-row gauge, i.e. triple the true power, on 1% of frames) but still
  // let the denominator drift with whatever the last 1.5s happened to contain.
  // A denominator that drifts is not noise, it is a slow scale error on every
  // prediction, and the aim marker cannot tell the two apart.
  let meterHist = [], meterGeom = null;
  function resetMeter() { meterHist = []; meterGeom = null; }

  function stableMeter(m, t) {
    if (!m) return null;
    if (!meterGeom) {
      meterHist.push({ t, top: m.topAbs, bot: m.botAbs });
      meterHist = meterHist.filter(o => t - o.t < 1500);
      if (meterHist.length >= 10) {
        const med = k => {
          const a = meterHist.map(o => o[k]).sort((x, y) => x - y);
          return a[a.length >> 1];
        };
        meterGeom = { top: med('top'), bot: med('bot') };
      }
    }
    const top = meterGeom ? meterGeom.top : m.topAbs;
    const bot = meterGeom ? meterGeom.bot : m.botAbs;
    const totalPx = bot - top + 1;
    if (totalPx < 4) return null;
    const fillPx = m.fillTopAbs === null ? 0 : Math.max(0, bot - m.fillTopAbs + 1);
    const rawFrac = Math.max(0, Math.min(1, fillPx / totalPx));
    // The game's power is always exactly k/64, so snapping the reading to that
    // ladder ought to remove the sub-step noise for free. It is computed, and
    // reported, but deliberately NOT what the helper uses. That reads backwards
    // until you know where the rungs land in pixels, so:
    //
    // The ladder is real. The minigame attaches the gauge's two sprites from
    // one anchor: the track at anchor.y-87, the fill at anchor.y-23 with its
    // origin moved to its own bottom edge so it grows upward. 87-23 = 64, the
    // same 64 the fill's scale is quantised to — a full fill reaches exactly
    // the track's top edge, one rung is exactly one game unit, and fill/track
    // really is the power.
    //
    // And on the live canvas the rung is exactly one PIXEL. Watched through
    // tools/chrome over a session of real casts, totalPx reads 64 and never
    // anything else, because the backing store is the game's own resolution —
    // so fillPx/64 IS k/64 by construction. Fifteen distinct locked charges
    // came back 0.063, 0.094, 0.141, 0.156 ... 0.813, every one of them a whole
    // rung, the largest departure being the 0.05% that three decimal places of
    // printout can account for on its own. rawFrac needs no snapping: it is
    // already exact.
    //
    // Which also explains the recordings, where 585 readings sat no closer to
    // the rungs than random, at 32, 64 or 128 alike. Those captured the canvas
    // at its CSS size, 750 tall against the game's 540, so a unit spanned
    // 750/540 = 1.389px and the gauge measured the ~89px we saw. A rung that
    // is 1.4px wide, through H.264, against a fill edge the colour masks
    // resolve to about half a pixel, is a rung that does not survive being
    // measured. The ladder was there; the capture destroyed it.
    //
    // So the snap stays off, and the two measurements say why better than
    // either does alone: it is an identity at 64px, exactly where it would be
    // safe, and unreliable at 89px, exactly where it would have to earn its
    // place. There is no canvas size at which it is worth having. `snapped`
    // stays in the probe as the check — if it ever diverges from rawFrac on a
    // live canvas, the gauge is being read at a scale nobody has thought about.
    const snapped = Math.round(rawFrac * RUNGS) / RUNGS;
    const frac = rawFrac;
    return {
      x: m.x,
      top: top / m.ny, bot: bot / m.ny,
      fillTop: m.fillTopAbs === null ? null : m.fillTopAbs / m.ny,
      total: totalPx / m.ny,
      totalPx, fillPx, stepPx: totalPx / RUNGS, rawFrac, frac, snapped,
      settled: !!meterGeom
    };
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

  // ---------- the game's own cast law ----------
  // Every version up to 2.5 learned power -> landing by fitting a curve to the
  // casts it had watched. None of it has to be guessed at. The minigame was
  // lifted out of the client and reimplemented offline (~/projects/minigames,
  // out of scripts.ActorEvents_229._event_Minigames1), and the cast is a dozen
  // lines of it:
  //
  //   * holding advances an angle by one whole degree every 10 ms update,
  //     starting at 90, and the gauge shows 1 - |sin(angle)|;
  //   * releasing launches the bobber at (0.4 + 2.06p, -1.4 - 1.45p) under
  //     gravity 0.05 per update;
  //   * the update that WOULD carry it past y = 5 does not move it at all, so
  //     the bobber rests on the last x it actually reached rather than where
  //     the parabola crosses the water. Worth up to one whole x-step short.
  //
  // Two things fall out that no fitted curve can give:
  //
  //   * The gauge is a LADDER of 91 rungs, one per update of the hold, because
  //     the angle only ever takes whole degrees. There is no cast in between
  //     two rungs, which makes a catch window countable instead of estimated.
  //   * The rungs are NOT evenly spaced. |cos| is the rate, so the fill crawls
  //     off the bottom of the gauge and sprints at the top: one rung moves the
  //     landing 0.8 lane units at 6% fill and 6.6 at full. That is why the same
  //     catch window is 210 ms wide up close and 30 ms wide at the far end, and
  //     why a late release costs so much more on a long cast.
  //
  // Checked two ways. Driven headless against the offline module itself over
  // all 91 casts: the same landing to 4e-13 of a lane unit, so this is a
  // transcription and not a re-derivation. And against the 19 measured casts,
  // through the parabola that was fitted to them: 0.58% of the lane apart on
  // average, inside that parabola's own 1.1% residual.
  //
  // Built once at load: 91 casts of about 120 updates each.
  const CAST = (() => {
    const out = [];
    for (let ang = 90; ang <= 180; ang++) {
      const p = 1 - Math.abs(Math.sin(ang * Math.PI / 180));
      let x = 0, y = 0, vy = -1.4 - 1.45 * p;
      const vx = 0.4 + 2.06 * p;
      // The loop guard is the game's own test, and the step it refuses to take
      // is the point of it. The x < 5 arm is the game's too: the first updates
      // always run, before the bobber has cleared the rod.
      let k = 0;
      for (; k < 400 && (y + vy < 5 || x < 5); k++) { x += vx; y += vy; vy += 0.05; }
      // How long this cast is in the air, which matters because the fish keep
      // swimming while it is. 600 ms off the bottom of the gauge, 1160 ms off
      // the top — more than a fifth of the lane bob's whole period.
      out.push({ ang, p, u: x, ms: k * 10 });
    }
    return out;
  })();
  const REACH0 = CAST[0].u, REACH1 = CAST[CAST.length - 1].u;   // 24.0 .. 285.4

  // A gauge fill and the rung under it, both ways. The rung is just the angle,
  // so this is closed form rather than a walk of the table: the hold runs
  // 90 -> 180 and |sin| is one-to-one across it.
  const rungP = a => 1 - Math.abs(Math.sin(a * Math.PI / 180));
  const pRung = p => 180 - Math.asin(Math.max(0, Math.min(1, 1 - p))) * 180 / Math.PI;

  // Where a cast at gauge fill p comes to rest, in the game's lane units, and
  // back again. The table is monotone in both columns, so each is a binary
  // search and a straight line across the single rung the answer lands in. The
  // interpolating is for READINGS, which fall anywhere; a cast never does.
  const span = (key, v) => {
    let lo = 0, hi = CAST.length - 1;
    if (v <= CAST[lo][key]) return 0;
    if (v >= CAST[hi][key]) return hi - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (CAST[mid][key] <= v) lo = mid; else hi = mid; }
    return lo;
  };
  const across = (key, out, v) => {
    const i = span(key, v), A = CAST[i], B = CAST[i + 1], d = B[key] - A[key];
    return d === 0 ? A[out] : A[out] + (B[out] - A[out]) * (v - A[key]) / d;
  };
  const castU = p => across('p', 'u', p);
  const castP = u => across('u', 'p', u);

  // ---------- aim calibration ----------
  // Two numbers now, not three, and neither of them is the shape of anything:
  // where the lane sprite this helper found begins in the game's units, and how
  // many of them it covers. The lane is the only thing that varies — how wide
  // findLane measured it, where it decided the ends were — and it enters the
  // model linearly, so the fit is a straight line through
  //
  //     landing fraction = A * castU(power) + B,   aimUW = 1/A, aimU0 = -B/A
  //
  // Two free parameters need far fewer samples than three ever did, three is
  // enough to move off the seed, and there is no longer any fallback path or
  // any way for the fit to bend the wrong way: it cannot bend at all.
  function refitAim() {
    const S = cfg.samples;
    if (S.length < 3) return;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [p, l] of S) {
      const x = castU(p);
      n++; sx += x; sy += l; sxx += x * x; sxy += x * l;
    }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return;
    const A = (n * sxy - sx * sy) / den;
    if (!(A > 0)) return;                       // a lane running backwards
    const uW = 1 / A, u0 = -((sy - A * sx) / n) * uW;
    // The same two gates the parabola was held to, for the same reason: a fit
    // that puts an empty gauge off the near end of the lane, or a full one off
    // the far end, is a fit through a mis-measured lane and not a cast curve.
    // The third gate it needed — that the curve rises all the way across — is
    // gone because the curve is the game's and rises by construction.
    const at = u => (u - u0) / uW;
    if (at(REACH0) < -0.15 || at(REACH0) > 0.35) return;
    if (at(REACH1) < 0.5 || at(REACH1) > 1.3) return;
    cfg.aimU0 = u0; cfg.aimUW = uW;
  }
  // Samples carried across from the parabola are still good measurements; fold
  // them into the new pair now rather than waiting for the next cast to land.
  refitAim();

  const aimFrac = p => Math.max(0, Math.min(1, (castU(p) - cfg.aimU0) / cfg.aimUW));

  // Inverse of the mapping: what power lands ON a given lane fraction. Clamped
  // rather than refused at the ends, because the far end of the lane is out of
  // reach — a full cast stops at 93% of it — and yet fish spawn out to 96%
  // and are still catchable from there, being only 3% short against a window of
  // 5%. Whether such a fish can actually be had is planFor's answer, not
  // this one's.
  const invAim = f => Math.max(0, Math.min(1, castP(cfg.aimU0 + f * cfg.aimUW)));

  // ---------- the catch window ----------
  // The rungs of the gauge that land a cast close enough to catch. This is the
  // whole of what the game asks: |fishX - bobberX| < 6 + SIZE, evaluated
  // against every cast that can be made, so what comes back is not an estimate
  // of a tolerance but the list of releases that work.
  //
  // Measured across every position each species can spawn at, with a fish that
  // is holding still:
  //
  //   fish   tol 15   5..21 rungs    50..210 ms   mean  90 ms
  //   eel    tol 16   5..8  rungs    50..80  ms   mean  61 ms
  //   squid  tol 18   3..7  rungs    30..70  ms   mean  56 ms
  //   whale  tol 23   3..9  rungs    30..90  ms   mean  69 ms
  //
  // and nothing is ever unreachable. But the far half of the lane is a 30-to-70
  // ms window, which is why a release that is 30 ms late — and 30 ms is a
  // frame and a half — misses everything out there while the same release up
  // close still lands. Hence the lead below.
  //
  // `where` is asked where the fish will be at a given moment, because each
  // rung is in the air for a different length of time (600 ms off the bottom of
  // the gauge, 1160 off the top) and the fish do not hold still. Testing every
  // rung separately against its OWN landing moment is the only way to get this
  // right; there is no single position of the fish to aim at.
  const hitRungs = (where, catchU, now) => {
    const out = [];
    const from = now + (cfg.lead || 0);
    for (let i = 0; i < CAST.length; i++)
      if (Math.abs(where(from + CAST[i].ms) - CAST[i].u) < catchU) out.push(i);
    return out;
  };

  // The rungs as contiguous runs. In 60 simulated lanes at casts 18-42 the set
  // never once split, and it should not be able to: a rung is worth 0.8 lane
  // units at the bottom of the gauge and 6.6 at the top, against a fish that
  // covers at most 0.41 of a unit in the 10 ms between one rung's landing and
  // the next's, so the landing always outruns the fish. Drawn as runs anyway,
  // because the cost is ten lines and the alternative is a band that quietly
  // spans a gap it should not.
  const runsOf = rungs => {
    const runs = [];
    for (const i of rungs) {
      const last = runs[runs.length - 1];
      if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
    }
    return runs;
  };

  // null means no cast catches it, which is a real answer and not a failure.
  // Every position the game can SPAWN at has a window — checked over all of
  // them — but the near end of the lane does not: a zero-power cast still
  // flies 24 lane units, so anything inside about 3% of the lane is short of
  // the shortest cast there is. Seen live on a replayed clip, on the frames
  // where the species pass picks something up in the lane's left padding. The
  // ring still draws; it just has no power to put beside it, which beats
  // clamping to an empty gauge and claiming that would work.
  const planFor = (where, catchU, now) => {
    const rungs = hitRungs(where, catchU, now);
    if (!rungs.length) return null;
    const mid = rungs[rungs.length >> 1];
    return {
      rungs, runs: runsOf(rungs), n: rungs.length,
      lo: CAST[rungs[0]].p, hi: CAST[rungs[rungs.length - 1]].p,
      // mid is the rung in the MIDDLE OF THE WINDOW, not the one that lands
      // dead on the fish. For anything in reach they are within a rung of each
      // other; for a fish past the end of a full cast only this one exists.
      mid: CAST[mid].p,
      // and where the fish will actually BE when that cast arrives, which is
      // what the lane band is drawn around. Not where it is now, and not the
      // span it drifts across on the way.
      at: where(now + (cfg.lead || 0) + CAST[mid].ms)
    };
  };

  // ---------- the fish do not hold still ----------
  // From cast 6 the lane bobs: bob = A * sin(G16), with G16 advancing 1.3
  // degrees every 20 ms, so 65 deg/s and a period of 5.54 s. A is 13 lane units
  // to cast 16 and grows after 17, reaching 23 by cast 30 and 30 by cast 60.
  //
  // That is not a detail. A cast is in the air 600 to 1160 ms, and over 900 ms
  // of it a fish at the wide end of that range covers up to 35 lane units —
  // more than a whale's entire catch window. Marking where a fish IS is
  // therefore close to worthless late in a run. Simulated over 60 lanes at
  // casts 18-42, of the casts a mark placed on the fish's current position
  // calls a catch:
  //
  //   where the fish is now          450 casts called, 53% really catch
  //   where it will be on landing    437 casts called, 99% really catch
  //
  // 53% is a coin flip, and it is what every version before this one drew.
  //
  // The fit is the honest one: the frequency is known exactly, so only the
  // centre, amplitude and phase are unknown, and x = c + a sin(wt) + b cos(wt)
  // is linear in all three. What it needs is TIME, not samples — a short arc
  // of a sinusoid fits beautifully and extrapolates into nonsense:
  //
  //   history   prediction error 900 ms out, p50 / p90 / worst
  //     0.5 s        3.6  /  8.6  / 16.0      (useless)
  //     1.0 s        1.0  /  2.3  /  4.5
  //     1.5 s        0.5  /  1.1  /  2.5
  //     2.5 s        0.2  /  0.5  /  1.0
  //
  // And the residual CANNOT be used to tell those apart: fits that went on to
  // miss by more than 6 units had an rms of 0.28 against 0.30 for the ones that
  // did not. The short window fits its noise perfectly and is wrong anyway. So
  // the gate is the SPAN and nothing else, set at 1.2 s for margin over the
  // 1.0 s where the failures stop, and below it the helper says it is not
  // tracking rather than guessing.
  //
  // Driven end to end — THIS code, fed fish positions out of the offline module
  // frame by frame, its plans then scored against the game's own bob advanced
  // to each rung's landing moment — 60 lanes, 458 casts called hittable:
  //
  //   98.0% really catch at 50 fps, 97.6% at 30, none of the plans cold
  //   after 2.0 s of frames, and not one of the 60 split into two runs.
  //
  // The band ends up a median 15.3 lane units ahead of the sprite, worst 28.3.
  // That offset IS the correction, and it is why the leader line is drawn: at
  // 28 units the band is nowhere near the fish it belongs to, and without
  // something joining the two it just looks broken.
  //
  // The one assumption is that the page's clock and the game's agree, since w
  // is fixed and the timestamps are performance.now(). If the game falls behind
  // real time the fit is off-frequency. Injected deliberately: 5% slow costs
  // 93.3%, 20% slow costs 82.5% — still well clear of the 53% that marking the
  // fish where it sits scores, so a laggy page degrades this rather than
  // inverting it. Found by getting it wrong in the test rig first.
  const BOB_W = 65 * Math.PI / 180 / 1000;   // rad per ms
  const TRACK_KEEP = 2500;                   // history kept, ms
  const TRACK_SPAN = 1200;                   // ...and how much of it the fit needs
  const TRACK_AMP = 45;                      // the game's own worst case is 36
  let tracks = [];

  // Which detected fish is which, frame to frame. Nearest within its own
  // species, and only within 12 lane units — a fish covers 0.41 of a unit
  // between frames at its fastest, so 12 is enormous slack for the centroid
  // jitter while staying under the gap the game leaves between two fish.
  function trackFish(seen, now, frozen) {
    // The bob stops dead while the bobber is in the water, and the fish are
    // moved to new places the moment it is reeled in. Both make every sample
    // taken before now a lie about where the fish is going, so the history goes
    // with them. This is also why the gate matters: after every catch the fit
    // is cold for 1.2 s, and it says so instead of drawing a stale curve.
    if (frozen) { tracks = []; return; }
    const free = tracks.slice();
    for (const s of seen) {
      let best = null, bestD = 12;
      for (const tr of free) {
        const d = Math.abs(tr.u - s.u);
        if (tr.name === s.name && d < bestD) { best = tr; bestD = d; }
      }
      if (best) free.splice(free.indexOf(best), 1);
      else { best = { name: s.name, t0: now, hist: [] }; tracks.push(best); }
      best.u = s.u; best.seen = now;
      best.hist.push({ t: now - best.t0, u: s.u });
      while (best.hist.length > 1 && now - best.t0 - best.hist[0].t > TRACK_KEEP) best.hist.shift();
      s.track = best;
    }
    tracks = tracks.filter(tr => now - tr.seen < 400);
  }

  // c + a sin(wt) + b cos(wt), least squares, w known. Returns null until the
  // history is long enough to mean anything.
  function bobFit(tr) {
    const h = tr.hist;
    if (h.length < 8 || h[h.length - 1].t - h[0].t < TRACK_SPAN) return null;
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], V = [0, 0, 0];
    for (const q of h) {
      const f = [1, Math.sin(BOB_W * q.t), Math.cos(BOB_W * q.t)];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) M[i][j] += f[i] * f[j];
        V[i] += f[i] * q.u;
      }
    }
    const s = solve3(M, V);
    if (!s) return null;
    const [c, a, b] = s;
    // A fit wilder than the game can produce is a fit through something that
    // is not a bobbing fish — a flickering detection, two sprites swapped.
    if (!(Math.hypot(a, b) <= TRACK_AMP)) return null;
    return t => c + a * Math.sin(BOB_W * (t - tr.t0)) + b * Math.cos(BOB_W * (t - tr.t0));
  }

  // ---------- release lead ----------
  // cfg.lead is the delay between you deciding to let go and the game locking
  // the power in, in milliseconds, and the gauge does not wait for you: one
  // rung is 10 ms and moves the landing 0.8 to 6.6 lane units. So every mark is
  // drawn EARLY by that much, and letting go as the fill reaches a mark locks
  // the power the mark is actually about.
  //
  // Both directions are exact, because a lead is only rungs — the angle is
  // what advances — so it is lead/10 degrees either way.
  const leadRungs = () => (cfg.lead || 0) / 10;
  // The fill to watch for, in order to lock p. Clamped at the bottom of the
  // sweep: a mark at 0 means there is no releasing early enough for that fish,
  // which is worth seeing rather than hiding.
  const leadBack = p => rungP(Math.max(90, pRung(p) - leadRungs()));
  // And what will actually lock if you let go while the fill reads p. Past the
  // top the sweep turns round and the gauge falls again; that is the game's
  // behaviour, so |sin| is left to do it rather than clamping it away.
  const leadFwd = p => rungP(pRung(p) + leadRungs());

  // Nobody can tell you your own reaction time, but your casts can. Every
  // release locks a power, and the helper knows exactly what it was showing as
  // the mark for each fish at that instant — the gap between the two, in
  // rungs, is how late that release was. Ten milliseconds a rung.
  //
  // WHICH mark you were aiming at is the only guess in it, so it is guarded
  // twice: the runner-up has to be more than twice as far off as the winner or
  // the cast is not attributable, and anything more than 12 rungs out was not
  // aimed at that fish at all. Both guards fail towards having no reading
  // rather than a wrong one, which is the right way round for a number whose
  // whole job is to be believed.
  //
  // Read-only, deliberately. cfg.lead moves when you move it and not before: a
  // mark that silently chases your own misses is a mark that shifts under you
  // every time you start to learn the timing, and then neither of you is
  // converging on anything.
  function learnLead(h) {
    if (!h.marks.length) return;
    const mine = pRung(h.power);
    const by = h.marks.map(mk => ({ mk, d: Math.abs(pRung(mk) - mine) })).sort((a, b) => a.d - b.d);
    if (by[0].d > 12) return;
    if (by.length > 1 && by[1].d < by[0].d * 2) return;
    cfg.leadObs.push(Math.round((mine - pRung(by[0].mk)) * 10) / 10);
    if (cfg.leadObs.length > 12) cfg.leadObs.shift();
    saveSoon();
  }
  // The middle one, not the mean: there are only ever twelve, and a single cast
  // aimed somewhere else entirely would drag an average across the whole
  // readout. Four before it says anything at all.
  const leadSeen = () => {
    const o = cfg.leadObs;
    if (o.length < 4) return null;
    const s = o.slice().sort((a, b) => a - b), h = s.length >> 1;
    return s.length & 1 ? s[h] : (s[h - 1] + s[h]) / 2;
  };

  // ---------- debug probe ----------
  // With tuning > Debug on, the measured values behind the drawing are
  // published on window.__idleon.fishing, refreshed every frame. That is what
  // tools/replay reads back when replaying a recording, and what to look at in
  // the console when the overlay is wrong but the status line looks fine — the
  // status line rounds, and the numbers that decide everything — the gauge's two ends — never
  // appear in it at all. Costs nothing while debug is off.
  const probe = o => {
    if (!cfg.debug) return;
    (window.__idleon = window.__idleon || {}).fishing = o;
  };

  // ---------- state ----------
  let frame = 0, lane = null, laneT = 0;
  let bob = null, bobHist = [], lastBobT = 0;
  let charge = 0, chargeSeen = 0, hold = null;

  // `halo` is the colour of the drop shadow the ring and its text sit on, and
  // it is a parameter because it has to flip with the palette: a dark ring needs
  // a light halo to survive the lane water, and the hazard's own bright red
  // still wants the black one. Defaulted so the hazard call is unchanged.
  function drawLaneMark(x, y, color, label, sub, halo) {
    octx.save();
    octx.shadowColor = halo || 'rgba(0,0,0,.6)'; octx.shadowBlur = 3;
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

    const img = grab(cv);
    if (!img) { stEl.textContent = readErr; probe({ frame, idle: readErr }); return; }
    const { d, sw, sh } = img;
    const kx = W / sw, ky = H / sh;
    const t = performance.now();

    const raw = tooDark(d, sw, sh) ? null : findLane(d, sw, sh);
    if (raw) laneT = t;
    const L = (t - laneT > 700) ? (laneHist = [], null) : stableLane(raw, t, sh);
    lane = L;
    if (!lane) {
      bobHist = []; hold = null; resetMeter();
      if (frame % 15 === 0) stEl.textContent = 'idle\nnot at the fishing spot';
      probe({ frame, idle: 'no lane' });
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
      // Search a little PAST both ends of the lane. A catch drifting to the end
      // of the water keeps swimming until its centre is level with the last
      // pixel of the bar, and half its sprite then hangs over the edge — but
      // the search box used to stop exactly at laneX1, so the blob was sliced
      // down the middle as it went. Watched live at Blunder Hills, a squid held
      // 173px and a solid ring out to 96% of the lane, then fell to 84px and
      // lost the ring at 99% purely to the slicing: the count floor was never
      // the problem, the width screen was, because three surviving columns are
      // not 1.2% of the canvas wide. Half a sprite is the margin that fixes it
      // — that squid measured 22px against a 296px lane, so 5% is half a sprite
      // with a little room. Nothing downstream gets looser: startX still throws
      // out the sand mound off the left end, and onLane still throws out the
      // surfboard rack off the right.
      const pad = Math.round(laneW * 0.05 / W * S.w);
      const sx0 = Math.round(laneX0 / W * S.w) - pad, sx1 = Math.round(laneX1 / W * S.w) + pad;
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
            // catchU comes across TOO. 2.4 added the catch tolerance to SPECIES
            // and drew a bar as wide as it, and this line is why nobody ever
            // saw one: the field stayed behind on the species, the draw read
            // undefined, `(f.catchN || 0) * laneW` came out 0, and both the bar
            // and the gauge band collapsed to nothing every frame for two
            // versions. It looked exactly like a helper that only draws a line,
            // because that is what it was. Anything SPECIES carries that the
            // drawing needs has to be copied here.
            // The colour is resolved HERE rather than carried on SPECIES, so
            // flipping the palette takes effect on the next frame instead of
            // needing a reload - the whole point of it being a toggle.
            fish.push({ ...o, name: sp.name, pts: sp.pts, color: spCol(sp.name), catchU: sp.catchU });
      const bobs2 = raw(isBobber, 60 * px * px);
      landed = bobs2.sort((a, b) => b.n - a.n)[0] || null;
      // The bobber is red too, so it lands in the hazard mask. Drop clusters
      // that coincide with it, and require the rest to be urchin-sized.
      //
      // Nothing is screened on size BEFORE the merge, and that is the point.
      // merge() exists because "a single sprite often breaks into a few blobs
      // (the urchin's spikes especially)" — but a 30px floor ran first and threw
      // the spikes away before merge could put them back, so the merge could
      // only ever reassemble a sprite that did not need reassembling. Measured
      // live: an urchin holding 150 matching pixels shattered into fragments
      // whose LARGEST was 7px, every one of them under the floor, and the lane
      // reported zero hazards with an urchin sitting on it. Handing merge the
      // raw blobs instead rebuilds it at 85px, clear of the 110*px*px screen
      // that still runs after. blobs() already refuses anything under 3px, and
      // that is the only pre-merge screen worth having.
      //
      // The trailing lane-start screen is the hazard pass's version of the
      // species pass's startX: the beach umbrella at the left end is red and
      // white, merges to 67px of its own, and clears the same 110*px*px floor.
      // Today the padded search box happens to cut it off — its centre sits at
      // -0.07 of the lane against a box reaching -0.05 — but two hundredths of
      // a lane is not a margin, it is a coincidence.
      haz = merge(raw(isHazard, 3), clump)
        .filter(o => o.n >= 110 * px * px && o.x > laneX0)
        .filter(o => !landed || Math.abs(o.x - landed.x) > W * 0.02);
    }
    // Everything below works in the game's lane units: the fish, the casts and
    // the tolerances are all on that scale, and only the drawing goes back to
    // pixels. Done once here so the drawing, the lead learner and the probe all
    // read the same plan rather than each recomputing its own.
    const uOf = x => cfg.aimU0 + (x - laneX0) / laneW * cfg.aimUW;
    const xOf = u => laneX0 + (u - cfg.aimU0) / cfg.aimUW * laneW;
    for (const f of fish) f.u = uOf(f.x);
    trackFish(fish, t, !!landed);
    for (const f of fish) {
      const fit = cfg.bob && f.track ? bobFit(f.track) : null;
      f.tracked = !!fit;
      f.plan = planFor(fit || (() => f.u), f.catchU, t);
    }

    if (cfg.marks) {
      // The catch REGION, not the spot. The game does not ask you to land on a
      // fish, it asks you to land within 15 to 23 lane units of one, and that
      // reads as a band with two edges rather than a line through the middle:
      // a near miss looks near, and a whale is visibly half again as forgiving
      // as a fish, which the sprite sizes do not suggest at all.
      //
      // Drawn as a filled band with its two edges picked out, because the edge
      // is the part that matters — it is where a cast stops being a catch.
      //
      // Drawn around where the fish will BE when the cast arrives, not where it
      // is now and not across the whole stretch it drifts over — a bar spanning
      // the drift would be a bar that is mostly wrong at any given moment. Solid
      // while the bob is tracked; dashed while it is not, which is the helper
      // saying it is working from a still fish and you should not trust it yet.
      // The two are worth telling apart on sight: they differ by up to 35 lane
      // units, which is wider than a whale.
      const bandH = Math.max(5, Math.round(laneW * 0.018));
      octx.save();
      octx.shadowColor = spHalo(); octx.shadowBlur = 2;
      for (const f of fish) {
        const r = tolFrac(f.catchU) * laneW;
        if (r <= 0 || !f.plan) continue;
        const cx = xOf(f.plan.at);
        octx.fillStyle = octx.strokeStyle = f.color;
        octx.setLineDash(f.tracked ? [] : [3, 3]);
        octx.globalAlpha = inkA(f.tracked ? 0.16 : 0.08);
        octx.fillRect(cx - r, f.y - bandH, r * 2, bandH * 2);
        octx.globalAlpha = inkA(f.tracked ? 0.55 : 0.4); octx.lineWidth = 2;
        octx.beginPath();
        octx.moveTo(cx - r, f.y - bandH); octx.lineTo(cx - r, f.y + bandH);
        octx.moveTo(cx + r, f.y - bandH); octx.lineTo(cx + r, f.y + bandH);
        octx.stroke();
        // A thin leader from the sprite to where it is headed. Deliberately not
        // the same object as the band: one hairline, no fill, so it reads as
        // "the fish is going there" and never as "this is catchable".
        if (Math.abs(cx - f.x) > 3) {
          octx.setLineDash([2, 4]); octx.globalAlpha = inkA(0.5); octx.lineWidth = 1;
          octx.beginPath(); octx.moveTo(f.x, f.y); octx.lineTo(cx, f.y); octx.stroke();
        }
        octx.setLineDash([]);
      }
      octx.restore();
      // Left of each catch, the gauge fill to release at and how long the
      // window it opens stays open. The milliseconds are the honest measure of
      // how hard the cast is: the same 15-unit tolerance is 210 ms of gauge up
      // close and 50 ms at the far end. Both recomputed every frame, so once
      // the fish start moving (later in a run) the labels track them.
      for (const f of fish) {
        const w = f.plan;
        drawLaneMark(f.x, f.y, f.color, `${f.name} +${f.pts}`,
                     w ? `${(leadBack(w.mid) * 100) | 0}% · ${w.n * 10}ms` : null, spHalo());
      }
      // A hazard with a catch sitting on it is not a hazard. Land there and the
      // catch is what you get — which is why the aim marker below already lets
      // the catch colour outrank the hazard colour. Ringing it AVOID as well
      // put a red ring and a species ring on the same pixel, arguing with each
      // other over a spot you actually want to hit. Hazards only cost you when
      // you land on a bare one, or miss everything; same W*0.02 as the marker.
      for (const z of haz)
        if (!fish.some(f => Math.abs(f.x - z.x) < W * 0.02)) {
          // Same treatment for the pufferfish, and the same drawing: its region
          // is how far away you have to stay, and at 19 lane units it is wider
          // than every catch except the whale.
          // The pufferfish does NOT bob — the game skips type 5 when it moves
          // the lane, so this one really is where it looks like it is, and its
          // band needs no prediction and gets no leader.
          const r = tolFrac(HAZARD_U) * laneW;
          const bh = Math.max(5, Math.round(laneW * 0.018));
          octx.save();
          octx.fillStyle = octx.strokeStyle = '#f87171';
          octx.globalAlpha = 0.16;
          octx.fillRect(z.x - r, z.y - bh, r * 2, bh * 2);
          octx.globalAlpha = 0.55; octx.lineWidth = 2;
          octx.beginPath();
          octx.moveTo(z.x - r, z.y - bh); octx.lineTo(z.x - r, z.y + bh);
          octx.moveTo(z.x + r, z.y - bh); octx.lineTo(z.x + r, z.y + bh);
          octx.stroke();
          octx.restore();
          drawLaneMark(z.x, z.y, '#f87171', 'AVOID');
        }
    }

    // ---- power meter ----
    // Its own native-resolution grab, not the downscaled frame — see the
    // power meter section for the ~6%-of-lane error that cost.
    const Gg = grabGauge(cv, lane, sw, sh);
    const m = stableMeter(Gg ? readMeter(Gg, lane) : null, t);
    if (m) {
      charge = m.frac;
      if (charge > 0.02) chargeSeen = t;
    }

    // The RELEASE WINDOW on the gauge, in the species colour: a band you let go
    // inside, not a line you try to hit. Every rung between its two edges lands
    // a cast that catches, and there are no casts in between them — the band
    // is the whole truth about that fish and nothing outside it works.
    //
    // A tick was never enough. It says where perfect is and nothing about the
    // room around it, and the room is the entire skill of the minigame: 210 ms
    // of it for a fish under the rod and 30 ms for a squid at the far end. The
    // band also sits ASYMMETRICALLY about its middle, because the rungs bunch
    // up towards the bottom of the gauge — the low edge of a window is always
    // the roomier one, which is worth being able to see.
    //
    // The whole band is drawn cfg.lead early, so it marks where the fill has to
    // READ when you decide, not where it ends up once the release lands.
    if (cfg.marks && m && fish.length) {
      const tx = m.x * kx, gy = p => (m.bot - p * (m.bot - m.top)) * ky;
      // Everything here stops at the pole's MIDLINE, leaving its right half
      // bare. 2.12 ran the box and the bar most of the way across, and at 0.5
      // alpha that covered the red fill you are meant to be watching rise into
      // it — reported in play with a red line drawn down the middle: "only
      // cover half of the power bar". Half the pole shows the fill, the other
      // half shows the window, side by side.
      //
      // The midline comes off the game's own sprite, not a pixel offset:
      // MGfshpow is 12 units wide with a 1-unit black outline, and tx is the
      // leftmost column readMeter settles on, which is inner column 1 (the
      // outline is black and fails isCase; column 1 ties for the longest run
      // whether the fill is up or not, and the first of a tie wins — the fill
      // sprite's pale columns 8-9 fail isBobber, so they only ever lose). So
      // the middle is 5 units right of tx. A unit is totalPx/64 backing-store
      // pixels — exactly 1 on a live canvas, 1.389 in a 750-tall recording —
      // and W/cv.width takes those to overlay pixels. On the screenshot this
      // was reported from, the pole spans x 33-49 and the drawn line averages
      // x 40; this puts the midline at ~40.8.
      const midX = tx + 5 * (m.totalPx / RUNGS) * (W / cv.width);
      octx.save();
      // A clip as well as the geometry, so the halo and the strokes' outer
      // halves cannot creep back across the line.
      octx.beginPath(); octx.rect(0, 0, midX, H); octx.clip();
      octx.shadowColor = spHalo(); octx.shadowBlur = 3;
      for (const f of fish) {
        const w = f.plan;
        if (!w) continue;
        octx.fillStyle = octx.strokeStyle = f.color;
        octx.setLineDash(f.tracked ? [] : [3, 3]);
        // One band per RUN of hittable rungs. The set has never been seen to
        // split, and probably cannot, but a single band drawn from the lowest
        // to the highest would silently paint over a gap if it ever did — and
        // a gap is precisely the thing you would need to know about.
        for (const [i0, i1] of w.runs) {
          // Both edges are rungs that CATCH, so a fill touching either line is
          // still a catch. 2.9 moved the top edge up to the first rung that
          // misses, on the reasoning that the fill sits on the last good rung
          // for a whole 10 ms update and all of it still catches. True, and
          // useless: it made the drawn line itself a miss, so letting go as the
          // fill reached it — which is what anyone does with an edge — missed.
          // Reported in play within the hour. The window as drawn is a rung
          // shorter than the time the label counts; that is the right way
          // round for the edge a late release falls off.
          const yLo = gy(leadBack(CAST[i0].p)), yHi = gy(leadBack(CAST[i1].p));
          const h = Math.abs(yHi - yLo);
          // Drawn as a closed box with a WHITE underlay, not the palette halo.
          // The gauge is a dark brown pole, and the neon halo is black: a black
          // edge on dark brown is no edge at all, and a 0.3 green wash over it
          // was, in play, "still a little hard to see". White against the pole
          // is the one pairing that reads whichever palette is on, so the box
          // gets a 5px white stroke with the species colour laid over it.
          // The right edge sits 2.5px inside the midline so the 5px white
          // stroke, centred on it, ends exactly there instead of being clipped.
          const bx = tx - 14, bw = midX - 2.5 - bx, by = Math.min(yLo, yHi), bh = Math.max(2, h);
          octx.save();
          octx.shadowBlur = 0;
          octx.globalAlpha = inkA(f.tracked ? 0.5 : 0.25);
          octx.fillRect(bx, by, bw, bh);
          octx.globalAlpha = f.tracked ? 0.9 : 0.55;
          octx.strokeStyle = '#fff'; octx.lineWidth = 5;
          octx.strokeRect(bx, by, bw, bh);
          octx.globalAlpha = f.tracked ? 1 : 0.7;
          octx.strokeStyle = f.color; octx.lineWidth = 2.5;
          octx.strokeRect(bx, by, bw, bh);
          octx.restore();
          // One hairline per rung, each at the fill that rung really sits at —
          // they are not evenly spaced and drawing them as if they were would
          // throw away the only thing the ladder has to say. Drawn only while
          // they are far enough apart to read: a 21-rung fish window is about
          // 14px of gauge, and 21 lines in 14px is a smear, not a count.
          if (h / (i1 - i0 + 1) >= 3) {
            octx.globalAlpha = inkA(0.45); octx.lineWidth = 1;
            octx.beginPath();
            for (let i = i0; i <= i1; i++) {
              const y = gy(leadBack(CAST[i].p));
              octx.moveTo(tx - 4, y); octx.lineTo(bx + bw - 2, y);
            }
            octx.stroke();
          }
        }
        // The middle rung, as a thick bar across the gauge: the fill to let go
        // at. The band's edges say how much room there is either side; this
        // says where to aim, and it has to be ON the gauge to be any use,
        // because the gauge is what you watch while you hold. 2.9 put it on
        // the lane, over the fish, where it only restated where the fish was.
        // Longer than the band on the left so it reads past it, level with the
        // midline on the right like everything else; solid either way, since
        // the band's dashing already says whether the bob is tracked.
        // Same white underlay as the box, for the same reason.
        const ym = gy(leadBack(w.mid));
        octx.setLineDash([]);
        octx.globalAlpha = f.tracked ? 0.95 : 0.6;
        octx.strokeStyle = '#fff'; octx.lineWidth = 7;
        octx.beginPath(); octx.moveTo(tx - 18, ym); octx.lineTo(midX, ym); octx.stroke();
        octx.globalAlpha = f.tracked ? 1 : 0.7;
        octx.strokeStyle = f.color; octx.lineWidth = 4;
        octx.beginPath(); octx.moveTo(tx - 17, ym); octx.lineTo(midX - 1, ym); octx.stroke();
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
      // Every move of the fill restarts the hold; the one that survives is the
      // plateau after the release. The marks are snapshotted with it, which is
      // what makes the lead measurable at all — they are the marks that were
      // on screen when you let go, and the fish have stopped moving by then.
      if (!hold || Math.abs(charge - hold.power) > 0.03)
        hold = {
          power: charge, t, xs: [],
          marks: fish.map(f => f.plan ? leadBack(f.plan.mid) : null).filter(v => v !== null)
        };
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
      learnLead(hold);
      hold = null;
    }

    // ---- live aim marker while charging ----
    let aimX = null;
    if (cfg.aim && charge > 0.02 && !bob) {
      // Where the cast lands if you let go NOW — which is not where the fill
      // reads now, because the gauge keeps climbing for cfg.lead milliseconds
      // after you decide to. Same correction as the marks, the other way round.
      aimX = laneX0 + aimFrac(leadFwd(charge)) * laneW;
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
                  : charge > 0.02 ? `power ${(charge * 100) | 0}% → ${(aimFrac(leadFwd(charge)) * 100) | 0}% of lane`
                  : `${fish.length} fish · ${haz.length} hazards` +
                    (cfg.bob && fish.length ? ` · ${fish.filter(f => f.tracked).length} tracked` : '');
      // The one thing watching cannot tell you: how late your own releases are
      // landing against the marks. Set tuning > lead to what this says and it
      // should read 0ms; it is the readout that proves the number, not the
      // number itself.
      const seen = leadSeen();
      stEl.textContent = cal + '\n' + line2 + (seen === null ? '' :
        `\nlead ${cfg.lead | 0}ms · casts ${Math.abs(seen * 10) | 0}ms ${seen >= 0 ? 'late' : 'early'}`);
    }

    probe({
      frame, lane, meter: m, charge,
      aimAt: aimX === null ? null : (aimX - laneX0) / laneW,
      lead: cfg.lead, leadSeen: leadSeen(), leadObs: cfg.leadObs.length,
      // The first fish's plan: the hittable rungs, whether its bob is being
      // tracked, and how far ahead of the sprite the band has been placed.
      win: fish.length && fish[0].plan
        ? { n: fish[0].plan.n, lo: fish[0].plan.lo, hi: fish[0].plan.hi,
            runs: fish[0].plan.runs.length, tracked: fish[0].tracked,
            leadU: fish[0].plan.at - fish[0].u }
        : null,
      tracks: tracks.length,
      landAt: landX === null ? null : (landX - laneX0) / laneW,
      // Where the bobber actually IS, as a fraction of the lane. The one
      // number that says whether the mapping is right: park a cast, read this,
      // compare with the aimAt that was showing when it was released.
      bobAt: landed ? (landed.x - laneX0) / laneW : null,
      fish: fish.length, haz: haz.length,
      cal: { u0: cfg.aimU0, uW: cfg.aimUW, n: cfg.samples.length }
    });
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
  const toggle = () => { cfg.on = !cfg.on; if (!cfg.on) { bobHist = []; tracks = []; } save(); sync(); };
  runBtn.onclick = toggle;
  $('#aim').onchange   = e => { cfg.aim = e.target.checked; save(); };
  $('#marks').onchange = e => { cfg.marks = e.target.checked; save(); };
  $('#ink').onchange   = e => { cfg.ink = e.target.checked; save(); };
  $('#arcx').onchange  = e => { cfg.arc = e.target.checked; save(); };
  $('#ruler').onchange = e => { cfg.ruler = e.target.checked; save(); };
  $('#bob').onchange   = e => { cfg.bob = e.target.checked; tracks = []; save(); };
  $('#debug').onchange = e => { cfg.debug = e.target.checked; save(); };
  $('#lead').onchange = e => {
    cfg.lead = Math.max(0, Math.min(300, +e.target.value || 0));
    e.target.value = cfg.lead;
    // The old readings were taken against marks drawn at the old lead, so they
    // say nothing about this one. Keeping them would leave the status line
    // reporting an error that has already been corrected for.
    cfg.leadObs = []; save();
  };
  $('#takelead').onclick = () => {
    // Adds to the lead rather than replacing it, because what the status line
    // reports is the error REMAINING at the current setting. One press per few
    // casts walks it in, and the readout going to 0ms is what says it is there.
    const seen = leadSeen();
    if (seen === null) return;
    cfg.lead = Math.max(0, Math.min(300, Math.round((cfg.lead + seen * 10) / 5) * 5));
    cfg.leadObs = []; save(); sync();
  };
  $('#cal').onclick = () => {
    cfg.samples = [];
    cfg.aimU0 = 8.96; cfg.aimUW = 296.85;
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
