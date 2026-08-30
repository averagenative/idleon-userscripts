# AGENTS.md

Userscripts that draw over the browser version of Legends of IdleOn. Everything
here is plain ES2020 in a single-file IIFE — no build step for the helpers, no
dependencies, no package.json.

## Layout

| | |
|---|---|
| `idleon-clicker.user.js` | autoclicker. The only one that sends input |
| `idleon-hoops.user.js` | Swishy Hoops shot preview |
| `idleon-fishing.user.js` | fishing cast landing prediction |
| `idleon-darts.user.js` | Throwy Darts aim path |
| `idleon-suite.user.js` | **generated** — all four in one install |
| `tools/suite/` | the generator, and the hand-written shell it wraps them in |
| `tools/replay/` | replay a screen recording through a helper, in Node |
| `tools/chrome/` | read a live session over the DevTools Protocol |

## The rules that matter

**Never edit `idleon-suite.user.js`.** It is generated. Edit the standalone
script and run `python3 tools/suite/build.py`. The build lifts each helper's
config, migration, detection, physics and wiring verbatim out of the standalone
file, matching on **marker text** — so if you delete or reword a section
comment like `// ---------- wiring ----------`, the build fails loudly rather
than cutting in the wrong place. That is the intended behaviour; fix the marker
or fix the build, do not work around it.

**Bump `@version` when you change a script.** Tampermonkey uses it to offer
updates. The suite has its own version in `tools/suite/00-head.js`.

**Bump `calVer` when a change invalidates learned calibration**, and reset the
seeds in the same commit. Every helper stores samples it has learned from your
own play; if the thing they were measured through changes, they are worse than
useless. `calVer` is the mechanism that throws them away on upgrade.

**Measure, do not guess.** Every constant in these files — colour windows,
gravity, wind strength, the power-to-distance map — came off recorded footage,
and the comment beside it says what was measured and how far off it was. Keep
that up. A number with no provenance is a number nobody can fix later.

## Verifying a change

There is no test runner. In order of what actually catches things:

    node --check idleon-*.user.js                  # syntax
    python3 tools/suite/build.py                   # and check git diff is only what you meant
    node tools/replay/replay.js --video clip.mp4 --script idleon-fishing.user.js \
         --pick meter.top,meter.total,meter.frac   # the real code, on real frames

The replay harness is the one to reach for when a value looks wrong. It runs
the actual userscript against a screen recording — no reimplementation, so
there is nothing to keep in sync and nothing to be wrong about separately. See
`tools/replay/README.md`. Do not re-derive a detection routine in another
language to check it; that debugs the port instead of the helper.

## Conventions

- **Comments say why, at length, and name the failure they prevent.** This
  codebase is mostly thresholds and constants, and the reason a number is 0.42
  is not recoverable from the number. Existing comments carry measurements,
  counts of frames checked, and what the previous value got wrong — match that.
- **Section headers are `// ---------- name ----------`** and the suite build
  cuts on them. Do not rename casually.
- Config lives in `localStorage` under one key per helper (`ac_cfg`,
  `hoops_cfg`, `fish_cfg`, `darts_cfg`). The suite reuses the same keys, so
  either version can be run without disturbing the other's settings.
- Panels live in a **closed shadow DOM** so the page cannot see them.
- No panel control keeps keyboard focus — the minigames are played with the
  keyboard, and a focused button re-fires on the next Space. Controls are out
  of the tab order, blur on release, and ignore keyboard-synthesised clicks.
- The helpers **only draw**. If you are adding something to a helper that
  sends input to the game, it belongs in the clicker instead, and the README's
  claim needs to change with it.

## Things that will bite you

- **`preserveDrawingBuffer`.** The helpers patch `getContext` at
  `document-start` because a WebGL drawing buffer reads back blank otherwise,
  and contexts are cached per canvas — so the patch has to land before the game
  makes its own. This is why they are not `document-idle`.
- **Calibration is stored as fractions of canvas size**, never pixels. The game
  scales its physics with the viewport; a pixel constant breaks on resize.
- **A fixed target stored in viewport pixels drifts.** The clicker keeps its
  fixed click point as a fraction of the canvas rect for the same reason — and
  a drifted click on bare ground is a walk command, so the character strolls
  off.
- **The suite builds its UI in the top frame only.** The standalone scripts
  disagreed about `@all-frames`; running the clicker in every frame gives
  duplicate panels and duplicate hotkey handlers. The `getContext` patch still
  runs everywhere, which is what all-frames was for.
