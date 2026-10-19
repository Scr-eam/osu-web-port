// The heads-up display over the playfield: score, accuracy, combo, health, the mods in play, and
// the key indicators. It is drawn on the 2D overlay, so it sits above the flashlight and the dim
// layers, as lazer's HUD does.
//
// The default look follows lazer's Argon HUD (ArgonSkin.cs, ArgonComboCounter, ArgonScoreCounter,
// ArgonAccuracyCounter, ArgonHealthDisplay): a combo counter bottom left that pops on each hit and
// flashes red on a miss, the score under the health bar, accuracy top right, and the keys bottom
// right. A skin that supplies its own digits or health bar gets those instead, placed as lazer's
// legacy components place them (LegacyDefaultComboCounter, LegacyScoreCounter, LegacyAccuracyCounter,
// LegacyHealthDisplay).
//
// Lazer's Torus font and argon-counter digits are not in this port, so Argon's digits use a system
// font, and its wireframe digits are ghost "8"s at the wireframe opacity. Positions are in lazer
// units: lazer lays its HUD out on a 1024 x 768 area scaled to fit the window (ScalingContainer,
// DrawSizePreservingFillContainer with its Minimum strategy), so u = min(w / 1024, h / 768) overlay pixels
// per unit. A legacy skin's 1x pixel is one unit (LegacySkin.GetTexture: ScaleAdjust 1, or 2 for @2x).

const FONT = '"Torus", "Nunito Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const CAP = 0.72;                     // cap height of the font, as a fraction of its em size
const LABEL = "#99ddff";              // OsuColour.Blue0, the colour of the labels above the counters
const GHOST = 0.25;                   // ArgonCounterTextComponent's default wireframe opacity
const ROLL_MS = 250;                  // RollingDuration of the Argon counters
const SHEAR = 0.8;                    // ArgonWedgePiece's shear: the wedges lean right going down
const WEDGE_RGB = "102,204,255";      // ArgonWedgePiece's accent, #66CCFF
const GLOW_RGB = "126,215,253";       // ArgonHealthDisplay's glow, #7ED7FD
const DAMAGE = "#ff5d5d";             // the red bar a miss leaves behind
const LEGACY_COMBO = 1.28;            // LegacyDefaultComboCounter's scale
const LEGACY_SCORE = 0.96;            // LegacyScoreCounter's scale
const LEGACY_ACCURACY = 0.6 * 0.96;   // LegacyAccuracyCounter's scale
const STABLE_MAGIC = 1.6;             // LegacySkin.STABLE_MAGIC_SCALE_FACTOR, for the health bar's offsets
const LEGACY_DELAY = 160;             // the combo count changes this long after a hit (big_pop_out_duration - 140)
const LEGACY_POP = 300;               // the copy that pops out after a hit grows and fades over this long
const LEGACY_ROLL = 20;               // a roll down to zero takes this long a step (rolling_duration)
const LEGACY_FADE = 100;              // the count fades out over this long once it reaches zero
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const SPECIAL = { ",": "comma", ".": "dot", "%": "percent", x: "x" };
const NO_SKIN = { sprite: () => null, overlap: () => 0, barFrameCount: () => 0, barFrame: () => null };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const outQuint = (p) => 1 - (1 - p) ** 5;
const font = (px, weight) => `${weight} ${px}px ${FONT}`;

// A number that rolls to its new value over ROLL_MS of song time, as lazer's counters do.
class Roll {
  constructor() {
    this.init = false;
    this.from = 0;
    this.to = 0;
    this.at = 0;
  }
  set(v, t) {
    if (!this.init) {
      this.init = true;
      this.from = this.to = v;
      this.at = t;
      return;
    }
    if (v === this.to) return;
    this.from = this.value(t);
    this.to = v;
    this.at = t;
  }
  value(t) {
    if (!this.init) return 0;
    const p = clamp((t - this.at) / ROLL_MS, 0, 1);
    return this.from + (this.to - this.from) * p;
  }
}

function defaultCanvas() {
  return typeof document !== "undefined" ? document.createElement("canvas") : null;
}

function measure(ctx, str, px, weight = 600) {
  ctx.font = font(px, weight);
  return ctx.measureText(str).width;
}

// Text on the alphabetic baseline at (x, y), aligned as given.
function text(ctx, str, x, y, px, { weight = 600, align = "right", colour = "#fff", alpha = 1 } = {}) {
  ctx.font = font(px, weight);
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colour;
  ctx.globalAlpha = alpha;
  ctx.fillText(str, x, y);
}

// A skin's own digits: each glyph sits on the baseline, `unit` overlay pixels per 1x skin pixel, and
// glyphs overlap by the skin's Overlap value. Characters the skin lacks are skipped.
function skinText(ctx, sk, family, str, x, baseline, unit, align) {
  const parts = [];
  for (const ch of str) {
    const key = /\d/.test(ch) ? ch : SPECIAL[ch];
    const s = key === undefined ? null : sk.sprite(`${family}-${key}`);
    if (s) parts.push(s);
  }
  const gap = sk.overlap(family) * unit;
  const widths = parts.map((s) => s.w1 * unit);
  const total = widths.reduce((a, b) => a + b, 0) - gap * Math.max(0, parts.length - 1);
  let px = align === "right" ? x - total : x;
  parts.forEach((s, i) => {
    const gh = s.h1 * unit;
    if (s.bmp) ctx.drawImage(s.bmp, px, baseline - gh, widths[i], gh);   // an empty glyph only takes its space
    px += widths[i] - gap;
  });
}

function rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// One of the Argon wedges behind the health bar: a parallelogram leaning right, fading in downwards.
function wedge(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, `rgba(${WEDGE_RGB},0)`);
  g.addColorStop(1, `rgba(${WEDGE_RGB},0.25)`);
  const s = SHEAR * h;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w + s, y + h);
  ctx.lineTo(x + s, y + h);
  ctx.closePath();
  ctx.fill();
}

// Argon's score: digits only, no zero padding, right aligned at rightX with the top at topY.
// Returns the baseline, so a counter below it can be stacked.
function argonScore(ctx, u, value, rightX, topY) {
  const px = 40 * u;
  const str = String(value);
  const base = topY + CAP * px;
  text(ctx, "8".repeat(str.length), rightX, base, px, { alpha: GHOST });
  text(ctx, str, rightX, base, px);
  return base;
}

// Argon's accuracy: a label, then the whole part, a half-size fraction and the percent sign, on one
// baseline. Its wireframes are ghost "8"s, as the score's are.
function argonAccuracy(ctx, u, value, rightX, topY) {
  const [whole, frac = "00"] = value.toFixed(2).split(".");
  const big = 40 * u;
  const small = 20 * u;
  const base = topY + 12 * u + CAP * big;
  const labelBase = topY + CAP * 12 * u;
  const percentW = measure(ctx, "%", big);
  const fracText = `.${frac}`;
  const fracRight = rightX - percentW;
  const wholeRight = fracRight - measure(ctx, fracText, small);
  // The whole part is as wide as its widest of label, ghost and digits; its digits sit at the right.
  const label = "ACCURACY";
  const wholeLeft = wholeRight - Math.max(
    measure(ctx, "888", big),
    measure(ctx, whole, big),
    measure(ctx, label, 12 * u, 700) + 2.5 * u,
  );
  text(ctx, label, wholeLeft + 2.5 * u, labelBase, 12 * u, { weight: 700, align: "left", colour: LABEL });
  text(ctx, "888", wholeRight, base, big, { alpha: GHOST });
  text(ctx, whole, wholeRight, base, big);
  text(ctx, ".88", fracRight, base, small, { alpha: GHOST });
  text(ctx, fracText, fracRight, base, small);
  text(ctx, "8", rightX, base, big, { alpha: GHOST });
  text(ctx, "%", rightX, base, big);
}

// The Argon backdrop: the two wedges and the health bar's dark background. It never changes, so
// the overlay draws it from a cached layer when it can (see layerFor).
function backdrop(ctx, u) {
  wedge(ctx, -50 * u, 15 * u, 380 * u, 72 * u);
  wedge(ctx, -46 * u, 20 * u, 380 * u, 72 * u);
  rrect(ctx, 50 * u, 20 * u, 300 * u, 30 * u, 10 * u);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();
}

// Argon's health fill: white up to shown, a glow at its end, and a red bar from shown to glow where
// health was lost. shown and glow are fractions of the bar. The bar's ends are rounded shapes, not a
// clip, which is much cheaper to draw every frame.
function argonHealth(ctx, u, shown, glow) {
  const x = 50 * u;
  const y = 20 * u;
  const w = 300 * u;
  const h = 30 * u;
  const r = 10 * u;
  if (glow > shown) {
    rrect(ctx, x, y, w * glow, h, r);
    ctx.fillStyle = DAMAGE;
    ctx.fill();
  }
  const fillW = w * shown;
  if (fillW > 0) {
    rrect(ctx, x, y, fillW, h, r);
    ctx.fillStyle = "#fff";
    ctx.fill();
    const cx = x + fillW;
    const cy = y + h / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 1.5);
    g.addColorStop(0, `rgba(${GLOW_RGB},0.5)`);
    g.addColorStop(1, `rgba(${GLOW_RGB},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(Math.max(x, cx - h * 1.5), y, Math.min(x + w, cx + h * 1.5) - Math.max(x, cx - h * 1.5), h);
  }
}

// The skin's own health bar: its background at the top left, and the animated fill cropped to the
// health. The fill is offset as lazer's new-style legacy fill is.
// Lazer's LegacyHealthDisplay: the background, the colour fill cropped to the health, and a marker at the
// fill's end. A skin with scorebar-marker has the fill further in and the marker on its middle line. An older
// skin marks the end with its ki heads, which change to the danger heads as health falls. shown is the bar's
// length (a fraction) and hp the health; a skin with one colour image rather than animation frames uses it.
function legacyHealth(ctx, sk, u, t, shown, hp) {
  const bg = sk.sprite("scorebar-bg");
  if (bg) {
    ctx.globalAlpha = 1;
    ctx.drawImage(bg.bmp, 0, 0, bg.w1 * u, bg.h1 * u);
  }
  const n = sk.barFrameCount();
  const fill = n > 0 ? sk.barFrame(((Math.floor((t * 60) / 1000) % n) + n) % n) : sk.sprite("scorebar-colour");
  const newStyle = !!sk.sprite("scorebar-marker");
  const ox = (newStyle ? 7.5 : 3) * STABLE_MAGIC;
  const oy = (newStyle ? 7.8 : 10) * STABLE_MAGIC;
  const w = fill ? fill.w1 * shown : 0;
  if (fill && w > 0) {
    ctx.globalAlpha = 1;
    ctx.drawImage(fill.bmp, 0, 0, fill.bmp.width * shown, fill.bmp.height, ox * u, oy * u, w * u, fill.h1 * u);
  }
  const marker = newStyle
    ? sk.sprite("scorebar-marker")
    : sk.sprite(hp < 0.2 ? "scorebar-kidanger2" : hp < 0.5 ? "scorebar-kidanger" : "scorebar-ki");
  if (marker) {
    ctx.globalAlpha = 1;
    const my = newStyle ? oy + (fill ? fill.h1 : 0) / 2 : oy;
    centred(ctx, marker, (ox + w) * u, my * u, u);
  }
}

// A skin sprite drawn with its centre at (x, y), in overlay pixels.
function centred(ctx, s, x, y, u) {
  ctx.drawImage(s.bmp, x - (s.w1 * u) / 2, y - (s.h1 * u) / 2, s.w1 * u, s.h1 * u);
}

// Argon's combo counter: the label, then the number and its ghost, right aligned, with an "x".
// scale is the pop, about the number's top left; colour is the number's colour (red after a miss).
function argonCombo(ctx, u, H, value, scale, colour) {
  const s = 1.3;                                    // ArgonSkin scales the combo counter by 1.3
  const px = 40 * u * s;
  const labelPx = 12 * u * s;
  const x0 = 36 * u;
  const base = H - 66 * u;
  const top = base - CAP * px;                      // cap top of the digits
  const ghost = `${"8".repeat(Math.max(1, String(value).length))}x`;
  const ghostW = measure(ctx, ghost, px);
  text(ctx, "COMBO", x0 + 2.5 * u * s, top - 12 * u * s + CAP * labelPx, labelPx,
    { weight: 700, align: "left", colour: LABEL });
  ctx.save();
  ctx.translate(x0, top);
  ctx.scale(scale, scale);
  text(ctx, ghost, ghostW, CAP * px, px, { alpha: GHOST });
  text(ctx, `${value}x`, ghostW, CAP * px, px, { colour });
  ctx.restore();
}

// Lazer's LegacyDefaultComboCounter, as a function of song time. update() keeps the state: legacyCount is
// the count and when it changes, legacyPop the copy that pops out after a hit, and legacyRoll the roll down
// after a miss. The count shown at t: its value and opacity. Nothing is shown at rest at zero.
function legacyShown(count, roll, t) {
  if (roll) {
    const p = clamp((t - roll.at) / roll.dur, 0, 1);
    const value = Math.round(roll.from * (1 - p));
    return { value, alpha: value > 0 ? 1 : 1 - clamp((t - roll.at - roll.dur) / LEGACY_FADE, 0, 1) };
  }
  if (!count) return { value: 0, alpha: 0 };
  const value = t >= count.at ? count.to : count.from;
  return { value, alpha: value > 0 ? 1 : 0 };
}

// The small pulse the count gives when it changes: up to 1.1 over 50 ms (ease in), back to 1 over 50 ms.
function legacyPulse(count, t) {
  if (!count || count.to <= count.from) return 1;
  const d = t - count.at;
  if (d < 0 || d >= 100) return 1;
  if (d < 50) return 1 + 0.1 * (d / 50) ** 2;
  const p = (d - 50) / 50;
  return 1.1 - 0.1 * (1 - (1 - p) ** 2);
}

// The count's text, left aligned on the origin's baseline: the skin's digits, or with none a plain number
// about as tall as a default skin's.
function legacyText(ctx, sk, unit, str, hasDigits) {
  if (hasDigits) {
    skinText(ctx, sk, "combo", str, 0, 0, unit, "left");
    return;
  }
  ctx.font = font(40 * unit, 700);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.fillText(str, 0, 0);
}

// Bottom left, 10 units in from the corner. The copy that pops out is additive, starts at 0.6 opacity and
// grows from 1.56 to 1 as it fades.
function legacyCombo(ctx, sk, u, H, hasDigits, count, pulse, pop) {
  const unit = LEGACY_COMBO * u;
  ctx.save();
  ctx.translate(10 * u, H - 10 * u);
  if (pop) {
    const k = 1 + 0.56 * (1 - pop.p);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.6 * (1 - pop.p);
    ctx.scale(k, k);
    legacyText(ctx, sk, unit, `${pop.value}x`, hasDigits);
    ctx.restore();
  }
  if (count.alpha > 0) {
    ctx.save();
    ctx.globalAlpha = count.alpha;
    ctx.scale(pulse, pulse);
    legacyText(ctx, sk, unit, `${count.value}x`, hasDigits);
    ctx.restore();
  }
  ctx.restore();
}

// The keys, bottom right: lit while the key or button is down.
function keys(ctx, u, w, H, list) {
  const shown = (list || []).filter((k) => k.enabled !== false);
  if (shown.length === 0) return;
  const bw = 28 * u;
  const bh = 24 * u;
  const gap = 6 * u;
  let x = w - 36 * u - (shown.length * bw + (shown.length - 1) * gap);
  const y = H - 66 * u - bh;
  ctx.font = font(12 * u, 700);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 1;
  for (const k of shown) {
    ctx.fillStyle = k.down ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.12)";
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = k.down ? "#000" : "#ddd";
    ctx.fillText(k.label, x + bw / 2, y + bh / 2);
    x += bw + gap;
  }
}

// Lazer's LegacySpriteText: the skin's glyphs for str, laid left to right and top aligned (legacy glyphs
// have no baseline), each pulled in by the font's overlap. With fixed width, digits take the width of the
// skin's "5" and sit centred in it (FixedWidthReferenceCharacter), as the score and accuracy text does.
// Returns the run, with its size in overlay pixels; null when the skin has none of the glyphs.
function glyphRun(sk, family, str, unit, fixed = false) {
  const five = fixed ? sk.sprite(`${family}-5`) : null;
  const parts = [];
  for (const ch of str) {
    const key = /\d/.test(ch) ? ch : SPECIAL[ch];
    const s = key === undefined ? null : sk.sprite(`${family}-${key}`);
    if (!s) continue;
    parts.push({ s, adv: five && /\d/.test(ch) ? five.w1 : s.w1 });
  }
  if (parts.length === 0) return null;
  const gap = sk.overlap(family);
  const width = parts.reduce((a, q) => a + q.adv, 0) - gap * (parts.length - 1);
  const height = parts.reduce((a, q) => Math.max(a, q.s.h1), 0);
  return { parts, gap, unit, w: width * unit, h: height * unit };
}
function drawRun(ctx, run, left, top) {
  let x = left;
  for (const q of run.parts) {
    const gw = q.s.w1 * run.unit;
    if (q.s.bmp) ctx.drawImage(q.s.bmp, x + (q.adv * run.unit - gw) / 2, top, gw, q.s.h1 * run.unit);
    x += (q.adv - run.gap) * run.unit;
  }
}
// Text for a skin that lacks the glyphs: a plain font, sized as a default skin's digits roughly are.
function plainRun(ctx, str, px) {
  return { plain: str, px, w: measure(ctx, str, px, 700), h: px * CAP };
}
function drawAnyRun(ctx, run, left, top) {
  if (run.plain === undefined) {
    drawRun(ctx, run, left, top);
    return;
  }
  text(ctx, run.plain, left, top + run.h, run.px, { weight: 700, align: "left" });
}

// Lazer's LegacySongProgress: a 33 unit ring with a white border, a pie at 0.92 of its size, and a 4 unit
// dot in the middle. Through the intro the pie is green and empties anticlockwise; then it fills white,
// clockwise from the top, as the map goes on. (cx, cy) is its centre.
function songPie(ctx, u, cx, cy, progress) {
  const r = (33 / 2) * u;
  const { intro, p } = progress;
  const amount = clamp(intro ? 1 - p : p, 0, 1);
  if (amount > 0) {
    const top = -Math.PI / 2;
    const sweep = amount * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    if (intro) ctx.arc(cx, cy, r * 0.92, top, top - sweep, true);
    else ctx.arc(cx, cy, r * 0.92, top, top + sweep, false);
    ctx.closePath();
    ctx.fillStyle = intro ? "rgba(199,255,47,0.6)" : "rgba(255,255,255,0.6)";
    ctx.globalAlpha = 1;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r - u, 0, Math.PI * 2);
  ctx.lineWidth = 2 * u;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 2 * u, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
}

// Where the song is, as lazer's SongProgress has it: through the intro (from the clock's start to the first
// note), then from the first note to the end of the last.
export function songProgress(t, pr) {
  const cur = Math.min(t, pr.last);
  if (cur < pr.first) return { intro: true, p: pr.first > pr.start ? (cur - pr.start) / (pr.first - pr.start) : 1 };
  return { intro: false, p: pr.last > pr.first ? (cur - pr.first) / (pr.last - pr.first) : 0 };
}

// Lazer's LegacyBarHitErrorMeter (stable's ScoreMeterError), bottom centre. The bar is as wide as the meh
// window, at STABLE_MAGIC units per ms; its coloured bands are the meh, ok and great windows. Each hit leaves a
// 3 unit line where it landed (late to the right), at 0.4 opacity fading out over 10 s, and the arrow above
// moves to a running average of where hits land.
const HIT_BAR = 3;
const HIT_COLOUR = { [5]: "#66ccff", [3]: "#88b300", [2]: "#ffcc22" };   // great, ok, meh (OsuColour.ForHitResult)
function hitErrorBar(ctx, u, w, H, errors, t, arrowRel) {
  const [great, ok, meh] = errors.windows;
  const maxW = Math.max(1, great, ok, meh);
  const bw = maxW * STABLE_MAGIC * u;
  const bh = HIT_BAR * 4 * STABLE_MAGIC * u;
  const cx = w / 2;
  const top = H - bh;
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = "#000";
  ctx.fillRect(cx - bw / 2, top, bw, bh);
  ctx.globalAlpha = 1;
  const barH = HIT_BAR * STABLE_MAGIC * u;
  for (const [win, colour] of [[meh, HIT_COLOUR[2]], [ok, HIT_COLOUR[3]], [great, HIT_COLOUR[5]]]) {
    const bwide = win * STABLE_MAGIC * u;
    ctx.fillStyle = colour;
    ctx.fillRect(cx - bwide / 2, top + bh / 2 - barH / 2, bwide, barH);
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(cx - (1.5 * STABLE_MAGIC * u) / 2, top, 1.5 * STABLE_MAGIC * u, bh);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const e of errors.list) {
    const age = t - e.at;
    if (age < 0 || age >= 10000) continue;
    const rel = clamp(e.offset / maxW / 2, -0.5, 0.5);
    ctx.globalAlpha = 0.4 * (1 - age / 10000);
    ctx.fillStyle = HIT_COLOUR[e.res] || "#fff";
    ctx.fillRect(cx + rel * bw - 1.5 * u, top, 3 * u, bh);
  }
  ctx.restore();
  // The arrow: a 10.2 x 4.8 triangle hanging from the bar's top edge, pointing down.
  const ax = cx + arrowRel * bw;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(ax - 5.1 * u, top);
  ctx.lineTo(ax + 5.1 * u, top);
  ctx.lineTo(ax, top + 4.8 * u);
  ctx.closePath();
  ctx.fill();
}

// Lazer's legacy key counter (LegacyKeyCounterDisplay, LegacyKeyCounter, and its place in
// OsuLegacySkinTransformer): anchored to the middle of the right edge, its top 40 * STABLE_MAGIC units above
// the middle. The skin's inputoverlay-background is turned 90 degrees down the right edge (stretched 1.05
// along its length); the keys are 46 unit boxes 7 units down, 1.2 apart. Each shows the skin's key icon at its
// own size, with the trigger's name (K1, M1) until its first press and then the count in the scoreentry font.
// A pressed key shrinks to 0.75 over 160 ms and its icon turns yellow (keys) or pink (mouse buttons).
const KEY_BOX = 46;
const KEY_SPACE = 1.2;
const KEY_MS = 160;
const KEY_ACTIVE = ["#ffde00", "#ffde00", "#f8009e", "#f8009e"];
const outQuad = (p) => 1 - (1 - p) * (1 - p);

function legacyKeys(ctx, sk, u, w, H, list, anims, t, tint) {
  const shown = (list || []).filter((k) => k.enabled !== false);
  if (shown.length === 0) return;
  const top = H / 2 - 40 * STABLE_MAGIC * u;
  const bg = sk.sprite("inputoverlay-background");
  if (bg && bg.bmp) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.translate(w + 0.5 * u, top);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bg.bmp, 0, 0, bg.w1 * 1.05 * u, bg.h1 * u);
    ctx.restore();
  }
  const icon = sk.sprite("inputoverlay-key");
  const rgbText = sk.keyText ? sk.keyText() : null;
  const colour = rgbText ? `rgb(${rgbText.join(",")})` : "#000";   // lazer's default when the skin sets none
  shown.forEach((k, i) => {
    const a = anims[i] || { scale: () => 1, firstAt: null };
    const cx = w - (KEY_BOX / 2) * u;
    const cy = top + 7 * u + i * (KEY_BOX + KEY_SPACE) * u + (KEY_BOX / 2) * u;
    ctx.save();
    ctx.translate(cx, cy);
    const sc = a.scale(t);
    ctx.scale(sc, sc);
    ctx.globalAlpha = 1;
    if (icon && icon.bmp) {
      const img = k.down ? tint(icon.bmp, KEY_ACTIVE[i] || KEY_ACTIVE[3]) : icon.bmp;
      ctx.drawImage(img, -(icon.w1 * u) / 2, -(icon.h1 * u) / 2, icon.w1 * u, icon.h1 * u);
    }
    // The name fades out and the count in over 160 ms from the first press.
    const p = a.firstAt === null ? 0 : clamp((t - a.firstAt) / KEY_MS, 0, 1);
    if (p < 1) {
      const px = 16 * u;                            // OsuFont's default size, semibold
      text(ctx, k.name || k.label, 0, (CAP * px) / 2, px, { weight: 600, align: "center", colour, alpha: 1 - p });
    }
    if (p > 0) {
      const run = glyphRun(sk, "scoreentry", String(k.count), u);
      ctx.globalAlpha = p;
      if (run) {
        drawRun(ctx, run, -run.w / 2, -run.h / 2);
      } else {
        const px = 16 * u;
        text(ctx, String(k.count), 0, (CAP * px) / 2, px, { weight: 700, align: "center", colour, alpha: p });
      }
    }
    ctx.restore();
  });
}

// makeCanvas makes an offscreen canvas for the cached backdrop. Without one (a test with no document),
// the backdrop is drawn every frame.
export function createHud({ makeCanvas = defaultCanvas } = {}) {
  let layer = null;                                 // { u, canvas } for the Argon backdrop
  let lastT = null;                                 // song time of the last draw, or null
  let comboPrev;                                    // combo at the last draw
  let comboRoll = new Roll();
  let comboPop = null;                              // Argon: { from, at, dur }, the scale pop
  let comboFlash = null;                            // Argon: { at, dur }, the red after a miss
  let legacyCount = null;                           // legacy: { from, to, at }, the count changing to `to` at `at`
  let legacyPop = null;                             // legacy: { value, at }, the copy that pops out after a hit
  let legacyRoll = null;                            // legacy: { from, at, dur }, the roll down after a miss
  let scoreRoll = new Roll();
  let accRoll = new Roll();
  let health = null;                                // { shown, glow, last, holdUntil }
  let keyAnims = [];                                // per key: { down, from, at, firstAt, scale(t) }
  let arrow = { floating: 0, from: 0, to: 0, at: -Infinity, seen: new WeakSet() };
  const tints = new Map();                          // "colour" -> Map(bitmap -> tinted canvas)

  // The key icon in the pressed colour, made once per bitmap and colour. Without a canvas (tests), as it is.
  function tinted(bmp, colour) {
    if (!makeCanvas) return bmp;
    let byBmp = tints.get(colour);
    if (!byBmp) tints.set(colour, (byBmp = new Map()));
    let c = byBmp.get(bmp);
    if (c) return c;
    c = makeCanvas();
    if (!c) return bmp;
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext("2d");
    if (!g) return bmp;
    g.drawImage(bmp, 0, 0);
    g.globalCompositeOperation = "multiply";       // the sprite's colour times the tint, as lazer's Colour
    g.fillStyle = colour;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-in"; // keep the sprite's own alpha
    g.drawImage(bmp, 0, 0);
    byBmp.set(bmp, c);
    return c;
  }

  // Each key's press animation: to 0.75 when down and back to 1, 160 ms with Easing.Out (quadratic).
  function updateKeys(list, t) {
    const shown = (list || []).filter((k) => k.enabled !== false);
    shown.forEach((k, i) => {
      let a = keyAnims[i];
      if (!a) {
        a = keyAnims[i] = {
          down: false, from: 1, at: -Infinity, firstAt: null,
          scale(now) {
            const target = this.down ? 0.75 : 1;
            const p = clamp((now - this.at) / KEY_MS, 0, 1);
            return this.from + (target - this.from) * outQuad(p);
          },
        };
      }
      if (k.down !== a.down) {
        a.from = a.scale(t);
        a.down = k.down;
        a.at = t;
      }
      if (k.count > 0 && a.firstAt === null) a.firstAt = t;
      if (k.count === 0) a.firstAt = null;
    });
  }

  // The hit error arrow: each new hit moves the running average 20% of the way to it, and the arrow eases
  // there over 800 ms (Easing.Out), as LegacyBarHitErrorMeter does.
  function arrowAt(t, list) {
    for (const e of list) {
      if (arrow.seen.has(e)) continue;
      arrow.seen.add(e);
      arrow.from = arrowNow(t);
      arrow.floating = arrow.floating * 0.8 + e.rel * 0.2;
      arrow.to = arrow.floating;
      arrow.at = t;
    }
    return arrowNow(t);
  }
  function arrowNow(t) {
    const p = clamp((t - arrow.at) / 800, 0, 1);
    return arrow.from + (arrow.to - arrow.from) * outQuad(p);
  }

  function reset() {
    lastT = null;
    comboPrev = undefined;
    comboRoll = new Roll();
    comboPop = null;
    comboFlash = null;
    legacyCount = null;
    legacyPop = null;
    legacyRoll = null;
    scoreRoll = new Roll();
    accRoll = new Roll();
    health = null;
    keyAnims = [];
    arrow = { floating: 0, from: 0, to: 0, at: -Infinity, seen: new WeakSet() };
  }

  function layerFor(u) {
    if (!makeCanvas) return null;
    if (layer && layer.u === u) return layer.canvas;
    const canvas = makeCanvas();
    if (!canvas) return null;
    canvas.width = Math.ceil(442 * u) + 2;          // x from -50 to 392 units, y from 15 to 93 units
    canvas.height = Math.ceil(78 * u) + 2;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.translate(50 * u, -15 * u);                   // the layer's origin is (-50, 15) units
    backdrop(g, u);
    layer = { u, canvas };
    return canvas;
  }

  function comboScale(t) {
    if (!comboPop) return 1;
    const e = outQuint(clamp((t - comboPop.at) / comboPop.dur, 0, 1));
    return comboPop.from + (1 - comboPop.from) * e;
  }

  function comboColour(t) {
    if (!comboFlash) return "#fff";
    // Lazer flashes the number red and fades it back to white.
    const e = outQuint(clamp((t - comboFlash.at) / comboFlash.dur, 0, 1));
    const g = Math.round(255 * e);
    return `rgb(255,${g},${g})`;
  }

  // The legacy count's change from prev to c at song time t. A hit changes the count LEGACY_DELAY later
  // and pops a copy out now; a miss rolls the count down from what is shown; anything else sets it at once.
  function legacyChange(prev, c, t) {
    if (c === prev + 1) {
      legacyRoll = null;
      legacyCount = { from: prev, to: c, at: t + LEGACY_DELAY };
      legacyPop = { value: c, at: t };
    } else if (c === 0) {
      const from = legacyShown(legacyCount, legacyRoll, t).value;
      legacyCount = null;
      legacyRoll = from > 0 ? { from, at: t, dur: from * LEGACY_ROLL } : null;
    } else {
      legacyRoll = null;
      legacyCount = { from: c, to: c, at: t };
    }
  }

  // Brings the counters to song time t and the frame's values. Paused time does not move them.
  function update(t, hud) {
    if (lastT !== null && t < lastT - 1) reset();   // restarted or sought back
    const dt = lastT === null ? 0 : t - lastT;
    lastT = t;

    const c = hud.combo | 0;
    if (comboPrev === undefined) {
      comboRoll.set(c, t);
      legacyCount = { from: c, to: c, at: t };
    } else if (c !== comboPrev) {
      const up = c > comboPrev;
      const miss = comboPrev > 1 && c === 0;
      const from = clamp(comboScale(t) * (up ? 1.1 : 0.8), 0.6, 1.4);
      comboPop = { from, at: t, dur: miss ? 2000 : 500 };
      if (miss) comboFlash = { at: t, dur: 2000 };
      comboRoll.set(c, t);
      legacyChange(comboPrev, c, t);
    }
    comboPrev = c;

    scoreRoll.set(Math.round(hud.score || 0), t);
    accRoll.set((hud.accuracy || 0) * 100, t);

    // Health: the white bar follows the health; after a miss the red bar stays for 600 ms, then shrinks.
    const hp = clamp(hud.health ?? 0, 0, 1);
    if (!health) {
      health = { shown: hp, glow: hp, last: hp, holdUntil: -Infinity };
    } else {
      if (hp < health.last - 1e-6) health.holdUntil = t + 600;
      const k = 1 - Math.exp(-0.05 * dt);           // about 50 a second, as lazer's damping
      health.shown += (hp - health.shown) * k;
      if (hp > health.glow) health.glow += (hp - health.glow) * k;
      else if (t >= health.holdUntil) health.glow += (hp - health.glow) * (1 - Math.exp(-0.01 * dt));
      health.last = hp;
    }
  }

  // Draws the HUD on ctx, which is the overlay's 2D context, sized w x H pixels. env: { t, hud,
  // modsText, keys, skin }, where skin is the accessor the renderer gives for the loaded skin.
  function draw(ctx, env) {
    const { t, hud, modsText, skin } = env;
    if (!hud) return;
    update(t, hud);
    updateKeys(env.keys, t);
    if (hud.errors) {
      const maxW = Math.max(1, ...hud.errors.windows);
      for (const e of hud.errors.list) if (e.rel === undefined) e.rel = clamp(e.offset / maxW / 2, -0.5, 0.5);
    }
    let w = env.w;
    const H = env.h;
    const sk = skin || NO_SKIN;
    // A loaded skin takes the legacy look for the combo counter and health bar, as lazer's legacy HUD does.
    const skinOn = !!skin && (skin.active ? skin.active() : true);
    // Legacy skins are drawn for a 16:9 screen: elements sit by the top-left (the health bar, whose
    // background is often a whole-screen picture with panels for the score and a frame round the playfield)
    // and by the right edge (score, accuracy, keys). On a wider window the HUD is laid out in a centred 16:9
    // area, so those line up with each other and with the centred playfield as the skin intends.
    const wide = skinOn && w / H > 16 / 9 + 0.01;
    const hudX = wide ? (w - (H * 16) / 9) / 2 : 0;
    if (wide) w = (H * 16) / 9;
    const u = Math.min(w / 1024, H / 768);
    const hp = clamp(hud.health ?? 0, 0, 1);
    const digitsOf = (family, extra = []) => [...DIGITS, ...extra].every((k) => sk.sprite(`${family}-${k}`));
    const legacy = {
      score: digitsOf("score"),
      accuracy: digitsOf("score", ["dot", "percent"]),
      combo: digitsOf("combo"),
      health: skinOn && (!!sk.sprite("scorebar-bg") || !!sk.sprite("scorebar-colour")
        || !!sk.sprite("scorebar-marker") || sk.barFrameCount() > 0),
    };
    const stacked = skinOn || legacy.score || legacy.health;  // a skin takes the legacy corner

    ctx.save();
    if (hudX) ctx.translate(hudX, 0);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;

    if (legacy.health) {
      legacyHealth(ctx, sk, u, t, health.shown, hp);
    } else {
      // The wedges and the bar's background, from the cached layer when the canvas can make one.
      const backing = layerFor(u);
      if (backing) ctx.drawImage(backing, -50 * u, 15 * u);
      else backdrop(ctx, u);
      argonHealth(ctx, u, health.shown, health.glow);
    }

    // Top right. Argon puts the score under its health bar. A skin gets lazer's legacy layout (LegacySkin's
    // main HUD components): the score in the corner, 10 units in, at 0.96; the accuracy under it, 9 units
    // down and 17 in, at 0.576; the song progress pie 18 units left of the accuracy, on its middle line.
    const scoreText = String(Math.round(scoreRoll.value(t)));
    const accValue = accRoll.value(t);
    ctx.globalAlpha = 1;
    let modsY = 92 * u;
    let modsRight = null;
    if (!stacked) {
      argonScore(ctx, u, scoreText, 250 * u, 56 * u);
      argonAccuracy(ctx, u, accValue, w - 20 * u, 20 * u);
    } else {
      const scoreStr = scoreText.padStart(8, "0");
      const sRun = (legacy.score && glyphRun(sk, "score", scoreStr, LEGACY_SCORE * u, true))
        || plainRun(ctx, scoreStr, 40 * LEGACY_SCORE * u);
      drawAnyRun(ctx, sRun, w - 10 * u - sRun.w, 0);
      const accStr = `${accValue.toFixed(2)}%`;
      const aRun = (legacy.accuracy && glyphRun(sk, "score", accStr, LEGACY_ACCURACY * u, true))
        || plainRun(ctx, accStr, 40 * LEGACY_ACCURACY * u);
      const aTop = sRun.h + 9 * u;
      drawAnyRun(ctx, aRun, w - 17 * u - aRun.w, aTop);
      if (skinOn && hud.progress) {
        const r = (33 / 2) * u;
        songPie(ctx, u, w - aRun.w - 18 * u - r, aTop + aRun.h / 2, songProgress(t, hud.progress));
      }
      modsY = aTop + Math.max(aRun.h, 33 * u) + 10 * u;
      modsRight = w - 10 * u;
    }

    // The mods in play: under the health bar for Argon, under the accuracy for a skin.
    if (modsText) {
      ctx.font = font(13 * u, 700);
      ctx.textAlign = modsRight === null ? "left" : "right";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.globalAlpha = 1;
      ctx.fillText(modsText, modsRight === null ? 50 * u : modsRight, modsY);
    }

    // Combo, bottom left.
    if (skinOn) {
      const count = legacyShown(legacyCount, legacyRoll, t);
      const pop = legacyPop && t >= legacyPop.at && t < legacyPop.at + LEGACY_POP
        ? { value: legacyPop.value, p: (t - legacyPop.at) / LEGACY_POP }
        : null;
      legacyCombo(ctx, sk, u, H, legacy.combo, count, legacyPulse(legacyCount, t), pop);
    } else {
      const value = Math.round(comboRoll.value(t));
      argonCombo(ctx, u, H, value, comboScale(t), comboColour(t));
    }

    if (skinOn) {
      legacyKeys(ctx, sk, u, w, H, env.keys, keyAnims, t, tinted);
      if (hud.errors && hud.errors.windows[2] > 0) hitErrorBar(ctx, u, w, H, hud.errors, t, arrowAt(t, hud.errors.list));
    } else {
      keys(ctx, u, w, H, env.keys);
    }
    ctx.restore();
  }

  return { reset, draw };
}