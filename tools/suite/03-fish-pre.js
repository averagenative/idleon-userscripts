
  // =====================================================================
  //  Helper — Fishing
  //  Landing prediction for a cast, plus fish and hazard markers.
  // =====================================================================
  const fishing = store('fish_cfg', {
/*__DEFAULTS__*/
  }, cfg => {
/*__MIGRATE__*/
  });

  const FISHING = {
    id: 'fishing', name: 'Fishing Helper', short: 'Fishing',
    z: 2147483644,
    theme: { dot: '#38bdf8', ac: '#0284c7' },
    slot: { top: 12, left: 460, width: 214, nub: 60 },
    dockOrder: 3,  helper: true,
    overlay: true,
    hotkeys: { F4: 'toggle', F3: 'hide' },
    keyHint: 'F4',
    cfg: fishing.cfg, save: fishing.save,
    bodyHTML: `
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
        <div class="hint">F4 on/off · F3 hide panel</div>`,

    init(ui) {
      const cfg = fishing.cfg, save = fishing.save, saveSoon = fishing.saveSoon;
      const $ = ui.$, root = ui.root, ov = ui.ov, octx = ui.octx,
            runBtn = ui.runBtn, dot = ui.dot, stEl = ui.stEl;

      function sync() {
        $('#aim').checked = cfg.aim; $('#marks').checked = cfg.marks;
        $('#ink').checked = cfg.ink;
        $('#arcx').checked = cfg.arc; $('#ruler').checked = cfg.ruler;
        $('#bob').checked = cfg.bob;
        $('#debug').checked = cfg.debug; $('#lead').value = cfg.lead | 0;
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
