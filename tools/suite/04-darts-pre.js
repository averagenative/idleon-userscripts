
  // =====================================================================
  //  Helper — Throwy Darts
  //  Predicted dart path and the band it lands in, wind included.
  // =====================================================================
  const darts = store('darts_cfg', {
/*__DEFAULTS__*/
  }, cfg => {
/*__MIGRATE__*/
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
