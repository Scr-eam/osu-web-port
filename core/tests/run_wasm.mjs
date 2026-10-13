// Drives build/osu_core.wasm through the C API (include/osu_core.h) with synthetic input.
// Usage: node tests/run_wasm.mjs [path/to/osu_core.wasm]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = process.argv[2] ?? join(here, "..", "build", "osu_core.wasm");

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
  env: { sin: Math.sin, cos: Math.cos, atan2: Math.atan2, acos: Math.acos },
});
const X = instance.exports;
const mem = () => new Uint8Array(X.memory.buffer);
const enc = new TextEncoder();

function cstr(ptr) {
  const m = mem();
  let e = ptr;
  while (m[e] !== 0) e++;
  return new TextDecoder().decode(m.subarray(ptr, e));
}

// Hit mask bits: 1 = key 1 (left), 2 = key 2 (right), 4 = mouse (left).
function load(text) {
  const bytes = enc.encode(text);
  const ptr = X.osu_input_buffer(bytes.length);
  mem().set(bytes, ptr);
  return X.osu_load(bytes.length) === 1;
}

function stats() {
  const p = X.osu_stats();
  return Array.from(new Float64Array(X.memory.buffer, p, 32));
}
const S = {
  score: 0, acc: 1, combo: 2, maxCombo: 3, great: 4, ok: 5, meh: 6, miss: 7,
  health: 8, failed: 9, finished: 10, rank: 11, now: 12, end: 13, preempt: 14,
  fadeIn: 15, radius: 16, od: 17, ar: 18, cs: 19, hp: 20, wGreat: 21, wOk: 22,
  wMeh: 23, wMiss: 24, drainRate: 25, topCount: 26, firstTime: 27, colours: 28,
  loaded: 29, maxComboPossible: 30, judgements: 31,
};

// Deterministic simulation: frames every `step` ms; presses are delivered before the
// frame that follows them, like an input queue.
// events: [{t, x, y, mask}] presses; cursor(t) -> [x, y]; held(t) -> mask.
function play({ from = 0, to, step = 10, presses = [], cursor, held }) {
  const ps = [...presses].sort((a, b) => a.t - b.t);
  let pi = 0;
  for (let t = from; t <= to; t += step) {
    while (pi < ps.length && ps[pi].t <= t) {
      const p = ps[pi++];
      X.osu_press(p.t, p.x, p.y, p.mask);
    }
    const [x, y] = cursor(t);
    X.osu_update(t, x, y, held(t));
  }
  // flush presses after the last frame
  while (pi < ps.length) {
    const p = ps[pi++];
    X.osu_press(p.t, p.x, p.y, p.mask);
  }
}

const HEADER = `osu file format v14

[General]
AudioFilename: audio.mp3
StackLeniency: 0.7

[Metadata]
Title:Test Map
Artist:Tester
Version:Hard

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
1000,500,4,2,0,60,1,0

[Events]
//Break
2,20000,21000

[HitObjects]
`;

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- tests ----
// 1. Loader and metadata
{
  const ok = load(HEADER + "256,192,1000,5,0,0:0:0:0:\n100,100,1500,1,0,0:0:0:0:\n300,100,2000,1,0,0:0:0:0:\n");
  check("load ok", ok, cstr(X.osu_error()));
  const s = stats();
  check("metadata title", cstr(X.osu_meta(0)) === "Test Map", cstr(X.osu_meta(0)));
  check("top count = 3", s[S.topCount] === 3, s[S.topCount]);
  check("colour count default 4", X.osu_colour_count() === 4, X.osu_colour_count());
  check("first object time", s[S.firstTime] === 1000, s[S.firstTime]);
  check("OD/AR/CS/HP stored", s[S.od] === 8 && s[S.ar] === 9 && s[S.cs] === 4 && s[S.hp] === 5);
  check("preempt AR9 = 600ms", near(s[S.preempt], 600), s[S.preempt]);
  // DifficultyRange(8, 80, 50, 20) = 32 -> floor(32) - 0.5; meh: DifficultyRange(8, 200, 150, 100) = 120
  check("great window OD8 = 31.5", near(s[S.wGreat], 31.5), s[S.wGreat]);
  check("meh window OD8 = 119.5", near(s[S.wMeh], 119.5), s[S.wMeh]);
  check("radius CS4", near(s[S.radius], 64 * ((1 - 0.7 * (4 - 5) / 5) / 2 * 1.00041), 1e-9), s[S.radius]);
}

// 2. Perfect play on circles: accuracy 1, all great, combo 3, total score 1,000,000
{
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n300,100,1500,1,0,0:0:0:0:\n200,250,2000,1,0,0:0:0:0:\n");
  const presses = [
    { t: 1000, x: 100, y: 100, mask: 1 },
    { t: 1500, x: 300, y: 100, mask: 1 },
    { t: 2000, x: 200, y: 250, mask: 1 },
  ];
  play({ to: 2100, presses, cursor: (t) => [200, 200], held: () => 0 });
  const s = stats();
  check("perfect circles: great x3", s[S.great] === 3, s[S.great]);
  check("perfect circles: accuracy 1", s[S.acc] === 1, s[S.acc]);
  check("perfect circles: combo 3", s[S.combo] === 3 && s[S.maxCombo] === 3, `${s[S.combo]}/${s[S.maxCombo]}`);
  check("perfect circles: score 1,000,000", s[S.score] === 1000000, s[S.score]);
  check("perfect circles: finished", s[S.finished] === 1, s[S.finished]);
  check("perfect circles: rank X", s[S.rank] === 5, s[S.rank]);
}

// 3. No input: everything misses by timeout; combo stays 0
{
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n300,100,1500,1,0,0:0:0:0:\n");
  play({ to: 2500, cursor: () => [0, 0], held: () => 0 });
  const s = stats();
  check("no input: 2 misses", s[S.miss] === 2, s[S.miss]);
  check("no input: accuracy 0", s[S.acc] === 0, s[S.acc]);
  check("no input: combo 0", s[S.combo] === 0);
  check("no input: health dropped", s[S.health] < 1, s[S.health]);
}

// 4. Press far too early is consumed and does nothing; a later press still hits
{
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n");
  const presses = [{ t: 100, x: 100, y: 100, mask: 1 }, { t: 1000, x: 100, y: 100, mask: 1 }];
  play({ to: 1100, presses, cursor: () => [100, 100], held: () => 0 });
  const s = stats();
  check("early press ignored (dt < -400)", s[S.great] === 1 && s[S.miss] === 0, `great=${s[S.great]} miss=${s[S.miss]}`);
}

// 5. Press inside the miss window (late by 300ms) is an immediate miss
{
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n");
  play({ to: 1400, presses: [{ t: 1300, x: 100, y: 100, mask: 1 }], cursor: () => [100, 100], held: () => 0 });
  const s = stats();
  check("late press 300ms = miss", s[S.miss] === 1 && s[S.great] === 0, `miss=${s[S.miss]} great=${s[S.great]}`);
}

// 6. Press outside the circle does nothing
{
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n");
  play({ to: 1300, presses: [{ t: 1000, x: 400, y: 300, mask: 1 }], cursor: () => [400, 300], held: () => 0 });
  const s = stats();
  check("press off-circle does not hit", s[S.great] === 0, s[S.great]);
}

// 7. Perfect slider: head, ticks, repeats, tail, all tracked. Score must equal max.
{
  const text = HEADER + "256,100,3000,6,0,L|384:100,1,128\n";  // type 6 = slider + new combo
  load(text);
  const s0 = stats();
  const start = 3000;
  const end = start + 128 / (100 * 1.4 / 500);  // single span, velocity px/ms
  const presses = [{ t: start, x: 256, y: 100, mask: 1 }];
  play({
    to: end + 200,
    presses,
    cursor: (t) => {
      const p = Math.min(1, Math.max(0, (t - start) / (end - start)));
      return [256 + 128 * p, 100];
    },
    held: (t) => (t >= start && t <= end + 100 ? 1 : 0),
  });
  const s = stats();
  check("slider: accuracy 1", near(s[S.acc], 1, 1e-9), s[S.acc]);
  check("slider: score equals max", s[S.score] === s0[S.maxComboPossible] * 0 + s[S.score] && s[S.score] === 1000000, s[S.score]);
  check("slider: combo equals max combo", s[S.combo] === s[S.maxCombo] && s[S.maxCombo] > 0, `${s[S.combo]}/${s[S.maxCombo]}`);
  check("slider: no misses", s[S.miss] === 0, s[S.miss]);
  check("slider: polyline points", X.osu_slider_point_count(0) > 1, X.osu_slider_point_count(0));
}

// 8. Slider that is never tracked: head hit, but ticks/tail miss -> accuracy below 1
{
  load(HEADER + "256,100,3000,6,0,L|384:100,1,128\n");
  play({ to: 3800, presses: [{ t: 3000, x: 256, y: 100, mask: 1 }], cursor: () => [0, 0], held: (t) => (t < 3010 ? 1 : 0) });
  const s = stats();
  check("untracked slider: accuracy < 1", s[S.acc] < 1, s[S.acc]);
  check("untracked slider: has miss-like judgement", s[S.miss] >= 1 || s[S.acc] < 1, `miss=${s[S.miss]}`);
}

// 9. Spinner: 4 turns per second for 3 s with the key held -> Great (progress >= 1), bonus added
{
  load(HEADER + "256,192,5000,12,0,8000\n");  // type 12 = spinner + new combo
  const cx = 256, cy = 192, R = 100;
  play({
    to: 8200,
    cursor: (t) => {
      const th = (2 * Math.PI * 4 * (t - 5000)) / 1000;
      return [cx + R * Math.sin(th), cy - R * Math.cos(th)];
    },
    held: (t) => (t >= 5000 && t <= 8000 ? 1 : 0),
  });
  const s = stats();
  check("spinner: great", s[S.great] === 1, `great=${s[S.great]} ok=${s[S.ok]} miss=${s[S.miss]}`);
  check("spinner: score >= 1e6 (bonus)", s[S.score] >= 1000000, s[S.score]);
}

// 10. Spinner not spun -> miss
{
  load(HEADER + "256,192,5000,12,0,8000\n");
  play({ to: 8200, cursor: () => [256, 100], held: () => 0 });
  const s = stats();
  check("idle spinner: miss", s[S.miss] === 1, s[S.miss]);
}

// 11. Restart resets state but keeps the loaded beatmap
{
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n");
  play({ to: 1100, presses: [{ t: 1000, x: 100, y: 100, mask: 1 }], cursor: () => [100, 100], held: () => 0 });
  X.osu_restart();
  X.osu_update(0, 0, 0, 0);
  const s = stats();
  check("restart clears judgements", s[S.great] === 0 && s[S.miss] === 0 && s[S.combo] === 0, `great=${s[S.great]}`);
  check("restart keeps max score", s[S.judgements] === 1, s[S.judgements]);
}

// 12. Records: count and layout
{
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n256,100,3000,6,0,L|384:100,1,128\n256,192,6000,12,0,7000\n");
  const n = X.osu_fill_records();
  const p = X.osu_records();
  const r = new Float32Array(X.memory.buffer, p, 16 * n);
  // top 3 + slider nests (head, ticks..., tail) + spinner ticks
  check("records: count > top count", n > 3, n);
  check("records: first is circle kind 0 at (100,100)", r[0] === 0 && near(r[1], 100, 1e-3) && near(r[2], 100, 1e-3), `${r[0]} ${r[1]} ${r[2]}`);
  let sawSpinnerTick = false, sawHead = false;
  for (let i = 0; i < n; i++) {
    const k = r[16 * i];
    if (k === 7 || k === 8) sawSpinnerTick = true;
    if (k === 3) sawHead = true;
  }
  check("records: contains slider head and spinner ticks", sawHead && sawSpinnerTick);
}

// 13. Invalid input is reported
{
  const ok = load(HEADER);
  check("empty hit objects rejected", ok === false, "");
  check("error message set", cstr(X.osu_error()).length > 0, cstr(X.osu_error()));
}

// 14. Failure mods (osu_set_mods): NoFail never fails, SuddenDeath fails on a miss, Perfect on any
// result below the top one. Health still fails a play that has no fail mod.
{
  const NF = 1, SD = 2, PF = 4;
  const many = Array.from({ length: 60 }, (_, i) => `100,100,${1000 + i * 500},1,0,0:0:0:0:\n`).join("");

  X.osu_set_mods(0);
  load(HEADER + many);
  play({ to: 31000, cursor: () => [0, 0], held: () => 0 });
  check("no mods: idle play fails", stats()[S.failed] === 1, stats()[S.failed]);

  X.osu_set_mods(NF);
  load(HEADER + many);
  play({ to: 31000, cursor: () => [0, 0], held: () => 0 });
  let s = stats();
  check("no fail: idle play never fails", s[S.failed] === 0, s[S.failed]);
  check("no fail: health still empties", s[S.health] === 0, s[S.health]);
  check("no fail: all 60 misses counted", s[S.miss] === 60, s[S.miss]);

  X.osu_set_mods(SD);
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n100,100,3000,1,0,0:0:0:0:\n");
  const hit = [{ t: 1000, x: 100, y: 100, mask: 1 }];
  play({ to: 2000, presses: hit, cursor: () => [100, 100], held: () => 0 });
  s = stats();
  check("sudden death: a hit does not fail", s[S.failed] === 0 && s[S.great] === 1, `failed=${s[S.failed]} great=${s[S.great]}`);
  play({ from: 2010, to: 3300, cursor: () => [100, 100], held: () => 0 });
  s = stats();
  check("sudden death: the first miss fails", s[S.failed] === 1 && s[S.miss] === 1, `failed=${s[S.failed]} miss=${s[S.miss]}`);

  X.osu_set_mods(PF);
  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n300,100,1500,1,0,0:0:0:0:\n200,250,2000,1,0,0:0:0:0:\n");
  play({
    to: 2100,
    presses: [{ t: 1000, x: 100, y: 100, mask: 1 }, { t: 1500, x: 300, y: 100, mask: 1 }, { t: 2000, x: 200, y: 250, mask: 1 }],
    cursor: () => [200, 200], held: () => 0,
  });
  s = stats();
  check("perfect: all great does not fail", s[S.failed] === 0 && s[S.great] === 3, `failed=${s[S.failed]} great=${s[S.great]}`);

  load(HEADER + "100,100,1000,5,0,0:0:0:0:\n");
  play({ to: 1200, presses: [{ t: 1080, x: 100, y: 100, mask: 1 }], cursor: () => [100, 100], held: () => 0 });
  s = stats();
  check("perfect: a late hit fails", s[S.failed] === 1 && s[S.great] === 0, `failed=${s[S.failed]} great=${s[S.great]}`);

  X.osu_set_mods(0);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
