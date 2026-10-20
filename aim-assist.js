// Hidden aim assist (not a mod: it isn't listed, labelled or shown on results).
//
// Turning it on/off: on any screen except gameplay, with no text box focused, type the code below within
// CODE_WINDOW_MS. A small dot flashes in the bottom-right corner (green = on, red = off). It is never saved, so a
// reload turns it off again.
//
// Strength: while it is on, press ] for stronger and [ for weaker (levels 1-10, starts at 5; not saved either). Works
// on any screen including mid-song, except in a text box. A row of small dots in the bottom-right corner shows the
// level for a moment. Higher levels pull from further away, harder and faster, and aim closer to the centre.
//
// What it does: when the cursor is already near the next note, the cursor is pulled part of the way toward it
// (more as the note's time gets close), aiming at a slightly off-centre point picked per note so hits don't all
// land dead centre. It never moves the cursor when you're far from the note, and the pull is smoothed so the
// cursor doesn't jump. It also helps keep the cursor inside the slider follow circle.

const CODE = "godmode";
const CODE_WINDOW_MS = 4000;

const LOOKAHEAD_MS = 450;      // the pull builds up over this long before a note's time
const MIN_LEVEL = 1;
const MAX_LEVEL = 15;
const DEFAULT_LEVEL = 5;

// The tuning for a strength level (level 5 is the original setting).
export function levelParams(level) {
  return {
    pullRange: 1.4 + 0.24 * level,             // in circle radii: how close the cursor must be before it gets pulled
    sliderRange: 2.0 + 0.24 * level,           // in circle radii, around the slider ball
    maxPull: Math.min(0.95, 0.12 * level + 0.02), // the largest share of the distance closed
    smoothMs: 70 - 5 * level,                  // how quickly the pull follows its target
    jitter: 0.5 - 0.036 * level,               // off-centre aim point, in circle radii
  };
}

let enabled = false;
let level = DEFAULT_LEVEL;
let P = levelParams(level);
const typed = [];

export const aimAssist = {
  get enabled() { return enabled; },
  get level() { return level; },
  setLevel(l) {
    level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(l)));
    P = levelParams(level);
  },
  offset: { x: 0, y: 0 },
  lastT: null,

  reset() {
    this.offset = { x: 0, y: 0 };
    this.lastT = null;
  },

  // The assisted cursor for song time t, from the player's own cursor `raw`.
  apply(t, raw, recs, top) {
    if (!enabled) return raw;
    const dt = this.lastT === null ? 16 : Math.min(100, Math.max(0, t - this.lastT));
    this.lastT = t;
    const d = recs.data;
    let want = { x: 0, y: 0 };
    let best = null;
    // a slider being followed comes first
    for (let i = 0; i < top; i++) {
      const o = i * 16;
      if (d[o] === 1 && t >= d[o + 4] && t <= d[o + 5]) {
        best = { x: d[o + 12], y: d[o + 13], r: d[o + 3] * P.sliderRange, s: Math.min(0.9, P.maxPull * 0.8) };
        break;
      }
    }
    if (!best) {
      // otherwise the next open circle or slider head
      let soonest = Infinity;
      for (let i = 0; i < recs.count; i++) {
        const o = i * 16;
        const kind = d[o];
        if ((kind !== 0 && kind !== 3) || d[o + 8] !== 0) continue;
        const start = d[o + 4];
        if (start - t > LOOKAHEAD_MS || t - start > 150 || start >= soonest) continue;
        soonest = start;
        const [jx, jy] = jitter(i, start);
        const r = d[o + 3];
        const timeFactor = Math.min(1, Math.max(0, 1 - (start - t) / LOOKAHEAD_MS));
        best = { x: d[o + 1] + jx * r * P.jitter, y: d[o + 2] + jy * r * P.jitter, r: r * P.pullRange, s: P.maxPull * (0.35 + 0.65 * timeFactor) };
      }
    }
    if (best) {
      const dx = best.x - raw.x;
      const dy = best.y - raw.y;
      const dist = Math.hypot(dx, dy);
      if (dist < best.r) {
        const near = 1 - dist / best.r;
        const s = best.s * near * near * (3 - 2 * near);   // smoothstep: gentle at the edge of the range
        want = { x: dx * s, y: dy * s };
      }
    }
    const k = 1 - Math.exp(-dt / P.smoothMs);
    this.offset.x += (want.x - this.offset.x) * k;
    this.offset.y += (want.y - this.offset.y) * k;
    return { x: raw.x + this.offset.x, y: raw.y + this.offset.y };
  },
};

// A fixed off-centre direction per note (same every play of the map).
function jitter(i, start) {
  let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(Math.floor(start), 40503)) >>> 0;
  const a = ((h & 0xffff) / 0x10000) * Math.PI * 2;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  const m = Math.sqrt((h & 0xffff) / 0x10000);
  return [Math.cos(a) * m, Math.sin(a) * m];
}

// isPlaying: () => true while a round is on (the code is ignored then, so play keys never count toward it).
export function installAimAssistCode(isPlaying) {
  addEventListener("keydown", (e) => {
    // strength: [ and ] while it is on (any screen, not in a text box)
    if (enabled && (e.code === "BracketLeft" || e.code === "BracketRight") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = document.activeElement;
      if (!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        aimAssist.setLevel(level + (e.code === "BracketRight" ? 1 : -1));
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
      aimAssist.reset();
      flash(enabled);
      if (enabled) setTimeout(showLevel, 250);
    }
  }, true);
}

function flash(on) {
  const dot = document.createElement("div");
  dot.style.cssText = `position:fixed;right:6px;bottom:6px;width:5px;height:5px;border-radius:50%;z-index:99999;pointer-events:none;transition:opacity 1.2s;background:${on ? "#3c6" : "#c33"}`;
  document.body.appendChild(dot);
  requestAnimationFrame(() => requestAnimationFrame(() => (dot.style.opacity = "0")));
  setTimeout(() => dot.remove(), 1400);
}

// A row of tiny dots in the bottom-right corner: lit ones show the level.
let levelBox = null;
let levelTimer = 0;
function showLevel() {
  if (!levelBox) {
    levelBox = document.createElement("div");
    levelBox.style.cssText = "position:fixed;right:6px;bottom:6px;display:flex;gap:2px;z-index:99999;pointer-events:none;transition:opacity .6s";
    document.body.appendChild(levelBox);
  }
  levelBox.innerHTML = "";
  for (let i = MIN_LEVEL; i <= MAX_LEVEL; i++) {
    const d = document.createElement("div");
    d.style.cssText = `width:3px;height:3px;border-radius:50%;background:${i <= level ? "#3c6" : "rgba(255,255,255,.18)"}`;
    levelBox.appendChild(d);
  }
  levelBox.style.opacity = "1";
  clearTimeout(levelTimer);
  levelTimer = setTimeout(() => (levelBox.style.opacity = "0"), 1000);
}
