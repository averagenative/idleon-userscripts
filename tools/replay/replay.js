#!/usr/bin/env node
'use strict';
// Replay a screen recording through a helper userscript, in Node, and print
// what it measured on every frame.
//
// This exists because the alternative is what it replaced: dump frames to PNG,
// re-implement the detection in another language, and debug the port instead of
// the helper. Here the code under test is the code that ships — the userscript
// is loaded unmodified, its loop is pumped a frame at a time, and its own
// debug probe (tuning > Debug, window.__idleon.<helper>) is read back.
//
//   node tools/replay/replay.js --video clip.mp4 --script idleon-fishing.user.js
//   node tools/replay/replay.js --video clip.mp4 --script idleon-fishing.user.js \
//        --pick meter.top,meter.total,meter.frac,charge --from 5 --to 9
//
// --crop WxH+X+Y   the game canvas inside the frame (auto-detected otherwise)
// --fps N          sample this many frames a second (default: every frame)
// --from/--to S    seconds
// --pick a,b,c     dotted paths out of the probe, printed as a table
// --status         print the helper's own status line instead of the probe
// --set k=v,...    seed config values, e.g. --set scale=8
// --helper NAME    which helper's probe unprefixed --pick paths refer to
// --budget MB      decode window size, default 192MB of raw frames
// --json           one JSON object per frame

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const dom = require('./dom.js');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[a.slice(2)] = process.argv[++i];
  else args[a.slice(2)] = true;
}
if (!args.video || !args.script) {
  console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22)
    .map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(1);
}
const scriptPath = path.resolve(ROOT, args.script);
const videoPath = path.resolve(args.video);

// ---------- where is the game canvas in the frame? ----------
// The page around it is near-black and the game is not, so the canvas is the
// tall bright block in the middle. Printed so it can be sanity-checked, and
// overridden with --crop when the guess is wrong.
function probeCanvas() {
  const W = 320, H = 180;                       // a thumbnail is plenty to find it
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', videoPath, '-frames:v', '1',
    '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: 1 << 26 });
  const lum = (x, y) => { const p = (y * W + x) * 4; return (buf[p] + buf[p + 1] + buf[p + 2]) / 3; };
  const run = (n, get) => {                     // longest bright run
    let best = [0, -1], s = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && get(i) > 45) { if (s < 0) s = i; }
      else if (s >= 0) { if (i - s > best[1] - best[0]) best = [s, i - 1]; s = -1; }
    }
    return best;
  };
  const [y0, y1] = run(H, y => lum(W >> 1, y));
  const my = (y0 + y1) >> 1;
  const [x0, x1] = run(W, x => lum(x, my));
  const sx = 1920 / W, sy = 1080 / H;           // probe was scaled; get real pixels back
  const meta = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', videoPath], { encoding: 'utf8' });
  const [vw, vh] = meta.stdout.trim().split(',').map(Number);
  const kx = vw / W, ky = vh / H;
  return { x: Math.round(x0 * kx), y: Math.round(y0 * ky),
           w: Math.round((x1 - x0 + 1) * kx), h: Math.round((y1 - y0 + 1) * ky) };
}

let crop;
if (args.crop) {
  const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(args.crop);
  if (!m) { console.error('--crop wants WxH+X+Y'); process.exit(1); }
  crop = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
} else {
  crop = probeCanvas();
  console.error(`# game canvas guessed at ${crop.w}x${crop.h}+${crop.x}+${crop.y} `
              + `(override with --crop WxH+X+Y)`);
}

// ---------- frames ----------
// Decoded a window at a time, not all at once. Raw RGBA is ~4MB a frame at
// 1080p, so a minute of footage is several gigabytes — the first version of
// this buffered the lot and died with ENOBUFS on a 78-second clip.
const frameBytes = crop.w * crop.h * 4;
const fps = Number(args.fps) || 30;
const BUDGET = (Number(args.budget) || 128) * 1024 * 1024;
const perChunk = Math.max(1, Math.floor(BUDGET / frameBytes));
const chunkSecs = perChunk / fps;

function decode(from, secs) {
  const vf = [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`];
  if (args.fps) vf.push(`fps=${args.fps}`);
  const ff = ['-v', 'error', '-ss', String(from)];
  if (secs != null) ff.push('-t', String(secs));
  ff.push('-i', videoPath, '-vf', vf.join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-');
  // Generous headroom: ffmpeg can emit a frame or two past the window's
  // end, and going one frame over the buffer is an ENOBUFS, not a truncation.
  return execFileSync('ffmpeg', ff, { maxBuffer: BUDGET * 2 });
}

const start = Number(args.from) || 0;
const stop = args.to != null ? Number(args.to) : Infinity;
console.error(`# decoding ${chunkSecs.toFixed(1)}s at a time from ${path.basename(videoPath)}`);

// ---------- the fake browser ----------
const game = dom.element('canvas', 'game');
game.width = crop.w; game.height = crop.h;
game.clientWidth = crop.w; game.clientHeight = crop.h;

let now = (Number(args.from) || 0) * 1000;
const rafQueue = [];
const store = {};

// seed config: debug on (that is what publishes the probe), plus any --set
const seed = { debug: true, on: true };
for (const kv of String(args.set || '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  seed[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
}
for (const key of ['ac_cfg', 'hoops_cfg', 'fish_cfg', 'darts_cfg']) store[key] = JSON.stringify(seed);

const ctxObj = {
  console,
  document: {
    documentElement: dom.element('html'),
    createElement: t => dom.element(t),
    querySelectorAll: sel => (sel === 'canvas' ? [game] : []),
    addEventListener() {}, removeEventListener() {},
    elementFromPoint: () => null,
  },
  localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  HTMLCanvasElement: function () {},
  MouseEvent: function () {},
  performance: { now: () => now },
  requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 1,
  innerWidth: crop.w, innerHeight: crop.h,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
ctxObj.HTMLCanvasElement.prototype = { getContext: () => null };
ctxObj.window = ctxObj;
ctxObj.self = ctxObj;
ctxObj.top = ctxObj;
ctxObj.globalThis = ctxObj;
vm.createContext(ctxObj);
vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), ctxObj, { filename: scriptPath });

// ---------- pump ----------
const dig = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const pick = args.pick ? String(args.pick).split(',') : null;
const fmt = v => v == null ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3))
           : typeof v === 'object' ? JSON.stringify(v) : String(v);

if (pick) console.log(['frame', 't'].concat(pick).join('\t'));
let warnedNoProbe = false, announced = false;

let i = 0;
for (let at = start; at < stop; at += chunkSecs) {
  const secs = Math.min(chunkSecs, stop - at);
  const raw = decode(at, Number.isFinite(secs) ? secs : null);
  const got = Math.floor(raw.length / frameBytes);
  if (!got) break;
  for (let j = 0; j < got; j++, i++) {
  game.surface.data.set(raw.subarray(j * frameBytes, (j + 1) * frameBytes));
  now = (start + i / fps) * 1000;
  const due = rafQueue.splice(0, rafQueue.length);
  for (const fn of due) fn(now);

  const t = (now / 1000).toFixed(2);
  if (args.status) {
    const st = dom.roots.map(r => r.querySelector('#st').textContent).filter(Boolean).join(' | ');
    console.log(`${i}\t${t}\t${st.replace(/\n/g, ' · ')}`);
    continue;
  }
  // The suite publishes several helpers at once, the standalone scripts one.
  // Either way a path may name the helper ("fishing.meter.top") or not
  // ("meter.top") — the latter resolves against the only helper present, or
  // against the one named by --helper.
  const all = ctxObj.__idleon || {};
  const keys = Object.keys(all);
  if (!keys.length) {
    if (!warnedNoProbe) {
      console.error('# no probe yet — helper gated out of this scene, or tuning > Debug is off');
      warnedNoProbe = true;
    }
    continue;
  }
  if (!announced) { console.error('# publishing: ' + keys.join(', ')); announced = true; }
  const one = args.helper ? all[args.helper] : keys.length === 1 ? all[keys[0]] : null;
  const look = p => { const v = dig(all, p); return v !== undefined ? v : one ? dig(one, p) : undefined; };
  const probe = one || all;
  if (pick) console.log([i, t].concat(pick.map(look).map(fmt)).join('\t'));
  else if (args.json) console.log(JSON.stringify({ frame: i, t: +t, ...probe }));
  else console.log(`${i}\t${t}\t${JSON.stringify(probe)}`);
  }
  if (!Number.isFinite(secs)) break;
}
