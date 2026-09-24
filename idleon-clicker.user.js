// ==UserScript==
// @name         IdleOn Clicker
// @namespace    nativerobot
// @version      3.9
// @downloadURL https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-clicker.user.js
// @updateURL   https://raw.githubusercontent.com/averagenative/idleon-userscripts/main/idleon-clicker.user.js
// @description  Stealthy in-page autoclicker panel for Legends of IdleOn (browser)
// @match        https://www.legendsofidleon.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ---------- persistence ----------
  const KEY = 'ac_cfg';
  const cfg = Object.assign({
    ivMin: 600,        // ms — lower bound of click interval
    ivMax: 1200,       // ms — upper bound; each click picks uniformly in [min, max]
    jitterPx: 2,       // +/- position jitter in px (0 = pixel-perfect)
    mode: 'cursor',    // 'cursor' | 'fixed'
    awake: true,       // keep the game running while the window is unfocused
    skKeys: [],        // skill-bar keys (1-9) pressed while clicking; empty = off
    skSec: 30,         // seconds between skill presses
    fx: 0, fy: 0,      // fixed target, viewport px (legacy / no-canvas fallback)
    fu: null, fv: null,// fixed target as a fraction of the game canvas rect
    collapsed: false,  // rolled up to just the title bar
    hidden: false,
    px: null, py: null // dragged panel position, viewport px
  }, JSON.parse(localStorage.getItem(KEY) || '{}'));
  // migrate old base+jitter config -> min/max range
  if (cfg.ivMin === undefined && cfg.interval !== undefined) {
    const j = cfg.jitterMs || 0;
    cfg.ivMin = Math.max(20, cfg.interval - j);
    cfg.ivMax = cfg.interval + j;
  }
  delete cfg.interval; delete cfg.jitterMs;
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));

  // ---------- state ----------
  let on = false, timer = null, skTimer = null, capturing = false;
  // lastX/lastY only move while the pointer is over THIS window. In a second
  // window — side by side, or simply not the one being pointed at — they go
  // stale the moment it leaves, and they are 0,0 before it has ever arrived.
  // Cursor mode would then click the top-left corner of the game forever,
  // silently, which is not a harmless no-op: a click on bare ground is a walk
  // command, so the character strolls off. ptrIn is what says whether the
  // coordinates mean anything.
  let lastX = 0, lastY = 0, ptrIn = false, wasBlind = false;
  document.addEventListener('mousemove', e => {
    lastX = e.clientX; lastY = e.clientY; ptrIn = true;
  }, true);
  // mouseout with a null relatedTarget is the pointer leaving the document
  // altogether; leaving for the panel, or for any other element, names that
  // element instead and does not count.
  document.addEventListener('mouseout', e => {
    if (!e.relatedTarget) ptrIn = false;
  }, true);

  // ---------- keep the game awake ----------
  // Firefox (on Wayland at least) stops handing out animation frames when the
  // game's window is covered, and IdleOn only moves forward on a frame. That
  // alone would just pause it, but Stencyl's onUpdate (N.js, read 2026-09-23)
  // credits at most 200 ms per frame, `200<=b&&(b=200)`, so a gap is not caught
  // up afterwards: it is lost. Measured on the live game, 2026-09-23: over
  // 78 s alt-tabbed away, frames stopped for 10.8 s, 18.8 s, 1.4 s and 0.9 s.
  // That is about 45% of the time gone, and only the ore mined in the
  // foreground was there on return.
  //
  // Suppressing the game's blur and visibilitychange handlers, as 3.7 did, has
  // no effect on this. Those set Stencyl's inFocus flag, and nothing reads it.
  //
  // So requestAnimationFrame is wrapped. Callbacks queue here and go out on
  // the next real frame as usual. Separately, a worker ticks every 40 ms, and
  // if no frame has come for 60 ms the queue is run from that tick instead.
  // A worker, because Firefox slows a hidden page's own timers to one a second,
  // which would still lose 4/5 of every second to the 200 ms cap. Its timers
  // it leaves alone: same session, 172 s away, worker ticks were never more
  // than 216 ms apart, the longest gap between game updates was 196 ms, and
  // the ore came back at full rate (600+ in under 3 minutes).
  //
  // Lime looks up window.requestAnimationFrame again on every frame, so this
  // works even when the wrap lands after the game has started. With `isOn()`
  // false only the real frames run, which is plain requestAnimationFrame.
  function keepGameAwake(isOn) {
    const nativeRAF = window.requestAnimationFrame.bind(window);
    let pending = new Map(), nextId = 1, armed = false, last = performance.now();
    const flush = t => {
      last = performance.now();
      const run = pending; pending = new Map();
      for (const cb of run.values()) {
        try { cb(t); } catch (e) { setTimeout(() => { throw e; }); }
      }
    };
    window.requestAnimationFrame = cb => {
      const id = nextId++;
      pending.set(id, cb);
      if (!armed) { armed = true; nativeRAF(t => { armed = false; flush(t); }); }
      return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); };
    const beat = new Worker(URL.createObjectURL(
      new Blob(['setInterval(() => postMessage(0), 40)'], { type: 'text/javascript' })));
    beat.onmessage = () => {
      const now = performance.now();
      if (isOn() && pending.size && now - last > 60) flush(now);
    };
  }
  keepGameAwake(() => cfg.awake);

  // ---------- stealth UI host (closed shadow DOM, hidden from page JS) ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  const mount = () => document.documentElement.appendChild(host);
  mount();

  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 12px/1.4 monospace; }
      #p { position: fixed; top: 12px; right: 12px; width: 210px;
           background: #14171c; color: #cdd3da; border: 1px solid #2a2f37;
           border-radius: 8px; pointer-events: auto; user-select: none;
           box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      #hd { display:flex; align-items:center; justify-content:space-between;
            padding: 7px 9px; cursor: move; background:#1b1f26; border-radius:8px 8px 0 0; }
      #hd b { color:#8b95a3; font-weight:600; letter-spacing:.3px; }
      #dot { width:9px; height:9px; border-radius:50%; background:#4b5563; display:inline-block; }
      #dot.on { background:#4ade80; box-shadow:0 0 8px #4ade80; }
      .body { padding: 9px; display:flex; flex-direction:column; gap:8px; }
      .row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      label { color:#8b95a3; }
      input[type=number] { width:62px; background:#0c0e12; color:#4ade80;
            border:1px solid #2a2f37; border-radius:4px; padding:2px 4px; }
      .seg { display:flex; border:1px solid #2a2f37; border-radius:5px; overflow:hidden; }
      .seg button { background:#0c0e12; color:#8b95a3; border:0; padding:3px 9px; cursor:pointer; }
      .seg button.sel { background:#2563eb; color:#fff; }
      .btn { width:100%; padding:6px; border:0; border-radius:5px; cursor:pointer;
             background:#2a2f37; color:#cdd3da; }
      .btn.go { background:#16a34a; color:#fff; }
      .btn.stop { background:#dc2626; color:#fff; }
      .btn.arm { background:#a16207; color:#fff; }
      #xy { color:#6b7280; }
      .hint { color:#4b5563; font-size:11px; text-align:center; }
      #min { cursor:pointer; color:#6b7280; padding:0 4px; }
      /* When the panel is fully hidden this dot is the way back — F10 is
         claimed by the browser's menu bar, so a hotkey alone can strand it. */
      #nub { position: fixed; top: 6px; right: 6px; width: 13px; height: 13px;
             border-radius: 50%; background: #2563eb; opacity: .55; cursor: pointer;
             pointer-events: auto; display: none; }
      #nub:hover { opacity: 1; }
    </style>
    <div id="nub" title="Show IdleOn Clicker"></div>
    <div id="p">
      <div id="hd"><span><span id="dot"></span> <b>IdleOn Clicker</b></span><span id="min">–</span></div>
      <div class="body">
        <button class="btn go" id="run">Start  (F8)</button>
        <div class="row"><label>Interval min</label><span><input id="ivmin" type="number" min="20" step="10"> ms</span></div>
        <div class="row"><label>Interval max</label><span><input id="ivmax" type="number" min="20" step="10"> ms</span></div>
        <div class="row"><label>Pos jitter</label><span><input id="jp" type="number" min="0" step="1"> px</span></div>
        <div class="row"><label>Target</label>
          <div class="seg"><button data-m="cursor">Cursor</button><button data-m="fixed">Fixed</button></div>
        </div>
        <button class="btn arm" id="set">Set Position</button>
        <div class="row"><label>XY</label><span id="xy">—</span></div>
        <div class="row"><label>Skills</label><span><input id="sks" type="number" min="1" step="1"> s</span></div>
        <div class="seg" id="skk">${[1,2,3,4,5,6,7,8,9].map(k => `<button data-k="${k}" style="flex:1;padding:3px 0">${k}</button>`).join('')}</div>
        <div class="row"><label>Unfocused</label>
          <div class="seg"><button data-a="1">Run</button><button data-a="0">Pause</button></div>
        </div>
        <div class="hint">F8 toggle · F9 panic-off · F10 hide</div>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  const dot = $('#dot'), runBtn = $('#run'), ivMinEl = $('#ivmin'), ivMaxEl = $('#ivmax'),
        jpEl = $('#jp'), xyEl = $('#xy'), setBtn = $('#set'), panel = $('#p'),
        nub = $('#nub'), body = $('.body'), minBtn = $('#min'), sksEl = $('#sks');

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

  // ---------- UI sync ----------
  function sync() {
    ivMinEl.value = cfg.ivMin; ivMaxEl.value = cfg.ivMax; jpEl.value = cfg.jitterPx;
    root.querySelectorAll('.seg button[data-m]').forEach(b => b.classList.toggle('sel', b.dataset.m === cfg.mode));
    sksEl.value = cfg.skSec;
    root.querySelectorAll('.seg button[data-k]').forEach(b => b.classList.toggle('sel', cfg.skKeys.includes(+b.dataset.k)));
    root.querySelectorAll('.seg button[data-a]').forEach(b => b.classList.toggle('sel', b.dataset.a === (cfg.awake ? '1' : '0')));
    xyEl.textContent = cfg.mode !== 'fixed'
      ? (ptrIn ? '(follows cursor)' : 'cursor is in another window')
      : hasTarget() ? fixedPoint().map(Math.round).join(', ') : 'not set';
    dot.classList.toggle('on', on);
    runBtn.textContent = on ? 'Stop  (F8)' : 'Start  (F8)';
    runBtn.className = 'btn ' + (on ? 'stop' : 'go');
    setBtn.textContent = capturing ? 'Click a spot…' : 'Set Position';
    body.style.display = cfg.collapsed ? 'none' : '';
    minBtn.textContent = cfg.collapsed ? '+' : '–';
    panel.style.display = cfg.hidden ? 'none' : '';
    nub.style.display = cfg.hidden ? '' : 'none';
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
    // Cursor mode with the pointer in another window has nothing to aim at, so
    // it holds rather than clicking a stale coordinate. The timer keeps running
    // and it resumes by itself when the pointer comes back. Announced, because
    // the failure is otherwise invisible: the clicker looks like it is running
    // and the game just never responds.
    const blind = cfg.mode !== 'fixed' && !ptrIn;
    if (blind !== wasBlind) { wasBlind = blind; sync(); }
    // Resolved every tick: the canvas rect can change under a running clicker.
    if (!blind && (cfg.mode !== 'fixed' || hasTarget())) {
      const [tx, ty] = cfg.mode === 'fixed' ? fixedPoint() : [lastX, lastY];
      clickAt(tx, ty);
    }
    const lo = Math.min(cfg.ivMin, cfg.ivMax), hi = Math.max(cfg.ivMin, cfg.ivMax);
    timer = setTimeout(tick, Math.max(20, lo + Math.random() * (hi - lo)));
  }

  // Skill-bar keys, pressed on their own timer alongside the clicks. The game
  // is Lime/Stencyl: its only key listener is on window, and it reads the key
  // from `keyCode` (N.js handleKeyEvent, read 2026-09-24) — which a synthetic
  // KeyboardEvent leaves at 0 whatever the init dict says, so it is defined on
  // the event instead. Down and up are held apart for 60-140 ms because
  // Stencyl turns keydown into a per-frame "pressed" flag; a press and release
  // inside one frame gap can be cleared before any skill code looks at it.
  // Several keys are staggered a quarter-second or so apart for the same
  // reason, and so they do not land as one impossible chord. Pressing a skill
  // that is still on cooldown does nothing, so an interval a little over the
  // longest cooldown is the setting to use.
  function pressKey(k) {
    const code = 48 + k;
    const send = type => {
      const e = new KeyboardEvent(type, { key: String(k), code: 'Digit' + k, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => code });
      Object.defineProperty(e, 'which',   { get: () => code });
      window.dispatchEvent(e);
    };
    send('keydown');
    setTimeout(() => send('keyup'), 60 + Math.random() * 80);
  }

  function skillTick() {
    if (!on || !cfg.skKeys.length) return;
    let t = 0;
    for (const k of cfg.skKeys) {
      setTimeout(() => { if (on) pressKey(k); }, t);
      t += 200 + Math.random() * 250;
    }
    // +0-10%, never early: late only costs a moment of cooldown, and a fixed
    // period is the most machine-like thing a clicker could do.
    skTimer = setTimeout(skillTick, Math.max(1, cfg.skSec) * 1000 * (1 + Math.random() * 0.1));
  }
  function skillRearm() { clearTimeout(skTimer); if (on) skillTick(); }

  function start() { if (!on) { on = true; sync(); tick(); skillTick(); } }
  function stop()  { on = false; clearTimeout(timer); clearTimeout(skTimer); sync(); }
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
    window.addEventListener('mousedown', grab, true);
  }

  // ---------- wiring ----------
  runBtn.onclick = toggle;
  setBtn.onclick = () => capturing ? null : armCapture();
  ivMinEl.onchange = e => { cfg.ivMin = Math.max(20, +e.target.value); save(); };
  ivMaxEl.onchange = e => { cfg.ivMax = Math.max(20, +e.target.value); save(); };
  jpEl.onchange = e => { cfg.jitterPx = Math.max(0, +e.target.value); save(); };
  root.querySelectorAll('.seg button[data-m]').forEach(b => b.onclick = () => { cfg.mode = b.dataset.m; save(); sync(); });
  sksEl.onchange = e => { cfg.skSec = Math.max(1, +e.target.value || 1); save(); skillRearm(); };
  root.querySelectorAll('.seg button[data-k]').forEach(b => b.onclick = () => {
    const k = +b.dataset.k;
    cfg.skKeys = cfg.skKeys.includes(k) ? cfg.skKeys.filter(x => x !== k) : [...cfg.skKeys, k].sort();
    save(); sync(); skillRearm();
  });
  root.querySelectorAll('.seg button[data-a]').forEach(b => b.onclick = () => { cfg.awake = b.dataset.a === '1'; save(); sync(); });
  // Roll the panel up rather than hiding it outright — the title bar stays on
  // screen so it can always be clicked open again.
  minBtn.onclick = () => { cfg.collapsed = !cfg.collapsed; save(); sync(); };
  nub.onclick = () => { cfg.hidden = false; save(); sync(); };

  // drag
  (() => {
    let dx, dy, drag = false;
    $('#hd').addEventListener('mousedown', e => {
      if (e.target.id === 'min') return;
      drag = true; const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      panel.style.right = 'auto';
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top  = (e.clientY - dy) + 'px';
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
  // button was touched last.
  root.querySelectorAll('button').forEach(el => {
    el.setAttribute('tabindex', '-1');
    el.addEventListener('mouseup', () => el.blur());
  });
  root.querySelectorAll('input').forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') el.blur();
  }));

  // hotkeys (capture phase). These fire even while a number input holds focus:
  // a function key is never typed into a field, and the game canvas swallows
  // the mousedown that would otherwise blur it — so a field left focused used
  // to strand F8/F9/F10 with no way back except the mouse. Whatever is focused
  // is blurred on the way through, which also commits a half-typed value.
  window.addEventListener('keydown', e => {
    if (e.key !== 'F8' && e.key !== 'F9' && e.key !== 'F10') return;
    e.preventDefault();
    if (root.activeElement) root.activeElement.blur();
    if (e.key === 'F8')  toggle();
    if (e.key === 'F9')  stop();                                    // panic off
    if (e.key === 'F10') { cfg.hidden = !cfg.hidden; save(); sync(); }
  }, true);

  sync();
})();
