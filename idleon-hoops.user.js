// ==UserScript==
// @name         IdleOn Hoops Helper
// @namespace    nativerobot
// @version      1.9
// @downloadURL https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-hoops.user.js
// @updateURL   https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-hoops.user.js
// @description  Dotted-line shot preview + live ball arc for the Swishy Hoops minigame in Legends of IdleOn
// @match        https://www.legendsofidleon.com/*
// @grant        none
// @run-at       document-start
// @all-frames   true
// ==/UserScript==
(function () {
  'use strict';

  // ---------- make the game's backbuffer readable ----------
  // OpenFL exports to WebGL, whose drawing buffer is wiped after each compose
  // unless preserveDrawingBuffer is set. getContext caches per canvas, so this
  // patch only bites if it lands before the game creates its context.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/i.test(type)) attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    return origGetContext.call(this, type, attrs);
  };

  // ---------- persistence ----------
  const KEY = 'hoops_cfg';
  const cfg = Object.assign({
    on: true,
    scale: 4,          // pixel-readback downscale (bigger = cheaper, blurrier)
    // Two masks, both measured off the real sprites.
    // Ball: hue 13-33, but its seam lines drop to v.38 — the threshold has to
    // stay below them or the ball fragments into pieces too small to detect.
    // Rim: bright red bar, v.85-.98. The wooden platform is hue 31 v.66, so it
    // passes the ball mask (and is thrown out by aspect ratio) but can never
    // reach rimV — which is the only thing keeping it from being read as a hoop.
    hue: 22,           // centre of the ball hue window, degrees
    hueW: 24,          // +/- hue window
    sMin: 0.45,        // min saturation, BALL mask only — exposed in tuning
    vMin: 0.36,        // min value — must stay under the ball's dark seams
    rimV: 0.80,        // rim min brightness (platform is .66 and must fail this)
    // The rim used to share sMin with the ball. Raising Min sat to chase a
    // cleaner ball mask therefore ate the rim's lit top edge (s .47) without
    // saying so — and rim detection is both invisible in a screen recording and
    // the thing that has broken most often. It gets its own floor. The platform
    // is still kept out by rimV, not by this.
    rimS: 0.42,        // rim min saturation, independent of the ball tuning
    hud: 25,           // HUD corner height, % of canvas (score pips, reward icon)
    span: 2500,        // how far ahead to draw, ms
    ghost: true,       // preview the shot from where you're standing
    trail: true,       // dots on recent observed positions
    makes: true,       // turn the line green when it predicts a make
    gate: true,        // only draw while the Swishy Hoops screen is up
    debug: false,      // outline every detected blob
    // Calibration is stored as fractions of canvas size so it survives resizing
    // the window — the game scales its physics with the viewport.
    calVer: 6,         // bump to throw away calibration learned by an older build
    // The shot is a fixed parabola anchored to the PLATFORM, not to the ball in
    // your hands. Written as y = platY + A*(u - uL)*(u - R) where u is distance
    // right of the platform centre: A is curvature, uL and R are where the path
    // crosses platform height going up and coming down. Anchoring to the held
    // ball instead was ~100px out, because that anchor goes stale while the
    // character jumps and the platform keeps moving under them.
    //
    // "Fixed" is now measured rather than assumed. The README used to record an
    // open question -- per-shot arc ranging 1.71-3.01, "either the shot
    // genuinely varies or the single-shot fit is noisy". It is the fit. Fitting
    // x(t) and y(t) separately across 15 live flights (which needs no release
    // instant, and cannot degenerate the way y-as-a-function-of-x does) gives a
    // release velocity of 536-541 px/s horizontally across every well-tracked
    // flight -- the same shot to half a percent. Nothing about it varies.
    //
    // These three are the medians of 8 flights that passed the span and bounce
    // screens, read live off the running game rather than off a recording:
    //
    //   shotA  2.233  sd .034  range 2.195..2.288   old seed 2.103, 6% low
    //   shotL -0.119  sd .030  range -.158..-.083   old seed -0.179, 33% off
    //   shotR  0.547  sd .031  range  .510.. .588   old seed 0.557, agrees
    //
    // shotR is the one the old five-shot seed already had right, and it is also
    // the one the tracked points actually cover. shotL is the weakest of the
    // three in both seeds: it is where the arc crossed platform height on the
    // way UP, which is behind the point tracking starts, so no shot ever
    // observes it directly and every estimate of it is an extrapolation. Its
    // own spread across shots is a quarter of its value. Treat a disagreement
    // there as unsettled rather than as this seed being right.
    shotA: 2.233,      // curvature x canvas width
    shotL: -0.119,     // upward crossing, fraction of width left of the platform
    shotR: 0.547,      // landing range, fraction of width right of the platform
    calSeeded: true,
    collapsed: false,  // rolled up to just the title bar
    hidden: false,
    px: null, py: null // dragged panel position, viewport px
  }, JSON.parse(localStorage.getItem(KEY) || '{}'));
  // Calibration learned before calVer 6 banked a fit from every frame of every
  // flight that produced a plausible-looking parabola, including flights barely
  // tracked at all and flights that came off the backboard. Measured over 15
  // live flights the committed curvature ranged 1.865-2.941 around a true
  // 2.23 — a live config caught mid-session held 2.486. That is not stale, it
  // is contaminated, and averaging more shots into it does not wash it out.
  if (cfg.calVer !== 6) {
    cfg.calVer = 6; cfg.calSeeded = true;
    cfg.shotA = 2.233; cfg.shotL = -0.119; cfg.shotR = 0.547;
  }
  delete cfg.grav; delete cfg.launch; delete cfg.launchN; delete cfg.gravN;
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));

  const boot = () => {

  // ---------- overlay + UI host (closed shadow DOM, invisible to page JS) ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  const root = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);

  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 12px/1.4 monospace; }
      canvas { position: fixed; left: 0; top: 0; pointer-events: none; }
      #p { position: fixed; top: 12px; left: 12px; width: 228px;
           background: #14171c; color: #cdd3da; border: 1px solid #2a2f37;
           border-radius: 8px; pointer-events: auto; user-select: none;
           box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      #hd { display:flex; align-items:center; justify-content:space-between;
            padding: 7px 9px; cursor: move; background:#1b1f26; border-radius:8px 8px 0 0; }
      #hd b { color:#8b95a3; font-weight:600; letter-spacing:.3px; }
      #dot { width:9px; height:9px; border-radius:50%; background:#4b5563; display:inline-block; }
      #dot.on { background:#f87171; box-shadow:0 0 8px #f87171; }
      .body { padding: 9px; display:flex; flex-direction:column; gap:7px; }
      .row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      label { color:#8b95a3; }
      input[type=number] { width:58px; background:#0c0e12; color:#f87171;
            border:1px solid #2a2f37; border-radius:4px; padding:2px 4px; }
      input[type=checkbox] { accent-color:#dc2626; }
      .seg { display:flex; border:1px solid #2a2f37; border-radius:5px; overflow:hidden; }
      .seg button { background:#0c0e12; color:#8b95a3; border:0; padding:3px 8px; cursor:pointer; }
      .seg button.sel { background:#dc2626; color:#fff; }
      .btn { width:100%; padding:6px; border:0; border-radius:5px; cursor:pointer;
             background:#2a2f37; color:#cdd3da; }
      .btn.go { background:#16a34a; color:#fff; }
      .btn.stop { background:#dc2626; color:#fff; }
      .btn.sm { padding:4px; font-size:11px; }
      #st { color:#6b7280; font-size:11px; white-space:pre-line; min-height:28px; }
      .hint { color:#4b5563; font-size:11px; text-align:center; }
      #min { cursor:pointer; color:#6b7280; padding:0 4px; }
      /* Guaranteed way back when the panel is fully hidden — F6/F10 style
         hotkeys can be swallowed by the browser, which would strand it. */
      #nub { position: fixed; top: 6px; left: 6px; width: 13px; height: 13px;
             border-radius: 50%; background: #dc2626; opacity: .55; cursor: pointer;
             pointer-events: auto; display: none; }
      #nub:hover { opacity: 1; }
      details summary { color:#4b5563; cursor:pointer; font-size:11px; outline:none; }
      details .body { padding:7px 0 0; gap:6px; }
      hr { border:0; border-top:1px solid #2a2f37; margin:1px 0; }
    </style>
    <canvas id="ov"></canvas>
    <div id="nub" title="Show Hoops Helper"></div>
    <div id="p">
      <div id="hd"><span><span id="dot"></span> <b>Hoops Helper</b></span><span id="min">–</span></div>
      <div class="body">
        <button class="btn go" id="run">Show arc  (F7)</button>
        <div class="row"><label>Shot preview</label><input id="ghost" type="checkbox"></div>
        <div class="row"><label>Flag makes</label><input id="makes" type="checkbox"></div>
        <div class="row"><label>Ball trail</label><input id="trail" type="checkbox"></div>
        <div id="st">idle</div>
        <button class="btn sm" id="cal">Reset calibration</button>
        <details>
          <summary>tuning</summary>
          <div class="body">
            <div class="row"><label>Arc length</label><span><input id="span" type="number" min="200" step="100"> ms</span></div>
            <div class="row"><label>Sampling</label>
              <div class="seg"><button data-s="2">2x</button><button data-s="4">4x</button><button data-s="8">8x</button></div>
            </div>
            <div class="row"><label>Ball hue</label><span><input id="hue" type="number" min="0" max="360" step="1"> °</span></div>
            <div class="row"><label>Hue width</label><span><input id="huew" type="number" min="1" max="90" step="1"> °</span></div>
            <div class="row"><label>Min sat</label><input id="smin" type="number" min="0" max="1" step="0.05"></div>
            <div class="row"><label>Ignore top</label><span><input id="hud" type="number" min="0" max="40" step="1"> %</span></div>
            <div class="row"><label>Only in minigame</label><input id="gate" type="checkbox"></div>
            <div class="row"><label>Debug blobs</label><input id="debug" type="checkbox"></div>
          </div>
        </details>
        <div class="hint">F7 arc on/off · F6 hide panel</div>
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
    $('#span').value = cfg.span; $('#hue').value = cfg.hue; $('#huew').value = cfg.hueW;
    $('#smin').value = cfg.sMin; $('#hud').value = cfg.hud;
    $('#trail').checked = cfg.trail; $('#makes').checked = cfg.makes;
    $('#debug').checked = cfg.debug; $('#ghost').checked = cfg.ghost;
    $('#gate').checked = cfg.gate;
    root.querySelectorAll('.seg button').forEach(b => b.classList.toggle('sel', +b.dataset.s === cfg.scale));
    dot.classList.toggle('on', cfg.on);
    runBtn.textContent = cfg.on ? 'Hide arc  (F7)' : 'Show arc  (F7)';
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
  let readErr = '';

  function gameCanvas() {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const a = c.clientWidth * c.clientHeight;
      if (a > area) { area = a; best = c; }
    }
    return area > 160000 ? best : null;   // ignore tiny/UI canvases
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

  // The rim is a 10px-tall bar. Read back at cfg.scale (4x) it is 2.5 rows or
  // less — and less still if the game's backbuffer is smaller than its CSS box,
  // which it is. Averaging that sliver against the night sky drags its value
  // under rimV, so whether the hoop is seen at all comes down to how the bar
  // happens to land on the sampling grid: in the recording it was missed for
  // 39 seconds straight, then found, with no change on screen. So the rim gets
  // its own readback, at 1-2x over the band it can appear in, sized to stay
  // near the cost of one 4x full-frame grab.
  const rimScratch = document.createElement('canvas');
  const rctx = rimScratch.getContext('2d', { willReadFrequently: true });
  const BAND_T = 0.28, BAND_B = 0.99;          // fraction of canvas height

  // Why the last rim scan came up empty, shown in the status line. Two
  // recordings in a row have reported NO RIM on frames where replaying this
  // same scan offline finds the bar every time, so the scan has to say which
  // stage it failed at rather than leaving it to be inferred.
  let rimWhy = '';

  function grabBand(cv, W) {
    const y0 = Math.round(cv.height * BAND_T);
    const bh = Math.round(cv.height * (BAND_B - BAND_T));
    // Pick the coarsest sampling that still puts four rows through a bar that
    // is ~10 CSS px thick, whatever resolution the game is rendering at.
    const perCss = cv.width / Math.max(1, W);
    const s = Math.max(1, Math.min(3, Math.floor(10 * perCss / 4)));
    const sw = Math.max(1, Math.round(cv.width / s)), sh = Math.max(1, Math.round(bh / s));
    if (rimScratch.width !== sw || rimScratch.height !== sh) { rimScratch.width = sw; rimScratch.height = sh; }
    // Resizing a canvas resets its context state, so this has to be re-set every
    // time. Point sampling rather than interpolating: a 10px bar reduced with
    // smoothing on has its colour diluted by whatever sits above and below it,
    // and the rim only clears rimV while it stays pure. Nothing to lose here —
    // there is no detail below the bar's own thickness worth preserving.
    rctx.imageSmoothingEnabled = false;
    try {
      rctx.clearRect(0, 0, sw, sh);
      rctx.drawImage(cv, 0, y0, cv.width, bh, 0, 0, sw, sh);
      return { d: rctx.getImageData(0, 0, sw, sh).data, sw, sh, y0, rows: bh / sh, s };
    } catch (e) { rimWhy = 'band read failed'; return null; }
  }

  // ---------- colour masks ----------
  // rim = true selects the bright-red hoop mask instead of the ball mask
  function isBallPx(r, g, b, rim) {
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (mx < (rim ? cfg.rimV : cfg.vMin) * 255) return false;
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const d = mx - mn;
    if (d < (rim ? cfg.rimS : cfg.sMin) * mx) return false;
    let h;
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    let dh = Math.abs(h - (rim ? 12 : cfg.hue));
    if (dh > 180) dh = 360 - dh;
    return dh <= (rim ? 22 : cfg.hueW);
  }

  // ---------- "am I actually in the minigame?" ----------
  // Swishy Hoops renders a full-screen dark navy night sky: measured at 92-93%
  // of sampled pixels, against 0.3-0.7% anywhere in the overworld. Without this
  // gate the overworld's orange scenery gets tracked and an arc is drawn over
  // normal play. Every third pixel is plenty for a 100x margin.
  function skyFrac(d, w, h) {
    let navy = 0, tot = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const p = (y * w + x) * 4, r = d[p], g2 = d[p + 1], b = d[p + 2];
        tot++;
        const mx = r > g2 ? (r > b ? r : b) : (g2 > b ? g2 : b);
        if (mx >= 140 || mx === 0) continue;                  // too bright to be night sky
        const mn = r < g2 ? (r < b ? r : b) : (g2 < b ? g2 : b);
        const dd = mx - mn;
        if (dd < 0.35 * mx) continue;
        if (mx !== b) continue;                               // blue must dominate
        let hu = 60 * ((r - g2) / dd + 4);
        if (hu < 0) hu += 360;
        if (hu > 195 && hu < 255) navy++;
      }
    }
    return tot ? navy / tot : 0;
  }

  // ---------- connected components ----------
  let mask = new Uint8Array(0), stack = new Int32Array(0);
  // Dead zones: the two HUD corners (score pips top-left, reward icon top-right)
  // and the bottom strip (the EXIT button is the same red as the rim). A plain
  // top band can't be used — the ball flies across the top of the screen.
  function blobs(d, w, h, rim) {
    const n = w * h;
    if (mask.length !== n) { mask = new Uint8Array(n); stack = new Int32Array(n); }
    const hudH = Math.round(h * cfg.hud / 100), hudW = Math.round(w * 0.17);
    const botY = Math.round(h * 0.94);
    for (let y = 0, i = 0; y < h; y++) {
      const inHud = y < hudH, dead = y >= botY;
      for (let x = 0; x < w; x++, i++) {
        if (dead || (inHud && (x < hudW || x >= w - hudW))) { mask[i] = 0; continue; }
        const p = i * 4;
        mask[i] = isBallPx(d[p], d[p + 1], d[p + 2], rim) ? 1 : 0;
      }
    }

    const out = [];
    for (let i = 0; i < n && out.length < 200; i++) {
      if (mask[i] !== 1) continue;
      let sp = 0; stack[sp++] = i; mask[i] = 2;
      let minx = w, maxx = 0, miny = h, maxy = 0, cnt = 0, sx = 0, sy = 0, lit = 0;
      while (sp) {
        const q = stack[--sp], qx = q % w, qy = (q / w) | 0;
        cnt++; sx += qx; sy += qy;
        const p2 = q * 4, m2 = Math.max(d[p2], d[p2 + 1], d[p2 + 2]);
        if (m2 >= 184) lit++;                    // v >= .72
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
        if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        if (qx > 0     && mask[q - 1] === 1) { mask[q - 1] = 2; stack[sp++] = q - 1; }
        if (qx < w - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack[sp++] = q + 1; }
        if (qy > 0     && mask[q - w] === 1) { mask[q - w] = 2; stack[sp++] = q - w; }
        if (qy < h - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack[sp++] = q + w; }
      }
      if (cnt < 4) continue;
      out.push({ x: sx / cnt, y: sy / cnt, w: maxx - minx + 1, h: maxy - miny + 1, n: cnt, lit: lit / cnt });
    }
    return out;
  }

  // Split blobs into hoop rims and ball candidates by shape and size, both
  // measured as a fraction of canvas width so this survives any window size.
  // (The ball renders ~3.9% of width; the HUD reward icon ~1.5%; the rim ~8.6%,
  // while the EXIT button is only ~5.7% and must not out-vote a real rim.)
  function classify(ballBlobs, k, W) {
    const minB = W * 0.022, maxB = W * 0.09;
    const cands = [];
    for (const b of ballBlobs) {
      const ar = b.w / b.h, cw = b.w * k;
      // The wooden platform shares the ball's hue and fragments into square-ish
      // chunks under the permissive mask, but it is a flat v=.66 brown while the
      // ball and the player's shirt are lit to v=.78-.98. Without this the
      // "ball in your hands" locks onto the ledge you are standing on.
      if (b.lit < 0.3) continue;
      if (ar >= 0.55 && ar <= 1.8 && cw >= minB && cw <= maxB)
        cands.push({ x: b.x * k, y: b.y * k, w: cw, h: b.h * k, n: b.n });
    }
    return cands;
  }

  // The rim is a long horizontal bar, but it touches the vertical backboard —
  // as one blob the pair is no longer flat enough to recognise. Scanning for the
  // single longest horizontal run of rim-coloured pixels finds the bar directly
  // and ignores the backboard, whose runs are only a few pixels wide.
  // The band already starts below the "SWISHY HOOPS" title, whose letters are
  // the same red and would otherwise chain into a long run. The only other
  // long red run is the EXIT button, which is cut out as a corner rather than
  // as a full-width strip: the camera sometimes parks the hoop at 90% of the
  // screen height, and a strip that low was swallowing it.
  function findRim(img, cvH, W, H) {
    const { d, sw, sh, y0, rows, s } = img;
    const kx = W / sw;                                  // band px -> CSS px
    const yAt = by => (y0 + by * rows) / cvH * H;        // band row -> CSS y
    const exitX = Math.round(sw * 0.88), exitY = (0.90 * cvH - y0) / rows;
    // The bar spans 9.3% of the canvas width on screen, but the longest run the
    // live scan managed was 5.8% — so whatever the readback is doing to it, 6%
    // was above what actually survives. It cannot drop much further than 5%:
    // the ball is a 3.9%-wide disc that passes the same colour test, and must
    // never out-run the rim.
    const minRun = W * 0.05;
    const y1 = Math.max(0, Math.ceil((0.30 * cvH - y0) / rows));   // hoop never sits higher
    let best = null, longest = 0;
    for (let y = y1; y < sh; y++) {
      const xEnd = y >= exitY ? exitX : sw;   // stop short of the EXIT button
      let run = 0, start = 0, gap = 0;
      for (let x = 0; x <= xEnd; x++) {
        const p = (y * sw + x) * 4;
        const ok = x < xEnd && isBallPx(d[p], d[p + 1], d[p + 2], true);
        if (ok) { if (!run) start = x; run += gap + 1; gap = 0; }
        else if (run && gap < 2) gap++;              // bridge anti-aliased gaps
        else {
          if (run * kx > longest) longest = run * kx;
          if (run * kx >= minRun) {
            const cand = { run, y, x0: start, x1: x - gap - 1 };
            // Between two long runs prefer the one nearest the last known hoop
            // rather than the longer one: the backboard post and the rim can
            // trade places for the longest-run title frame by frame, and the
            // arc jumping between them is worse than a slightly short bar.
            if (!best) best = cand;
            else if (lastRim) {
              const score = c => Math.abs((c.x0 + c.x1) / 2 * kx - lastRim.x) +
                                 Math.abs(yAt(c.y) - lastRim.y);
              if (score(cand) < score(best)) best = cand;
            } else if (cand.run > best.run) best = cand;
          }
          run = 0; gap = 0;
        }
      }
    }
    if (!best) {
      // The longest red bar anywhere in the searched area, against what it had
      // to beat. "0/80" means nothing matched the colour at all; "62/80" means
      // the bar is being found but broken up or sampled away.
      rimWhy = `${Math.round(longest)}/${Math.round(minRun)}@${s || '?'}x${sw}`;
      return null;
    }
    return { x: (best.x0 + best.x1) / 2 * kx, y: yAt(best.y), w: best.run * kx };
  }

  // The platform you stand on: a wide, flat, dull brown bar (hue ~31, v ~.66 —
  // exactly the thing that used to be mistaken for the rim). It is visible in
  // every single frame of every recording, which is what makes it the right
  // anchor: unlike the ball in your hands it can never go stale while the
  // character winds up and the platform slides out from under them.
  function findPlatform(d, w, h, k, W) {
    let best = null;
    for (let y = Math.round(h * 0.30); y < h; y++) {
      let run = 0, start = 0, gap = 0;
      for (let x = 0; x <= w; x++) {
        let ok = false;
        if (x < w) {
          const p = (y * w + x) * 4;
          const [hu, s, v] = rgbToHsv(d[p], d[p + 1], d[p + 2]);
          ok = hu > 18 && hu < 46 && s > 0.45 && v > 0.45 && v < 0.80;
        }
        if (ok) { if (!run) start = x; run += gap + 1; gap = 0; }
        else if (run && gap < 3) gap++;
        else { if (run && (!best || run > best.run)) best = { run, y, x0: start, x1: x - gap - 1 }; run = 0; gap = 0; }
      }
    }
    if (!best || best.run * k < W * 0.06) return null;
    return { x: (best.x0 + best.x1) / 2 * k, y: best.y * k, w: best.run * k };
  }

  function rgbToHsv(r, g, b) {
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

  // ---------- debug probe ----------
  // With tuning > Debug on, the measured values behind the drawing are
  // published on window.__idleon.hoops, refreshed every frame. That is what
  // tools/replay reads back when replaying a recording, and what to look at in
  // the console when the overlay is wrong but the status line looks fine — the
  // status line rounds, and the numbers that decide everything — the rim and platform anchors — never
  // appear in it at all. Costs nothing while debug is off.
  const probe = o => {
    if (!cfg.debug) return;
    (window.__idleon = window.__idleon || {}).hoops = o;
  };

  // ---------- state ----------
  let plat = null, platT = 0;    // the platform, re-found every frame
  let holdT = -1e9;              // last time a ball was seen in your hands
  let flightPlat = null;         // where the platform was when this shot left
  let calSamples = [], flyT = 0; // per-flight calibration fits, awaiting commit

  // Calibration used to be folded in on every frame of a flight. With a 0.25
  // weight applied 30-40 times in a row that is not a gentle average — a single
  // shot pulls the numbers all the way onto its own fit, including the early
  // frames when only three or four points had been seen and the parabola was
  // still garbage. Hence "arc" wandering 1.71-3.01 across the recording.
  // One commit per shot, from the median of that shot's fits, instead.
  function commitCal() {
    const s = calSamples;
    calSamples = [];
    if (s.length < 6) return;                // too few frames tracked to trust
    const med = key => {
      const v = s.map(o => o[key]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    const An = med('A'), Ln = med('L'), Rn = med('R');
    const w = cfg.calSeeded ? 1 : 0.3;       // first real shot replaces the seed
    cfg.shotA += (An - cfg.shotA) * w;
    cfg.shotL += (Ln - cfg.shotL) * w;
    cfg.shotR += (Rn - cfg.shotR) * w;
    cfg.calSeeded = false;
    save();
  }

  // The shot as a curve in screen space, anchored to the platform. Time never
  // enters it, so it does not depend on when the ball was first spotted.
  function shotCurve(px, py, dir, W) {
    const A = cfg.shotA / W, uL = cfg.shotL * W, uR = cfg.shotR * W;
    return { at: x => { const u = (x - px) * dir; return py + A * (u - uL) * (u - uR); },
             A, uL, uR, px, py, dir };
  }
  let lastRim = null, rimT = 0;
  let frame = 0;

  // ---------- multi-target tracking ----------
  // One track is not enough: the player's orange shirt is the same colour and
  // size as the ball, the two merge into a single blob while it is held, and
  // they split at release. Following every candidate separately lets the fast
  // one be recognised as the shot without the slow one dragging the track off.
  let tracks = [];               // {pts:[{t,x,y}], x, y, vx, vy, last, n}
  const GATE = 260;              // px a track may jump between frames

  // Also records average horizontal speed: the player's jump is fast but almost
  // purely vertical, and without that distinction a jump reads as a shot.
  function trackSpeed(tr) {
    const p = tr.pts;
    tr.spx = 0;
    if (p.length < 2) return 0;
    const a = p[p.length - 1];
    let b = p[0];
    for (let i = p.length - 2; i >= 0; i--) { b = p[i]; if (a.t - b.t >= 100) break; }
    const dt = (a.t - b.t) / 1000;
    if (dt <= 0.008) return 0;
    tr.spx = Math.abs(a.x - b.x) / dt;
    return Math.hypot(a.x - b.x, a.y - b.y) / dt;
  }

  function updateTracks(cands, t) {
    for (const tr of tracks) {
      const dt = (t - tr.last) / 1000;
      tr.px = tr.x + tr.vx * dt; tr.py = tr.y + tr.vy * dt;
    }
    const taken = new Set();
    for (const c of cands) {
      let best = null, bd = Infinity;
      for (const tr of tracks) {
        if (taken.has(tr)) continue;
        const d = Math.hypot(c.x - tr.px, c.y - tr.py);
        if (d < bd) { bd = d; best = tr; }
      }
      if (best && bd < GATE) {
        taken.add(best);
        best.pts.push({ t, x: c.x, y: c.y });
        if (best.pts.length > 40) best.pts.shift();
        const dt = (t - best.last) / 1000;
        if (dt > 0.008) { best.vx = (c.x - best.x) / dt; best.vy = (c.y - best.y) / dt; }
        best.x = c.x; best.y = c.y; best.last = t; best.n = c.n; best.w = c.w;
      } else {
        tracks.push({ pts: [{ t, x: c.x, y: c.y }], x: c.x, y: c.y, vx: 0, vy: 0, last: t, n: c.n, w: c.w });
      }
    }
    tracks = tracks.filter(tr => t - tr.last <= 350 && !tr.gone);
    if (tracks.length > 12) tracks = tracks.slice(-12);
  }

  // ---------- path fitting ----------
  // The tracked ball is fitted as a parabola in x-y directly. Fitting against
  // time needs gravity AND a release instant, and both were shaky: the release
  // instant depends on detection latency, which varies between recordings and
  // threw the predicted landing out by ~100px. A curve through the points has
  // neither problem, and the curve is what gets drawn anyway.
  function fitXY(pts) {
    const n = pts.length;
    if (n < 6) return null;
    let xs = pts.map(p => p.x);
    if (Math.max(...xs) - Math.min(...xs) < 40) return null;   // needs x spread
    let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
    for (const p of pts) {
      const x = p.x, y = p.y, x2 = x * x;
      sx += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2;
      sy += y; sxy += x * y; sx2y += x2 * y;
    }
    const sol = solve3([[sx4, sx3, sx2], [sx3, sx2, sx], [sx2, sx, n]], [sx2y, sxy, sy]);
    if (!sol || !(sol[0] > 0)) return null;                    // must curve downward
    return { a: sol[0], b: sol[1], c: sol[2] };
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

  // ---------- drawing ----------
  // Walk the path in screen x and stroke it. Taking the curve as a function of
  // x (rather than stepping through time) means the same routine draws both the
  // fitted flight and the platform-anchored preview.
  // The red bar that gets detected is the whole rim assembly, which runs on
  // past the net into the backboard post — it is wider than the hole and its
  // centre sits ~5% of its width right of it. Scoring off the raw bar at
  // +/-0.55 called anything within 68px a swish, which is wider than the hoop.
  const HOLE_OFF = -0.05, HOLE_HALF = 0.30;
  function drawCurve(yAt, xStart, dir, W, H, style) {
    const pts = [];
    let made = false, hitX = 0;
    const rim = lastRim;
    const holeX = rim ? rim.x + rim.w * HOLE_OFF : 0;
    const step = Math.max(3, W / 240) * dir;
    for (let x = xStart, i = 0; i < 900; i++, x += step) {
      const y = yAt(x);
      const prev = pts[pts.length - 1];
      if (rim && prev && prev.y <= rim.y && y >= rim.y &&
          x > holeX - rim.w * HOLE_HALF && x < holeX + rim.w * HOLE_HALF) { made = true; hitX = x; }
      pts.push({ x, y });
      if (y > H + 80 || x < -80 || x > W + 80) break;
    }
    if (pts.length < 2) return false;

    const green = cfg.makes && made;
    octx.save();
    octx.shadowColor = 'rgba(0,0,0,.7)';
    octx.shadowBlur = 3;
    octx.setLineDash(style === 'ghost' ? [3, 6] : [6, 7]);
    octx.lineWidth = style === 'ghost' ? 2 : 2.6;
    octx.strokeStyle = green ? '#4ade80' : (style === 'ghost' ? '#ff7a70' : '#ff3b30');
    octx.globalAlpha = style === 'ghost' ? 0.85 : 1;
    octx.beginPath();
    octx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) octx.lineTo(p.x, p.y);
    octx.stroke();

    octx.setLineDash([]);
    const e = pts[pts.length - 1];
    octx.beginPath(); octx.arc(e.x, e.y, 4, 0, Math.PI * 2); octx.stroke();
    if (made) {
      octx.lineWidth = 2.5;
      octx.beginPath(); octx.arc(hitX, rim.y, 7, 0, Math.PI * 2); octx.stroke();
    }
    octx.restore();
    return made;
  }

  // Draws the detected bar faintly and the window that actually counts as a
  // make solidly, so a "not lined up" verdict can be checked against the hoop.
  function drawRim(r) {
    const holeX = r.x + r.w * HOLE_OFF, half = r.w * HOLE_HALF;
    octx.save();
    octx.strokeStyle = 'rgba(96,165,250,.4)'; octx.lineWidth = 1;
    octx.setLineDash([3, 4]);
    octx.beginPath();
    octx.moveTo(r.x - r.w * 0.5, r.y); octx.lineTo(r.x + r.w * 0.5, r.y);
    octx.stroke();
    octx.setLineDash([]);
    octx.strokeStyle = '#60a5fa'; octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(holeX - half, r.y); octx.lineTo(holeX + half, r.y);
    octx.moveTo(holeX - half, r.y - 5); octx.lineTo(holeX - half, r.y + 5);
    octx.moveTo(holeX + half, r.y - 5); octx.lineTo(holeX + half, r.y + 5);
    octx.stroke();
    octx.restore();
  }

  // ---------- main loop ----------
  function loop() {
    requestAnimationFrame(loop);
    frame++;
    if (!cfg.on) return;

    const cv = gameCanvas();
    if (!cv) { if (frame % 30 === 0) stEl.textContent = 'no game canvas found'; probe({ frame, idle: 'no game canvas' }); return; }

    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
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

    const k = W / img.sw;                                   // downscaled px -> CSS px
    // Only draw inside Swishy Hoops — otherwise the overworld's orange scenery
    // gets tracked and an arc appears over normal play.
    if (cfg.gate && skyFrac(img.d, img.sw, img.sh) < 0.55) {
      tracks = []; lastRim = null; plat = null; flightPlat = null; holdT = -1e9;
      calSamples = [];
      if (frame % 15 === 0) stEl.textContent = 'idle\nnot in Swishy Hoops';
      probe({ frame, idle: 'gated out: sky < 55%' });
      return;
    }

    const ballBlobs = blobs(img.d, img.sw, img.sh, false);
    const t = performance.now();
    const cands = classify(ballBlobs, k, W);
    // The hoop only drifts as the camera pans, so its own (finer, pricier)
    // readback runs at a third of the frame rate once it has been found.
    const rim = (!lastRim || frame % 3 === 0) ? (() => {
      const band = grabBand(cv, W);
      const r = band ? findRim(band, cv.height, W, H) : null;
      if (r) return r;
      const bandWhy = rimWhy;
      // Fall back to the coarse grab that has already been read for the blobs.
      // The same scan, just sampled the way v1.0 sampled it — so whatever goes
      // wrong with the fine band read, this cannot end up seeing less than the
      // build before it did.
      const flat = findRim({ d: img.d, sw: img.sw, sh: img.sh, y0: 0, rows: cv.height / img.sh, s: cfg.scale },
                           cv.height, W, H);
      // Report both stages. Letting the fallback overwrite the band's reason
      // hid which of the two was actually failing for a whole round of testing.
      if (!flat) rimWhy = `band ${bandWhy} / flat ${rimWhy}`;
      return flat;
    })() : null;
    const pl = findPlatform(img.d, img.sw, img.sh, k, W);
    if (pl) { plat = pl; platT = t; }
    else if (t - platT > 700) plat = null;

    if (cfg.debug) {
      octx.lineWidth = 1;
      octx.strokeStyle = 'rgba(140,140,140,.45)';
      for (const b of ballBlobs) octx.strokeRect(b.x * k - b.w * k / 2, b.y * k - b.h * k / 2, b.w * k, b.h * k);
      octx.strokeStyle = 'rgba(255,60,60,.9)';
      for (const c of cands) octx.strokeRect(c.x - c.w / 2, c.y - c.h / 2, c.w, c.h);
    }

    if (rim) { lastRim = rim; rimT = t; }
    else if (t - rimT > 4000) lastRim = null;
    if (lastRim) drawRim(lastRim);

    // ---- track every candidate, then decide which one is the shot ----
    updateTracks(cands, t);
    let fly = null;
    // A ball resting on the platform means you are holding the next shot. This
    // is tracked separately from the flight, because after a miss the game hands
    // you a new ball while the previous one is still falling off-screen.
    let holding = null;
    for (const tr of tracks) {
      const sp = trackSpeed(tr);
      tr.sp = sp;
      if (t - tr.last > 120) continue;                               // stale: ball already gone
      // Once a ball has left the play area the shot is over — keeping it would
      // leave the old arc on screen while you line the next one up.
      if (tr.y > H * 0.94 || tr.x > W * 0.97 || tr.x < W * 0.02) { tr.gone = true; continue; }
      if (tr.gone) continue;
      if (sp > H * 0.35 && tr.spx > W * 0.08 && tr.pts.length >= 3) { if (!fly || sp > fly.sp) fly = tr; }
      // Judged on HORIZONTAL speed only: a held ball rides the platform up and
      // down, so its total speed regularly exceeds any "stationary" threshold
      // and the preview blinked out every time the platform picked up pace.
      else if (plat && tr.spx < W * 0.06 &&
               Math.abs(tr.x - plat.x) < W * 0.08 &&
               tr.y < plat.y && tr.y > plat.y - H * 0.30) {
        if (!holding || tr.n > holding.n) holding = tr;
      }
    }
    const flying = !!fly;
    // Brief detection dropouts shouldn't flicker the preview off.
    if (holding) holdT = t;
    const ready = holding || (t - holdT < 300);
    if (fly && !fly.flew) {
      // First frame this track counts as a shot. Its history still holds the
      // stationary held phase and the wind-up, which are not projectile motion
      // and would flatten both the curvature and the velocity fit.
      fly.flew = true;
      fly.pts = fly.pts.slice(-3);
      // Where the platform was as this shot left — the frame of reference the
      // whole shot model is expressed in.
      flightPlat = plat ? { x: plat.x, y: plat.y } : null;
      calSamples = [];
    }
    if (fly) flyT = t;
    // Tracking drops the ball for a frame or two mid-flight, so the shot is
    // only called over once it has stayed gone.
    else if (t - flyT < 400) { /* still the same shot */ }
    else { flightPlat = null; if (calSamples.length) commitCal(); }

    // ---- live arc for a ball in the air ----
    let made = null;
    if (fly) {
      const f = fitXY(fly.pts);
      if (f) {
        if (cfg.trail) {
          octx.fillStyle = 'rgba(255,59,48,.55)';
          for (const p of fly.pts) { octx.beginPath(); octx.arc(p.x, p.y, 2, 0, Math.PI * 2); octx.fill(); }
        }
        const p0 = fly.pts[0], pN = fly.pts[fly.pts.length - 1];
        const dir = Math.sign(pN.x - p0.x) || 1;
        made = drawCurve(x => f.a * x * x + f.b * x + f.c, fly.x, dir, W, H, 'live');

        // Has this shot come off the backboard or the far lip of the rim? Both
        // are ordinary ways to score, and both send the ball back over x it has
        // already crossed. A projectile's x is monotonic, so any retreat from
        // the furthest point reached is a bounce and nothing else. The margin
        // is a whole 1% of the width because the tracker's own x jitter measured
        // 3-7px rms, and one noisy frame must not read as a bounce.
        if (!fly.dir0 && Math.abs(pN.x - p0.x) > 4) fly.dir0 = Math.sign(pN.x - p0.x);
        if (fly.dir0) {
          const reach = pN.x * fly.dir0;
          if (fly.reach === undefined || reach > fly.reach) fly.reach = reach;
          else if (fly.reach - reach > W * 0.01) fly.bounced = true;
        }

        // Learn the shot in platform-relative terms: curvature, plus where the
        // path crosses platform height going up and coming down. Those three
        // are the same for every shot regardless of when tracking began.
        if (flightPlat) {
          const A = f.a, py = flightPlat.y;
          const disc = f.b * f.b - 4 * A * (f.c - py);
          if (disc > 0) {
            const r1 = (-f.b - Math.sqrt(disc)) / (2 * A), r2 = (-f.b + Math.sqrt(disc)) / (2 * A);
            const uL = (Math.min(r1, r2) - flightPlat.x) * dir;
            const uR = (Math.max(r1, r2) - flightPlat.x) * dir;
            const An = A * W, Ln = uL / W, Rn = uR / W;
            const xs = fly.pts.map(q => q.x);
            const span = Math.max(...xs) - Math.min(...xs);
            // Two screens on top of the plausibility window, both measured off
            // 15 live flights read out of the running game over the DevTools
            // protocol. The window alone is not enough: it asks whether the
            // fitted parabola looks sane, never whether the points under it
            // were a single projectile, and the worst offenders sail through.
            //
            // SPAN. fitXY needs only 40px of x to return a curve, and it will,
            // but curvature error goes as 1/spread^2, so a fit over a short arc
            // is a guess wearing a number. The three wildest calibrations in
            // the sample -- A of 2.941, 1.865, 2.716 against a true 2.23 -- came
            // from the three shortest tracks, spans of 200, 143 and 140px. 40px
            // stays as fitXY's floor because the live arc should still draw
            // early in a flight; it is only LEARNING that waits for real spread.
            //
            // BOUNCE. y is fitted as a function of x, so a ball returning over
            // its own x is not a hard fit, it is an impossible one -- two y for
            // one x. That is where A reached 55.
            //
            // Sweeping the span gate over those flights (commits kept, spread
            // of the committed A):
            //
            //   none (shipped)  15 commits  47.4%   1.865-2.941
            //   0.10 W          11 commits  19.3%
            //   0.15 W          10 commits   8.2%      + bounce cut  4.3%
            //   0.20 W          10 commits   7.7%      + bounce cut  4.2%
            //   0.25 W          10 commits   7.2%      + bounce cut  4.0%
            //   0.30 W          10 commits   5.1%
            //   0.35 W           7 commits   2.0%
            //   0.40 W           2 commits   0.9%
            //
            // Commits hold flat from .15 to .30 and fall off a cliff above it,
            // so .20 sits in the middle of the plateau rather than on an edge:
            // tightening or loosening it by a quarter changes nothing much.
            // Together they take the spread from 47.4% to 4.2% for two commits
            // out of ten -- and a commit is cheap, the calibration averages.
            if (!fly.bounced && span >= W * 0.20 &&
                An > 1.5 && An < 3.2 && Rn > 0.40 && Rn < 0.75 && Ln > -0.45 && Ln < 0.05)
              calSamples.push({ A: An, L: Ln, R: Rn });
          }
        }
      }
    }

    // ---- shot preview, anchored to the platform ----
    let ghostMade = null;
    // Drawn whenever a ball is in your hands — NOT gated on "no shot in flight".
    // After a miss both are true at once, and suppressing the preview then is
    // exactly when you need it to line up the next shot.
    if (cfg.ghost && plat && ready) {
      const dir = lastRim ? Math.sign(lastRim.x - plat.x) || 1 : 1;
      const curve = shotCurve(plat.x, plat.y, dir, W);
      // Start the line directly above the platform rather than at the curve's
      // left crossing: that crossing is ~0.18 of a screen to the left, which
      // ran off the edge and made the arc appear to fly in from nowhere.
      ghostMade = drawCurve(curve.at, plat.x, dir, W, H, 'ghost');
      octx.save();
      const topY = curve.at(plat.x);
      octx.strokeStyle = 'rgba(255,122,112,.35)';             // tie the arc to the platform
      octx.setLineDash([2, 4]); octx.lineWidth = 1;
      octx.beginPath(); octx.moveTo(plat.x, plat.y); octx.lineTo(plat.x, topY); octx.stroke();
      octx.setLineDash([]);
      octx.strokeStyle = 'rgba(255,122,112,.6)'; octx.lineWidth = 2;
      octx.beginPath(); octx.moveTo(plat.x - 10, plat.y); octx.lineTo(plat.x + 10, plat.y); octx.stroke();
      octx.restore();
    }

    if (frame % 8 === 0) {
      const cal = `range ${(cfg.shotR * 100).toFixed(0)}% · arc ${cfg.shotA.toFixed(2)}` +
                  (cfg.calSeeded ? ' (default)' : '');
      // Both lines get reported when both are on screen. Holding the next ball
      // while a shot is still falling is the normal state after a miss, and
      // "ready" used to win outright — so the panel would read "not lined up"
      // about the preview while a green live arc dropped through the hoop right
      // next to it, or claim SWISH off the preview while the shot in the air was
      // visibly missing. Each label now says which line it is talking about.
      const parts = [];
      if (flying) parts.push(made === null ? 'shot tracking' : (made ? 'shot SWISH' : 'shot misses'));
      if (ready) parts.push(ghostMade ? 'aim SWISH' : 'aim off');
      if (!parts.length) parts.push(`no ball (${cands.length} blobs)`);
      const what = parts.join(' · ');
      // Rim and platform state are always shown: without them a missing or
      // wrong arc gives no clue which half of the picture failed.
      const rimSt = lastRim ? 'rim' : `NO RIM ${rimWhy}`;
      stEl.textContent = `${cal}\n${what} · ${rimSt} · ${plat ? 'platform' : 'NO PLATFORM'}`;
    }

    probe({
      frame, plat, rim: lastRim, rimWhy, blobs: cands.length, tracks: tracks.length,
      flying, made, ready, ghostMade,
      cal: { a: cfg.shotA, l: cfg.shotL, r: cfg.shotR, seeded: cfg.calSeeded }
    });
  }

  // ---------- wiring ----------
  // A button that has been clicked keeps keyboard focus, and the minigame is
  // played with the keyboard — so a Space or Enter aimed at the game re-fires
  // whichever control was touched last. Nothing has been observed going wrong
  // this way; it is guarded because "Reset calibration" is one stray keypress
  // from throwing away a session's worth of learning, silently.
  const tap = (el, fn) => el.addEventListener('click', e => {
    if (!e.detail) return;                    // detail 0 => Space/Enter, not a click
    el.blur();
    fn(e);
  });

  const toggle = () => { cfg.on = !cfg.on; if (!cfg.on) tracks = []; save(); sync(); };
  tap(runBtn, toggle);
  tap($('#cal'), () => { cfg.shotA = 2.233; cfg.shotL = -0.119; cfg.shotR = 0.547; cfg.calSeeded = true; calSamples = []; save(); });
  $('#span').onchange  = e => { cfg.span = Math.max(200, +e.target.value); save(); };
  $('#hue').onchange   = e => { cfg.hue = (+e.target.value % 360 + 360) % 360; save(); };
  $('#huew').onchange  = e => { cfg.hueW = Math.min(90, Math.max(1, +e.target.value)); save(); };
  $('#smin').onchange  = e => { cfg.sMin = Math.min(1, Math.max(0, +e.target.value)); save(); };
  $('#hud').onchange   = e => { cfg.hud = Math.min(40, Math.max(0, +e.target.value)); save(); };
  $('#ghost').onchange = e => { cfg.ghost = e.target.checked; save(); };
  $('#trail').onchange = e => { cfg.trail = e.target.checked; save(); };
  $('#makes').onchange = e => { cfg.makes = e.target.checked; save(); };
  $('#debug').onchange = e => { cfg.debug = e.target.checked; save(); };
  $('#gate').onchange  = e => { cfg.gate = e.target.checked; save(); };
  root.querySelectorAll('.seg button').forEach(b => tap(b, () => {
    cfg.scale = +b.dataset.s; tracks = []; save(); sync();
  }));
  tap(minBtn, () => { cfg.collapsed = !cfg.collapsed; save(); sync(); });
  tap(nub, () => { cfg.hidden = false; save(); sync(); });

  // Belt and braces: keep every control out of the tab order, drop focus as
  // soon as a control is released, and blur anything still focused the moment
  // a game key arrives. Number inputs are exempt — they have to keep focus to
  // be typed into, and the keydown handler below already yields to them.
  root.querySelectorAll('button, input[type=checkbox], summary').forEach(el => {
    el.setAttribute('tabindex', '-1');
    el.addEventListener('mouseup', () => el.blur());
  });

  // drag
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

  root.querySelectorAll('input[type=number]').forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') el.blur();
  }));

  // hotkeys (capture phase). These fire even while a number input holds focus:
  // a function key is never typed into a field, and the game canvas swallows
  // the mousedown that would otherwise blur it — so a field left focused used
  // to strand the hotkeys with no way back except the mouse. Whatever is
  // focused is blurred on the way through, committing a half-typed value.
  window.addEventListener('keydown', e => {
    const inField = root.activeElement && root.activeElement.tagName === 'INPUT';
    // Capture phase, so this lands before the browser turns the key into a
    // click on whatever control still holds focus.
    if ((e.key === ' ' || e.key === 'Enter') && !inField && root.activeElement) root.activeElement.blur();
    if (e.key !== 'F6' && e.key !== 'F7') return;
    e.preventDefault();
    if (root.activeElement) root.activeElement.blur();
    if (e.key === 'F7') toggle();
    if (e.key === 'F6') { cfg.hidden = !cfg.hidden; save(); sync(); }
  }, true);

  sync();
  requestAnimationFrame(loop);
  };

  if (document.documentElement) boot();
  else document.addEventListener('readystatechange', function once() {
    if (document.documentElement) { document.removeEventListener('readystatechange', once); boot(); }
  });
})();
