
  // =====================================================================
  //  Helper — Clicker
  //  Stealthy autoclicker. The only helper that reads no pixels and needs no
  //  animation frame; it runs on its own randomised setTimeout.
  // =====================================================================
  const clicker = store('ac_cfg', {
/*__DEFAULTS__*/
  }, cfg => {
/*__MIGRATE__*/
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

/*__CLICKCORE__*/

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
