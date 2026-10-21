// Hidden aimbot (not a mod: it isn't listed, labelled or shown on results), layered on top of your own mouse.
//
// Turning it on/off: on any screen except gameplay, with no text box focused, type the code below within
// CODE_WINDOW_MS. A small dot flashes in the bottom-right corner (blue = on, red = off). It is never saved, so a
// reload turns it off again.
//
// Strength: while it is on, press ] for stronger and [ for weaker (levels 1-10, starts at 5; not saved either). A row
// of small blue dots in the bottom-right corner shows the level for a moment.
//
// How it works: it never pulls against you. Your mouse moves the cursor exactly as always; the aimbot only shapes the
// movement you're already making, the way a good player's hand would:
//  * magnetism: when you move toward the next note, the cursor travels a bit further toward it than your hand did;
//  * steering: as you move, your path bends toward the note (more the further you move), so a flick that would land
//    to the side lands on the circle;
//  * settle: if you've stopped just off the note right before its time, the cursor eases the last bit onto it;
//  * sliders: the cursor is drawn back toward the slider ball when you drift, so you stay inside the follow circle;
//  * moving away from the note lets go at once, so nothing ever drags or feels sticky.
// It aims at a random off-centre point on each note (never dead centre), and every correction is smoothed so the
// cursor's path stays human. Higher levels shape your movement more (level 1 is barely noticeable). Presses and
// spinners stay yours.

const CODE = "aimbot";
const CODE_WINDOW_MS = 4000;
const MIN_LEVEL = 1;
const MAX_LEVEL = 10;
const DEFAULT_LEVEL = 1;
const COLOUR = "#39f";
const LOOKAHEAD_MS = 380;       // the note you're heading for: from this long before its time
const HOLD_MS = 70;             // full strength until this long after it (presses are often a little late)
const RELEASE_MS = 170;         // then fading out until this long after it

export function levelParams(level) {
  const f = (level - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL);   // 0 .. 1
  return {
    magnet: 0.05 + 0.1 * f,        // extra share of your movement toward the note
    steer: 0.05 + 0.1 * f,         // how much your path bends toward the note per distance moved
    settleReach: 0.4 + 0.4 * f,    // circle radii: how far off you can stop and still be eased onto the note
    settleGain: 0.2 + 0.2 * f,
    sliderGain: 0.1 + 0.2 * f,     // sliders: how strongly drift is corrected
    sliderTau: 110,       // ms
    maxOffset: 0.3 + 0.5 * f,      // circle radii: the most the cursor can differ from your mouse
    aimSpread: 0,    // off-centre aim point, sigma in circle radii
    wobble: 0,       // slider target wobble, circle radii
  };
}

let enabled = false;
let level = DEFAULT_LEVEL;
let P = levelParams(level);
const typed = [];

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

// smooth noise: a few sines with random frequencies and phases (-1..1)
function makeNoise(freqs) {
  const parts = freqs.map((f) => ({ f: f * (0.85 + 0.3 * Math.random()), px: Math.random() * 6.283, py: Math.random() * 6.283, a: 0.6 + 0.4 * Math.random() }));
  const norm = parts.reduce((s, p) => s + p.a, 0);
  return (tMs) => {
    let x = 0;
    let y = 0;
    for (const p of parts) {
      x += p.a * Math.sin((tMs / 1000) * p.f * 6.283 + p.px);
      y += p.a * Math.sin((tMs / 1000) * p.f * 6.283 + p.py);
    }
    return { x: x / norm, y: y / norm };
  };
}

export const aimbot = {
  get enabled() { return enabled; },
  get level() { return level; },
  setLevel(l) {
    level = clamp(Math.round(l), MIN_LEVEL, MAX_LEVEL);
    P = levelParams(level);
  },
  out: null,                    // the cursor shown and used for presses
  off: { x: 0, y: 0 },          // how far the cursor is from your mouse
  prevRaw: null,
  lastT: null,
  aims: new Map(),              // record index -> off-centre aim offset (in radii), picked once per note
  wobbleNoise: makeNoise([1.1, 1.7, 2.6]),

  reset() {
    this.out = null;
    this.off = { x: 0, y: 0 };
    this.prevRaw = null;
    this.lastT = null;
    this.aims = new Map();
    this.wobbleNoise = makeNoise([1.1, 1.7, 2.6]);
  },

  aimFor(i) {
    let a = this.aims.get(i);
    if (!a) {
      let x = gauss() * P.aimSpread;
      let y = gauss() * P.aimSpread;
      const m = Math.hypot(x, y);
      if (m > 0.7) { x *= 0.7 / m; y *= 0.7 / m; }
      a = { x, y };
      this.aims.set(i, a);
    }
    return a;
  },

  // Shrinks the offset as you move without ever slowing you: the part of it that's behind you melts (which only adds
  // a little to your movement), the sideways part melts more gently, the part ahead of you is kept.
  melt(mv, moved, scale) {
    const C = this.off;
    if (moved <= 0.05) return;
    const mx = mv.x / moved;
    const my = mv.y / moved;
    let a = C.x * mx + C.y * my;
    let lx = C.x - mx * a;
    let ly = C.y - my * a;
    if (a < 0) a *= Math.exp(-moved / scale);
    const kl = Math.exp(-moved / (scale * 2));
    lx *= kl;
    ly *= kl;
    C.x = mx * a + lx;
    C.y = my * a + ly;
  },

  // The cursor for song time t: your cursor `raw` plus the shaping. recs: the core's records, top: top-level count.
  apply(t, raw, recs, top) {
    if (!enabled) return raw;
    if (this.lastT !== null && t < this.lastT - 5) this.reset();   // a restart / rewind
    const dt = this.lastT === null ? 16 : clamp(t - this.lastT, 0, 50);
    this.lastT = t;
    const mv = this.prevRaw ? { x: raw.x - this.prevRaw.x, y: raw.y - this.prevRaw.y } : { x: 0, y: 0 };
    this.prevRaw = { x: raw.x, y: raw.y };
    const moved = Math.hypot(mv.x, mv.y);
    const d = recs.data;
    const C = this.off;
    const C0x = C.x;
    const C0y = C.y;

    // what you're heading for: a slider being followed, else the next note to hit
    let tgt = null;
    for (let i = 0; i < top; i++) {
      const o = i * 16;
      if (d[o] === 1 && t >= d[o + 4] && t <= d[o + 5]) {
        const r = d[o + 3] || 30;
        const w = this.wobbleNoise(t);
        tgt = { slider: true, x: d[o + 12] + w.x * P.wobble * r, y: d[o + 13] + w.y * P.wobble * r, r };
        break;
      }
    }
    if (!tgt) {
      let soonest = Infinity;
      for (let i = 0; i < recs.count; i++) {
        const o = i * 16;
        const kind = d[o];
        if ((kind !== 0 && kind !== 3) || d[o + 8] !== 0) continue;
        const start = d[o + 4];
        if (start - t > LOOKAHEAD_MS || t - start > RELEASE_MS || start >= soonest) continue;
        soonest = start;
        const r = d[o + 3] || 30;
        const a = this.aimFor(i);
        tgt = { slider: false, x: d[o + 1] + a.x * r, y: d[o + 2] + a.y * r, r, start,
          w: t <= start ? smooth(1 - (start - t) / LOOKAHEAD_MS) : 1 - smooth((t - start - HOLD_MS) / (RELEASE_MS - HOLD_MS)) };
      }
    }

    if (!tgt) {
      // nothing to help with: the difference melts into your movement (and very slowly on its own while you're still)
      this.melt(mv, moved, 30);
      if (moved <= 0.05) {
        const k = Math.exp(-dt / 900);
        C.x *= k;
        C.y *= k;
      }
    } else {
      // any offset slowly melts into your movement (never slowing you), so it can't build up
      this.melt(mv, moved, 4 * (32));
      const cur = { x: raw.x + C.x, y: raw.y + C.y };
      const ex = tgt.x - cur.x;
      const ey = tgt.y - cur.y;
      const dist = Math.hypot(ex, ey);
      const ux = dist > 0 ? ex / dist : 0;
      const uy = dist > 0 ? ey / dist : 0;
      // an offset left over from the last note that points away from this one fades by itself (~150 ms)
      if (C.x * (tgt.x - raw.x) + C.y * (tgt.y - raw.y) < 0) {
        const k = Math.exp(-dt / 150);
        C.x *= k;
        C.y *= k;
      }
      if (tgt.slider) {
        // drift away from the ball is corrected smoothly, whatever you do; your movement still passes through
        const k = (1 - Math.exp(-dt / P.sliderTau)) * P.sliderGain * smooth((dist - 0.25 * tgt.r) / (0.6 * tgt.r));
        let cx = ex * k;
        let cy = ey * k;
        if (moved > 0.05) {
          // never against your movement: if you're deliberately moving away, only the sideways part is corrected
          const mx = mv.x / moved;
          const my = mv.y / moved;
          const back = cx * mx + cy * my;
          if (back < 0) { cx -= back * mx; cy -= back * my; }
        }
        // and never grows the offset past the cap
        const capS = P.maxOffset * tgt.r;
        const nxs = C.x + cx;
        const nys = C.y + cy;
        const after = Math.hypot(nxs, nys);
        if (after > capS && after > Math.hypot(C.x, C.y)) {
          const before = Math.hypot(C.x, C.y);
          const f = before >= capS ? 0 : (capS - before) / (after - before);
          cx *= f;
          cy *= f;
        }
        C.x += cx;
        C.y += cy;
      } else {
        if (moved > 0.05) {
        const along = mv.x * ux + mv.y * uy;          // how much of your movement heads for the note
        if (along > 0) {
          // magnetism: a little extra travel toward the note, never past it
          const room = Math.max(0, 0.8 * P.maxOffset * tgt.r - Math.hypot(C.x, C.y));   // stop growing before the cap
          const extra = Math.min(along * P.magnet * tgt.w, dist * 0.6, room);
          C.x += ux * extra;
          C.y += uy * extra;
          // steering: bend the path toward the note, in proportion to how far you moved
          const mx = mv.x / moved;
          const my = mv.y / moved;
          const latx = ex - mx * (ex * mx + ey * my);
          const laty = ey - my * (ex * mx + ey * my);
          const s = Math.min(0.35, (moved / Math.max(dist, 1)) * P.steer * 2) * tgt.w;
          C.x += latx * s;
          C.y += laty * s;
        } else {
          // moving away: let go straight away (the difference melts into your movement)
          this.melt(mv, moved, 0.5 * tgt.r);
        }
        }
      }
      // just off the note right before its time and not moving away from it: ease the last bit onto it
      const along2 = moved > 0.05 ? (mv.x * ux + mv.y * uy) / moved : 0;
      const nx = tgt.x - (raw.x + C.x);
      const ny = tgt.y - (raw.y + C.y);
      if (tgt.start - t < 200 && Math.hypot(nx, ny) < P.settleReach * tgt.r && along2 > -0.3) {
        const k = (1 - Math.exp(-dt / 55)) * P.settleGain * tgt.w;
        C.x += nx * k;
        C.y += ny * k;
      }
    }
    // never further from your mouse than maxOffset circle radii
    const r0 = tgt ? tgt.r : 32;
    const m = Math.hypot(C.x, C.y);
    const cap = P.maxOffset * r0;
    if (m > cap) { C.x *= cap / m; C.y *= cap / m; }
    // your movement always comes through: whatever the shaping did this frame, the cursor still moves at least 85% of
    // your movement in the direction you moved (it can add to it or bend it, never hold you back)
    if (moved > 0.3) {
      const mx = mv.x / moved;
      const my = mv.y / moved;
      const dAlong = (C.x - C0x) * mx + (C.y - C0y) * my;
      const floor = -0.15 * moved;
      if (dAlong < floor) {
        C.x += (floor - dAlong) * mx;
        C.y += (floor - dAlong) * my;
      }
    }
    this.out = { x: raw.x + C.x, y: raw.y + C.y };
    return this.out;
  },
};

// isPlaying: () => true while a round is on (the code is ignored then, so play keys never count toward it).
export function installAimbotCode(isPlaying) {
  addEventListener("keydown", (e) => {
    // strength: [ and ] while it is on (any screen, not in a text box)
    if (enabled && (e.code === "BracketLeft" || e.code === "BracketRight") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = document.activeElement;
      if (!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))) {
        e.preventDefault();
        aimbot.setLevel(level + (e.code === "BracketRight" ? 1 : -1));
        showLevel();
        return;
      }
    }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isPlaying()) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.key.length !== 1) return;
    const now = performance.now();
    typed.push({ c: e.key.toLowerCase(), t: now });
    while (typed.length > CODE.length) typed.shift();
    if (typed.length === CODE.length && typed.map((x) => x.c).join("") === CODE && now - typed[0].t <= CODE_WINDOW_MS) {
      typed.length = 0;
      enabled = !enabled;
      aimbot.reset();
      flash(enabled);
      if (enabled) setTimeout(showLevel, 250);
    }
  }, true);
}

function flash(on) {
  const dot = document.createElement("div");
  dot.style.cssText = `position:fixed;right:6px;bottom:6px;width:5px;height:5px;border-radius:50%;z-index:99999;pointer-events:none;transition:opacity 1.2s;background:${on ? COLOUR : "#c33"}`;
  document.body.appendChild(dot);
  requestAnimationFrame(() => requestAnimationFrame(() => (dot.style.opacity = "0")));
  setTimeout(() => dot.remove(), 1400);
}

// A row of tiny dots in the bottom-right corner (just above the aim assist's row): lit ones show the level.
let levelBox = null;
let levelTimer = 0;
function showLevel() {
  if (!levelBox) {
    levelBox = document.createElement("div");
    levelBox.style.cssText = "position:fixed;right:6px;bottom:12px;display:flex;gap:2px;z-index:99999;pointer-events:none;transition:opacity .6s";
    document.body.appendChild(levelBox);
  }
  levelBox.innerHTML = "";
  for (let i = MIN_LEVEL; i <= MAX_LEVEL; i++) {
    const d = document.createElement("div");
    d.style.cssText = `width:3px;height:3px;border-radius:50%;background:${i <= level ? COLOUR : "rgba(255,255,255,.18)"}`;
    levelBox.appendChild(d);
  }
  levelBox.style.opacity = "1";
  clearTimeout(levelTimer);
  levelTimer = setTimeout(() => (levelBox.style.opacity = "0"), 1000);
}
