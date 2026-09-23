// ==UserScript==
// @name         IdleOn Helper Suite
// @namespace    nativerobot
// @version      1.2
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
  // layout: 'free' keeps the dragged-anywhere behaviour every version until now
  // had, and stays the default so an upgrade moves nobody's panels. 'left' and
  // 'top' dock them into one column or one row.
  // solo: opening a helper closes the other helpers. Only meaningful docked,
  // where they share a column; see the collapse handler.
  // follow: opt in to letting the active minigame open its own helper.
  // awake: keep the game running while its window is unfocused; see below.
  const suite = Object.assign({ collapsed: false, hidden: false,
                                layout: 'free', solo: true, follow: false, awake: true },
                              JSON.parse(localStorage.getItem(SUITE_KEY) || '{}'));
  suite.enabled = Object.assign({}, ALL_ON, suite.enabled);
  const saveSuite = () => localStorage.setItem(SUITE_KEY, JSON.stringify(suite));

  // ---------- keep the game awake ----------
  // Alt-tabbing away pauses the whole game, not just a minigame. The game
  // does this to itself. Lime's HTML5 window (N.js, read 2026-09-23) listens
  // for `blur` on window and `visibilitychange` on document, turns either into
  // onDeactivate, and Stencyl's onFocusLost answers with inFocus = false. That
  // stops progress in open menus as well, such as a running upgrade screen.
  // Chrome does not hide a page just because its window lost focus.
  //
  // This lives in the shell, not in a helper, so it holds with every helper
  // switched off. Both events are swallowed in the capture phase, and only
  // when they are aimed at the window or document itself. An element losing
  // focus sends its own `blur` to that element and goes through as normal.
  // Lime registers without capture, and capture listeners run first at the
  // target, so the order of registration does not matter.
  //
  // Not fixable from here: a minimised window, or one on another workspace.
  // Chrome really hides that page and throttles requestAnimationFrame.
  const swallowFocusLoss = e => {
    if (suite.awake && (e.target === window || e.target === document)) e.stopImmediatePropagation();
  };
  window.addEventListener('blur', swallowFocusLoss, true);
  window.addEventListener('visibilitychange', swallowFocusLoss, true);

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

  // ---------- docked layouts ----------
  // Five panels is a lot of furniture to arrange by hand every session, and
  // only one helper is ever useful at a time — you are in exactly one minigame.
  // Docking stacks them against an edge in a fixed order and takes over their
  // positions; the saved px/py are left untouched so switching back to 'free'
  // restores exactly where things were.
  const docks = [];                 // { def, ui }, sorted by def.dockOrder
  const DOCK_EDGE = 10, DOCK_GAP = 8;
  let relayoutPending = false;

  function relayout() {
    if (suite.layout === 'free') {
      for (const d of docks) d.ui.place();
      return;
    }
    const vert = suite.layout === 'left';
    // ?? not ||: the hub is dockOrder 0, which || would treat as missing and
    // sort to the bottom of its own dock.
    const list = docks.slice().sort((a, b) => (a.def.dockOrder ?? 99) - (b.def.dockOrder ?? 99));
    // Packed into lanes, not shelved into rows. Shelving — starting every
    // wrapped panel below the TALLEST one before it — leaves a hole: expanding
    // the clicker pushed a collapsed Darts panel most of a screen down, past
    // the empty space under the Suite panel where it plainly belonged.
    //
    // So panels run along the dock's edge until the viewport is used up, and
    // that fixes a set of lanes: columns for a top dock, rows for a left one.
    // Everything after goes into whichever lane is currently SHALLOWEST, so a
    // short panel fills the gap beside a short neighbour instead of clearing
    // the tall one. Lanes are disjoint along the edge, so nothing can overlap
    // however the depths fall.
    const lim  = vert ? window.innerHeight - DOCK_EDGE : window.innerWidth - DOCK_EDGE;
    const lanes = [];            // { pos, size, edge } along / across / depth used
    let cursor = DOCK_EDGE;
    for (const { ui } of list) {
      if (ui.cfg.hidden) continue;        // hidden panels are a nub, not a slot
      const p = ui.panel;
      p.style.right = 'auto';
      // Measured before placing: style.width pins the width, so the height does
      // not depend on where it lands, and the lane has to be chosen first.
      const r = p.getBoundingClientRect();
      const along = vert ? r.height : r.width;    // extent along the dock edge
      const deep  = vert ? r.width  : r.height;   // extent away from it
      let lane;
      if (cursor + along <= lim || !lanes.length) {
        // Room for another lane — or this is the first panel, which opens one
        // even if it is bigger than the viewport, because there is nowhere else.
        lane = { pos: cursor, size: along, edge: DOCK_EDGE };
        lanes.push(lane);
        cursor += along + DOCK_GAP;
      } else {
        // Prefer the shallowest lane this actually FITS in; panels differ by up
        // to ~30px and one placed in a narrower lane would hang over its
        // neighbour. Fall back to the shallowest overall if none is wide enough.
        const fits = lanes.filter(l => l.size >= along);
        const pool = fits.length ? fits : lanes;
        lane = pool.reduce((m, l) => (l.edge < m.edge ? l : m), pool[0]);
      }
      p.style.left = (vert ? lane.edge : lane.pos) + 'px';
      p.style.top  = (vert ? lane.pos  : lane.edge) + 'px';
      lane.edge += deep + DOCK_GAP;
    }
  }

  // The hub owns the layout controls, but a drag out of a dock has to change
  // the layout from inside makePanel. This is the seam between the two.
  let onLayoutChange = () => {};
  // Solo has to be an invariant, not just something the collapse button does.
  // Arriving in a dock with four helpers already open gives a column that needs
  // two of them to fit — which is the exact thing the dock is for avoiding. So
  // entering a docked layout closes all but the first open helper.
  function enforceSolo() {
    if (!suite.solo || suite.layout === 'free') return;
    let kept = false;
    const list = docks.slice().sort((a, b) => (a.def.dockOrder ?? 99) - (b.def.dockOrder ?? 99));
    for (const d of list) {
      if (!d.def.helper || d.ui.cfg.collapsed) continue;
      if (!kept) { kept = true; continue; }      // the first open one stays open
      d.ui.cfg.collapsed = true; d.ui.save(); d.ui.chrome();
    }
  }
  function syncLayout() { enforceSolo(); relayout(); onLayoutChange(); }

  // Collapsing a panel changes every panel below it, so the re-stack is
  // coalesced to one pass per frame rather than run per panel per change.
  function relayoutSoon() {
    if (relayoutPending) return;
    relayoutPending = true;
    requestAnimationFrame(() => { relayoutPending = false; relayout(); });
  }
  window.addEventListener('resize', relayoutSoon);

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
      /* A setting that changes how the game itself behaves, not just what the
         panel draws. It is bright so nobody forgets it is doing that. */
      .loud { color:#ff3b3b; font-weight:700; }
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
      relayoutSoon();               // heights and occupancy just changed
    }

    // drag
    let dx = 0, dy = 0, drag = false;
    $('#hd').addEventListener('mousedown', e => {
      if (e.target.id === 'min') return;
      // Dragging out of a dock means you want it somewhere else, so the dock
      // gets out of the way rather than snapping the panel back and looking
      // broken. "Reset panel layout" puts it back.
      if (suite.layout !== 'free') { suite.layout = 'free'; saveSuite(); syncLayout(); }
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
      place,                   // so a dock can hand positions back on the way out
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
        const i = docks.findIndex(d => d.ui === ui);
        if (i >= 0) docks.splice(i, 1);
        relayoutSoon();
      }
    };

    docks.push({ def, ui });
    minBtn.addEventListener('click', () => {
      cfg.collapsed = !cfg.collapsed;
      ui.save();
      // Solo closes the other HELPERS when you open one — not the clicker,
      // which is useful alongside any of them, and not the suite panel. Only
      // while docked: in the free layout the panels are wherever you put them
      // and collapsing one you never touched would just look like a bug.
      if (!cfg.collapsed && suite.solo && suite.layout !== 'free' && def.helper) {
        for (const d of docks) {
          if (d.ui === ui || !d.def.helper || d.ui.cfg.collapsed) continue;
          d.ui.cfg.collapsed = true; d.ui.save(); d.ui.chrome();
        }
      }
      chrome();
    });
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
