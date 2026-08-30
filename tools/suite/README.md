# Building `idleon-suite.user.js`

    python3 tools/suite/build.py

The suite is **generated**, not maintained by hand. Everything that makes a
helper work — its config defaults and migration, its detection, physics and
drawing code, and its control wiring — is lifted verbatim out of the standalone
script, so a fix there reaches the suite by re-running the build. Edit the
standalone script, never `idleon-suite.user.js`.

What *is* hand-written lives in the `0*-*.js` parts here:

| part | what it holds |
|---|---|
| `00-head.js` | the suite core: the WebGL readback patch, the shared game-canvas lookup and frame grab, `solve3`, the panel factory, the single animation frame, the hotkey table, and start/stop for a helper |
| `01-clicker.js` … `04-darts-*.js` | per-helper: the panel body HTML, `sync()`, and the descriptor (theme, slot, hotkeys) |
| `05-hub.js` | the Suite switchboard panel and boot |

Placeholders (`/*__DEFAULTS__*/`, `/*__MIGRATE__*/`, `/*__CLICKCORE__*/`) are
filled from the standalone scripts. Region boundaries are matched on **marker
text**, never line numbers, so an edit upstream cannot silently shift a cut —
a missing marker fails the build instead.
