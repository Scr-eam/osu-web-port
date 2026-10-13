// osu!standard gameplay core (C API).
//
// Ported from osu!lazer (2026.1005.0): hit windows, difficulty ranges, beatmap
// processing (combo, stacking, slider events), judgements for circles / sliders /
// spinners, ScoreProcessor (ScoreV2 weights), OsuHealthProcessor.
//
// Built with Emscripten (emcc -sSTANDALONE_WASM) or clang --target=wasm32.
// No libc / STL is used by the core itself.
//
// Usage from JS:
//   1. Write the .osu text into osu_input_buffer(n), then osu_load(n).
//   2. Optionally write skin colours into osu_skin_buffer(count) and call
//      osu_set_skin_colours(count) before load (beatmap [Colours] take precedence).
//   3. Each frame:  osu_press(...) for each new button press (in time order),
//                   then osu_update(...), then osu_fill_records() and read records.
//
// Coordinates are playfield pixels (512 x 384). Times are song milliseconds.
// `mask` bits: 1 = key 1, 2 = key 2, 4 = left mouse button, 8 = right mouse button.

#ifndef OSU_CORE_H
#define OSU_CORE_H

#ifdef __cplusplus
extern "C" {
#endif

// ---- loading -------------------------------------------------------------
char* osu_input_buffer(int capacity);
int osu_load(int length);               // 1 = ok, 0 = failed (see osu_error)
const char* osu_error(void);
const char* osu_meta(int which);        // 0 title, 1 artist, 2 version, 3 audio filename

float* osu_skin_buffer(int count);      // capacity for count RGB triples (0..255)
void osu_set_skin_colours(int count);
int osu_colour_count(void);
const float* osu_colours(void);         // RGB triples (0..255)

// ---- playback ------------------------------------------------------------
void osu_restart(void);
void osu_update(double timeMs, float x, float y, int mask);
void osu_press(double timeMs, float x, float y, int mask);
// Failure mods: 1 No Fail (never fails), 2 Sudden Death (fails on a miss), 4 Perfect (fails on any result
// below the top one). Health can still fail a play with 2 or 4. Any time; takes effect with the next result.
void osu_set_mods(int bits);

// ---- rendering data ------------------------------------------------------
// Record layout (16 floats each):
//   0  kind: 0 circle, 1 slider, 2 spinner, 3 slider head, 4 slider tick,
//            5 slider repeat, 6 slider tail, 7 spinner tick, 8 spinner bonus tick
//   1  x (stacked position)            2  y
//   3  radius (px)                     4  start time (ms)
//   5  end time (ms)                   6  combo colour index (not reduced): use it modulo the
//                                          palette length, osu_colours() count or the skin's
//   7  combo number (0 = none)         8  state: 0 open, 1 hit, 2 missed
//   9  judged time (ms, -1 = none)    10  result code (see below)
//   11 slider/spinner progress 0..1    12 slider ball x   13 slider ball y
//   14 1 while tracking (slider) or spinning (spinner), else 0
//   15 top-level index (for sliders/spinners) or -1
// Result codes: 0 none, 1 miss, 2 meh (50), 3 ok (100), 4 good, 5 great (300),
//   6 perfect, 7 small tick miss, 8 small tick hit, 9 large tick miss,
//   10 large tick hit, 11 small bonus, 12 large bonus, 13 ignore miss,
//   14 ignore hit, 15 combo break, 16 slider tail hit
int osu_fill_records(void);             // returns number of records written
const float* osu_records(void);
int osu_top_count(void);                // number of top-level objects
int osu_slider_point_count(int topIndex);
const float* osu_slider_points(int topIndex); // stacked polyline, x,y pairs

// ---- stats ---------------------------------------------------------------
// Indices: 0 score, 1 accuracy (0..1), 2 combo, 3 max combo, 4 great, 5 ok,
// 6 meh, 7 miss, 8 health (0..1), 9 failed, 10 finished, 11 rank (0 D .. 5 X),
// 12 current time, 13 end time, 14 preempt ms, 15 fade-in ms, 16 radius px,
// 17 OD, 18 AR, 19 CS, 20 HP, 21 great window ms, 22 ok window ms,
// 23 meh window ms, 24 miss window ms, 25 drain rate, 26 top-level count,
// 27 first object time, 28 colour count, 29 loaded, 30 max possible combo,
// 31 total judgements
const double* osu_stats(void);

#ifdef __cplusplus
}
#endif

#endif  // OSU_CORE_H
