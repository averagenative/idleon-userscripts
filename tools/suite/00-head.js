// ==UserScript==
// @name         IdleOn Helper Suite
// @namespace    nativerobot
// @version      1.2
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
