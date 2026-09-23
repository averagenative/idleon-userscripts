
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
    dockOrder: 1,
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
        <div class="row"><label>Unfocused</label>
          <div class="seg"><button data-a="1">Run</button><button data-a="0">Pause</button></div>
        </div>
        <div class="hint">F8 toggle · F9 panic-off · F10 hide</div>`,

    init(ui) {
      const cfg = clicker.cfg, save = clicker.save;
      const $ = ui.$, root = ui.root, runBtn = ui.runBtn, dot = ui.dot;
      const ivMinEl = $('#ivmin'), ivMaxEl = $('#ivmax'), jpEl = $('#jp'),
            xyEl = $('#xy'), setBtn = $('#set');

      let on = false, timer = null, capturing = false;
      // lastX/lastY only move while the pointer is over THIS window, so in a
      // second window they go stale on the way out and are 0,0 before it has
      // ever arrived. See the standalone clicker for the whole story; ptrIn is
      // what says whether the coordinates mean anything.
      let lastX = 0, lastY = 0, ptrIn = false, wasBlind = false;
      ui.on(document, 'mousemove', e => {
        lastX = e.clientX; lastY = e.clientY; ptrIn = true;
      }, true);
      // A null relatedTarget is the pointer leaving the document altogether;
      // leaving for a panel names that element instead and does not count.
      ui.on(document, 'mouseout', e => { if (!e.relatedTarget) ptrIn = false; }, true);

      // Swallow the window blur / visibilitychange that makes the game pause
      // itself on alt-tab. See "keep the game awake" in the standalone clicker
      // for what the game does with them and what this cannot fix. Registered
      // through ui.on so that switching the clicker off takes it away too.
      const swallowFocusLoss = e => {
        if (cfg.awake && (e.target === window || e.target === document)) e.stopImmediatePropagation();
      };
      ui.on(window, 'blur', swallowFocusLoss, true);
      ui.on(window, 'visibilitychange', swallowFocusLoss, true);

      function sync() {
        ivMinEl.value = cfg.ivMin; ivMaxEl.value = cfg.ivMax; jpEl.value = cfg.jitterPx;
        root.querySelectorAll('.seg button[data-m]').forEach(b => b.classList.toggle('sel', b.dataset.m === cfg.mode));
        root.querySelectorAll('.seg button[data-a]').forEach(b => b.classList.toggle('sel', b.dataset.a === (cfg.awake ? '1' : '0')));
        xyEl.textContent = cfg.mode !== 'fixed'
          ? (ptrIn ? '(follows cursor)' : 'cursor is in another window')
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
      root.querySelectorAll('.seg button[data-m]').forEach(b => b.onclick = () => { cfg.mode = b.dataset.m; save(); sync(); });
      root.querySelectorAll('.seg button[data-a]').forEach(b => b.onclick = () => { cfg.awake = b.dataset.a === '1'; save(); sync(); });

      // panic stops the clicker outright; switching the helper off has to as
      // well, or a torn-down panel leaves a timer clicking with no way to see it.
      return { sync, toggle, panic: stop, destroy: stop };
    }
  };
