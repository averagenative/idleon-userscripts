// ==UserScript==
// @name         IdleOn Clicker
// @namespace    nativerobot
// @version      3.0
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
    interval: 800,     // ms between clicks
    jitterMs: 40,      // +/- timing jitter (0 = exact)
    jitterPx: 2,       // +/- position jitter in px (0 = pixel-perfect)
    mode: 'cursor',    // 'cursor' | 'fixed'
    fx: 0, fy: 0,      // fixed target
    hidden: false
  }, JSON.parse(localStorage.getItem(KEY) || '{}'));
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));

  // ---------- state ----------
  let on = false, timer = null, capturing = false;
  let lastX = 0, lastY = 0;
  document.addEventListener('mousemove', e => { lastX = e.clientX; lastY = e.clientY; }, true);

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
    </style>
    <div id="p">
      <div id="hd"><span><span id="dot"></span> <b>IdleOn Clicker</b></span><span id="min">–</span></div>
      <div class="body">
        <button class="btn go" id="run">Start  (F8)</button>
        <div class="row"><label>Interval</label><span><input id="iv" type="number" min="20" step="10"> ms</span></div>
        <div class="row"><label>Timing jitter</label><span><input id="jm" type="number" min="0" step="5"> ms</span></div>
        <div class="row"><label>Pos jitter</label><span><input id="jp" type="number" min="0" step="1"> px</span></div>
        <div class="row"><label>Target</label>
          <div class="seg"><button data-m="cursor">Cursor</button><button data-m="fixed">Fixed</button></div>
        </div>
        <button class="btn arm" id="set">Set Position</button>
        <div class="row"><label>XY</label><span id="xy">—</span></div>
        <div class="hint">F8 toggle · F9 panic-off · F10 hide</div>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  const dot = $('#dot'), runBtn = $('#run'), ivEl = $('#iv'), jmEl = $('#jm'),
        jpEl = $('#jp'), xyEl = $('#xy'), setBtn = $('#set'), panel = $('#p');

  // ---------- UI sync ----------
  function sync() {
    ivEl.value = cfg.interval; jmEl.value = cfg.jitterMs; jpEl.value = cfg.jitterPx;
    root.querySelectorAll('.seg button').forEach(b => b.classList.toggle('sel', b.dataset.m === cfg.mode));
    xyEl.textContent = cfg.mode === 'fixed' ? `${cfg.fx || '—'}, ${cfg.fy || '—'}` : '(follows cursor)';
    dot.classList.toggle('on', on);
    runBtn.textContent = on ? 'Stop  (F8)' : 'Start  (F8)';
    runBtn.className = 'btn ' + (on ? 'stop' : 'go');
    setBtn.textContent = capturing ? 'Click a spot…' : 'Set Position';
    host.style.display = cfg.hidden ? 'none' : '';
  }

  // ---------- clicking ----------
  const rand = j => j ? (Math.random() * 2 - 1) * j : 0;

  function clickAt(x, y) {
    x = Math.round(x + rand(cfg.jitterPx));
    y = Math.round(y + rand(cfg.jitterPx));
    const el = document.elementFromPoint(x, y) || document.querySelector('canvas');
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
    const [tx, ty] = cfg.mode === 'fixed' ? [cfg.fx, cfg.fy] : [lastX, lastY];
    clickAt(tx, ty);
    timer = setTimeout(tick, Math.max(20, cfg.interval + rand(cfg.jitterMs)));
  }

  function start() { if (!on) { on = true; sync(); tick(); } }
  function stop()  { on = false; clearTimeout(timer); sync(); }
  function toggle(){ on ? stop() : start(); }

  // ---------- position capture ----------
  function armCapture() {
    capturing = true; sync();
    const grab = e => {
      e.preventDefault(); e.stopPropagation();
      cfg.fx = e.clientX; cfg.fy = e.clientY; cfg.mode = 'fixed';
      capturing = false; save(); sync();
      window.removeEventListener('mousedown', grab, true);
    };
    window.addEventListener('mousedown', grab, true);
  }

  // ---------- wiring ----------
  runBtn.onclick = toggle;
  setBtn.onclick = () => capturing ? null : armCapture();
  ivEl.onchange = e => { cfg.interval = Math.max(20, +e.target.value); save(); };
  jmEl.onchange = e => { cfg.jitterMs = Math.max(0, +e.target.value); save(); };
  jpEl.onchange = e => { cfg.jitterPx = Math.max(0, +e.target.value); save(); };
  root.querySelectorAll('.seg button').forEach(b => b.onclick = () => { cfg.mode = b.dataset.m; save(); sync(); });
  $('#min').onclick = () => { cfg.hidden = true; save(); sync(); };

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
    window.addEventListener('mouseup', () => drag = false);
  })();

  // hotkeys (capture phase; ignore while typing in our own fields)
  window.addEventListener('keydown', e => {
    if (root.activeElement && root.activeElement.tagName === 'INPUT') return;
    if (e.key === 'F8')  { e.preventDefault(); toggle(); }
    if (e.key === 'F9')  { e.preventDefault(); stop(); }            // panic off
    if (e.key === 'F10') { e.preventDefault(); cfg.hidden = !cfg.hidden; save(); sync(); }
  }, true);

  sync();
})();
