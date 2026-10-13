// Mods, as in osu! (lazer's OsuMod* classes): which ones this port plays with, and what each one changes.
//
// Beatmap mods (EZ, HR, MR) rewrite the beatmap text before the core loads it, so the core works from the
// modified numbers and positions, as lazer applies them to the beatmap. Failure mods (NF, SD, PF) go to the
// core with osu_set_mods. Rate mods (DT, NC, HT, DC) change the song clock (index.html). HD and FL are drawn
// by the renderer.
//
// Not here: the score multiplier lazer applies per mod (scores are unmodified), pitch correction for rate
// mods (the browser cannot change speed without changing pitch, so DT sounds higher), and the mods that change
// how notes are read (Random, Relax, Autopilot, Spun Out and the rest).

export const MODS = [
  { id: "EZ", name: "Easy", desc: "Circles, approach rate, accuracy and health are halved. Lazer's Easy." },
  { id: "HD", name: "Hidden", desc: "Circles fade out before you hit them, and approach circles are hidden." },
  { id: "HR", name: "Hard Rock", desc: "Circles, approach rate, accuracy and health go up. The playfield is flipped vertically." },
  { id: "DT", name: "Double Time", rate: 1.5, desc: "The song plays 1.5x faster. The pitch goes up with it." },
  { id: "NC", name: "Nightcore", rate: 1.5, desc: "Double Time, with the pitch up as well." },
  { id: "HT", name: "Half Time", rate: 0.75, desc: "The song plays 0.75x slower. The pitch goes down with it." },
  { id: "DC", name: "Daycore", rate: 0.75, desc: "Half Time, with the pitch down as well." },
  { id: "MR", name: "Mirror", desc: "The playfield is flipped horizontally." },
  { id: "FL", name: "Flashlight", desc: "Only a circle around the cursor is visible." },
  { id: "NF", name: "No Fail", desc: "You can't fail, no matter what." },
  { id: "SD", name: "Sudden Death", desc: "Miss and fail." },
  { id: "PF", name: "Perfect", desc: "Any result below the top one fails." },
];

// Pairs of mods that cannot be on together (lazer's IncompatibleMods). Every rate mod excludes the others,
// as lazer's rate mods do.
const EXCLUSIVE = [
  ["NF", "SD"], ["NF", "PF"], ["SD", "PF"],
  ["EZ", "HR"], ["HR", "MR"],
  ["DT", "NC"], ["DT", "HT"], ["DT", "DC"], ["NC", "HT"], ["NC", "DC"], ["HT", "DC"],
];

const KNOWN = new Set(MODS.map((m) => m.id));
const DIFFICULTY_KEYS = ["CircleSize", "ApproachRate", "OverallDifficulty", "HPDrainRate"];
const PLAYFIELD_W = 512;
const PLAYFIELD_H = 384;

export function conflicts(id) {
  return EXCLUSIVE.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));
}

// The set with id switched: turned off if it is on, otherwise on, with the mods that conflict with it turned off.
export function toggleMod(set, id) {
  const next = new Set(set);
  if (next.has(id)) {
    next.delete(id);
    return next;
  }
  for (const other of conflicts(id)) next.delete(other);
  next.add(id);
  return next;
}

// Failure bits for osu_set_mods (game.h MOD_NF = 1, MOD_SD = 2, MOD_PF = 4).
export function failBits(set) {
  return (set.has("NF") ? 1 : 0) | (set.has("SD") ? 2 : 0) | (set.has("PF") ? 4 : 0);
}

// The song's speed: 1.5 for Double Time and Nightcore, 0.75 for Half Time and Daycore, otherwise 1.
export function rateOf(set) {
  for (const m of MODS) if (set.has(m.id) && m.rate) return m.rate;
  return 1;
}

// The flashlight (lazer's OsuModFlashlight): 125 playfield units at no combo, a little smaller from combo 100
// and 200, and it reaches the cursor FOLLOW_DELAY_MS after the cursor moves.
export const FLASHLIGHT_RADIUS = 125;
export const FOLLOW_DELAY_MS = 120;
export function flashlightRadius(combo) {
  const scale = combo >= 200 ? 0.625 : combo >= 100 ? 0.8125 : 1;   // 2.0/3.2 and 2.6/3.2 of the 0-combo size
  return FLASHLIGHT_RADIUS * scale;
}

// Short labels for the play screen, in the order of MODS: "HD HR DT".
export function modsLabel(set) {
  return MODS.filter((m) => set.has(m.id)).map((m) => m.id).join(" ");
}

const KEY = "osuport.mods";

// The saved mods, read back through toggleMod so an impossible saved pair cannot come back.
export function loadStoredMods() {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) || "[]");
    let set = new Set();
    for (const id of Array.isArray(ids) ? ids : []) if (KNOWN.has(id) && !set.has(id)) set = toggleMod(set, id);
    return set;
  } catch (_) {
    return new Set();
  }
}

export function storeMods(set) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch (_) {
    // Storage can be full or blocked: the choice still holds for this visit.
  }
}

const fmt = (v) => String(Math.round(v * 1000) / 1000);
const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// The beatmap text with the beatmap mods applied: EZ and HR change [Difficulty] (written out in full, so the
// approach rate does not depend on the overall difficulty default), HR and MR move the objects, sliders included.
export function mapText(text, set) {
  const ez = set.has("EZ");
  const hr = set.has("HR");
  const mr = set.has("MR");
  if (!ez && !hr && !mr) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  // Reads the difficulty as the core does: each value has a default, and ApproachRate defaults to OverallDifficulty.
  const read = { CircleSize: 5, OverallDifficulty: 5, HPDrainRate: 5, ApproachRate: null };
  let section = "";
  for (const line of lines) {
    const head = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (head) {
      section = head[1];
      continue;
    }
    if (section !== "Difficulty") continue;
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv && DIFFICULTY_KEYS.includes(kv[1])) read[kv[1]] = finiteOr(Number(kv[2]), read[kv[1]]);
  }
  const od0 = read.OverallDifficulty;
  let cs = read.CircleSize;
  let ar = read.ApproachRate ?? od0;
  let od = od0;
  let hp = read.HPDrainRate;
  if (ez) {
    cs *= 0.5;
    ar *= 0.5;
    od *= 0.5;
    hp *= 0.5;
  }
  if (hr) {
    cs = Math.min(cs * 1.3, 10);      // lazer's Hard Rock circle size uses 1.3
    ar = Math.min(ar * 1.4, 10);
    od = Math.min(od * 1.4, 10);
    hp = Math.min(hp * 1.4, 10);
  }
  const difficulty = [
    `CircleSize:${fmt(cs)}`, `ApproachRate:${fmt(ar)}`, `OverallDifficulty:${fmt(od)}`, `HPDrainRate:${fmt(hp)}`,
  ];

  const out = [];
  section = "";
  for (const line of lines) {
    const head = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (head) {
      section = head[1];
      out.push(line);
      if (section === "Difficulty" && (ez || hr)) out.push(...difficulty);
      continue;
    }
    if (section === "Difficulty" && (ez || hr)) {
      const kv = /^\s*([A-Za-z]+)\s*:/.exec(line);
      if (kv && DIFFICULTY_KEYS.includes(kv[1])) continue;   // replaced by the values written above
    }
    if (section === "HitObjects" && (hr || mr) && line.trim() && !line.trim().startsWith("//")) {
      out.push(flipObject(line, hr, mr));
      continue;
    }
    out.push(line);
  }
  return out.join(eol);
}

// One [HitObjects] line with its position flipped. Slider curves are absolute points after the curve type,
// so each point is flipped the same way as the slider's start.
function flipObject(line, hr, mr) {
  const f = line.split(",");
  if (f.length < 3) return line;
  let x = Number(f[0]);
  let y = Number(f[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return line;
  if (mr) x = PLAYFIELD_W - x;
  if (hr) y = PLAYFIELD_H - y;
  f[0] = fmt(x);
  f[1] = fmt(y);
  const type = Number(f[3]);
  if (f.length > 5 && (type & 2)) {          // slider
    f[5] = f[5].split("|").map((p, i) => {
      if (i === 0) return p;                  // the curve type letter
      const [px, py] = p.split(":").map(Number);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return p;
      return `${fmt(mr ? PLAYFIELD_W - px : px)}:${fmt(hr ? PLAYFIELD_H - py : py)}`;
    }).join("|");
  }
  return f.join(",");
}
