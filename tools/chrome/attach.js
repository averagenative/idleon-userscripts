#!/usr/bin/env node
'use strict';
// Read values out of a LIVE game, over the Chrome DevTools Protocol.
//
// The replay harness (tools/replay) is the better tool for anything you can
// reproduce from a recording — it is deterministic and you can step it. This is
// for the things a recording cannot show you: what the helper is doing right
// now, in your session, against whatever the game is actually rendering.
//
// Start Chrome with the protocol open, in a throwaway profile so your normal
// one is untouched:
//
//   google-chrome --remote-debugging-port=9222 \
//                 --user-data-dir=/tmp/idleon-debug \
//                 https://www.legendsofidleon.com/
//
// Then, with the helper's tuning > Debug ticked:
//
//   node tools/chrome/attach.js --watch                    # the probe, twice a second
//   node tools/chrome/attach.js --watch --pick fishing.meter.top,fishing.charge
//   node tools/chrome/attach.js --eval 'JSON.parse(localStorage.fish_cfg)'
//   node tools/chrome/attach.js --set fish_cfg.debug=true  # then reload the page
//
// --url <substring> picks a different tab; --port a different debugging port.
//
// Nothing here needs npm: Node 22 has WebSocket and fetch built in.

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 0 && a.slice(2, eq) !== 'set') args[a.slice(2, eq)] = a.slice(eq + 1);
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[a.slice(2)] = process.argv[++i];
  else args[a.slice(2)] = true;
}
const PORT = args.port || 9222;

async function target() {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  } catch {
    console.error(`Nothing listening on 127.0.0.1:${PORT}.\n\n` +
      `  google-chrome --remote-debugging-port=${PORT} --user-data-dir=/tmp/idleon-debug \\\n` +
      `                https://www.legendsofidleon.com/\n`);
    process.exit(1);
  }
  const pages = list.filter(t => t.type === 'page');
  const match = args.url || 'legendsofidleon';
  const game = pages.find(t => t.url.includes(match));
  if (!game) {
    console.error(`No tab matching ${JSON.stringify(match)} (override with --url). Open pages:`);
    for (const p of pages) console.error('  ' + p.url);
    process.exit(1);
  }
  return game;
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = e => rej(e);
  });
}

(async () => {
  const t = await target();
  const ws = await connect(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg.result); }
  };
  const send = (method, params) => new Promise(res => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  // The userscript runs with @grant none, so it shares the page's world —
  // window.__idleon is reachable from a plain evaluate.
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'threw' };
    return { value: r.result.value };
  };

  console.error(`# attached to ${t.title || t.url}`);

  if (args.set) {
    const m = /^(\w+)\.([\w.]+)=(.*)$/.exec(args.set);
    if (!m) { console.error('--set wants key.field=value, e.g. fish_cfg.debug=true'); process.exit(1); }
    const [, key, field, raw] = m;
    const out = await evaluate(
      `(() => { const c = JSON.parse(localStorage.${key} || '{}');` +
      ` c[${JSON.stringify(field)}] = ${JSON.stringify(raw)} === 'true' ? true :` +
      ` ${JSON.stringify(raw)} === 'false' ? false : isNaN(+${JSON.stringify(raw)}) ?` +
      ` ${JSON.stringify(raw)} : +${JSON.stringify(raw)};` +
      ` localStorage.${key} = JSON.stringify(c); return c; })()`);
    console.log(JSON.stringify(out.value ?? out.error, null, 2));
    console.error('# reload the page for the helper to pick this up');
    ws.close(); return;
  }

  if (args.eval) {
    const out = await evaluate(`JSON.stringify(${args.eval})`);
    console.log(out.value !== undefined ? out.value : out.error);
    ws.close(); return;
  }

  // --watch: poll the probe. The helper republishes it every frame, so this is
  // a sample of the live values, not a stream of every one of them.
  const pick = args.pick ? String(args.pick).split(',') : null;
  const every = Number(args.every) || 500;
  const dig = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
  const fmt = v => v == null ? '-' : typeof v === 'object' ? JSON.stringify(v)
             : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v);
  if (pick) console.log(['time'].concat(pick).join('\t'));
  let warned = false;
  setInterval(async () => {
    const out = await evaluate('JSON.stringify(window.__idleon || null)');
    const probe = out.value ? JSON.parse(out.value) : null;
    if (!probe) {
      if (!warned) { console.error('# window.__idleon is empty — tick tuning > Debug in the helper panel'); warned = true; }
      return;
    }
    warned = false;
    const ts = new Date().toTimeString().slice(0, 8);
    if (pick) console.log([ts].concat(pick.map(p => fmt(dig(probe, p)))).join('\t'));
    else console.log(ts + '\t' + JSON.stringify(probe));
  }, every);
})();
