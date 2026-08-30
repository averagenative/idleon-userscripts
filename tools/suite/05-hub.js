
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
      // Each row: the helper's name, its toggle hotkey, an eye that shows or
      // hides that panel, and the tickbox that runs it at all. The eye is here
      // because a hidden panel leaves only a 13px nub on screen to click, and
      // nothing says which nub is which — so "where did my darts panel go" had
      // no answer you could find by looking.
      MODULES.map(m =>
        `<div class="row"><label>${m.short}</label>` +
        `<span><span class="hint">${m.keyHint}</span> ` +
        `<button class="eye" id="eye-${m.id}" data-m="${m.id}">\u25cf</button> ` +
        `<input id="en-${m.id}" type="checkbox"></span></div>`
      ).join('\n        ') + `
        <hr>
        <button class="btn sm" id="panels">Hide all panels</button>
        <button class="btn sm" id="reset">Reset panel layout</button>
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
      for (const m of MODULES) {
        hub.$('#en-' + m.id).checked = !!suite.enabled[m.id];
        const eye = hub.$('#eye-' + m.id), off = !live.has(m.id);
        eye.textContent = m.cfg.hidden ? '\u25cb' : '\u25cf';
        eye.title = m.cfg.hidden ? 'Show the ' + m.short + ' panel' : 'Hide the ' + m.short + ' panel';
        eye.className = 'eye' + (off ? ' off' : '');
      }
      hub.$('#panels').textContent = anyShown() ? 'Hide all panels' : 'Show all panels';
      hub.chrome();
    }

    for (const m of MODULES) {
      hub.$('#en-' + m.id).onchange = e => { setEnabled(m, e.target.checked); syncHub(); };
      hub.$('#eye-' + m.id).onclick = () => {
        m.cfg.hidden = !m.cfg.hidden; m.save();
        const inst = live.get(m.id);
        if (inst) inst.ui.chrome();
        syncHub();
      };
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

    // Puts every panel back in its default slot, unhidden and unrolled —
    // including the ones that are switched off, whose stored position would
    // otherwise still be off-screen next time they are switched back on.
    hub.$('#reset').onclick = () => {
      for (const m of MODULES) {
        const inst = live.get(m.id);
        if (inst) inst.ui.reset();
        else { m.cfg.px = null; m.cfg.py = null; m.cfg.hidden = false; m.cfg.collapsed = false; m.save(); }
      }
      hub.reset();
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
