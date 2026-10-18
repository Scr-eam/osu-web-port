// Skin loading for the web player. An .osk file is a zip with skin.ini, sprite images and
// optional hit sounds. The skin folder is the one that holds skin.ini. Fixed sprites and hit
// sounds are read from that folder only, as osu! does. Digit sets (hit circle numbers, score,
// combo) are found through the [Fonts] prefixes, which may point into a sub-folder such as
// Assets/score/score, so those sub-folders are read too. Imported skins are kept in IndexedDB
// (best effort).
import { readZip } from "./zip.js";

// Sprites the renderer asks for by logical name. Digit sprites are resolved through the [Fonts]
// prefixes in skin.ini, so they are mapped separately below.
const FIXED_SPRITES = new Set([
  "hitcircle", "hitcircleoverlay", "approachcircle",
  "sliderstartcircle", "sliderstartcircleoverlay", "sliderendcircle", "sliderendcircleoverlay",
  "sliderscorepoint", "sliderpoint10", "sliderpoint30", "reversearrow", "sliderfollowcircle",
  "sliderb-nd", "sliderb-spec", "followpoint",
  "spinner-approachcircle", "spinner-background", "spinner-circle", "spinner-metre",
  "spinner-top", "spinner-middle", "spinner-middle2", "spinner-bottom", "spinner-glow",
  "cursor", "cursormiddle", "cursortrail",
  // the main menu's centre logo
  "menu-osu",
  "hit300", "hit300g", "hit100", "hit50", "hit0",
  // The legacy health bar: its background, the single colour image (when there are no animation frames),
  // and the marker, which is either the newer scorebar-marker or the older ki heads.
  "scorebar-bg", "scorebar-colour", "scorebar-marker", "scorebar-ki", "scorebar-kidanger", "scorebar-kidanger2",
  // The legacy key counter: its background and the key icon behind each count.
  "inputoverlay-background", "inputoverlay-key",
]);
// Animation frames: slider ball frames (sliderb0, sliderb1, ...), follow point frames, and the
// legacy health bar's fill frames (scorebar-colour-0, ...).
const FRAME_SPRITE = /^(sliderb\d+|followpoint-\d+|scorebar-colour-\d+)$/;
const SCORE_TAILS = ["comma", "dot", "percent", "x"];
const HIT_SOUND_NAMES = ["normal-hitnormal", "hitnormal"];
const SOUND_EXTENSIONS = ["wav", "ogg", "mp3"];

function parseRgb(value) {
  const p = value.split(",").map((v) => Number(v.trim()));
  return p.length >= 3 && p.slice(0, 3).every((v) => Number.isFinite(v)) ? p.slice(0, 3) : null;
}

// A [Fonts] prefix as a path inside the skin: osu! accepts either slash, and no leading "./".
function prefixPath(value, fallback) {
  const p = value.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  return p || fallback;
}

// The parts of skin.ini the player uses. Colours are [r, g, b] in 0..255, or null when unset.
export function parseSkinIni(text) {
  const ini = {
    combo: [],
    sliderBorder: null,
    sliderTrack: null,
    approachCircle: null,
    overlayAboveNumber: false,
    hitPrefix: "default",
    hitOverlap: 0,
    scorePrefix: "score",
    scoreOverlap: 0,
    comboPrefix: "score",       // lazer and stable fall back to the score digits for the combo
    comboOverlap: 0,
  };
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      continue;
    }
    const kv = /^([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim();
    if (section === "general") {
      if (key === "hitcircleoverlayabovenumer") ini.overlayAboveNumber = value === "1";
    } else if (section === "colours") {
      const combo = /^combo(\d+)$/.exec(key);
      if (combo && Number(combo[1]) >= 1 && parseRgb(value)) ini.combo[Number(combo[1]) - 1] = parseRgb(value);
      else if (key === "sliderborder") ini.sliderBorder = parseRgb(value);
      else if (key === "slidertrackoverride") ini.sliderTrack = parseRgb(value);
      else if (key === "inputoverlaytext") ini.inputOverlayText = parseRgb(value);
      else if (key === "approachcircle") ini.approachCircle = parseRgb(value);
    } else if (section === "fonts") {
      if (key === "hitcircleprefix") ini.hitPrefix = prefixPath(value, "default");
      else if (key === "hitcircleoverlap") ini.hitOverlap = Number(value) || 0;
      else if (key === "scoreprefix") ini.scorePrefix = prefixPath(value, "score");
      else if (key === "scoreoverlap") ini.scoreOverlap = Number(value) || 0;
      else if (key === "comboprefix") ini.comboPrefix = prefixPath(value, "score");
      else if (key === "combooverlap") ini.comboOverlap = Number(value) || 0;
    }
  }
  ini.combo = ini.combo.filter((c) => c).slice(0, 256);
  return ini;
}

const escapeRe = (s) => s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Maps a file stem (lower case, no @2x) to the renderer's logical sprite name, or null. nested is
// true for a file in a sub-folder of the skin: only the prefixed digit sets may live there.
function logicalName(stem, ini, nested) {
  const digit = new RegExp(`^${escapeRe(ini.hitPrefix)}-(\\d)$`).exec(stem);
  if (digit) return `digit-${digit[1]}`;
  const score = new RegExp(`^${escapeRe(ini.scorePrefix)}-(\\d|${SCORE_TAILS.join("|")})$`).exec(stem);
  if (score) return `score-${score[1]}`;
  const combo = new RegExp(`^${escapeRe(ini.comboPrefix)}-(\\d|x)$`).exec(stem);
  if (combo) return `combo-${combo[1]}`;
  if (nested) return null;
  // The key counter's digits: a fixed name, from the skin folder (lazer's LegacyFont.ScoreEntry).
  const entry = /^scoreentry-(\d|comma|dot|percent|x)$/.exec(stem);
  if (entry) return `scoreentry-${entry[1]}`;
  if (FRAME_SPRITE.test(stem)) return stem;
  return FIXED_SPRITES.has(stem) ? stem : null;
}

// Finds the skin folder: the folder that holds skin.ini. Without one, the shallowest folder
// with images is used, so a bare folder of sprites still loads.
function skinFolder(entries) {
  let iniKey = null;
  for (const key of entries.keys()) {
    if ((key === "skin.ini" || key.endsWith("/skin.ini")) && (iniKey === null || key.length < iniKey.length)) {
      iniKey = key;
    }
  }
  if (iniKey !== null) return iniKey.slice(0, iniKey.length - "skin.ini".length);
  let imageKey = null;
  for (const key of entries.keys()) {
    if (/\.(png|jpe?g)$/.test(key) && (imageKey === null || key.length < imageKey.length)) imageKey = key;
  }
  return imageKey === null ? "" : imageKey.slice(0, imageKey.lastIndexOf("/") + 1);
}

// Reads an .osk (or zip) file. Throws if it holds nothing usable.
// audioCtx is only used to decode the hit sound; an OfflineAudioContext works without a gesture.
export async function loadSkinFile(blob, audioCtx) {
  const entries = await readZip(await blob.arrayBuffer());
  const root = skinFolder(entries);
  const files = new Map();              // path inside the skin folder (lower case) -> entry
  for (const [key, entry] of entries) {
    if (!key.startsWith(root)) continue;
    const rest = key.slice(root.length);
    if (rest) files.set(rest.toLowerCase(), entry);
  }

  const iniEntry = files.get("skin.ini");
  const ini = parseSkinIni(iniEntry ? new TextDecoder().decode(await iniEntry.read()) : "");

  // Several files can map to one sprite (name@2x, or a digit set under another prefix). The
  // largest decoded image wins, so a @2x sprite is used when it exists and a 1x one otherwise.
  const candidates = new Map();         // logical name -> [{ entry, ext }]
  for (const [name, entry] of files) {
    const m = /^(.+?)(@2x)?\.(png|jpe?g)$/.exec(name);
    if (!m) continue;
    const logical = logicalName(m[1], ini, name.includes("/"));
    if (!logical) continue;
    if (!candidates.has(logical)) candidates.set(logical, []);
    candidates.get(logical).push({ entry, ext: m[3], at2x: m[2] === "@2x" });
  }
  const images = new Map();
  const scales = new Map();             // logical name -> 2 when the chosen file is name@2x, else 1
  const blank = new Set();              // names whose files are all 1x1: the skin draws nothing there
  for (const [logical, list] of candidates) {
    let best = null;                    // { bmp, scale }
    let tiny = false;
    for (const c of list) {
      let bmp = null;
      try {
        bmp = await createImageBitmap(new Blob([await c.entry.read()], { type: c.ext === "png" ? "image/png" : "image/jpeg" }));
      } catch (_) {
        continue;                       // a damaged image just falls back to the flat shape
      }
      if (bmp.width <= 2 || bmp.height <= 2) {
        tiny = true;                    // 1x1 placeholder, not a picture
        bmp.close?.();
        continue;
      }
      if (!best || bmp.width * bmp.height > best.bmp.width * best.bmp.height) {
        if (best) best.bmp.close?.();
        best = { bmp, scale: c.at2x ? 2 : 1 };
      } else {
        bmp.close?.();
      }
    }
    if (best) {
      images.set(logical, best.bmp);
      scales.set(logical, best.scale);
    } else if (tiny) {
      blank.add(logical);
    }
  }

  // A combo font with the same prefix as the score (the default) is the score's digits.
  if (ini.comboPrefix.toLowerCase() === ini.scorePrefix.toLowerCase()) {
    for (const k of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "x"]) {
      const from = `score-${k}`;
      const to = `combo-${k}`;
      if (images.has(to) || blank.has(to)) continue;
      if (images.has(from)) {
        images.set(to, images.get(from));
        scales.set(to, scales.get(from));
      } else if (blank.has(from)) {
        blank.add(to);
      }
    }
  }

  let hit = null;
  if (audioCtx) {
    for (const base of HIT_SOUND_NAMES) {
      for (const ext of SOUND_EXTENSIONS) {
        const e = files.get(`${base}.${ext}`);
        if (e && !hit) {
          try {
            hit = await audioCtx.decodeAudioData(await e.read());
          } catch (_) {
            hit = null;
          }
        }
      }
    }
  }

  if (!iniEntry && images.size === 0 && !hit) throw new Error("No skin.ini, images or hit sounds found in that file.");
  return { ini, colours: ini.combo, images, scales, blank, hit };
}
