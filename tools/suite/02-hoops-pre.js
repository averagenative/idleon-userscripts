
  // =====================================================================
  //  Helper — Swishy Hoops
  //  Dotted-line shot preview + live ball arc.
  // =====================================================================
  const hoops = store('hoops_cfg', {
/*__DEFAULTS__*/
  }, cfg => {
/*__MIGRATE__*/
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
