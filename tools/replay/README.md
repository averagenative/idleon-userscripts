# Debugging the helpers

Two tools. Reach for the first one.

## `tools/replay` — replay a recording through the real helper

    node tools/replay/replay.js --video clip.mp4 --script idleon-fishing.user.js \
         --pick meter.top,meter.total,meter.frac,charge --from 5 --to 9

Loads the userscript **unmodified** in Node against a stubbed DOM whose "game
canvas" is a frame of a screen recording, pumps its loop one frame at a time,
and prints what it measured. The code under test is the code that ships: no
port, nothing to keep in sync, and the numbers you get out are the numbers the
overlay was drawn from.

It reads the helper's own debug probe — `window.__idleon.<helper>`, published
every frame while **tuning > Debug** is on, which the harness turns on for you.
The probe carries what the status line cannot: the gauge's two ends, the rim
and platform anchors, the wind, the live calibration. When the helper bails out
early the probe says why (`idle: "gated out: sky < 55%"`).

| flag | |
|---|---|
| `--video` `--script` | required |
| `--crop WxH+X+Y` | where the game canvas sits in the frame. Auto-detected, and the guess is printed — override it if it looks wrong |
| `--from` `--to` | seconds |
| `--fps N` | sample N frames a second instead of all of them |
| `--pick a.b,c` | dotted paths out of the probe, as a table. Prefix with the helper (`fishing.meter.top`) when replaying the suite, which publishes all three at once |
| `--helper NAME` | which helper unprefixed `--pick` paths mean |
| `--status` | the helper's own status line instead |
| `--set k=v,...` | seed config, e.g. `--set scale=8` |
| `--json` | one JSON object per frame |

Worked example — the v1.8 gauge bug, before and after, on the same clip:

    $ ... --script <pre-1.8 fishing> --pick meter.top,meter.total,meter.frac
    0  5.00  72  22  0.182
    1  5.17  60  34  0.265      <- gauge grew 12 rows; nothing moved on screen
    2  5.33  60  34  0.412      <- same red bar, now reads 0.41

    $ ... --script idleon-fishing.user.js --pick meter.top,meter.total,meter.frac
    0  5.00  72  22  0.182
    1  5.17  72  22  0.409
    2  5.33  72  22  0.636      <- and 0.64 is what the bar actually shows

**One caveat.** Chrome's image downscale is its own; the harness uses a box
filter, which is close but not bit-identical, and the auto-detected crop is a
couple of pixels off the real canvas rect. A disagreement of a row or two is
the harness, not the helper. Anything larger is real.

## `tools/chrome` — read a live session over the DevTools Protocol

For what a recording cannot show you: what the helper is doing *right now*.

    google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/idleon-debug \
                  https://www.legendsofidleon.com/

    node tools/chrome/attach.js --watch --pick fishing.meter.top,fishing.charge
    node tools/chrome/attach.js --eval 'JSON.parse(localStorage.fish_cfg)'
    node tools/chrome/attach.js --set fish_cfg.debug=true

Tick **tuning > Debug** in the helper panel first, or `--set` it and reload.
The throwaway `--user-data-dir` keeps your real profile out of it. Node 22 has
`WebSocket` and `fetch` built in, so there is nothing to install.

## Getting a recording

Point it at `idleon-suite.user.js` and all three minigame helpers replay together, each reporting on the same frames — a quick way to confirm the suite build behaves exactly like the standalone script it was generated from.

Any screen capture of the game will do. The harness finds the canvas itself;
`--crop` is only for when it guesses wrong. 30fps is plenty, and `--fps 6` is
usually enough to read a cast.
