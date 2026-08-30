
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
      MODULES.map(m =>
        `<div class="row"><label>${m.short}</label>` +
        `<span><span class="hint">${m.keyHint}</span> <input id="en-${m.id}" type="checkbox"></span></div>`
      ).join('\n        ') + `
        <hr>
        <button class="btn sm" id="panels">Hide all panels</button>
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
      for (const m of MODULES) hub.$('#en-' + m.id).checked = !!suite.enabled[m.id];
      hub.$('#panels').textContent = anyShown() ? 'Hide all panels' : 'Show all panels';
      hub.chrome();
    }

    for (const m of MODULES) {
      hub.$('#en-' + m.id).onchange = e => { setEnabled(m, e.target.checked); syncHub(); };
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
