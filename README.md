# IdleOn Clicker

A stealthy in-page autoclicker panel for [Legends of IdleOn](https://www.legendsofidleon.com/) (browser version), delivered as a [Tampermonkey](https://www.tampermonkey.net/) userscript.

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
| **Interval** | Milliseconds between clicks (min 20). |
| **Timing jitter** | Random ± ms added to each interval so timing isn't robotic (0 = exact). |
| **Pos jitter** | Random ± px added to each click position (0 = pixel-perfect). |
| **Target: Cursor** | Clicks wherever your mouse currently is. |
| **Target: Fixed** | Clicks a fixed point you set. |
| **Set Position** | Arms capture — your next click sets the fixed target (and switches to Fixed mode). |
| **XY** | Shows the current fixed target, or "(follows cursor)". |
| **–** (header) | Minimize/hide the panel. |

Drag the panel by its header to move it. All settings persist in `localStorage` (`ac_cfg`).

### Hotkeys

| Key | Action |
|---|---|
| **F8** | Toggle clicking on/off |
| **F9** | Panic off (stop immediately) |
| **F10** | Hide / show the panel |

Hotkeys are ignored while you're typing in one of the panel's own number fields.

## How it works

- **Closed shadow DOM host** pinned at max `z-index` with `pointer-events` only on the panel itself, so it overlays the game without blocking it and stays invisible to page scripts.
- Each "click" dispatches a full `mousemove → mousedown → mouseup → click` sequence via `document.elementFromPoint` (falling back to the game `<canvas>`), matching what a real click produces.
- Timing and position jitter make the input stream look less mechanical.

## License

MIT — do whatever you want with it.
