// Checks for hud.js against a recording stand-in for the 2D context: the combo pop and miss flash,
// the rolling counters, the health bar's hold after a miss, the reset when song time goes back, and
// the legacy path that draws a skin's own digits. Run: node tests/hud_check.mjs
import { createHud, songProgress } from "../hud.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? `  [${detail}]` : ""));
  if (!ok) failures++;
}

// A context that records what the HUD draws: texts with their colour, scale calls, and images.
function stubContext() {
  const log = { texts: [], scales: [], images: [], rects: [], fills: [], moves: [], arcs: [] };
  const grad = () => ({ addColorStop() {} });
  // The horizontal extent of the current path, so a filled rounded bar can be measured.
  let path = { minX: Infinity, maxX: -Infinity };
  const stack = [];
  const reach = (...xs) => {
    for (const x of xs) {
      path.minX = Math.min(path.minX, x);
      path.maxX = Math.max(path.maxX, x);
    }
  };
  const ctx = {
    font: "", textAlign: "", textBaseline: "", fillStyle: "", globalAlpha: 1,
    // save and restore keep the opacity and blend mode, as a canvas does, so one part's settings do not leak.
    save() { stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation }); },
    restore() { Object.assign(this, stack.pop() || {}); },
    beginPath() { path = { minX: Infinity, maxX: -Infinity }; },
    moveTo(x) { reach(x); },
    lineTo(x) { reach(x); },
    arcTo(x1, y1, x2) { reach(x1, x2); },
    closePath() {},
    fill() { log.fills.push({ fill: this.fillStyle, w: path.maxX - path.minX }); },
    clip() {},
    fillRect(x, y, w, h) { log.rects.push({ x, y, w, h, fill: this.fillStyle }); },
    translate(x, y) { log.moves.push([x, y]); },
    rotate() {},
    arc(x, y, r) { log.arcs.push({ x, y, r }); },
    stroke() {},
    scale(x) { log.scales.push(x); },
    createLinearGradient: grad,
    createRadialGradient: grad,
    measureText(str) { return { width: str.length * 20 }; },
    fillText(str) { log.texts.push({ str, colour: this.fillStyle, alpha: this.globalAlpha }); },
    drawImage(img, ...rest) { log.images.push({ img, rest, alpha: this.globalAlpha, comp: this.globalCompositeOperation }); },
  };
  return { ctx, log };
}

const H = 768;      // lazer lays its HUD out on 1024 x 768, so u = 1 and lazer units are pixels
const W = 1024;
const frame = (t, combo, extra = {}) => ({
  t,
  w: W,
  h: H,
  hud: { score: 1000, accuracy: 0.98, combo, health: 1, ...extra },
  modsText: "",
  keys: null,
});
const comboScaleOf = (log) => log.scales[0];      // argonCombo is the only scale user on the default look

// --- Argon combo: a hit pops the counter to 1.1 times its size, easing back to 1 over 500 ms.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  hud.draw(ctx, { ...frame(0, 0), skin: null });
  log.scales.length = 0;
  hud.draw(ctx, frame(1000, 1));
  check("Argon: the first hit pops the combo to 1.1", near(comboScaleOf(log), 1.1), `${comboScaleOf(log)}`);
  log.scales.length = 0;
  hud.draw(ctx, frame(1250, 1));
  const mid = comboScaleOf(log);
  check("Argon: the pop eases out (between 1 and 1.1 halfway)", mid > 1 && mid < 1.1, `${mid}`);
  log.scales.length = 0;
  hud.draw(ctx, frame(1500, 1));
  check("Argon: the pop is back to 1 after 500 ms", near(comboScaleOf(log), 1, 0.001), `${comboScaleOf(log)}`);
}

// --- A miss (combo back to 0 from above 1) shrinks the counter to 0.8 and flashes the number red.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  hud.draw(ctx, frame(0, 0));
  hud.draw(ctx, frame(1000, 5));
  hud.draw(ctx, frame(3000, 5));
  log.scales.length = 0;
  log.texts.length = 0;
  hud.draw(ctx, frame(3000, 0));
  check("Argon: a miss scales the counter by 0.8", near(comboScaleOf(log), 0.8, 0.001), `${comboScaleOf(log)}`);
  // The count rolls down from 5 over 250 ms, so the number drawn at once is still rolling.
  const num = log.texts.find((x) => x.str.endsWith("x") && x.alpha === 1);
  check("Argon: the counter flashes red at once after a miss", num && num.colour === "rgb(255,0,0)", num && `${num.str} ${num.colour}`);
  log.texts.length = 0;
  hud.draw(ctx, frame(5000, 0));
  const later = log.texts.find((x) => x.str === "0x");
  check("Argon: the red has faded to white after 2 s", later && later.colour === "rgb(255,255,255)", later && later.colour);
}

// --- Rolling: the score rolls to a new value over 250 ms of song time.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  hud.draw(ctx, frame(0, 0, { score: 0 }));
  hud.draw(ctx, frame(1000, 0, { score: 1000 }));
  log.texts.length = 0;
  hud.draw(ctx, frame(1125, 0, { score: 1000 }));
  // The score has three digits here; the accuracy's whole part (98) does not.
  const half = log.texts.find((x) => x.alpha === 1 && x.str.length === 3 && /^\d+$/.test(x.str));
  check("Score: rolls up over 250 ms", half && Number(half.str) > 0 && Number(half.str) < 1000, half && half.str);
  log.texts.length = 0;
  hud.draw(ctx, frame(1300, 0, { score: 1000 }));
  const done = log.texts.find((x) => x.str === "1000" && x.alpha === 1);
  check("Score: lands on its value after the roll", !!done, log.texts.map((x) => x.str).join(","));
}

// --- Health: a miss keeps the red bar for 600 ms before it shrinks back. The red path runs to the old
// health and the white fill to the new one, so the red that shows is the gap between their widths.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const widthsOf = (colour) => log.fills.filter((f) => f.fill === colour).map((f) => f.w);
  const visibleRed = () => {
    const red = Math.max(0, ...widthsOf("#ff5d5d"));
    const white = Math.max(0, ...widthsOf("#fff"));
    return red - white;
  };
  hud.draw(ctx, frame(0, 0, { health: 1 }));
  log.fills.length = 0;
  hud.draw(ctx, frame(1000, 0, { health: 0.5 }));
  check("Health: a miss leaves a red bar", visibleRed() > 100, `${visibleRed().toFixed(1)} px`);
  log.fills.length = 0;
  hud.draw(ctx, frame(1500, 0, { health: 0.5 }));
  check("Health: the red bar holds until 600 ms after the miss", visibleRed() > 100, `${visibleRed().toFixed(1)} px`);
  log.fills.length = 0;
  hud.draw(ctx, frame(4000, 0, { health: 0.5 }));
  check("Health: the red bar shrinks back once the hold ends", visibleRed() < 2, `${visibleRed().toFixed(1)} px`);
}

// --- Going back in song time (a restart or seek) resets the counters.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  hud.draw(ctx, frame(0, 0, { score: 0 }));
  hud.draw(ctx, frame(5000, 3, { score: 5000 }));
  hud.draw(ctx, frame(100, 0, { score: 0 }));
  log.texts.length = 0;
  hud.draw(ctx, frame(100, 0, { score: 0 }));
  const zero = log.texts.find((x) => x.str === "0" && x.alpha === 1);
  check("Reset: going back in song time shows the new values at once", !!zero, log.texts.map((x) => x.str).join(","));
}

// --- Legacy skin: its own digits draw with drawImage, the Argon labels do not.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const bmp = { width: 60, height: 80, close() {} };
  const sprite = { bmp, w1: 30, h1: 40 };
  const sprites = new Map();
  for (const d of "0123456789") {
    sprites.set(`score-${d}`, sprite);
    sprites.set(`combo-${d}`, sprite);
  }
  sprites.set("score-dot", sprite);
  sprites.set("score-percent", sprite);
  sprites.set("combo-x", sprite);
  sprites.set("scorebar-bg", { bmp, w1: 410, h1: 80 });
  const frames = [{ bmp, w1: 410, h1: 40 }];
  const skin = {
    sprite: (n) => sprites.get(n) || null,
    overlap: () => 10,
    barFrameCount: () => frames.length,
    barFrame: (i) => frames[i] || null,
  };
  hud.draw(ctx, { ...frame(0, 0), skin });
  hud.draw(ctx, { ...frame(1000, 7), skin });
  const argonLabels = log.texts.filter((x) => x.str === "COMBO" || x.str === "ACCURACY");
  check("Legacy: no Argon labels when the skin draws the HUD", argonLabels.length === 0);
  check("Legacy: the skin's digits are drawn as images", log.images.length > 20, `${log.images.length} images`);
  check("Legacy: the health bar uses the skin's background", log.images.some((i) => i.img === bmp && i.rest[2] === 410));
}

// --- Partial skin: a skin with score digits but no combo digits still gets the legacy counter (lazer's
// legacy HUD always does), drawn as plain text, and never Argon's label.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const bmp = { width: 60, height: 80, close() {} };
  const sprite = { bmp, w1: 30, h1: 40 };
  const sprites = new Map();
  for (const d of "0123456789") sprites.set(`score-${d}`, sprite);
  const skin = { sprite: (n) => sprites.get(n) || null, overlap: () => 0, barFrameCount: () => 0, barFrame: () => null };
  hud.draw(ctx, { ...frame(0, 0), skin });
  hud.draw(ctx, { ...frame(1000, 4), skin });
  check("Partial skin: no Argon label", !log.texts.some((x) => x.str === "COMBO"));
  check("Partial skin: the new count pops out as plain text", log.texts.some((x) => x.str === "4x"));
  log.texts.length = 0;
  hud.draw(ctx, { ...frame(1200, 4), skin });
  check("Partial skin: the count itself is plain text after 160 ms", log.texts.some((x) => x.str === "4x" && x.alpha === 1));
}

// Skins whose digits and bitmaps name themselves, so a check can read which digits were drawn.
function namedSkin({ combo = true, extra = {}, frames = [] } = {}) {
  const made = new Map();
  const sprite = (name, w1 = 30, h1 = 40) => ({ bmp: { id: name, width: w1, height: h1, close() {} }, w1, h1 });
  for (const d of "0123456789") {
    made.set(`score-${d}`, sprite(`score-${d}`));
    if (combo) made.set(`combo-${d}`, sprite(`combo-${d}`));
  }
  if (combo) made.set("combo-x", sprite("combo-x"));
  for (const [name, s] of Object.entries(extra)) made.set(name, sprite(name, s.w1, s.h1));
  return {
    active: () => true,
    sprite: (n) => made.get(n) || null,
    overlap: () => 0,
    barFrameCount: () => frames.length,
    barFrame: (i) => frames[i] || null,
  };
}
// The combo digits drawn in the count (not the popping copy, which is additive), and in the copy.
const countDigits = (log) => log.images
  .filter((i) => i.comp !== "lighter" && i.img.id.startsWith("combo-")).map((i) => i.img.id.slice(6)).join("");
const popDigits = (log) => log.images
  .filter((i) => i.comp === "lighter" && i.img.id.startsWith("combo-")).map((i) => i.img.id.slice(6)).join("");

// --- Legacy combo, lazer's LegacyDefaultComboCounter: a hit pops a copy of the new count out at once, and the
// count changes 160 ms later with a small pulse.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const sk = namedSkin();
  hud.draw(ctx, { ...frame(0, 6), skin: sk });
  log.images.length = 0;
  log.scales.length = 0;
  hud.draw(ctx, { ...frame(1000, 7), skin: sk });
  check("Legacy combo: the hit pops out the new count at once", popDigits(log) === "7x", popDigits(log));
  check("Legacy combo: the popping copy is additive at 0.6 opacity", log.images.some((i) => i.comp === "lighter" && near(i.alpha, 0.6)));
  check("Legacy combo: the count still shows the old value until 160 ms", countDigits(log) === "6x", countDigits(log));
  log.images.length = 0;
  log.scales.length = 0;
  hud.draw(ctx, { ...frame(1200, 7), skin: sk });
  check("Legacy combo: the count changes 160 ms after the hit", countDigits(log) === "7x", countDigits(log));
  check("Legacy combo: the count pulses about 1.06 at 40 ms into the change", near(log.scales[1], 1.064, 0.001), `${log.scales[1]}`);
  log.images.length = 0;
  hud.draw(ctx, { ...frame(1500, 7), skin: sk });
  check("Legacy combo: the popping copy is gone after 300 ms", popDigits(log) === "", popDigits(log));
}

// --- Legacy miss: the count rolls down to zero at 20 ms a step, the "0x" fades out over 100 ms, and nothing
// is drawn once it has gone.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const sk = namedSkin();
  hud.draw(ctx, { ...frame(0, 0), skin: sk });
  hud.draw(ctx, { ...frame(1000, 5), skin: sk });
  hud.draw(ctx, { ...frame(3000, 5), skin: sk });
  hud.draw(ctx, { ...frame(3000, 0), skin: sk });
  log.images.length = 0;
  hud.draw(ctx, { ...frame(3020, 0), skin: sk });
  check("Legacy miss: the count rolls down, 20 ms a step", countDigits(log) === "4x", countDigits(log));
  log.images.length = 0;
  hud.draw(ctx, { ...frame(3100, 0), skin: sk });
  check("Legacy miss: at zero the 0x is still there", countDigits(log) === "0x", countDigits(log));
  log.images.length = 0;
  hud.draw(ctx, { ...frame(3150, 0), skin: sk });
  const fading = log.images.find((i) => i.comp !== "lighter" && i.img.id.startsWith("combo-"));
  check("Legacy miss: the 0x fades over 100 ms", fading && near(fading.alpha, 0.5, 0.01), fading && `${fading.alpha}`);
  log.images.length = 0;
  hud.draw(ctx, { ...frame(3200, 0), skin: sk });
  check("Legacy miss: nothing is drawn once faded", countDigits(log) === "", countDigits(log));
}

// --- Legacy health bar: a skin with one colour image (no animation frames) still gets the legacy bar, the
// older ki marker sits at the fill's end, and the newer marker puts the fill further in.
{
  const colour = { w1: 362, h1: 30 };
  const ki = { w1: 20, h1: 20 };
  const bgSpec = { w1: 410, h1: 50 };
  const hud = createHud();
  const { ctx, log } = stubContext();
  const sk = namedSkin({ combo: false, extra: { "scorebar-bg": bgSpec, "scorebar-colour": colour, "scorebar-ki": ki } });
  hud.draw(ctx, { ...frame(0, 0), skin: sk });
  const fill = log.images.find((i) => i.img.id === "scorebar-colour");
  check("Legacy health: a single colour image is drawn", !!fill);
  check("Legacy health: the older fill sits at 4.8 units across", fill && near(fill.rest[4], 4.8, 0.01), fill && `${fill.rest[4]}`);
  const marker = log.images.find((i) => i.img.id === "scorebar-ki");
  check("Legacy health: the ki marker sits at the fill's end, centred", marker && near(marker.rest[0], 4.8 + 362 - 10, 0.01)
    && near(marker.rest[1], 16 - 10, 0.01), marker && `${marker.rest[0]},${marker.rest[1]}`);

  const hud2 = createHud();
  const second = stubContext();
  const sk2 = namedSkin({ combo: false, extra: { "scorebar-bg": bgSpec, "scorebar-colour": colour, "scorebar-marker": ki } });
  hud2.draw(second.ctx, { ...frame(0, 0), skin: sk2 });
  const fill2 = second.log.images.find((i) => i.img.id === "scorebar-colour");
  check("Legacy health: the newer fill sits 12 units across", fill2 && near(fill2.rest[4], 12, 0.01), fill2 && `${fill2.rest[4]}`);
  const marker2 = second.log.images.find((i) => i.img.id === "scorebar-marker");
  check("Legacy health: the newer marker sits on the fill's middle line", marker2 && near(marker2.rest[1], 12.48 + 15 - 10, 0.01),
    marker2 && `${marker2.rest[1]}`);

  // Low health swaps the ki for the danger heads.
  const hud3 = createHud();
  const third = stubContext();
  const sk3 = namedSkin({ combo: false, extra: { "scorebar-bg": bgSpec, "scorebar-colour": colour, "scorebar-ki": ki, "scorebar-kidanger": ki } });
  hud3.draw(third.ctx, { ...frame(0, 0, { health: 0.3 }), skin: sk3 });
  check("Legacy health: a low health uses the danger head", third.log.images.some((i) => i.img.id === "scorebar-kidanger"));
}

// --- The Argon backdrop is drawn once into a cached canvas, which the HUD then copies each frame.
{
  const made = [];
  const layerCtx = stubContext().ctx;
  const fakeCanvas = { width: 0, height: 0, getContext: () => layerCtx };
  const hud = createHud({ makeCanvas: () => { made.push(fakeCanvas); return fakeCanvas; } });
  const { ctx, log } = stubContext();
  hud.draw(ctx, frame(0, 0));
  hud.draw(ctx, frame(16, 0));
  const copies = log.images.filter((i) => i.img === fakeCanvas);
  check("Backdrop: made once, then copied each frame", made.length === 1 && copies.length === 2,
    `made ${made.length}, copied ${copies.length}`);
  check("Backdrop: the cached canvas is sized for the wedges and bar", fakeCanvas.width > 400 && fakeCanvas.height > 70,
    `${fakeCanvas.width}x${fakeCanvas.height}`);
  hud.draw(ctx, { ...frame(32, 0), h: 720, w: 1280 });
  check("Backdrop: a new window size makes a new cached canvas", made.length === 2);
}

// --- Legacy keys: each key shows its trigger name (K1, M1) until its first press, then its press count, with
// the skin's key icon behind it. The skin's text colour is a function, as the renderer exposes it.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const sk = namedSkin({ combo: false, extra: { "inputoverlay-key": { w1: 60, h1: 60 } } });
  sk.keyText = () => [255, 255, 255];
  const keysAt = (count) => [
    { label: "Z", name: "K1", count, down: false },
    { label: "M", name: "M1", count: 0, down: false, enabled: true },
  ];
  hud.draw(ctx, { ...frame(0, 0, { }), keys: keysAt(0), skin: sk });
  const names = log.texts.filter((x) => x.str === "K1" || x.str === "M1").map((x) => x.str);
  check("Legacy keys: each key shows its trigger name before a press", names.join(",") === "K1,M1", names.join(","));
  check("Legacy keys: the skin's key icon is drawn behind each key", log.images.filter((i) => i.img.id === "inputoverlay-key").length === 2);
  check("Legacy keys: the skin's text colour is used", log.texts.some((x) => x.str === "K1" && x.colour === "rgb(255,255,255)"));
  hud.draw(ctx, { ...frame(16, 0, { }), keys: keysAt(3), skin: sk });
  log.texts.length = 0;
  hud.draw(ctx, { ...frame(200, 0, { }), keys: keysAt(3), skin: sk });
  check("Legacy keys: once the 160 ms fade is over, a pressed key shows only its count",
    log.texts.some((x) => x.str === "3") && !log.texts.some((x) => x.str === "K1"));
}

// --- An empty glyph (a transparent percent sign, say) still takes its place in the number.
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const sk = namedSkin({});
  sk.sprite = ((base) => (n) => (n === "score-percent" ? { bmp: null, w1: 1, h1: 1 } : base(n)))(sk.sprite);
  hud.draw(ctx, { ...frame(0, 0), skin: sk });
  check("Empty glyph: the number is drawn without a null image", log.images.every((i) => i.img !== null));
}

// --- The legacy layout, from lazer's LegacySkin / OsuLegacySkinTransformer, on a 1024 x 768 canvas (u = 1).
{
  const hud = createHud();
  const { ctx, log } = stubContext();
  const sk = namedSkin({ extra: { "score-dot": { w1: 10, h1: 40 }, "score-percent": { w1: 20, h1: 40 }, "inputoverlay-key": { w1: 60, h1: 60 } } });
  const keysAll = [
    { label: "Z", name: "K1", count: 0, down: false },
    { label: "X", name: "K2", count: 0, down: false },
    { label: "M1", name: "M1", count: 0, down: false, enabled: true },
    { label: "M2", name: "M2", count: 0, down: false, enabled: true },
  ];
  const errors = { list: [{ offset: 20, res: 5, at: 0 }], windows: [50, 100, 150] };
  hud.draw(ctx, { ...frame(0, 0, { progress: { start: -2000, first: 1000, last: 5000 }, errors }), keys: keysAll, skin: sk });
  const score = log.images.filter((i) => i.img.id && i.img.id.startsWith("score-") && i.rest[1] === 0);
  const right = Math.max(...score.map((i) => i.rest[0] + i.rest[2]));
  check("Legacy score: 8 digits in the top right corner, 10 units in, at 0.96", score.length === 8 && near(right, W - 10),
    `${score.length} glyphs, right edge ${right}`);
  const acc = log.images.filter((i) => i.img.id && i.img.id.startsWith("score-") && i.rest[1] > 0);
  const accTop = acc.length ? acc[0].rest[1] : -1;
  const accRight = Math.max(...acc.map((i) => i.rest[0] + i.rest[2]));
  check("Legacy accuracy: 9 units under the score, 17 in from the edge", near(accTop, 40 * 0.96 + 9) && near(accRight, W - 17),
    `top ${accTop}, right ${accRight}`);
  const ring = log.arcs.find((a) => near(a.r, 33 / 2 - 1));
  check("Song progress: a 33 unit ring on the accuracy's middle line", !!ring && near(ring.y, accTop + 40 * 0.576 / 2),
    ring ? `y ${ring.y}` : "none");
  const keyMoves = log.moves.filter((m) => near(m[0], W - 23));
  check("Legacy keys: four 46 unit boxes, the first centred 64 + 7 + 23 units from the middle",
    keyMoves.length === 4 && near(keyMoves[0][1], H / 2 - 64 + 7 + 23) && near(keyMoves[1][1] - keyMoves[0][1], 47.2),
    keyMoves.map((m) => m[1].toFixed(1)).join(","));
  const back = log.rects.find((r) => r.fill === "#000");
  check("Hit error bar: as wide as the meh window at 1.6 units a ms, on the bottom edge, centred",
    !!back && near(back.w, 150 * 1.6) && near(back.x, W / 2 - 120) && near(back.y, H - 19.2), back ? JSON.stringify(back) : "none");
  const line = log.rects.find((r) => r.fill === "#66ccff" && near(r.w, 3));
  check("Hit error bar: a great 20 ms late lands right of centre", !!line && near(line.x + 1.5, W / 2 + (20 / 150 / 2) * 240),
    line ? `${line.x}` : "none");
}
{
  const intro = songProgress(-500, { start: -2000, first: 1000, last: 5000 });
  const mid = songProgress(3000, { start: -2000, first: 1000, last: 5000 });
  check("Song progress: the intro runs from the clock's start to the first note", intro.intro && near(intro.p, 0.5), JSON.stringify(intro));
  check("Song progress: then from the first note to the end of the last", !mid.intro && near(mid.p, 0.5), JSON.stringify(mid));
}

function near(a, b, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}

console.log(failures ? `${failures} failed` : "all HUD checks passed");
process.exit(failures ? 1 : 0);
