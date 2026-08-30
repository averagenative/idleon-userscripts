"""Build idleon-suite.user.js out of the four standalone scripts.

Nothing about a helper is retyped here. Its config defaults, its migration, its
detection/physics/drawing code and its control wiring are all lifted verbatim
from the standalone script, so a fix over there lands in the suite by re-running
this. Only the shell is hand-written, in the 0*-*.js parts beside this file:
the config store, the panel body, sync(), and the suite's own switchboard.

Boundaries are matched on marker text, never on line numbers.
"""
import re, pathlib
SRC = pathlib.Path(__file__).resolve().parents[2]
P = pathlib.Path(__file__).parent

def lines_of(name):
    return (SRC / name).read_text().split('\n')

def region(name, start, end, drop_funcs=(), drop_lines=(), indent=4):
    """Verbatim text from the line matching `start` up to (not including) `end`."""
    L = lines_of(name)
    try:
        a = next(i for i, l in enumerate(L) if start in l)
        b = next(i for i, l in enumerate(L) if end in l and i > a)
    except StopIteration:
        raise SystemExit(f'{name}: marker not found ({start!r} / {end!r})')
    out, i = [], a
    while i < b:
        l = L[i]
        m = re.match(r'  function (\w+)\(', l)
        if m and m.group(1) in drop_funcs:
            while i < b and L[i] != '  }':
                i += 1
            i += 1
            while i < b and not L[i].strip():
                i += 1
            continue
        if any(d in l for d in drop_lines) or l.strip() == 'requestAnimationFrame(loop);':
            i += 1
            continue
        out.append(' ' * indent + l if l.strip() else '')
        i += 1
    return '\n'.join(out).rstrip('\n')

CHROME = re.compile(r'^\s*(collapsed: false|hidden: false)\b')

def config(name, indent=4):
    """The defaults object body and the migration statements, verbatim."""
    txt = (SRC / name).read_text()
    m = re.search(r"const cfg = Object\.assign\(\{\n(.*?)\n  \}, JSON\.parse\("
                  r"localStorage\.getItem\(KEY\) \|\| '\{\}'\)\);\n(.*?)\n  const save = ",
                  txt, re.S)
    if not m:
        raise SystemExit(f'{name}: could not find the config block')
    def fix(block, extra=0):
        keep = [l for l in block.split('\n')
                if not CHROME.match(l) and 'let saveAt' not in l]
        return '\n'.join(' ' * (indent + extra) + l if l.strip() else '' for l in keep)
    return fix(m.group(1)), fix(m.group(2), extra=0)

def part(name, **subs):
    s = (P / name).read_text().rstrip('\n')
    for k, v in subs.items():
        s = s.replace('/*__%s__*/' % k, v)
    return s

SHARED = ('const scratch = document.createElement', 'const sctx = scratch.getContext',
          "let readErr = '';")
CLICK, HOOP, FISH, DART = ('idleon-clicker.user.js', 'idleon-hoops.user.js',
                           'idleon-fishing.user.js', 'idleon-darts.user.js')

cd, cm = config(CLICK); hd, hm = config(HOOP); fd, fm = config(FISH); dd, dm = config(DART)

chunks = [
    part('00-head.js'),

    part('01-clicker.js', DEFAULTS=cd, MIGRATE=cm,
         CLICKCORE=region(CLICK, '---------- target resolution ----------',
                          '---------- position capture ----------')),

    part('02-hoops-pre.js', DEFAULTS=hd, MIGRATE=hm),
    region(HOOP, 'The rim is a 10px-tall bar', '---------- wiring ----------',
           drop_funcs=('solve3',)),
    region(HOOP, '---------- wiring ----------', 'tap(minBtn'),
    part('02-hoops-post.js'),

    part('03-fish-pre.js', DEFAULTS=fd, MIGRATE=fm),
    region(FISH, 'The whole frame is read downscaled', '---------- wiring ----------',
           drop_funcs=('gameCanvas', 'grab', 'solve3'), drop_lines=SHARED),
    region(FISH, '---------- wiring ----------', 'minBtn.onclick'),
    part('03-fish-post.js'),

    part('04-darts-pre.js', DEFAULTS=dd, MIGRATE=dm),
    region(DART, 'The dart is a ~4px-wide sprite', '---------- wiring ----------',
           drop_funcs=('gameCanvas', 'grab'), drop_lines=SHARED),
    region(DART, '---------- wiring ----------', 'minBtn.onclick'),
    part('04-darts-post.js'),

    part('05-hub.js'),
]
out = re.sub(r'\n{3,}', '\n\n', '\n'.join(chunks)) + '\n'
(SRC / 'idleon-suite.user.js').write_text(out)
print('wrote idleon-suite.user.js —', len(out.split('\n')), 'lines')
