# IdleOn userscripts

Four independent Tampermonkey userscripts for the browser version of Legends of IdleOn:

- **[IdleOn Clicker](#idleon-clicker)** — a stealthy autoclicker panel.
- **[Hoops Helper](#hoops-helper)** — a dotted-line shot preview for the Swishy Hoops minigame.
- **[Fishing Helper](#fishing-helper)** — a landing-spot aim marker for the fishing minigame.
- **[Darts Helper](#darts-helper)** — an aim path and hit-band readout for Throwy Darts.

The three helpers **only draw**. They never click, move the mouse, or send input to the game.

The helpers were built by measuring real gameplay footage: sprite colours, sizes and physics were read off recordings frame by frame rather than guessed, and the tracking and prediction code is replayed against that footage as a test.

# IdleOn Clicker

A stealthy in-page autoclicker panel for [Legends of IdleOn](https://www.legendsofidleon.com/) (browser version), delivered as a [Tampermonkey](https://www.tampermonkey.net/) userscript.

<img src="docs/panel.png" alt="IdleOn Clicker control panel" align="right" width="200">

It renders a small draggable control panel over the game and fires synthetic mouse clicks on a timer — useful for anything in IdleOn that wants repeated clicking (mining/fishing swing timers, afk-gain nudging, etc.). The panel lives in a **closed shadow DOM**, so the page's own JavaScript can't see it. The game doesn't check `isTrusted` on click events, so dispatched clicks are accepted as real.

> ⚠️ Automating input may violate the game's terms of service. Use at your own risk — this is a personal tool.

## Install

1. Install the **Tampermonkey** browser extension:
   - [Chrome / Edge / Brave](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
2. Open the raw script:
   **[idleon-clicker.user.js](https://raw.githubusercontent.com/averagenative/idleon-clicker/main/idleon-clicker.user.js)**
3. Tampermonkey detects the `.user.js` and opens its install tab — click **Install**.
4. Go to <https://www.legendsofidleon.com/> and load the game. The panel appears in the top-right.

To update later, just open the raw link again and re-install (Tampermonkey can also auto-check if you enable it).

### Manual install (alternative)

Open the Tampermonkey dashboard → **+** (Create a new script) → paste the contents of [`idleon-clicker.user.js`](idleon-clicker.user.js) → **File → Save**.

## Usage

The panel shows a status dot (green = running) and these controls:

| Control | What it does |
|---|---|
| **Start / Stop** | Toggle clicking. |
| **Interval min / max** | Each click waits a random time picked uniformly in `[min, max]` ms, so the cadence isn't robotic. Set both equal for a fixed rate (min 20). |
| **Pos jitter** | Random ± px added to each click position (0 = pixel-perfect). |
| **Target: Cursor** | Clicks wherever your mouse currently is. |
| **Target: Fixed** | Clicks a fixed point you set. |
| **Set Position** | Arms capture — your next click sets the fixed target (and switches to Fixed mode). |
| **XY** | Shows the current fixed target, or "(follows cursor)". |
| **–** (header) | Roll the panel up to just its title bar. Click **+** to open it again. |

Drag the panel by its header to move it. All settings persist in `localStorage` (`ac_cfg`).

### Hotkeys

| Key | Action |
|---|---|
| **F8** | Toggle clicking on/off |
| **F9** | Panic off (stop immediately) |
| **F10** | Hide / show the panel |

Hotkeys work even while a panel field has focus — the field is committed and blurred first. The game canvas eats the click that would normally move focus out of a number input, so a hotkey that yielded to the focused field could be stranded there for good.

**The panel can't get stuck.** `–` only rolls it up to the title bar, so it's always clickable. If F10 hides it completely, a small blue dot stays in the top-right corner — click that to bring it back. (Firefox claims F10 for its menu bar, so a hotkey alone isn't a safe way out.)

## How it works

- **Closed shadow DOM host** pinned at max `z-index` with `pointer-events` only on the panel itself, so it overlays the game without blocking it and stays invisible to page scripts.
- Each "click" dispatches a full `mousemove → mousedown → mouseup → click` sequence via `document.elementFromPoint` (falling back to the game `<canvas>`), matching what a real click produces.
- A randomized per-click interval (uniform in `[min, max]`) plus position jitter make the input stream look less mechanical.

---

# Hoops Helper

**[`idleon-hoops.user.js`](idleon-hoops.user.js)** draws a **dotted red aim line** over the *Swishy Hoops* minigame. It clicks nothing; it only draws.

Because the platform you stand on and the hoop both drift, the useful thing to see is *where a shot taken right now would land*. The helper watches the game canvas, learns the shape of your shot from the shots you actually take, and draws the resulting parabola live — re-aimed every frame as the platform and hoop move. It turns green when the arc drops through the rim.

The arc is anchored to the **platform**, not to the ball in your hands. That matters: the character jumps before letting go, and the platform keeps sliding while they do, so anything anchored to the ball is stale by the time the shot leaves. Measured across three recordings, the ball-anchored version missed the landing point by ~100px; the platform-anchored one is within ~40px, and the platform is detectable in 100% of frames.

### What gets drawn

| Overlay | Meaning |
|---|---|
| **Short-dashed line** | Shot preview — where the ball goes if you shoot now, drawn from above the platform and tied to it by a faint connector. |
| **Tick on the platform** | The anchor the whole prediction is measured from. |
| **Both lines at once** | Normal after a miss — the game hands you the next ball while the previous shot is still falling. |
| **Long-dashed line** | The live arc of a shot already in the air, fitted to its real motion. |
| **Green instead of red** | The arc drops through the rim — you're lined up. Either line can go green independently; the status line says which, as `aim` (the preview) and `shot` (the ball in the air). |
| **Circle on the rim** | Exactly where the ball crosses the hoop's height. |
| **Blue bar with end ticks** | The scoring window — the arc has to drop through *this*, not the whole faint bar behind it, to count as a make. The faint bar is the rim assembly as detected, which runs on past the net into the backboard. |

The arc starts noticeably **above your head** — that's correct, not a bug. The character jumps before letting go, so the ball leaves from well above where they were standing.

### Calibration

The shot is described by three numbers, all fractions of canvas size: the curvature of the arc, and where it crosses platform height going up and coming down. They are seeded from five measured shots, so the arc draws immediately — the status shows `(default)` until your own first shot replaces them outright (not blended, since the default isn't your game). Later shots refine by averaging, and fits outside the measured spread are rejected rather than averaged in.

Each shot contributes **once**, from the median of the fits taken across its whole flight, committed when the ball is gone. An earlier build folded in every frame of every flight; at a 0.25 weight applied thirty-odd times in a row that is not an average, so each shot ended up sitting on its own last fit no matter what came before it.

That made it possible to read the **per-shot spread** off a recording taken while resetting between shots: `arc` ranged 1.71–3.01 and `range` 48–63%. That is a ±30% swing on curvature from shots taken the same way, which is far wider than the ±3% the seeded defaults were measured at. Either the shot genuinely varies or the single-shot fit is noisy; until that is settled, treat the preview as an aim guide rather than a guarantee. Averaging across shots is what the current weighting is for — **resetting between shots defeats it**.

Predicting each measured shot from only the *other* shots (leave-one-out) lands within 48px, mean error 3px.

Calibration is stored in `localStorage` (`hoops_cfg`) relative to canvas size, so it survives resizing the window. **Reset calibration** returns to the measured default. Calibration learned by an older build is discarded automatically via a version stamp — early builds tracked the wrong sprites and learned wrong numbers, and a wrong throw is worse than none.

### Controls

| Control | What it does |
|---|---|
| **Show / Hide arc** | Master toggle (F7). |
| **Shot preview** | Draw the aim line from the platform. |
| **Flag makes** | Turn the arc green when it predicts a make. |
| **Ball trail** | Dots on recent tracked positions. |
| **tuning ▸** | Arc length, readback downscale, ball colour window, HUD margin, **Only in minigame**, and a debug mode that outlines every detected blob. |

The preview appears whenever a ball is in your hands, which deliberately includes the moment after a miss when the previous shot is still in the air — that is exactly when you want to line the next one up. A shot that has left the play area stops being drawn rather than lingering.

**F7** toggles the arc, **F6** hides the panel (a red dot in the top-left corner brings it back).

# Fishing Helper

**[`idleon-fishing.user.js`](idleon-fishing.user.js)** helps you place a cast in the fishing minigame. Also draw-only.

Fishing is a click-and-hold power bar: the longer you hold, the further the bobber flies. The helper reads the power gauge while you hold and draws a **live marker on the lane showing where the cast will land**, so you can release when it's over a fish and not over a hazard.

| Overlay | Meaning |
|---|---|
| **Arrow on the lane** | Where the cast lands at your current power. Green over a catch, red over a mine, amber otherwise. Green wins when a fish sits on a mine — landing on a fish always counts, even directly on top of one. |
| **Ring + name + points** | A catchable on the lane: green fish +1, gold eel +2, purple squid +3, blue whale +5 (higher tiers appear as your landing streak grows — and catching the whale resets the streak). |
| **Percentage left of a ring** | The target power that lands the cast on that catch — hold until the gauge reads this, then release. Also drawn as a tick on the power gauge in the same colour. Both update live, so they keep tracking once the fish start to move. |
| **Red ring, "AVOID"** | A mine on the lane. |
| **Amber dotted arc + ring** | A bobber already in the air, and where it will come down. |
| **White 0–8 ruler** | Numbered graduations on the power gauge and their matching landing marks on the lane — hold the gauge to *N* to land at *N*. Idea borrowed from [se7enek's IdleonHelper](https://github.com/se7enek/IdleonHelper) (a static overlay endorsed by the game's creator); here the marks are generated from the live calibration, so they stay correct as it refits. |
| **Blue dashed line** | The detected lane. |

### Calibration

The power-to-distance mapping is seeded from nine measured casts and then refit from your own — every cast that lands is recorded as a `(power, landing)` pair (20 kept, in `fish_cfg`). Straight out of the box the marker lands within roughly 10–15 px of the truth, and it tightens as you fish. **Reset aim calibration** clears the learned pairs.

**F4** toggles the helper, **F3** hides the panel.

# Darts Helper

**[`idleon-darts.user.js`](idleon-darts.user.js)** draws where your dart will go in *Throwy Darts*, and names the band it would hit. Draw-only.

Unlike the other two, this game gives you a **free aim**: the dart pivots continuously in your hand and you throw at the angle you choose. So the helper has to read your aim, not just your position. It does — and that turned out to be the whole problem.

| Overlay | Meaning |
|---|---|
| **Dotted path** | Where the dart flies at your current aim, wind included. Coloured by the band it lands in. |
| **Ring + label on the board** | The predicted hit point and its score (+1 / +2 / +3 / +5). |

**F2** toggles the path, **F1** hides the panel.

### How the aim is read

The dart's colours are useless for this: the character's body is white (s=0.02) and so is the dart shaft (s=0.03). What separates them is *shape* — the dart is a long thin protrusion ahead of the hand. The helper finds the gold fletching, then marches outward at every forward angle through anything that isn't the reddish wall, and takes the angle that reaches furthest. A continuity filter rejects readings that jump more than the sweep physically can, which is what removes the occasional 40°-wrong answer.

Checked against 16 real throws, the measured aim matches the angle actually flown with **r = 0.97**.

Wind is read from the **colour of the HUD arrow** (none / cyan / magenta) rather than the "N mph" text, so no OCR is involved; the three states separate cleanly across all 1846 frames of the reference recording.

### What is and isn't nailed down

Launch speed (0.548 × width/s) and gravity (0.612 × height) come from fitting each flight against time and are well determined (sd 3–8%). Predicting forward from them still lands a consistent 56px low, so a measured residual is applied on top — with it, **12 of 16 throws land in the right band, against 3 of 16 without**.

That residual is honest bookkeeping, not physics. Re-fitting speed, gravity and an aim offset together does remove the bias, but only by driving those values to unphysical numbers: over this narrow range of aim angles they trade off against each other, so the fit is degenerate. The likely real cause is that the hand moves during the throw, making the release point different from the aiming pivot — the same class of bug as the hoops stale anchor. Wider-ranging throws would settle it.

## How the helpers work

- Both patch `HTMLCanvasElement.prototype.getContext` at `document-start` to force `preserveDrawingBuffer: true`; without it a WebGL canvas reads back blank. Contexts are cached per canvas, so the script must load before the game creates its own — which is why these run at `document-start` rather than `document-idle` like the clicker.
- Each frame the canvas is drawn into a downscaled scratch canvas and read with `getImageData`. Pixels are matched in HSV against colours measured from real footage, then grouped into blobs by flood fill.
- **Each helper refuses to draw outside its own minigame.** Swishy Hoops is 92.8% dark-navy night sky against 0.6% anywhere else; the fishing lane is a long *thin* blue bar, which distinguishes it from the hoops sky that shares its colour. Both tests were checked against every frame of both recordings with no false result either way.
- Hoops tracks every orange blob separately rather than following one, because the player's shirt is the same colour and size as the ball, the two merge into a single blob while it is held, and they split at release.
- Shots are fitted as a **curve in x-y**, not against time. Fitting against time needs both gravity and a release instant, and the release instant depends on detection latency — which varies between recordings and threw the predicted landing out by ~100px. A curve through the tracked points has neither problem, and the curve is what gets drawn anyway.
- The lane/platform anchors are chosen for being detectable in **every** frame. Anything that can go stale becomes an error you cannot see.
- **The hoop gets its own, finer readback.** Everything else is found on the 4× scratch canvas, but the rim is a bar ~10px thick — two and a half rows at 4×, fewer still because the game's backbuffer is smaller than its CSS box. Averaged against the night sky that sliver falls under the brightness threshold, so whether the hoop was seen came down to how it happened to land on the sampling grid: one recording missed it for 39 seconds straight, then found it, with nothing changing on screen. The rim is now scanned over the band it can appear in, at whatever sampling still puts four rows through the bar. It runs at a third of the frame rate once found, since the hoop only drifts as the camera pans.
- **No panel control keeps keyboard focus.** A clicked button stays focused, and the minigame is played with the keyboard, so a keypress aimed at the game re-fires whichever control was touched last — and *Reset calibration* is one stray Space from silently discarding a session's learning. Controls are out of the tab order, blur on release, ignore keyboard-synthesised clicks, and anything still focused is blurred the moment a game key arrives.

### If something isn't detected

Turn on **Debug blobs** under *tuning* — every colour match gets outlined, which shows immediately whether the problem is detection or physics.

- *Nothing at all, status says "canvas not readable"* — the script must load **before** the game creates its WebGL context. Reload the page with the script already enabled.
- *Says "not in Swishy Hoops" while you're in it* — untick **Only in minigame**.
- *Arc is missing or misplaced* — the status line names what failed: `NO RIM` or `NO PLATFORM`. `NO RIM` carries the reason, as `<longest red run found>/<needed>@<sampling>x<width>` for each of the two scans — `0/66` means nothing matched the rim colour at all, `41/66` means the bar is being found but broken up, and the trailing numbers say what resolution it was read at. The rim is the one thing here that cannot be checked from a screen recording, because the readback sees the game's own backbuffer rather than the upscaled picture on screen.
- *Status seems to describe the wrong arc* — it doesn't: `aim` is the preview from where you're standing, `shot` is the ball already in the air, and after a miss both are on screen at once and both get reported. `NO RIM` in the status means makes cannot be flagged at all.
- *Ball missed or flickering* — widen **Hue width**, or lower **Min sat**. These tune the ball mask only; the rim keeps its own thresholds so that chasing a cleaner ball can't quietly cost you the hoop.
- *Choppy on a weak machine* — set sampling to **8×**.

## License

MIT — do whatever you want with it.
