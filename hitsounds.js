// Hit sound support for the earlier port (index-mods.html), following osu!lazer:
//  * loadDefaultSamples: the default skin's gameplay samples (lazer's "argon" set from osu-resources), so a map's
//    whistles / finishes / claps / slider ticks / soft and drum banks sound even without an imported skin, and fill in
//    whatever an imported skin leaves out (lazer falls back to its default skin the same way);
//  * createLoops: looping samples that play while something is held — the slider slide / whistle while a slider is
//    tracked (DrawableSlider.slidingSample), the spinner spin while spinning (DrawableSpinner.spinningSample).
// The samples are downloaded once and kept in the browser's Cache Storage, so later visits work offline.

const COMMIT = "a3423ae5fa76223b648db1df31875a952b588d69";   // the osu-resources commit assets/manifest.json uses
const DIR = "Samples/Gameplay/Argon/";
const SOURCES = [
  `./osu-resources-local/${DIR}`,
  `./assets/osu-resources/${DIR}`,
  `https://raw.githubusercontent.com/ppy/osu-resources/${COMMIT}/osu.Game.Resources/${DIR}`,
];
const CACHE = "osu-default-hitsounds-v1";

const BANKED = ["hitnormal", "hitwhistle", "hitfinish", "hitclap", "slidertick", "sliderslide", "sliderwhistle"];
const PLAIN = ["spinnerspin", "spinnerbonus"];
export const DEFAULT_SAMPLE_NAMES = [
  ...["normal", "soft", "drum"].flatMap((b) => BANKED.map((n) => `${b}-${n}`)),
  ...PLAIN,
];

async function fetchSample(file) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { cache = null; }
  const remote = SOURCES[SOURCES.length - 1] + file;
  if (cache) {
    try {
      const hit = await cache.match(remote);
      if (hit) return await hit.arrayBuffer();
    } catch { /* fall through */ }
  }
  for (const base of SOURCES) {
    try {
      const res = await fetch(base + file);
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      if (cache) cache.put(remote, new Response(bytes.slice(0))).catch(() => {});
      return bytes;
    } catch { /* next source */ }
  }
  return null;
}

/**
 * name ("soft-hitclap", "spinnerspin") -> AudioBuffer, for the samples osu-resources has (drum-sliderwhistle, for one,
 * doesn't exist and is left out). Resolves once all are loaded; failures just leave a sample out.
 */
export async function loadDefaultSamples(ctx) {
  const out = new Map();
  await Promise.all(DEFAULT_SAMPLE_NAMES.map(async (name) => {
    const bytes = await fetchSample(`${name}.wav`);
    if (!bytes) return;
    try { out.set(name, await ctx.decodeAudioData(bytes)); } catch { /* not decodable: left out */ }
  }));
  return out;
}

/**
 * Looping samples keyed by what is holding them (a slider's index plus the sample name). Each frame the caller passes
 * the set it wants playing; new ones start, missing ones fade out (lazer: the spinner fades in over 300 ms and out over
 * 240 ms, the slider sample stops when tracking ends).
 */
export function createLoops(getContext, getDestination) {
  const active = new Map();   // key -> { src, gain, fadeOut }
  const stopOne = (key, fadeMs) => {
    const a = active.get(key);
    if (!a) return;
    active.delete(key);
    const ctx = getContext();
    const now = ctx.currentTime;
    try {
      a.gain.gain.cancelScheduledValues(now);
      a.gain.gain.setValueAtTime(a.gain.gain.value, now);
      a.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
      a.src.stop(now + fadeMs / 1000 + 0.02);
    } catch { /* already stopped */ }
  };
  return {
    /** wanted: Map key -> { buffer, volume (0..1), rate, fadeInMs, fadeOutMs } */
    update(wanted) {
      const ctx = getContext();
      const dest = getDestination();
      if (!ctx || !dest) return;
      const now = ctx.currentTime;
      for (const [key, w] of wanted) {
        let a = active.get(key);
        if (!a) {
          if (!w.buffer) continue;
          const src = ctx.createBufferSource();
          const gain = ctx.createGain();
          src.buffer = w.buffer;
          src.loop = true;
          gain.gain.setValueAtTime(w.fadeInMs ? 0 : w.volume, now);
          if (w.fadeInMs) gain.gain.linearRampToValueAtTime(w.volume, now + w.fadeInMs / 1000);
          src.connect(gain).connect(dest);
          src.start();
          a = { src, gain, fadeOut: w.fadeOutMs ?? 0, volume: w.volume };
          active.set(key, a);
        } else if (Math.abs(a.volume - w.volume) > 1e-3) {
          a.volume = w.volume;
          a.gain.gain.setTargetAtTime(w.volume, now, 0.03);
        }
        if (w.rate != null && Math.abs(a.src.playbackRate.value - w.rate) > 1e-3) a.src.playbackRate.setValueAtTime(w.rate, now);
      }
      for (const [key, a] of [...active]) if (!wanted.has(key)) stopOne(key, a.fadeOut);
    },
    stopAll() { for (const key of [...active.keys()]) stopOne(key, 0); },
  };
}
