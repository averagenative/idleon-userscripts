'use strict';
// A DOM stub with real pixels in it.
//
// Enough of a browser for a helper userscript to boot, run its loop, and read
// the game canvas — where "the game canvas" is a frame of a screen recording.
// The helper is not modified or reimplemented: the code under test is the same
// code that runs in the browser.
//
// The one place this is NOT the browser is image resampling. Chrome's
// downscale is its own; this uses a box filter, which is close but not
// bit-identical. A threshold sitting right on the edge of a colour window can
// therefore land differently here than in the game. Treat a disagreement of
// one or two units as the harness, not the helper.

class Surface {
  constructor(w = 0, h = 0) { this._w = 0; this._h = 0; this.width = w; this.height = h; }
  get width() { return this._w; }
  set width(v) { if (v !== this._w) { this._w = v | 0; this._alloc(); } }
  get height() { return this._h; }
  set height(v) { if (v !== this._h) { this._h = v | 0; this._alloc(); } }
  _alloc() { this.data = new Uint8ClampedArray(Math.max(0, this._w * this._h * 4)); }
}

// Box-filtered draw of `src` onto `dst`. Matches what a browser does closely
// enough for colour-window work when downscaling, which is all these do.
function blit(src, dst, sx, sy, sw, sh, dx, dy, dw, dh, smooth) {
  const S = src.data, D = dst.data;
  const xs = sw / dw, ys = sh / dh;
  for (let j = 0; j < dh; j++) {
    const ty = dy + j;
    if (ty < 0 || ty >= dst.height) continue;
    const y0 = sy + j * ys, y1 = y0 + ys;
    for (let i = 0; i < dw; i++) {
      const tx = dx + i;
      if (tx < 0 || tx >= dst.width) continue;
      const x0 = sx + i * xs, x1 = x0 + xs;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      if (!smooth || (xs <= 1 && ys <= 1)) {
        const px = Math.min(src.width - 1, Math.max(0, Math.floor(x0)));
        const py = Math.min(src.height - 1, Math.max(0, Math.floor(y0)));
        const p = (py * src.width + px) * 4;
        r = S[p]; g = S[p + 1]; b = S[p + 2]; a = S[p + 3]; n = 1;
      } else {
        for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
          if (py < 0 || py >= src.height) continue;
          for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
            if (px < 0 || px >= src.width) continue;
            const p = (py * src.width + px) * 4;
            r += S[p]; g += S[p + 1]; b += S[p + 2]; a += S[p + 3]; n++;
          }
        }
      }
      if (!n) continue;
      const q = (ty * dst.width + tx) * 4;
      D[q] = r / n; D[q + 1] = g / n; D[q + 2] = b / n; D[q + 3] = a / n;
    }
  }
}

function ctx2d(surface, record) {
  const ops = [];
  const c = {
    imageSmoothingEnabled: true,
    canvas: surface,
    ops,
    drawImage(img, ...a) {
      const src = img.surface || img;          // a canvas element, or a bare Surface
      let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh;
      if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; }
      else if (a.length === 4) { [dx, dy, dw, dh] = a; }
      else { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
      blit(src, surface, sx, sy, sw, sh, dx | 0, dy | 0, Math.round(dw), Math.round(dh),
           c.imageSmoothingEnabled);
    },
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) {
        const sy = y + j;
        if (sy < 0 || sy >= surface.height) continue;
        out.set(surface.data.subarray((sy * surface.width + x) * 4,
                                      (sy * surface.width + x + w) * 4), j * w * 4);
      }
      return { data: out, width: w, height: h };
    },
    clearRect(x, y, w, h) {
      if (x === 0 && y === 0 && w >= surface.width && h >= surface.height) surface.data.fill(0);
    },
    measureText: t => ({ width: String(t).length * 6 }),
  };
  // Drawing calls are recorded rather than rasterised: what matters is where
  // the helper put its markers, not what they look like.
  for (const m of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'stroke',
                   'fill', 'arc', 'rect', 'strokeRect', 'fillRect', 'fillText', 'strokeText',
                   'setLineDash', 'setTransform', 'translate', 'rotate', 'scale', 'ellipse',
                   'quadraticCurveTo', 'bezierCurveTo', 'clip']) {
    if (!c[m]) c[m] = (...args) => { if (record) ops.push([m, ...args]); };
  }
  return c;
}

function element(tag, id) {
  const surface = tag === 'canvas' ? new Surface(0, 0) : null;
  const cache = new Map();
  const el = {
    tagName: tag.toUpperCase(), id, style: {}, dataset: {}, _text: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, blur() {}, focus() {},
    remove() {}, appendChild() {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: el.width, bottom: el.height,
                                    width: el.width, height: el.height }),
    querySelectorAll: () => [],
    querySelector(sel) {
      if (!cache.has(sel)) cache.set(sel, element(sel.includes('canvas') || sel === '#ov' ? 'canvas' : 'div',
                                                  sel.replace(/^#/, '')));
      return cache.get(sel);
    },
    attachShadow() {
      const r = element('shadow');
      r.activeElement = null;
      module.exports.roots.push(r);
      return r;
    },
    set innerHTML(v) {}, get innerHTML() { return ''; },
    set textContent(v) { el._text = String(v); }, get textContent() { return el._text; },
    set onclick(f) {}, set onchange(f) {},
    set checked(v) {}, get checked() { return false; },
    set value(v) {}, get value() { return 0; },
  };
  if (surface) {
    Object.defineProperty(el, 'width', { get: () => surface.width, set: v => surface.width = v });
    Object.defineProperty(el, 'height', { get: () => surface.height, set: v => surface.height = v });
    el.clientWidth = 0; el.clientHeight = 0;
    el.surface = surface;
    let ctx = null;
    el.getContext = () => ctx || (ctx = ctx2d(surface, id === 'ov'));
  } else {
    el.width = 0; el.height = 0;
  }
  return el;
}

module.exports = { Surface, element, ctx2d, blit, roots: [] };
