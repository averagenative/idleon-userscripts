// ==UserScript==
// @name         IdleOn Helper Suite
// @namespace    nativerobot
// @version      1.11
// @downloadURL https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-suite.user.js
// @updateURL   https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-suite.user.js
// @description  All-in-one: autoclicker + Hoops, Fishing and Darts minigame helpers for Legends of IdleOn, each one individually switchable
// @match        https://www.legendsofidleon.com/*
// @grant        none
// @run-at       document-start
// @all-frames   true
// ==/UserScript==
//
// This is the four standalone scripts (idleon-clicker, idleon-hoops,
// idleon-fishing, idleon-darts) merged into one install. The detection,
// physics and calibration code is the same code, moved verbatim; what is new
// is the shell around it:
//
//   * a Suite panel that switches each helper on and off. A helper that is off
//     builds no UI, reads no pixels and claims no hotkeys — it costs nothing.
//   * one animation frame drives every enabled helper, and the downscaled
//     readback of the game canvas is taken ONCE per frame and shared, instead
//     of once per helper.
//   * shared panel chrome: drag, roll-up, hide, the nub that brings a hidden
//     panel back, and the focus hygiene that keeps game keys out of the panel.
//   * panel positions are remembered, which matters now that there are five.
//
// Each helper keeps its own localStorage key (ac_cfg, hoops_cfg, fish_cfg,
// darts_cfg), so calibration learned by the standalone scripts carries over
// and either version can be run without disturbing the other's settings.
//
// Uninstall the four standalone scripts before enabling this one, or you get
// two of everything.

(function () {
  'use strict';

  // ---------- make the game's backbuffer readable ----------
  // OpenFL exports to WebGL, whose drawing buffer is wiped after each compose
  // unless preserveDrawingBuffer is set, and getContext caches per canvas — so
  // this has to land before the game creates its context, which is why the
  // whole script runs at document-start.
  //
  // It is patched in EVERY frame (@all-frames) even though the panels are only
  // built in the top one: the patch must reach whichever document ends up
  // owning the canvas, and it is free if nothing there ever asks for WebGL.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/i.test(type)) attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    return origGetContext.call(this, type, attrs);
  };

  // The UI is built in the top frame only. The clicker has always run top-only
  // (it dispatches mouse events into this document, so it has to be where the
  // canvas is) and it works, which says the game canvas lives here. Building
  // panels in subframes too would give a second, dead copy of all five.
  // Flip this if the game ever moves into an iframe.
  const UI_IN_SUBFRAMES = false;
  if (!UI_IN_SUBFRAMES && window.top !== window.self) return;

  // =====================================================================
  //  Suite core — everything the individual helpers share
  // =====================================================================

  // ---------- which helpers are on ----------
  const SUITE_KEY = 'idleon_suite';
  const ALL_ON = { clicker: true, hoops: true, fishing: true, darts: true };
  const suite = Object.assign({ collapsed: false, hidden: false },
                              JSON.parse(localStorage.getItem(SUITE_KEY) || '{}'));
  suite.enabled = Object.assign({}, ALL_ON, suite.enabled);
  const saveSuite = () => localStorage.setItem(SUITE_KEY, JSON.stringify(suite));

  // ---------- the game canvas ----------
  // Largest canvas on the page is the game; anything smaller is a UI element.
  function gameCanvas() {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const a = c.clientWidth * c.clientHeight;
      if (a > area) { area = a; best = c; }
    }
    return area > 160000 ? best : null;   // ignore tiny/UI canvases
  }

  // ---------- 3x3 solve, used by the hoops and fishing curve fits ----------
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

  // ---------- shared downscaled readback of the whole frame ----------
  // All three minigame helpers want the same thing: the frame, downscaled by
  // cfg.scale, as raw RGBA. Standalone that was one drawImage + getImageData
  // each; here the first caller in a frame pays for it and the rest read the
  // same buffer. They can only differ if their scales differ, so the cache is
  // keyed on scale as well as on the frame and the canvas.
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  let frameId = 0, cache = null;
  let grabErr = '';

  function grabFrame(cv, scale) {
    if (cache && cache.f === frameId && cache.cv === cv && cache.scale === scale) {
      grabErr = cache.err;
      return cache.img;
    }
    const sw = Math.max(1, Math.round(cv.width / scale));
    const sh = Math.max(1, Math.round(cv.height / scale));
    if (scratch.width !== sw || scratch.height !== sh) { scratch.width = sw; scratch.height = sh; }
    let img = null;
    try {
      sctx.clearRect(0, 0, sw, sh);
      sctx.drawImage(cv, 0, 0, sw, sh);
      img = { d: sctx.getImageData(0, 0, sw, sh).data, sw, sh };
      grabErr = '';
    } catch (e) {
      grabErr = e && e.name === 'SecurityError' ? 'canvas not readable (tainted)' : 'pixel readback failed';
    }
    cache = { f: frameId, cv, scale, img, err: grabErr };
    return img;
  }

  // ---------- panel chrome ----------
  // Every panel is the same furniture around a different body: a title bar
  // that drags, a roll-up toggle, a hide toggle, and a nub that brings a
  // hidden panel back. F-keys can be swallowed by the browser (F10 opens the
  // menu bar), so the nub is the guaranteed way back, not a convenience.
  const CHROME_CSS = `
      * { box-sizing: border-box; font: 12px/1.4 monospace; }
      canvas { position: fixed; left: 0; top: 0; pointer-events: none; }
      #p { position: fixed; background: #14171c; color: #cdd3da; border: 1px solid #2a2f37;
           border-radius: 8px; pointer-events: auto; user-select: none;
           box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      #hd { display:flex; align-items:center; justify-content:space-between;
            padding: 7px 9px; cursor: move; background:#1b1f26; border-radius:8px 8px 0 0; }
      #hd b { color:#8b95a3; font-weight:600; letter-spacing:.3px; }
      #dot { width:9px; height:9px; border-radius:50%; background:#4b5563; display:inline-block; }
      #dot.on { background: var(--dot); box-shadow: 0 0 8px var(--dot); }
      .body { padding: 9px; display:flex; flex-direction:column; gap:7px; }
      .row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      label { color:#8b95a3; }
      input[type=number] { width:60px; background:#0c0e12; color: var(--dot);
            border:1px solid #2a2f37; border-radius:4px; padding:2px 4px; }
      input[type=checkbox] { accent-color: var(--ac); }
      .seg { display:flex; border:1px solid #2a2f37; border-radius:5px; overflow:hidden; }
      .seg button { background:#0c0e12; color:#8b95a3; border:0; padding:3px 8px; cursor:pointer; }
      .seg button.sel { background: var(--ac); color:#fff; }
      .btn { width:100%; padding:6px; border:0; border-radius:5px; cursor:pointer;
             background:#2a2f37; color:#cdd3da; }
      .btn.go { background:#16a34a; color:#fff; }
      .btn.stop { background: var(--stop); color:#fff; }
      .btn.arm { background:#a16207; color:#fff; }
      .btn.sm { padding:4px; font-size:11px; }
      #st { color:#6b7280; font-size:11px; white-space:pre-line; min-height:28px; }
      .hint { color:#4b5563; font-size:11px; text-align:center; }
      #min { cursor:pointer; color:#6b7280; padding:0 4px; }
      #nub { position: fixed; width: 13px; height: 13px; border-radius: 50%;
             background: var(--ac); opacity: .55; cursor: pointer;
             pointer-events: auto; display: none; }
      #nub:hover { opacity: 1; }
      .eye { background:none; border:0; color: var(--ac); cursor:pointer; padding:0 2px;
             font-size:11px; line-height:1; }
      .eye.off { color:#374151; }
      details summary { color:#4b5563; cursor:pointer; font-size:11px; outline:none; }
      details .body { padding:7px 0 0; gap:6px; }
      hr { border:0; border-top:1px solid #2a2f37; margin:1px 0; }`;

  // Every live panel's shadow root, so a game key can be swallowed from
  // whichever one happens to hold focus.
  const roots = new Set();

  function makePanel(def, cfg) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:' + def.z;
    const root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    roots.add(root);

    const t = def.theme;
    root.innerHTML =
      `<style>:host{--dot:${t.dot};--ac:${t.ac};--stop:${t.stop || t.ac}}${CHROME_CSS}</style>` +
      (def.overlay ? '<canvas id="ov"></canvas>' : '') +
      `<div id="nub" title="Show ${def.name}"></div>
       <div id="p">
         <div id="hd"><span><span id="dot"></span> <b>${def.name}</b></span><span id="min">–</span></div>
         <div class="body">${def.bodyHTML}</div>
       </div>`;

    const $ = s => root.querySelector(s);
    const panel = $('#p'), nub = $('#nub'), minBtn = $('#min'), body = $('#p > .body');
    const ov = $('#ov'), octx = ov ? ov.getContext('2d') : null;

    // Layout: the slot is where the panel sits until it is dragged, after
    // which its own position is remembered — five panels is too many to
    // re-arrange every session.
    //
    // Everything is clamped to the viewport, saved positions and default slots
    // alike. A position saved on a wider window, or a default slot on a narrow
    // one, otherwise puts a panel where it cannot be reached or dragged back —
    // and the only cure left is clearing localStorage.
    panel.style.width = def.slot.width + 'px';
    nub.style.top = '6px';
    nub.style.left = def.slot.nub + 'px';

    function place() {
      const w = def.slot.width, h = 40;
      if (cfg.px != null && cfg.py != null) {
        panel.style.right = 'auto';
        panel.style.left = Math.max(0, Math.min(cfg.px, window.innerWidth - w)) + 'px';
        panel.style.top = Math.max(0, Math.min(cfg.py, window.innerHeight - h)) + 'px';
        return;
      }
      panel.style.top = Math.max(0, Math.min(def.slot.top, window.innerHeight - h)) + 'px';
      if (def.slot.right != null && def.slot.right + w <= window.innerWidth) {
        panel.style.left = 'auto';
        panel.style.right = def.slot.right + 'px';
      } else {
        panel.style.right = 'auto';
        panel.style.left = Math.max(0, Math.min(def.slot.left != null ? def.slot.left
                                                : window.innerWidth - w - def.slot.right, window.innerWidth - w)) + 'px';
      }
    }
    place();

    // Listeners are tracked so a helper that gets switched off leaves nothing
    // behind on window or document.
    const bound = [];
    const on = (target, type, fn, capture) => {
      target.addEventListener(type, fn, capture);
      bound.push([target, type, fn, capture]);
    };

    function chrome() {
      body.style.display = cfg.collapsed ? 'none' : '';
      minBtn.textContent = cfg.collapsed ? '+' : '–';
      panel.style.display = cfg.hidden ? 'none' : '';
      nub.style.display = cfg.hidden ? '' : 'none';
    }

    // drag
    let dx = 0, dy = 0, drag = false;
    $('#hd').addEventListener('mousedown', e => {
      if (e.target.id === 'min') return;
      drag = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      panel.style.right = 'auto';
    });
    on(window, 'mousemove', e => {
      if (!drag) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
    });
    on(window, 'mouseup', () => {
      if (!drag) return;
      drag = false;
      const r = panel.getBoundingClientRect();
      cfg.px = Math.round(r.left); cfg.py = Math.round(r.top);
      ui.save();
    });

    const ui = {
      def, cfg, root, $, panel, ov, octx, on, chrome,
      // The way back from a panel that has been dragged somewhere unreachable,
      // or left off-screen by a window that has since been made narrower.
      reset() {
        cfg.px = null; cfg.py = null; cfg.hidden = false; cfg.collapsed = false;
        ui.save(); place(); chrome();
      },
      dot: $('#dot'), runBtn: $('#run'), stEl: $('#st'), nub, minBtn, body,
      save: () => {},          // replaced by the module, which owns its store
      // Keep every control out of the tab order and drop focus as soon as it
      // is released, so a Space or Enter aimed at the game can't re-fire
      // whichever control was touched last. Number inputs keep focus while
      // they are being typed into; the hotkey handler yields to them.
      settle() {
        root.querySelectorAll('button, input[type=checkbox], summary').forEach(el => {
          el.setAttribute('tabindex', '-1');
          el.addEventListener('mouseup', () => el.blur());
        });
        root.querySelectorAll('input[type=number]').forEach(el => el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === 'Escape') el.blur();
        }));
      },
      destroy() {
        for (const [tg, ty, fn, cap] of bound) tg.removeEventListener(ty, fn, cap);
        roots.delete(root);
        host.remove();
      }
    };

    minBtn.addEventListener('click', () => { cfg.collapsed = !cfg.collapsed; ui.save(); chrome(); });
    nub.addEventListener('click', () => { cfg.hidden = false; ui.save(); chrome(); });
    return ui;
  }

  // ---------- one animation frame for the whole suite ----------
  const live = new Map();          // id -> running instance

  function driver() {
    requestAnimationFrame(driver);
    frameId++;
    cache = null;
    for (const inst of live.values()) {
      if (!inst.loop) continue;
      try { inst.loop(); }
      catch (e) {
        // A throw used to kill that helper's self-scheduling loop outright and
        // silently. Now it is contained, reported in the helper's own status
        // line, and given a few frames to be a transient before it is dropped.
        inst.errs = (inst.errs || 0) + 1;
        if (inst.errs === 1) console.error('[IdleOn suite] ' + inst.id + ' loop failed', e);
        if (inst.errs > 5) {
          inst.loop = null;
          if (inst.ui.stEl) inst.ui.stEl.textContent = 'stopped: loop threw\nsee the console';
        }
      }
    }
  }

  // ---------- hotkeys ----------
  // One capture-phase listener for the suite. Capture, so it lands before the
  // browser turns a Space or Enter into a click on whatever control still
  // holds focus, and before the page sees the key at all.
  const keymap = new Map();

  window.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') {
      for (const r of roots) {
        const a = r.activeElement;
        if (a && a.tagName !== 'INPUT') a.blur();
      }
      return;
    }
    const fn = keymap.get(e.key);
    if (!fn) return;
    e.preventDefault();
    // Function keys are never typed into a field, and the game canvas swallows
    // the mousedown that would otherwise blur one — so a field left focused
    // used to strand the hotkeys. Blur on the way through, which also commits
    // a half-typed value.
    for (const r of roots) if (r.activeElement) r.activeElement.blur();
    fn();
  }, true);

  // ---------- starting and stopping a helper ----------
  function startModule(def) {
    if (live.has(def.id)) return;
    const cfg = def.cfg;
    const ui = makePanel(def, cfg);
    ui.save = def.save;
    const inst = def.init(ui) || {};
    inst.id = def.id; inst.ui = ui;
    live.set(def.id, inst);

    ui.settle();
    ui.chrome();
    if (inst.sync) inst.sync();

    for (const [key, name] of Object.entries(def.hotkeys)) {
      if (name === 'hide') keymap.set(key, () => { cfg.hidden = !cfg.hidden; def.save(); ui.chrome(); });
      else if (inst[name]) keymap.set(key, inst[name]);
    }
  }

  function stopModule(def) {
    const inst = live.get(def.id);
    if (!inst) return;
    if (inst.destroy) inst.destroy();
    inst.loop = null;
    inst.ui.destroy();
    live.delete(def.id);
    for (const key of Object.keys(def.hotkeys)) keymap.delete(key);
  }

  const setEnabled = (def, want) => {
    suite.enabled[def.id] = !!want;
    saveSuite();
    want ? startModule(def) : stopModule(def);
  };

  // A helper's config store. Each keeps the key the standalone script used, so
  // hard-won calibration survives the move.
  function store(key, defaults, migrate) {
    const cfg = Object.assign({ collapsed: false, hidden: false, px: null, py: null },
                              defaults, JSON.parse(localStorage.getItem(key) || '{}'));
    if (migrate) migrate(cfg);
    let last = 0;
    const save = () => localStorage.setItem(key, JSON.stringify(cfg));
    const saveSoon = () => { const t = performance.now(); if (t - last > 1000) { last = t; save(); } };
    return { cfg, save, saveSoon };
  }

  // =====================================================================
  //  Helper — Clicker
  //  Stealthy autoclicker. The only helper that reads no pixels and needs no
  //  animation frame; it runs on its own randomised setTimeout.
  // =====================================================================
  const clicker = store('ac_cfg', {
        ivMin: 600,        // ms — lower bound of click interval
        ivMax: 1200,       // ms — upper bound; each click picks uniformly in [min, max]
        jitterPx: 2,       // +/- position jitter in px (0 = pixel-perfect)
        mode: 'cursor',    // 'cursor' | 'fixed'
        fx: 0, fy: 0,      // fixed target, viewport px (legacy / no-canvas fallback)
        fu: null, fv: null,// fixed target as a fraction of the game canvas rect
  }, cfg => {
      // migrate old base+jitter config -> min/max range
      if (cfg.ivMin === undefined && cfg.interval !== undefined) {
        const j = cfg.jitterMs || 0;
        cfg.ivMin = Math.max(20, cfg.interval - j);
        cfg.ivMax = cfg.interval + j;
      }
      delete cfg.interval; delete cfg.jitterMs;
  });

  const CLICKER = {
    id: 'clicker', name: 'IdleOn Clicker', short: 'Clicker',
    z: 2147483646,
    theme: { dot: '#4ade80', ac: '#2563eb', stop: '#dc2626' },
    slot: { top: 12, right: 12, width: 210, nub: 24 },
    overlay: false,
    hotkeys: { F8: 'toggle', F9: 'panic', F10: 'hide' },
    keyHint: 'F8',
    cfg: clicker.cfg, save: clicker.save,
    bodyHTML: `
        <button class="btn go" id="run">Start  (F8)</button>
        <div class="row"><label>Interval min</label><span><input id="ivmin" type="number" min="20" step="10"> ms</span></div>
        <div class="row"><label>Interval max</label><span><input id="ivmax" type="number" min="20" step="10"> ms</span></div>
        <div class="row"><label>Pos jitter</label><span><input id="jp" type="number" min="0" step="1"> px</span></div>
        <div class="row"><label>Target</label>
          <div class="seg"><button data-m="cursor">Cursor</button><button data-m="fixed">Fixed</button></div>
        </div>
        <button class="btn arm" id="set">Set Position</button>
        <div class="row"><label>XY</label><span id="xy">—</span></div>
        <div class="hint">F8 toggle · F9 panic-off · F10 hide</div>`,

    init(ui) {
      const cfg = clicker.cfg, save = clicker.save;
      const $ = ui.$, root = ui.root, runBtn = ui.runBtn, dot = ui.dot;
      const ivMinEl = $('#ivmin'), ivMaxEl = $('#ivmax'), jpEl = $('#jp'),
            xyEl = $('#xy'), setBtn = $('#set');

      let on = false, timer = null, capturing = false;
      let lastX = 0, lastY = 0;
      ui.on(document, 'mousemove', e => { lastX = e.clientX; lastY = e.clientY; }, true);

      function sync() {
        ivMinEl.value = cfg.ivMin; ivMaxEl.value = cfg.ivMax; jpEl.value = cfg.jitterPx;
        root.querySelectorAll('.seg button').forEach(b => b.classList.toggle('sel', b.dataset.m === cfg.mode));
        xyEl.textContent = cfg.mode !== 'fixed' ? '(follows cursor)'
          : hasTarget() ? fixedPoint().map(Math.round).join(', ') : 'not set';
        dot.classList.toggle('on', on);
        runBtn.textContent = on ? 'Stop  (F8)' : 'Start  (F8)';
        runBtn.className = 'btn ' + (on ? 'stop' : 'go');
        setBtn.textContent = capturing ? 'Click a spot…' : 'Set Position';
        ui.chrome();
      }

      // ---------- target resolution ----------
      // Largest canvas on the page is the game; anything smaller is a UI element.
      function gameCanvas() {
        let best = null, area = 0;
        for (const c of document.querySelectorAll('canvas')) {
          const a = c.clientWidth * c.clientHeight;
          if (a > area) { area = a; best = c; }
        }
        return area > 160000 ? best : null;   // ignore tiny/UI canvases
      }

      // A fixed target is stored as a fraction of the game canvas, not as viewport
      // pixels, so it survives a resize, zoom or fullscreen toggle. The canvas is
      // scaled and letterboxed, so the same screen pixel lands on a different spot
      // in the world once its size changes — and a click on bare ground is a walk
      // command, which is how a drifted target sends the character strolling off.
      const hasTarget = () => cfg.fu != null || cfg.fx || cfg.fy;

      function fixedPoint() {
        const cv = gameCanvas();
        if (!cv || cfg.fu == null) return [cfg.fx, cfg.fy];   // pre-3.3 config
        const r = cv.getBoundingClientRect();
        return [r.left + cfg.fu * r.width, r.top + cfg.fv * r.height];
      }

      // ---------- clicking ----------
      const rand = j => j ? (Math.random() * 2 - 1) * j : 0;

      function clickAt(x, y) {
        x = Math.round(x + rand(cfg.jitterPx));
        y = Math.round(y + rand(cfg.jitterPx));
        const el = document.elementFromPoint(x, y) || gameCanvas();
        if (!el) return;
        for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0
          }));
        }
      }

      function tick() {
        if (!on) return;
        // Resolved every tick: the canvas rect can change under a running clicker.
        if (cfg.mode !== 'fixed' || hasTarget()) {
          const [tx, ty] = cfg.mode === 'fixed' ? fixedPoint() : [lastX, lastY];
          clickAt(tx, ty);
        }
        const lo = Math.min(cfg.ivMin, cfg.ivMax), hi = Math.max(cfg.ivMin, cfg.ivMax);
        timer = setTimeout(tick, Math.max(20, lo + Math.random() * (hi - lo)));
      }

      function start() { if (!on) { on = true; sync(); tick(); } }
      function stop()  { on = false; clearTimeout(timer); sync(); }
      function toggle(){ on ? stop() : start(); }

      // ---------- position capture ----------
      function armCapture() {
        capturing = true; sync();
        const grab = e => {
          e.preventDefault(); e.stopPropagation();
          cfg.fx = e.clientX; cfg.fy = e.clientY;
          const cv = gameCanvas(), r = cv && cv.getBoundingClientRect();
          cfg.fu = r ? (e.clientX - r.left) / r.width  : null;
          cfg.fv = r ? (e.clientY - r.top)  / r.height : null;
          cfg.mode = 'fixed';
          capturing = false; save(); sync();
          window.removeEventListener('mousedown', grab, true);
        };
        ui.on(window, 'mousedown', grab, true);
      }

      // ---------- wiring ----------
      runBtn.onclick = toggle;
      setBtn.onclick = () => capturing ? null : armCapture();
      ivMinEl.onchange = e => { cfg.ivMin = Math.max(20, +e.target.value); save(); };
      ivMaxEl.onchange = e => { cfg.ivMax = Math.max(20, +e.target.value); save(); };
      jpEl.onchange = e => { cfg.jitterPx = Math.max(0, +e.target.value); save(); };
      root.querySelectorAll('.seg button').forEach(b => b.onclick = () => { cfg.mode = b.dataset.m; save(); sync(); });

      // panic stops the clicker outright; switching the helper off has to as
      // well, or a torn-down panel leaves a timer clicking with no way to see it.
      return { sync, toggle, panic: stop, destroy: stop };
    }
  };

  // =====================================================================
  //  Helper — Swishy Hoops
  //  Dotted-line shot preview + live ball arc.
  // =====================================================================
  const hoops = store('hoops_cfg', {
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
        //
        // KNOWN, UNEXPLAINED, and the biggest error left. These two are supposed to
        // describe the SHOT, so anchoring to the platform should make them
        // invariant to where the platform happens to be. They are not. Across two
        // independent runs read off the live game:
        //
        //             corr(platY, shotL)   corr(platY, shotR)
        //   8 flights        -0.79               +0.71
        //   5 flights        -0.86               +0.77
        //
        // Curvature barely moves, which is the tell: shotA is set by g/2vx^2 and
        // neither of those cares how high the platform is, while shotL and shotR
        // are where the arc meets platform HEIGHT.
        //
        // It looks like the lever and it is not. Modelling shotL as linear in
        // platform height predicts it 43% better out of sample -- leave-one-out
        // mean error 51.6px falls to 29.6px -- and shotR barely moves, 40.8 to
        // 37.7px. But the number that decides a make is the height of the arc where
        // it passes the RIM, and there the same comparison is:
        //
        //   constant, as shipped        mean 54.7px   worst 117.5px
        //   linear in platform height   mean 53.0px   worst 113.9px
        //
        // Three percent. The errors in A, L and R are correlated and largely cancel
        // by the time the curve reaches the rim, so a correction that plainly
        // improves two of the three parameters buys almost nothing where it counts.
        // Measured, not argued, and left unshipped on that basis: an unexplained
        // empirical correction fitted on 11 flights from one player has to earn
        // more than 3% before it goes in.
        //
        // It is worse than useless, and the way it hides is worth writing down.
        // Adding a second session's flights and pooling the two made the same
        // correction look like a 31% win -- 75.2px down to 51.8px -- which is
        // exactly the kind of number that gets a change shipped. Split by session
        // it evaporates:
        //
        //   session A (n=8)    54.7px -> 53.0px    -3%
        //   session B (n=7)    61.4px -> 75.1px   +23%   WORSE
        //   pooled   (n=15)    75.2px -> 51.8px   -31%
        //
        // The tell is that pooling made the CONSTANT model worse than it was in
        // either session on its own, which can only happen if pooling introduced
        // variance neither session had. The linear term then soaks that up, and the
        // leave-one-out score rewards it for absorbing an artefact of pooling
        // rather than for predicting anything. Per-session the parameters agree to
        // within .21 of a standard deviation, so there is no real drift to model.
        // Score a per-shot correction per session, never across pooled sessions.
        //
        // And be suspicious of the correlation itself. Measured on three separate
        // captures the platform-height coupling to curvature came out at -0.13,
        // -0.46 and -0.82; within the two halves of the third capture, -0.81 and
        // -0.96. That is not one effect measured three times, it is what a
        // correlation looks like at n = 6 to 12. Curvature is the one parameter the
        // anchor cannot touch mathematically -- shotA is a*W straight off the fit
        // and platform position never enters it -- so a coupling there has to be
        // either real physics or a bias in the estimator, and the time domain says
        // it is neither: across those same flights vx holds to 1.3% and neither vx
        // nor the fitted g tracks platform height (-0.11 and -0.14). The physical
        // curvature g/2vx^2 is constant. The wobble is sampling noise in medA.
        //
        // A slope cap was tried on the back of it -- refit y(x) using only the part
        // of the arc below some |dy/dx|, on the theory that the steep tail is where
        // the parameterisation degenerates and how much tail gets tracked depends
        // on how high the platform was. On the capture it was derived from it looked
        // excellent, spread 12.3% down to 5.1%. It does not replicate: no effect at
        // all on a second capture, and on a third the single fit it rests on is
        // catastrophic, 92% spread, because one whole-segment fit is exactly the
        // thing the gated median exists to avoid. Not shipped.
        //
        // What IS stable: the gated median's own spread runs 4-12% depending on the
        // session, against 47% before the screens went in. That is the honest state
        // of it. Anything smaller than that needs more than a dozen flights per
        // session to see, and every correction derived from a dozen has so far
        // failed on the next dozen.
        //
        // The ~55px of arc height at the rim is therefore the real accuracy ceiling
        // today, and it is per-shot noise in L and R rather than anything to do
        // with the anchor. Averaging across shots is what actually removes it,
        // which is what the commit weighting is for.
        //
        // Three explanations have been measured and none survived:
        //   - Stale anchor. flightPlat is sampled a frame or two after release and
        //     the platform is moving (26 of 32 releases, ~135px/s, biased upward).
        //     But recomputing L and R against the platform at release+dt over
        //     -200..+400ms gives no minimum -- the spread falls monotonically and
        //     is still falling at -200ms, which is before the ball left.
        //   - The detector picking a different row of the platform as it moves.
        //     The detected width was 177px in 2565 of 2566 logged frames.
        //   - The ball inheriting the platform's velocity. platV correlates worse
        //     than platY (-0.68 vs -0.86 for L), though on an oscillating platform
        //     the two are confounded and 5 flights cannot separate them.
        //
        // What is left is that the shot may simply not be fixed relative to the
        // platform -- if the character's jump reaches a height that is not purely
        // platform-relative, the arc meets platform height further out when the
        // platform sits lower, which is the observed sign. Settling it needs the
        // release instant, which nothing currently measures.
        shotA: 2.233,      // curvature x canvas width
        shotL: -0.119,     // upward crossing, fraction of width left of the platform
        shotR: 0.547,      // landing range, fraction of width right of the platform
        calSeeded: true,
  }, cfg => {
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
  });

  const HOOPS = {
    id: 'hoops', name: 'Hoops Helper', short: 'Hoops',
    z: 2147483645,
    theme: { dot: '#f87171', ac: '#dc2626' },
    slot: { top: 12, left: 220, width: 228, nub: 42 },
    overlay: true,
    hotkeys: { F7: 'toggle', F6: 'hide' },
    keyHint: 'F7',
    cfg: hoops.cfg, save: hoops.save,
    bodyHTML: `
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
        <div class="hint">F7 arc on/off · F6 hide panel</div>`,

    init(ui) {
      const cfg = hoops.cfg, save = hoops.save;
      const $ = ui.$, root = ui.root, ov = ui.ov, octx = ui.octx,
            runBtn = ui.runBtn, dot = ui.dot, stEl = ui.stEl;

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
        ui.chrome();
        if (!cfg.on) octx.clearRect(0, 0, ov.width, ov.height);
      }

      // ---------- pixel readback ----------
      // The full-frame grab comes from the suite, which takes it once per frame
      // and hands the same buffer to every helper reading at this scale.
      let readErr = '';
      const grab = cv => { const img = grabFrame(cv, cfg.scale); readErr = grabErr; return img; };
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

      return { loop, sync, toggle };
    }
  };

  // =====================================================================
  //  Helper — Fishing
  //  Landing prediction for a cast, plus fish and hazard markers.
  // =====================================================================
  const fishing = store('fish_cfg', {
        on: true,
        scale: 4,
        marks: true,       // ring the fish and the hazards
        aim: true,         // live landing marker while the power bar charges
        arc: true,         // dotted arc for a bobber already in the air
        ruler: true,       // numbered 0-8 graduations on the gauge and lane
        debug: false,
        // landing = aim2*p^2 + aim1*p + aim0, p the gauge fill, result a fraction
        // along the lane.
        //
        // v6: the mapping is a CURVE, not a line. Every version up to v5 fitted a
        // straight line, and a line through this data has residuals that are
        // positive at both ends and negative in the middle — the signature of
        // fitting a curve with a ruler. It went unnoticed because the recording it
        // was measured on only ever used 0.23-0.68 of the gauge, where a line is a
        // fine approximation. A second recording covering 0.09-1.00 showed the
        // ends pulling away: the v5 line under-predicted every long cast by 5-8%
        // of the lane, all in the same direction. That is the "I have to release
        // before the mark to hit anything far out" complaint, exactly.
        //
        // 19 casts across two fishing spots, powers 0.09 to 1.00, each pairing the
        // locked gauge fill with where the bobber came to rest:
        //
        //   line       mean 2.2% of the lane, worst 3.9%, residuals still curved
        //   parabola   mean 1.1% of the lane, worst 2.2%, no pattern left
        //
        // Both spots fall on the SAME curve, so this is the game's law and not a
        // per-spot quirk — which also means the seed is worth trusting before any
        // self-calibration has happened.
        calVer: 6,         // bump to discard samples gathered under an older gauge
        aim2: 0.3095, aim1: 0.5631, aim0: 0.0420,
        samples: [],       // [powerFraction, landingFraction] pairs, newest last
  }, cfg => {
      // Samples are (power, landing) pairs and would survive a change of model —
      // but not a change of what "power" meant. Everything learned before v6 was
      // paired with a gauge reading that could collapse, so it goes.
      if (cfg.calVer !== 6) {
        cfg.calVer = 6; cfg.samples = [];
        cfg.aim2 = 0.3095; cfg.aim1 = 0.5631; cfg.aim0 = 0.0420;
        delete cfg.aimA; delete cfg.aimB;
      }
      // A zero curvature can only have come from the straight-line fallback that
      // refitAim used to drop to below eight samples — the seed has never been a
      // line under calVer 6. Put the seed curve back; the samples themselves are
      // still good, and the first cast landed from here refits them properly.
      if (!cfg.aim2) { cfg.aim2 = 0.3095; cfg.aim1 = 0.5631; cfg.aim0 = 0.0420; }
  });

  const FISHING = {
    id: 'fishing', name: 'Fishing Helper', short: 'Fishing',
    z: 2147483644,
    theme: { dot: '#38bdf8', ac: '#0284c7' },
    slot: { top: 12, left: 460, width: 214, nub: 60 },
    overlay: true,
    hotkeys: { F4: 'toggle', F3: 'hide' },
    keyHint: 'F4',
    cfg: fishing.cfg, save: fishing.save,
    bodyHTML: `
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
        <div class="hint">F4 on/off · F3 hide panel</div>`,

    init(ui) {
      const cfg = fishing.cfg, save = fishing.save, saveSoon = fishing.saveSoon;
      const $ = ui.$, root = ui.root, ov = ui.ov, octx = ui.octx,
            runBtn = ui.runBtn, dot = ui.dot, stEl = ui.stEl;

      function sync() {
        $('#aim').checked = cfg.aim; $('#marks').checked = cfg.marks;
        $('#arcx').checked = cfg.arc; $('#ruler').checked = cfg.ruler;
        $('#debug').checked = cfg.debug;
        dot.classList.toggle('on', cfg.on);
        runBtn.textContent = cfg.on ? 'Hide helper  (F4)' : 'Show helper  (F4)';
        runBtn.className = 'btn ' + (cfg.on ? 'stop' : 'go');
        ui.chrome();
        if (!cfg.on) octx.clearRect(0, 0, ov.width, ov.height);
      }

      // ---------- pixel readback ----------
      // The full frame comes from the suite's shared grab, taken once per frame
      // whatever else is running.
      let readErr = '';
      const grab = cv => { const img = grabFrame(cv, cfg.scale); readErr = grabErr; return img; };
      // The whole frame is read downscaled (cheap, enough to find the lane), but the
      // sprites sitting on the lane are small and spiky — at 4x the urchin breaks
      // into fragments too small to trust. The lane is only a thin strip, so it is
      // re-read at native resolution, which costs about as much as the whole
      // downscaled frame and makes the sprites solid.
      const strip = document.createElement('canvas');
      const stctx = strip.getContext('2d', { willReadFrequently: true });

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
        for (let y = yLo; y < yHi; y++) {
          let c = 0, r = 0;
          for (let x = cx0; x < cx1; x++) {
            const [hu, s, v] = hsvAt(d, y * w + x);
            if (isBobber(hu, s, v)) { r++; c++; }
            else if (isCase(hu, s, v)) c++;
          }
          rowN[y - yLo] = c; rowRed[y - yLo] = r;
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
        const on = i => i >= 0 && i < n && rowN[i] > 0;

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
        for (let y = top; y <= bot; y++) if (rowRed[y - yLo] > 0) { fillTop = y; break; }
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
      // A parabola needs its samples spread out to be worth fitting: six casts all
      // at half power pin the middle and let the ends fly anywhere, which is a
      // worse predictor than the seed they replaced. So the quadratic is only
      // accepted with enough samples over a wide enough range of the gauge.
      //
      // Below that the fit used to drop to a straight line, on the reasoning that a
      // line is "still better than nothing and cannot bend the wrong way". That was
      // true when the seed was itself a line, and became wrong the moment v6 made
      // the seed a curve measured over 19 casts and two spots: the fallback was no
      // longer replacing nothing, it was replacing the best number in the file. In
      // practice it fired almost immediately — three casts is enough — and a live
      // config caught in the act held aim2 = 0, aim1 = .8456 from six samples that
      // spanned only p .25 to .625. Against the seed that line reads +2.2% of the
      // lane at half power and -6.9% at full, so the further the target the more
      // power it demands, and you have to release early to land anything. That is
      // exactly the complaint v6 was supposed to have fixed.
      //
      // So the fallback keeps the curvature and fits only what the samples can
      // honestly see: the slope and the offset. Both spots measured for v6 fell on
      // the same curve, which makes SEED_C2 the game's law rather than one lane's
      // quirk, while slope and offset absorb the things that do move — chiefly how
      // wide findLane measured this particular lane. Two free parameters need far
      // fewer samples than three, and the result cannot bend the wrong way either.
      const SEED_C2 = 0.3095;   // must move with cfg.aim2's default and migration
      function refitAim() {
        const S = cfg.samples;
        if (S.length < 3) return;
        const ps = S.map(s => s[0]);
        const span = Math.max(...ps) - Math.min(...ps);
        let c2 = 0, c1, c0;

        if (S.length >= 8 && span > 0.35) {
          let s0 = S.length, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
          for (const [p, l] of S) {
            const p2 = p * p;
            s1 += p; s2 += p2; s3 += p2 * p; s4 += p2 * p2;
            y0 += l; y1 += p * l; y2 += p2 * l;
          }
          const sol = solve3([[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]], [y2, y1, y0]);
          if (sol) [c2, c1, c0] = sol;
        }
        if (!c2) {
          // Curvature pinned, slope and offset least-squared over l - SEED_C2*p^2.
          c2 = SEED_C2;
          let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
          for (const [p, l] of S) {
            const y = l - c2 * p * p;
            n++; sx += p; sy += y; sxx += p * p; sxy += p * y;
          }
          const den = n * sxx - sx * sx;
          if (Math.abs(den) < 1e-6) return;
          c1 = (n * sxy - sx * sy) / den;
          c0 = (sy - c1 * sx) / n;
        }

        // Reject anything that is not a sane cast curve: it has to rise all the way
        // across the gauge and stay on the lane. A fit that dips in the middle, or
        // sends full power off the end, is overfitted noise — keep what we had.
        const at = p => c2 * p * p + c1 * p + c0;
        const slope = p => 2 * c2 * p + c1;
        if (slope(0) <= 0 || slope(1) <= 0) return;
        if (at(0) < -0.15 || at(0) > 0.35 || at(1) < 0.5 || at(1) > 1.3) return;
        cfg.aim2 = c2; cfg.aim1 = c1; cfg.aim0 = c0;
      }

      const aimFrac = p => Math.max(0, Math.min(1, cfg.aim2 * p * p + cfg.aim1 * p + cfg.aim0));

      // Inverse of the mapping: what power lands ON a given lane fraction. Only as
      // good as the current calibration, same as the aim marker. The curve rises
      // across the whole gauge (refitAim will not accept one that does not), so the
      // root wanted is always the one from the positive branch.
      const invAim = f => {
        const a = cfg.aim2, b = cfg.aim1, c = cfg.aim0 - f;
        if (Math.abs(a) < 1e-6) return Math.abs(b) > 0.05 ? Math.max(0, Math.min(1, -c / b)) : null;
        const disc = b * b - 4 * a * c;
        if (disc < 0) return null;
        return Math.max(0, Math.min(1, (-b + Math.sqrt(disc)) / (2 * a)));
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
          bobHist = []; hold = null; meterHist = [];
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
                fish.push({ ...o, name: sp.name, pts: sp.pts, color: sp.color });
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
        if (cfg.marks) {
          // Left of each catch, the power that would land the cast on it — the
          // number to release the gauge at. Recomputed every frame, so once the
          // fish start moving (later in a run) the label tracks them.
          for (const f of fish) {
            const p = invAim((f.x - laneX0) / laneW);
            drawLaneMark(f.x, f.y, f.color, `${f.name} +${f.pts}`, p !== null ? ((p * 100) | 0) + '%' : null);
          }
          // A hazard with a catch sitting on it is not a hazard. Land there and the
          // catch is what you get — which is why the aim marker below already lets
          // the catch colour outrank the hazard colour. Ringing it AVOID as well
          // put a red ring and a species ring on the same pixel, arguing with each
          // other over a spot you actually want to hit. Hazards only cost you when
          // you land on a bare one, or miss everything; same W*0.02 as the marker.
          for (const z of haz)
            if (!fish.some(f => Math.abs(f.x - z.x) < W * 0.02))
              drawLaneMark(z.x, z.y, '#f87171', 'AVOID');
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

        probe({
          frame, lane, meter: m, charge,
          aimAt: aimX === null ? null : (aimX - laneX0) / laneW,
          landAt: landX === null ? null : (landX - laneX0) / laneW,
          // Where the bobber actually IS, as a fraction of the lane. The one
          // number that says whether the mapping is right: park a cast, read this,
          // compare with the aimAt that was showing when it was released.
          bobAt: landed ? (landed.x - laneX0) / laneW : null,
          fish: fish.length, haz: haz.length,
          cal: { c2: cfg.aim2, c1: cfg.aim1, c0: cfg.aim0, n: cfg.samples.length }
        });
      }
      // ---------- wiring ----------
      const toggle = () => { cfg.on = !cfg.on; if (!cfg.on) bobHist = []; save(); sync(); };
      runBtn.onclick = toggle;
      $('#aim').onchange   = e => { cfg.aim = e.target.checked; save(); };
      $('#marks').onchange = e => { cfg.marks = e.target.checked; save(); };
      $('#arcx').onchange  = e => { cfg.arc = e.target.checked; save(); };
      $('#ruler').onchange = e => { cfg.ruler = e.target.checked; save(); };
      $('#debug').onchange = e => { cfg.debug = e.target.checked; save(); };
      $('#cal').onclick = () => {
        cfg.samples = [];
        cfg.aim2 = 0.3095; cfg.aim1 = 0.5631; cfg.aim0 = 0.0420;
        save();
      };

      return { loop, sync, toggle };
    }
  };

  // =====================================================================
  //  Helper — Throwy Darts
  //  Predicted dart path and the band it lands in, wind included.
  // =====================================================================
  const darts = store('darts_cfg', {
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
  }, cfg => {
      if (cfg.calVer !== 4) {
        cfg.calVer = 4; cfg.vN = 0.548; cfg.gN = 0.612; cfg.landN = -0.023;
        cfg.windK = 0.0158;
      }
  });

  const DARTS = {
    id: 'darts', name: 'Darts Helper', short: 'Darts',
    z: 2147483643,
    theme: { dot: '#fbbf24', ac: '#d97706' },
    slot: { top: 12, left: 686, width: 216, nub: 78 },
    overlay: true,
    hotkeys: { F2: 'toggle', F1: 'hide' },
    keyHint: 'F2',
    cfg: darts.cfg, save: darts.save,
    bodyHTML: `
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
        <div class="hint">F2 on/off · F1 hide panel</div>`,

    init(ui) {
      const cfg = darts.cfg, save = darts.save, saveSoon = darts.saveSoon;
      const $ = ui.$, root = ui.root, ov = ui.ov, octx = ui.octx,
            runBtn = ui.runBtn, dot = ui.dot, stEl = ui.stEl;

      function sync() {
        $('#path').checked = cfg.path; $('#band').checked = cfg.band;
        $('#live').checked = cfg.live; $('#debug').checked = cfg.debug;
        dot.classList.toggle('on', cfg.on);
        runBtn.textContent = cfg.on ? 'Hide path  (F2)' : 'Show path  (F2)';
        runBtn.className = 'btn ' + (cfg.on ? 'stop' : 'go');
        ui.chrome();
        if (!cfg.on) octx.clearRect(0, 0, ov.width, ov.height);
      }

      // ---------- readback ----------
      // Full frame from the suite's shared grab; darts wants it as {d,w,h}.
      let readErr = '';
      const grab = cv => {
        const img = grabFrame(cv, cfg.scale);
        readErr = grabErr;
        return img && { d: img.d, w: img.sw, h: img.sh };
      };
      // The dart is a ~4px-wide sprite; at 4x it is a smear. The area around the
      // player is re-read at native resolution so the aim can be measured.
      const aimC = document.createElement('canvas');
      const actx = aimC.getContext('2d', { willReadFrequently: true });

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
          board = null; dartPts = []; aimDeg = null;
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

        probe({
          frame, board, wind, aimDeg, hand, hitBand, hitY, dart: dartPts.length,
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

      return { loop, sync, toggle };
    }
  };

  // =====================================================================
  //  Suite panel — the switchboard
  // =====================================================================
  const MODULES = [CLICKER, HOOPS, FISHING, DARTS];

  const HUB = {
    id: 'suite', name: 'IdleOn Suite',
    z: 2147483647,
    theme: { dot: '#a78bfa', ac: '#7c3aed' },
    slot: { top: 12, left: 12, width: 196, nub: 6 },
    overlay: false,
    bodyHTML:
      // Each row: the helper's name, its toggle hotkey, an eye that shows or
      // hides that panel, and the tickbox that runs it at all. The eye is here
      // because a hidden panel leaves only a 13px nub on screen to click, and
      // nothing says which nub is which — so "where did my darts panel go" had
      // no answer you could find by looking.
      MODULES.map(m =>
        `<div class="row"><label>${m.short}</label>` +
        `<span><span class="hint">${m.keyHint}</span> ` +
        `<button class="eye" id="eye-${m.id}" data-m="${m.id}">\u25cf</button> ` +
        `<input id="en-${m.id}" type="checkbox"></span></div>`
      ).join('\n        ') + `
        <hr>
        <button class="btn sm" id="panels">Hide all panels</button>
        <button class="btn sm" id="reset">Reset panel layout</button>
        <div class="hint">unticking a helper stops it:<br>no panel, no readback, no hotkey</div>`
  };

  function boot() {
    const hub = makePanel(HUB, suite);
    hub.save = saveSuite;
    hub.dot.classList.add('on');

    // "all hidden" drives the button's label, so it reads as the thing it is
    // about to do rather than as the state it is in.
    const anyShown = () => MODULES.some(m => live.has(m.id) && !m.cfg.hidden);

    function syncHub() {
      for (const m of MODULES) {
        hub.$('#en-' + m.id).checked = !!suite.enabled[m.id];
        const eye = hub.$('#eye-' + m.id), off = !live.has(m.id);
        eye.textContent = m.cfg.hidden ? '\u25cb' : '\u25cf';
        eye.title = m.cfg.hidden ? 'Show the ' + m.short + ' panel' : 'Hide the ' + m.short + ' panel';
        eye.className = 'eye' + (off ? ' off' : '');
      }
      hub.$('#panels').textContent = anyShown() ? 'Hide all panels' : 'Show all panels';
      hub.chrome();
    }

    for (const m of MODULES) {
      hub.$('#en-' + m.id).onchange = e => { setEnabled(m, e.target.checked); syncHub(); };
      hub.$('#eye-' + m.id).onclick = () => {
        m.cfg.hidden = !m.cfg.hidden; m.save();
        const inst = live.get(m.id);
        if (inst) inst.ui.chrome();
        syncHub();
      };
    }
    hub.$('#panels').onclick = () => {
      const hide = anyShown();
      for (const m of MODULES) {
        m.cfg.hidden = hide; m.save();
        const inst = live.get(m.id);
        if (inst) inst.ui.chrome();
      }
      syncHub();
    };

    // Puts every panel back in its default slot, unhidden and unrolled —
    // including the ones that are switched off, whose stored position would
    // otherwise still be off-screen next time they are switched back on.
    hub.$('#reset').onclick = () => {
      for (const m of MODULES) {
        const inst = live.get(m.id);
        if (inst) inst.ui.reset();
        else { m.cfg.px = null; m.cfg.py = null; m.cfg.hidden = false; m.cfg.collapsed = false; m.save(); }
      }
      hub.reset();
      syncHub();
    };

    for (const m of MODULES) if (suite.enabled[m.id]) startModule(m);

    hub.settle();
    syncHub();
    requestAnimationFrame(driver);
  }

  if (document.documentElement) boot();
  else document.addEventListener('readystatechange', function once() {
    if (document.documentElement) { document.removeEventListener('readystatechange', once); boot(); }
  });
})();
