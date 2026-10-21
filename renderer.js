// WebGL2 renderer for the osu! playfield. Discs, rings and skin sprites share one instanced
// pipeline, so draw order is the push order. Sprites sample a texture atlas packed from the
// active skin; anything a skin lacks falls back to the flat shapes. Judgement popups, the HUD (hud.js),
// and numbers that skin glyphs cannot draw are drawn on a 2D overlay canvas.
// The canvas must have a 4:3 aspect ratio (the playfield is 512 x 384).
import { KIND, RES } from "./core.js";
import { createHud } from "./hud.js";
import { drawResumeText, cursorTint } from "./resume.js";

export const PF_W = 512;     // the playfield: where object centres go
export const PF_H = 384;
// The area the canvas shows, in playfield units: { x, y, w, h }, where w / h is the canvas's aspect
// ratio (the canvas covers the whole window). The view covers the box (x0,y0)-(x1,y1) and grows on
// one axis as needed, so nothing inside the box is cut off.
export function viewFor(x0, y0, x1, y1, aspect = 4 / 3) {
  const w = Math.max(x1 - x0, (y1 - y0) * aspect);
  const h = w / aspect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
// How far a note reaches past its centre, in radii: the body, its border and its approach ring.
// The approach ring closes onto 128/118 of the note, as DefaultApproachCircle.cs does.
export const APPROACH_START = 128 / 118;
// How dark the playfield is outside the flashlight's circle. The shader itself is not in the lazer source
// this port has, so this is an estimate of its look.
const FLASHLIGHT_DARKNESS = 0.95;
export const OBJECT_PAD = APPROACH_START + 0.05;
// A slider's follow circle reaches this far, in radii.
export const FOLLOW_PAD = 1.6;
export const PLAYFIELD_VIEW = viewFor(0, 0, PF_W, PF_H);
const STRIDE = 14; // centre(2) half(2) colour(4) mode(1) width(1) uv(4)
const MODE_FILL = 0;
const MODE_RING = 1;
const MODE_SPRITE = 2; // for sprites the width field carries a rotation in radians
const ATLAS_W = 4096;
const SPRITE_MAX = 512; // skin images larger than this are scaled down when packed
const WHITE = [1, 1, 1];
const NO_UV = [0, 0, 0, 0];
const SPECIAL_GLYPHS = { ",": "comma", ".": "dot", "%": "percent", x: "x" };
const SPINNER_RADIUS = 118;
const SPINNER_CENTRE = [PF_W / 2, PF_H / 2];
const FOLLOW_SPACING = 32;   // playfield units between follow points
const GRADIENT_STEPS = 8;    // smooth gradient layers between a slider's border and its centre
const TRAIL_MS = 120;        // how long a cursor trail copy lasts

const rgb01 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
// Opaque layers are dimmed by scaling their colour. The playfield background is almost black,
// so this reads as fading. Alpha blending is avoided because overlapping discs would brighten.
const shade = (c, a) => [c[0] * a, c[1] * a, c[2] * a];
// Border thickness of a slider body, as a fraction of its radius.
const borderWidth = (rad) => Math.max(2, rad * 0.1);

const VS = `#version 300 es
in vec2 aCorner;
in vec2 aCenter;
in vec2 aHalf;
in vec4 aColour;
in float aMode;
in float aWidth;
in vec4 aUV;
uniform vec2 uSize;
uniform vec2 uOrigin;
out vec2 vLocal;
out vec4 vColour;
out vec2 vHalf;
out float vMode;
out float vWidth;
out vec2 vUV;
void main() {
  bool sprite = aMode > 1.5;
  vec2 ext = sprite ? aHalf : aHalf + vec2(aWidth * 0.5 + 2.0);
  vec2 local = aCorner * ext;
  float ang = sprite ? aWidth : 0.0;
  vec2 rot = vec2(cos(ang) * local.x - sin(ang) * local.y, sin(ang) * local.x + cos(ang) * local.y);
  vec2 p = aCenter + rot;
  vLocal = local;
  vColour = aColour;
  vHalf = aHalf;
  vMode = aMode;
  vWidth = aWidth;
  vUV = mix(aUV.xy, aUV.zw, aCorner * 0.5 + 0.5);
  gl_Position = vec4((p.x - uOrigin.x) / uSize.x * 2.0 - 1.0, 1.0 - (p.y - uOrigin.y) / uSize.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColour;
in vec2 vHalf;
in float vMode;
in float vWidth;
in vec2 vUV;
uniform sampler2D uAtlas;
out vec4 outColor;
void main() {
  if (vMode > 1.5) {
    vec4 t = textureLod(uAtlas, vUV, 0.0);
    float sa = t.a * vColour.a;
    if (sa <= 0.0) discard;
    outColor = vec4(t.rgb * vColour.rgb, sa);
    return;
  }
  float d = length(vLocal);
  float a;
  if (vMode < 0.5) {
    a = 1.0 - smoothstep(vHalf.x - 1.0, vHalf.x + 0.5, d);
  } else {
    float dist = abs(d - vHalf.x);
    a = 1.0 - smoothstep(vWidth * 0.5 - 1.0, vWidth * 0.5 + 0.5, dist);
  }
  float alpha = vColour.a * a;
  if (alpha <= 0.0) discard;
  outColor = vec4(vColour.rgb, alpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

// Angle (radians) of a reverse arrow at (x, y): back along the slider's centre-line.
function arrowAngle(pts, x, y) {
  const n = pts.length >> 1;
  if (n < 2) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < n; k++) {
    const dx = pts[2 * k] - x;
    const dy = pts[2 * k + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  // Past the middle the reverse happens at the far end, so the arrow points back into the slider.
  const j = best < n / 2 ? Math.min(best + 1, n - 1) : Math.max(best - 1, 0);
  return Math.atan2(pts[2 * j + 1] - pts[2 * best + 1], pts[2 * j] - pts[2 * best]);
}

// The end point of a slider's centre-line (the last sample of its path).
function sliderEnd(index, sliderPoints) {
  const p = sliderPoints(index);
  return [p[p.length - 2], p[p.length - 1]];
}

// The part of a resampled centre-line between fractions f0 and f1 of its length (snaking).
function subPath(pts, f0, f1) {
  const n = pts.length >> 1;
  const out = [];
  if (n < 2 || f1 <= f0) return new Float32Array(0);
  const cum = [0];
  for (let k = 1; k < n; k++) {
    cum.push(cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]));
  }
  const total = cum[n - 1];
  const at = (d) => {
    let k = 1;
    while (k < n - 1 && cum[k] < d) k++;
    const seg = cum[k] - cum[k - 1] || 1;
    const f = (d - cum[k - 1]) / seg;
    return [pts[2 * (k - 1)] + (pts[2 * k] - pts[2 * (k - 1)]) * f, pts[2 * (k - 1) + 1] + (pts[2 * k + 1] - pts[2 * (k - 1) + 1]) * f];
  };
  const a = f0 * total;
  const b = f1 * total;
  out.push(...at(a));
  for (let k = 0; k < n; k++) if (cum[k] > a && cum[k] < b) out.push(pts[2 * k], pts[2 * k + 1]);
  out.push(...at(b));
  return Float32Array.from(out);
}

export function createRenderer(canvas, overlay) {
  // The canvas is transparent where nothing is drawn, so a beatmap video behind it shows through (see setVeil).
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
  if (!gl) throw new Error("WebGL2 is not available in this browser.");
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  // unit quad corners (triangle strip)
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(prog, "aCorner");
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  const bindInst = (name, size, offset) => {
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    gl.vertexAttribDivisor(loc, 1);
  };
  bindInst("aCenter", 2, 0);
  bindInst("aHalf", 2, 2);
  bindInst("aColour", 4, 4);
  bindInst("aMode", 1, 8);
  bindInst("aWidth", 1, 9);
  bindInst("aUV", 4, 10);
  const uSize = gl.getUniformLocation(prog, "uSize");
  const uOrigin = gl.getUniformLocation(prog, "uOrigin");
  gl.uniform1i(gl.getUniformLocation(prog, "uAtlas"), 0);

  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // Atlas texture. It stays a 1x1 white texel until a skin is set.
  const atlasTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

  const ctx2d = overlay.getContext("2d");
  const atlasCanvas = document.createElement("canvas");
  let sprites = new Map();     // logical name -> { uv, aspect, w1, h1 }; w1/h1 are the 1x skin size
  let bitmaps = new Map();     // logical name -> ImageBitmap, for judgement popups on the overlay
  let blank = new Set();       // names the skin leaves empty on purpose (1x1 images)
  let sliderBorder = null;     // [r, g, b] in 0..1 from skin.ini, or null when unset
  let sliderTrack = null;
  let veil = null;
  function setVeil(strength) {
    veil = strength;
  }
  let overlayAboveNumber = false;
  let hitOverlap = 0;
  let scoreOverlap = 0;
  let comboOverlap = 0;
  let legacySprites = new Map();
  let barFrames = [];
  let keyText = null;
  let legacyHud = false;
  const hud = createHud();
  const EMPTY_DIGIT = { bmp: null, w1: 1, h1: 1 };
  const hudSkin = {
    active: () => legacyHud,
    sprite: (name) => legacySprites.get(name)
      || (/^(score|combo)-/.test(name) && blank.has(name) ? EMPTY_DIGIT : null),
    overlap: (family) => (family === "combo" ? comboOverlap : family === "scoreentry" ? 1 : scoreOverlap),
    barFrameCount: () => barFrames.length,
    barFrame: (i) => barFrames[i] || null,
    keyText: () => keyText,
  };

  function setSkin(skin) {
    const images = skin ? skin.images : new Map();
    const scales = skin ? skin.scales : new Map();
    const ini = skin ? skin.ini : null;
    blank = skin ? skin.blank : new Set();
    sliderBorder = ini && ini.sliderBorder ? rgb01(ini.sliderBorder) : null;
    sliderTrack = ini && ini.sliderTrack ? rgb01(ini.sliderTrack) : null;
    overlayAboveNumber = !!(ini && ini.overlayAboveNumber);
    hitOverlap = ini ? ini.hitOverlap : 0;
    scoreOverlap = ini ? ini.scoreOverlap : 0;
    comboOverlap = ini ? ini.comboOverlap : 0;
    keyText = ini && ini.inputOverlayText ? ini.inputOverlayText : null;
    legacyHud = !!skin && !skin.argon && images.size > 0;
    bitmaps = new Map(images);
    legacySprites = new Map();
    for (const [name, bmp] of images) {
      const sc = scales.get(name) || 1;
      legacySprites.set(name, { bmp, w1: bmp.width / sc, h1: bmp.height / sc });
    }
    barFrames = [...legacySprites]
      .filter(([name]) => /^scorebar-colour-\d+$/.test(name))
      .sort((a, b) => Number(a[0].slice("scorebar-colour-".length)) - Number(b[0].slice("scorebar-colour-".length)))
      .map(([, s]) => s);
    sprites = new Map();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    if (images.size === 0) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      return;
    }
    const items = [];
    for (const [name, bmp] of images) {
      const s = Math.min(1, SPRITE_MAX / Math.max(bmp.width, bmp.height));
      const sc = scales.get(name) || 1;
      items.push({
        name,
        bmp,
        w: Math.max(1, Math.round(bmp.width * s)),
        h: Math.max(1, Math.round(bmp.height * s)),
        w1: bmp.width / sc,
        h1: bmp.height / sc,
      });
    }
    items.sort((a, b) => b.h - a.h);
    const PAD = 2;
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const it of items) {
      if (x + it.w + PAD > ATLAS_W) {
        x = 0;
        y += rowH + PAD;
        rowH = 0;
      }
      it.x = x;
      it.y = y;
      x += it.w + PAD;
      rowH = Math.max(rowH, it.h);
    }
    const atlasH = Math.max(1, y + rowH);
    if (atlasH > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      return;
    }
    atlasCanvas.width = ATLAS_W;
    atlasCanvas.height = atlasH;
    const c = atlasCanvas.getContext("2d");
    c.clearRect(0, 0, ATLAS_W, atlasH);
    for (const it of items) {
      c.drawImage(it.bmp, it.x, it.y, it.w, it.h);
      sprites.set(it.name, {
        uv: [it.x / ATLAS_W, it.y / atlasH, (it.x + it.w) / ATLAS_W, (it.y + it.h) / atlasH],
        aspect: it.w / it.h,
        w1: it.w1,
        h1: it.h1,
      });
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
  }

  let batch = new Float32Array(STRIDE * 4096);
  let n = 0;
  const put = (x, y, hw, hh, c, a, mode, width, uv) => {
    if ((n + 1) * STRIDE > batch.length) {
      const bigger = new Float32Array(batch.length * 2);
      bigger.set(batch);
      batch = bigger;
    }
    const o = n * STRIDE;
    batch[o] = x;
    batch[o + 1] = y;
    batch[o + 2] = hw;
    batch[o + 3] = hh;
    batch[o + 4] = c[0];
    batch[o + 5] = c[1];
    batch[o + 6] = c[2];
    batch[o + 7] = a;
    batch[o + 8] = mode;
    batch[o + 9] = width;
    batch[o + 10] = uv[0];
    batch[o + 11] = uv[1];
    batch[o + 12] = uv[2];
    batch[o + 13] = uv[3];
    n++;
  };
  const push = (x, y, r, c, a, mode, width) => put(x, y, r, r, c, a, mode, width, NO_UV);
  const sprite = (name, x, y, h, c, a, angle = 0) => {
    if (blank.has(name)) return true;
    const s = sprites.get(name);
    if (!s) return false;
    const hh = h / 2;
    put(x, y, hh * s.aspect, hh, c, a, MODE_SPRITE, angle, s.uv);
    return true;
  };
  const hasSprite = (name) => sprites.has(name);
  const framesOf = (re) => [...sprites.keys()]
    .filter((k) => re.test(k) && !blank.has(k))
    .sort((x, y) => Number(/(\d+)$/.exec(x)?.[1] ?? 0) - Number(/(\d+)$/.exec(y)?.[1] ?? 0));
  const size1x = (name, scale) => (sprites.get(name)?.h1 || 0) * scale;

  const flush = () => {
    if (n === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, batch.subarray(0, n * STRIDE), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    n = 0;
  };

  const circleScale = (rad) => (2 * rad) / (sprites.get("hitcircle")?.h1 || 128);

  function glyphsFor(text, family) {
    const out = [];
    for (const ch of text) {
      const key = /\d/.test(ch) ? ch : SPECIAL_GLYPHS[ch];
      const name = key === undefined ? null : `${family}-${key}`;
      if (!name || blank.has(name) || !sprites.has(name)) return null;
      out.push(sprites.get(name));
    }
    return out;
  }

  function drawGlyphs(text, family, scale, gap, x, y, align, a) {
    const glyphs = glyphsFor(text, family);
    if (!glyphs) return false;
    if (glyphs.length === 0) return true;
    const step = gap * scale;
    const widths = glyphs.map((g) => g.w1 * scale);
    const total = widths.reduce((s, w) => s + w, 0) - step * (glyphs.length - 1);
    let px = align === "right" ? x - total : align === "left" ? x : x - total / 2;
    glyphs.forEach((g, i) => {
      const w = widths[i];
      const h = g.h1 * scale;
      put(px + w / 2, y, w / 2, h / 2, WHITE, a, MODE_SPRITE, 0, g.uv);
      px += w - step;
    });
    return true;
  }

  const sliderCache = new Map();
  function sliderCentres(index, points, radius) {
    let entry = sliderCache.get(index);
    if (entry) return entry;
    const step = Math.max(1, radius * 0.12);
    const out = [];
    if (points.length >= 2) {
      out.push(points[0], points[1]);
      let carry = 0;
      for (let i = 0; i + 3 < points.length; i += 2) {
        const x0 = points[i];
        const y0 = points[i + 1];
        const x1 = points[i + 2];
        const y1 = points[i + 3];
        const len = Math.hypot(x1 - x0, y1 - y0);
        let d = step - carry;
        while (d <= len) {
          const f = d / len;
          out.push(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
          d += step;
        }
        carry = len - (d - step);
      }
      const ex = points[points.length - 2];
      const ey = points[points.length - 1];
      if (out[out.length - 2] !== ex || out[out.length - 1] !== ey) out.push(ex, ey);
    }
    entry = Float32Array.from(out);
    sliderCache.set(index, entry);
    return entry;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      overlay.width = w;
      overlay.height = h;
    }
  }

  function draw(frame) {
    resize();
    const { t, data, count, colours, preempt, fadeIn, radius, sliderPoints } = frame;
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (veil === null) gl.clearColor(0, 0, 0, 1);
    else gl.clearColor(0, 0, 0, veil);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const view = frame.view || PLAYFIELD_VIEW;
    gl.uniform2f(uSize, view.w, view.h);
    gl.uniform2f(uOrigin, view.x, view.y);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);

    const rec = (i) => data.subarray(i * 16, i * 16 + 16);
    const col = (idx) => {
      const c = colours[idx % colours.length];
      return c ? rgb01(c) : WHITE;
    };
    const appearAt = (start) => Math.min(1, Math.max(0, (t - (start - preempt)) / fadeIn));
    const hidden = !!frame.hidden;
    const hiddenAt = (start) => {
      const inA = Math.min(1, Math.max(0, (t - (start - preempt)) / (0.4 * preempt)));
      const outA = Math.min(1, Math.max(0, (t - (start - 0.6 * preempt)) / (0.3 * preempt)));
      return inA * (1 - outA);
    };
    const hiddenBody = (start, end) => {
      const from = start - preempt + fadeIn;
      const k = Math.min(1, Math.max(0, (t - from) / Math.max(1, end - from)));
      return (1 - k) * (1 - k);
    };
    const fadeAt = (start, judged, judgedAt, res) => {
      let a = appearAt(start);
      if (judged) {
        const hit = res >= RES.MEH && res <= RES.PERFECT;
        a *= Math.max(0, 1 - (t - judgedAt) / (hit ? 240 : 120));
      }
      return a;
    };
    const dot = (x, y, c, a) => {
      push(x, y, radius * 0.28, WHITE, 0.95 * a, MODE_FILL, 0);
      push(x, y, radius * 0.2, c, 0.9 * a, MODE_FILL, 0);
    };
    const px = circleScale(radius);
    const numbers = [];

    const top = frame.top ?? count;
    const snaking = frame.snaking || {};
    const ballFrames = framesOf(/^sliderb\d+$/);
    const followFrames = framesOf(/^followpoint(-\d+)?$/);

    // Pass 0: follow points between the objects of a combo, under everything else.
    for (let i = 0; i + 1 < top; i++) {
      const a = rec(i);
      const b = rec(i + 1);
      if (b[7] === 1 || a[0] === KIND.SPINNER || b[0] === KIND.SPINNER) continue;
      if (t < a[4] || t > b[4]) continue;
      const fade = Math.min(1, (t - a[4]) / (preempt * 0.5)) * Math.min(1, (b[4] - t) / 100);
      const [ex, ey] = a[0] === KIND.SLIDER ? sliderEnd(a[15], sliderPoints) : [a[1], a[2]];
      const dx = b[1] - ex;
      const dy = b[2] - ey;
      const dist = Math.hypot(dx, dy);
      const usable = dist - a[3] - b[3];
      const m = Math.floor(usable / FOLLOW_SPACING);
      if (m < 1 || dist === 0) continue;
      const ang = Math.atan2(dy, dx);
      const name = followFrames.length ? followFrames[Math.floor(t / 100) % followFrames.length] : null;
      for (let k = 1; k <= m; k++) {
        const d = a[3] + (usable * k) / (m + 1);
        const x = ex + (dx / dist) * d;
        const y = ey + (dy / dist) * d;
        if (!name || !sprite(name, x, y, a[3] * 0.5, WHITE, 0.9 * fade, ang)) push(x, y, 1.8, WHITE, 0.7 * fade, MODE_FILL, 0);
      }
    }

    // Helper to check if a slider has repeats (reverses)
    const sliderHasReverses = (sliderIndex) => {
      for (let j = 0; j < count; j++) {
        const other = rec(j);
        if (other[0] === KIND.REPEAT && other[15] === sliderIndex) return true;
      }
      return false;
    };

    // Pass 1: slider bodies
    const bg = [0, 0, 0];
    for (let i = count - 1; i >= 0; i--) {
      const r = rec(i);
      if (r[0] !== KIND.SLIDER) continue;
      const start = r[4];
      const end = r[5];
      if (t < start - preempt || t > end + 240) continue;
      let a = appearAt(start) * (t > end ? Math.max(0, 1 - (t - end) / 240) : 1);
      if (hidden) a *= hiddenBody(start, end);
      if (a <= 0) continue;
      const rad = r[3];
      const full = sliderCentres(r[15], sliderPoints(r[15]), rad);
      
      const hasReverses = sliderHasReverses(r[15]);
      // Sliders with reverse arrows / repeats do not snake in or out in osu!lazer
      const f1 = (snaking.in && !hasReverses) ? Math.min(1, Math.max(0, (t - (start - preempt)) / preempt)) : 1;
      const f0 = (snaking.out && t > start && !hasReverses) ? Math.min(1, Math.max(0, (t - start) / Math.max(1, end - start))) : 0;
      
      const pts = (snaking.in || snaking.out) && !hasReverses ? subPath(full, f0, f1) : full;
      if (pts.length < 2) continue;

      const defaultTrack = [32 / 255, 32 / 255, 32 / 255];
      const baseTrack = sliderTrack || defaultTrack;
      const body = baseTrack.map((c) => c * 0.85 + bg[0] * 0.15);
      const edge = body.map((c) => c * 0.65);
      const core = body.map((c) => Math.min(1, c * 1.35 + 0.15));

      const bw = borderWidth(rad);
      const numPts = pts.length >> 1;

      // Draw border layer across all points
      const borderCol = shade(sliderBorder || WHITE, a);
      const borderStride = Math.max(1, Math.round((0.25 * rad) / Math.max(1, rad * 0.12)));
      for (let k = 0; k < pts.length; k += 2 * borderStride) {
        push(pts[k], pts[k + 1], rad, borderCol, 1, MODE_FILL, 0);
      }
      push(pts[pts.length - 2], pts[pts.length - 1], rad, borderCol, 1, MODE_FILL, 0);

      // Draw gradient layers (skip inner layers on endpoints when path is long enough to prevent concentric rings)
      for (let s = 0; s < GRADIENT_STEPS; s++) {
        const f = s / (GRADIENT_STEPS - 1);
        const mix = [0, 1, 2].map((k) => edge[k] + (core[k] - edge[k]) * f);
        const lr = ((rad - bw) * (GRADIENT_STEPS - s)) / GRADIENT_STEPS;
        const c = shade(mix, a);
        const stride = Math.max(1, Math.round((0.25 * lr) / Math.max(1, rad * 0.12)));

        const startIdx = (s > 0 && numPts >= 3) ? 2 : 0;
        const endIdx = (s > 0 && numPts >= 3) ? pts.length - 4 : pts.length - 2;

        for (let k = startIdx; k <= endIdx; k += 2 * stride) {
          push(pts[k], pts[k + 1], lr, c, 1, MODE_FILL, 0);
        }
        if (s === 0 || numPts < 3) {
          push(pts[pts.length - 2], pts[pts.length - 1], lr, c, 1, MODE_FILL, 0);
        }
      }
    }
    flush();

    // Pass 2: slider ticks, repeat arrows and tails, then the spinner.
    for (let i = 0; i < count; i++) {
      const r = rec(i);
      const kind = r[0];
      if (kind === KIND.TICK || kind === KIND.REPEAT || kind === KIND.TAIL) {
        const start = r[4];
        if (t < start - preempt || t > start + 150) continue;
        const judged = r[8] !== 0;
        if (judged && t - r[9] > 150) continue;
        const a = fadeAt(start, judged, r[9], r[10]);
        if (a <= 0) continue;
        const c = col(r[6]);
        const x = r[1];
        const y = r[2];
        if (kind === KIND.TICK) {
          if (!sprite("sliderscorepoint", x, y, size1x("sliderscorepoint", px), WHITE, 0.95 * a)) {
            push(x, y, radius * 0.2, WHITE, 0.9 * a, MODE_FILL, 0);
          }
        } else if (kind === KIND.REPEAT) {
          const ang = arrowAngle(sliderCentres(r[15], sliderPoints(r[15]), r[3]), x, y);
          if (!sprite("reversearrow", x, y, size1x("reversearrow", px), WHITE, 0.95 * a, ang)) dot(x, y, c, a);
        } else if (sprite("sliderendcircle", x, y, size1x("sliderendcircle", px), c, 0.95 * a)) {
          if (hasSprite("sliderendcircleoverlay")) {
            sprite("sliderendcircleoverlay", x, y, size1x("sliderendcircleoverlay", px), WHITE, 0.95 * a);
          }
        } else {
          dot(x, y, c, a);
        }
      } else if (kind === KIND.SPINNER) {
        const start = r[4];
        const end = r[5];
        if (t < start - preempt || t > end + 300) continue;
        const a = appearAt(start) * (t > end ? Math.max(0, 1 - (t - end) / 300) : 1);
        const [cx, cy] = SPINNER_CENTRE;
        const R = SPINNER_RADIUS;
        if (!sprite("spinner-background", cx, cy, 2 * R, WHITE, 0.9 * a)) {
          push(cx, cy, R, [0, 0, 0], 0.35 * a, MODE_FILL, 0);
        }
        if (t < start) {
          const p = Math.min(1, Math.max(0, (t - (start - preempt)) / preempt));
          sprite("spinner-approachcircle", cx, cy, 2 * R, WHITE, 0.6 * a * p);
        }
        if (!sprite("spinner-circle", cx, cy, 2 * R, WHITE, 0.4 * a)) push(cx, cy, R, WHITE, 0.4 * a, MODE_RING, 2.5);
        const prog = Math.min(1, Math.max(0, r[11]));
        if (prog > 0) {
          const dots = Math.max(1, Math.ceil((prog * 2 * Math.PI * R) / 1.6));
          for (let k = 0; k <= dots; k++) {
            const ang = -Math.PI / 2 + (prog * 2 * Math.PI * k) / dots;
            push(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, 2.8, WHITE, a, MODE_FILL, 0);
          }
        }
      }
    }
    flush();

    // Pass 3: circles and slider heads, latest first.
    const hitLighting = frame.hitLighting !== false;
    for (let i = count - 1; i >= 0; i--) {
      const r = rec(i);
      const kind = r[0];
      if (kind !== KIND.CIRCLE && kind !== KIND.HEAD) continue;
      const start = r[4];
      if (t < start - preempt) continue;
      const judged = r[8] !== 0;
      const hit = judged && r[10] >= RES.MEH && r[10] <= RES.PERFECT;
      const dt = judged ? t - r[9] : 0;
      const fadeMs = Math.max(20, frame.hitFade ?? 200);
      const flashMs = Math.max(fadeMs, 300);
      if (judged && (hit ? dt > flashMs : dt > 120)) continue;
      let a = hidden && !judged ? hiddenAt(start) : appearAt(start);
      let s = 1;
      let flash = 0;
      if (judged && hit) {
        const u = Math.min(1, dt / fadeMs);
        s = 1 - 0.2 * (1 - Math.exp(-6 * u) * Math.cos(9 * u));
        a *= (1 - u) ** 2;
        flash = Math.min(1, dt / 60) * Math.max(0, 1 - dt / flashMs);
      } else if (judged) {
        a *= Math.max(0, 1 - dt / 120);
      }
      if (a <= 0 && flash <= 0) continue;
      const x = r[1];
      const y = r[2];
      const rad = r[3];
      const c = col(r[6]);
      const body = kind === KIND.HEAD && hasSprite("sliderstartcircle") ? "sliderstartcircle" : "hitcircle";
      const overlay = hasSprite(`${body}overlay`) ? `${body}overlay` : "hitcircleoverlay";
      const d = 2 * rad * s;
      const rr = rad * s;
      const drawBody = () => {
        if (!sprite(body, x, y, d, c, 0.95 * a)) push(x, y, rr, c, 0.95 * a, MODE_FILL, 0);
      };
      const drawOverlay = () => {
        if (!sprite(overlay, x, y, d, WHITE, 0.95 * a)) push(x, y, rr, WHITE, 0.95 * a, MODE_RING, 4);
      };
      const drawFlash = () => {
        if (flash > 0) sprite("glow", x, y, 2 * rad * (hitLighting ? 2.6 : 1.9), c, 0.9 * flash);
      };
      const drawNumber = () => {
        if (judged) return;
        if (!drawGlyphs(String(r[7]), "digit", circleScale(rad), hitOverlap, x, y, "centre", a)) {
          numbers.push({ text: String(r[7]), x, y, a });
        }
      };
      if (overlayAboveNumber) {
        drawBody();
        drawNumber();
        drawOverlay();
      } else {
        drawBody();
        drawOverlay();
        drawNumber();
      }
      drawFlash();
      if (!judged && t <= start && !hidden) {
        const p = Math.min(1, Math.max(0, (t - (start - preempt)) / preempt));
        const approach = rad * APPROACH_START * (1 + 3 * (1 - p));
        if (!sprite("approachcircle", x, y, 2 * approach, c, 0.9 * a)) push(x, y, approach, c, 0.9 * a, MODE_RING, 3);
      }
    }
    flush();

    // Pass 4: slider balls, and follow circle.
    for (let i = 0; i < count; i++) {
      const r = rec(i);
      if (r[0] !== KIND.SLIDER || t < r[4] || t > r[5]) continue;
      const x = r[12];
      const y = r[13];
      const rad = r[3];
      if (r[14] !== 0 && !sprite("sliderfollowcircle", x, y, 3.2 * rad, WHITE, 0.9)) {
        push(x, y, rad * 1.6, WHITE, 0.5, MODE_RING, 2);
      }
      const c = col(r[6]);
      if (ballFrames.length) {
        const name = ballFrames[Math.floor(t / (1000 / 60)) % ballFrames.length];
        sprite(name, x, y, size1x(name, px), c, 1);
        if (hasSprite("sliderb-nd")) sprite("sliderb-nd", x, y, size1x("sliderb-nd", px), c, 1);
        if (hasSprite("sliderb-spec")) sprite("sliderb-spec", x, y, size1x("sliderb-spec", px), WHITE, 0.8);
      } else {
        push(x, y, rad * 0.26, c, 1, MODE_FILL, 0);
        push(x, y, rad * 0.1, WHITE, 0.6, MODE_FILL, 0);
      }
    }
    flush();

    if (frame.cursor) {
      const cur = frame.cursor;
      const scale = cur.size || 1;
      for (const p of cur.trail || []) {
        const age = t - p.t;
        if (age < 0 || age > TRAIL_MS) continue;
        const k = 1 - age / TRAIL_MS;
        if (!hasSprite("cursortrail") || !sprite("cursortrail", p.x, p.y, size1x("cursortrail", px) * scale * k, WHITE, 0.7 * k)) {
          push(p.x, p.y, 2.5 * k * scale, WHITE, 0.4 * k, MODE_FILL, 0);
        }
      }
      if (!sprite("cursor", cur.x, cur.y, size1x("cursor", px) * scale, WHITE, 1, cur.angle || 0)) {
        push(cur.x, cur.y, 4 * scale, WHITE, 0.9, MODE_FILL, 0);
      }
    }
    flush();

    drawOverlay(frame, rec, count, numbers, view);
  }

  function drawOverlay(frame, rec, count, numbers, view) {
    const { t, preempt, radius } = frame;
    const sx = overlay.width / view.w;
    const sy = overlay.height / view.h;
    const ox = (x) => (x - view.x) * sx;
    const oy = (y) => (y - view.y) * sy;
    ctx2d.clearRect(0, 0, overlay.width, overlay.height);
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";

    if (frame.flashlight) {
      const fl = frame.flashlight;
      const cx = ox(fl.x);
      const cy = oy(fl.y);
      const r = fl.r * sx;
      ctx2d.fillStyle = `rgba(0,0,0,${FLASHLIGHT_DARKNESS})`;
      ctx2d.fillRect(0, 0, overlay.width, overlay.height);
      ctx2d.globalCompositeOperation = "destination-out";
      const hole = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, r);
      hole.addColorStop(0, "rgba(0,0,0,1)");
      hole.addColorStop(0.8, "rgba(0,0,0,1)");
      hole.addColorStop(1, "rgba(0,0,0,0)");
      ctx2d.fillStyle = hole;
      ctx2d.fillRect(0, 0, overlay.width, overlay.height);
      ctx2d.globalCompositeOperation = "source-over";
    }

    if (frame.dim > 0) {
      ctx2d.fillStyle = `rgba(0,0,0,${Math.min(1, frame.dim)})`;
      ctx2d.fillRect(0, 0, overlay.width, overlay.height);
    }

    ctx2d.font = `600 ${Math.round(radius * sy * 0.9)}px system-ui, sans-serif`;
    ctx2d.fillStyle = "#fff";
    for (const num of numbers) {
      ctx2d.globalAlpha = num.a;
      ctx2d.fillText(num.text, ox(num.x), oy(num.y));
    }
    ctx2d.globalAlpha = 1;

    const labels = { [RES.GREAT]: "300", [RES.PERFECT]: "300g", [RES.OK]: "100", [RES.MEH]: "50", [RES.MISS]: "X" };
    const images = { [RES.GREAT]: "hit300", [RES.PERFECT]: "hit300g", [RES.OK]: "hit100", [RES.MEH]: "hit50", [RES.MISS]: "hit0" };
    ctx2d.font = `700 ${Math.round(14 * sy)}px system-ui, sans-serif`;
    for (let i = 0; i < count; i++) {
      const r = rec(i);
      if (r[8] === 0) continue;
      const dt = t - r[9];
      if (dt < 0 || dt > 500) continue;
      const label = labels[r[10]];
      if (!label) continue;
      const name = images[r[10]];
      if (blank.has(name)) continue;
      const py = oy(r[2] - radius * 1.4 - dt * 0.03);
      ctx2d.globalAlpha = 1 - dt / 500;
      const bmp = bitmaps.get(name);
      if (bmp) {
        const h = radius * 0.9 * sy;
        const w = (h * bmp.width) / bmp.height;
        ctx2d.drawImage(bmp, ox(r[1]) - w / 2, py - h / 2, w, h);
      } else {
        ctx2d.fillStyle = r[10] === RES.MISS ? "#f55" : "#9f9";
        ctx2d.fillText(label, ox(r[1]), py);
      }
    }
    ctx2d.globalAlpha = 1;

    if (frame.skipHint) {
      ctx2d.font = `600 ${Math.round(16 * sy)}px system-ui, sans-serif`;
      ctx2d.fillStyle = "rgba(255,255,255,0.8)";
      ctx2d.fillText(frame.skipHint, ox(PF_W / 2), oy(PF_H * 0.8));
    }

    if (frame.hud) {
      ctx2d.save();
      hud.draw(ctx2d, {
        t,
        w: overlay.width,
        h: overlay.height,
        hud: frame.hud,
        modsText: frame.modsText,
        keys: frame.keys,
        skin: hudSkin,
      });
      ctx2d.restore();
    }

    if (frame.resume) {
      const r = frame.resume;
      const cpx = circleScale(radius);
      const size = r.size || 1;
      if (r.pointer) promptCursor(ox(r.pointer.x), oy(r.pointer.y), cpx * sy * size, 4 * sy * size, [1, 1, 1], 1);
      if (r.alpha > 0) {
        promptCursor(ox(r.x), oy(r.y), cpx * sy * size * r.scale, 4 * sy * size * r.scale, cursorTint(r.mix), r.alpha);
      }
      drawResumeText(ctx2d, r, overlay.width, overlay.height);
    }
  }

  let tintCanvas = null;
  function promptCursor(x, y, k, dotR, rgb, alpha) {
    const s = legacySprites.get("cursor");
    ctx2d.save();
    ctx2d.globalAlpha = alpha;
    if (!s) {
      ctx2d.fillStyle = `rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})`;
      ctx2d.beginPath();
      ctx2d.arc(x, y, dotR, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.restore();
      return;
    }
    let img = s.bmp;
    if (rgb.some((v) => v < 1) && typeof document !== "undefined") {
      tintCanvas = tintCanvas || document.createElement("canvas");
      tintCanvas.width = s.bmp.width;
      tintCanvas.height = s.bmp.height;
      const g = tintCanvas.getContext("2d");
      g.globalCompositeOperation = "source-over";
      g.drawImage(s.bmp, 0, 0);
      g.globalCompositeOperation = "multiply";
      g.fillStyle = `rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})`;
      g.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(s.bmp, 0, 0);
      img = tintCanvas;
    }
    const w = s.w1 * k;
    const h = s.h1 * k;
    ctx2d.drawImage(img, x - w / 2, y - h / 2, w, h);
    ctx2d.restore();
  }

  function reset() {
    sliderCache.clear();
    hud.reset();
  }

  return { draw, resize, reset, setSkin, setVeil, spriteNames: () => [...sprites.keys()] };
}