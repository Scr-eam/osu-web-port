// Thin JS wrapper around build/osu_core.wasm (C API in include/osu_core.h).
// Times are song milliseconds; coordinates are playfield pixels (512 x 384).

export const RECORD_FLOATS = 16;

export const RES = {
  NONE: 0, MISS: 1, MEH: 2, OK: 3, GOOD: 4, GREAT: 5, PERFECT: 6,
  SMALL_TICK_MISS: 7, SMALL_TICK_HIT: 8, LARGE_TICK_MISS: 9, LARGE_TICK_HIT: 10,
  SMALL_BONUS: 11, LARGE_BONUS: 12, IGNORE_MISS: 13, IGNORE_HIT: 14, COMBO_BREAK: 15,
  SLIDER_TAIL_HIT: 16,
};

export const KIND = {
  CIRCLE: 0, SLIDER: 1, SPINNER: 2, HEAD: 3, TICK: 4, REPEAT: 5, TAIL: 6,
  SPIN_TICK: 7, SPIN_BONUS: 8,
};

export async function loadCore(url) {
  const bytes = await (await fetch(url)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { sin: Math.sin, cos: Math.cos, atan2: Math.atan2, acos: Math.acos },
  });
  return new Core(instance.exports);
}

const STAT = {
  score: 0, accuracy: 1, combo: 2, maxCombo: 3, great: 4, ok: 5, meh: 6, miss: 7,
  health: 8, failed: 9, finished: 10, rank: 11, time: 12, endTime: 13, preempt: 14,
  fadeIn: 15, radius: 16, od: 17, ar: 18, cs: 19, hp: 20, windowGreat: 21,
  windowOk: 22, windowMeh: 23, windowMiss: 24, drainRate: 25, objectCount: 26,
  firstTime: 27, colourCount: 28, loaded: 29, maxComboPossible: 30, judgements: 31,
};

export class Core {
  constructor(exports) {
    this.X = exports;
  }

  cstr(ptr) {
    const m = new Uint8Array(this.X.memory.buffer);
    let e = ptr;
    while (m[e] !== 0) e++;
    return new TextDecoder().decode(m.subarray(ptr, e));
  }

  // Returns true on success, otherwise the error text.
  load(text) {
    const bytes = new TextEncoder().encode(text);
    const ptr = this.X.osu_input_buffer(bytes.length);
    if (!ptr) return "Beatmap is larger than the input buffer.";
    new Uint8Array(this.X.memory.buffer, ptr, bytes.length).set(bytes);
    if (this.X.osu_load(bytes.length) === 1) return true;
    return this.cstr(this.X.osu_error()) || "Could not load beatmap.";
  }

  // colours: array of [r, g, b] in 0..255 (used when the beatmap has no [Colours]).
  setSkinColours(colours) {
    const n = Math.min(colours.length, 256);
    const ptr = this.X.osu_skin_buffer(n);
    const f = new Float32Array(this.X.memory.buffer, ptr, n * 3);
    for (let i = 0; i < n; i++) {
      f[i * 3] = colours[i][0];
      f[i * 3 + 1] = colours[i][1];
      f[i * 3 + 2] = colours[i][2];
    }
    this.X.osu_set_skin_colours(n);
  }

  meta() {
    return {
      title: this.cstr(this.X.osu_meta(0)),
      artist: this.cstr(this.X.osu_meta(1)),
      version: this.cstr(this.X.osu_meta(2)),
      audio: this.cstr(this.X.osu_meta(3)),
    };
  }

  colours() {
    const n = this.X.osu_colour_count();
    const p = this.X.osu_colours();
    const f = new Float32Array(this.X.memory.buffer, p, n * 3);
    const out = [];
    for (let i = 0; i < n; i++) out.push([f[i * 3], f[i * 3 + 1], f[i * 3 + 2]]);
    return out;
  }

  restart() {
    this.X.osu_restart();
  }

  // Failure mods: bits from mods.js failBits (1 No Fail, 2 Sudden Death, 4 Perfect). Any time before a result.
  setMods(bits) {
    this.X.osu_set_mods(bits);
  }

  // mask bits: 1 = key 1, 2 = key 2, 4 = mouse button (the bits that are held now)
  update(t, x, y, mask) {
    this.X.osu_update(t, x, y, mask);
  }

  // Press event at time t. mask bits are the buttons that went down.
  press(t, x, y, mask) {
    this.X.osu_press(t, x, y, mask);
  }

  stats() {
    const p = this.X.osu_stats();
    const s = new Float64Array(this.X.memory.buffer, p, 32);
    const o = {};
    for (const k in STAT) o[k] = s[STAT[k]];
    return o;
  }

  // Fills and returns the record view: { count, get(i) -> Float32Array(16) subarray }.
  records() {
    const n = this.X.osu_fill_records();
    const p = this.X.osu_records();
    const all = new Float32Array(this.X.memory.buffer, p, n * RECORD_FLOATS);
    return { count: n, data: all };
  }

  topCount() {
    return this.X.osu_top_count();
  }

  // Stacked slider polyline as a Float32Array copy of [x0, y0, x1, y1, ...].
  sliderPoints(index) {
    const n = this.X.osu_slider_point_count(index);
    if (n === 0) return new Float32Array(0);
    const p = this.X.osu_slider_points(index);
    return new Float32Array(this.X.memory.buffer, p, n * 2).slice();
  }
}
