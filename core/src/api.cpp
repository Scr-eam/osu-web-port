// C API (include/osu_core.h): arena, buffers, load / playback / records / stats.
#include "game.h"
#include "../include/osu_core.h"

// ---- freestanding libc subset (the core is built without libc) ----
extern "C" {
void* memcpy(void* d, const void* s, unsigned long n) {
    unsigned char* dd = (unsigned char*)d;
    const unsigned char* ss = (const unsigned char*)s;
    for (unsigned long i = 0; i < n; i++) dd[i] = ss[i];
    return d;
}
void* memmove(void* d, const void* s, unsigned long n) {
    unsigned char* dd = (unsigned char*)d;
    const unsigned char* ss = (const unsigned char*)s;
    if (dd < ss) {
        for (unsigned long i = 0; i < n; i++) dd[i] = ss[i];
    } else {
        for (unsigned long i = n; i > 0; i--) dd[i - 1] = ss[i - 1];
    }
    return d;
}
void* memset(void* d, int c, unsigned long n) {
    unsigned char* dd = (unsigned char*)d;
    for (unsigned long i = 0; i < n; i++) dd[i] = (unsigned char)c;
    return d;
}
}

namespace oc {

// ---------------------------------------------------------------- arena ----
static const unsigned long ARENA_BYTES = 64UL * 1024 * 1024;
static unsigned char g_arena[ARENA_BYTES] __attribute__((aligned(16)));
static unsigned long g_arenaTop = 0;
static bool g_arenaOverflow = false;

void* arenaAlloc(unsigned long bytes) {
    unsigned long aligned = (bytes + 7UL) & ~7UL;
    if (g_arenaTop + aligned > ARENA_BYTES) {
        g_arenaOverflow = true;
        return 0;
    }
    void* p = g_arena + g_arenaTop;
    g_arenaTop += aligned;
    return p;
}

void arenaReset() {
    g_arenaTop = 0;
    g_arenaOverflow = false;
}

unsigned long arenaUsed() { return g_arenaTop; }

}  // namespace oc

// -------------------------------------------------------------- state ----
using namespace oc;

static const int INPUT_CAP = 8 * 1024 * 1024;
static char g_input[INPUT_CAP];
static const char* g_err = "";
static bool g_loaded = false;

static float g_skinF[256 * 3];
static Rgb g_skinRgb[256];
static int g_skinCount = 0;

static float* g_colourF = 0;      // osu_colours()
static float* g_rec = 0;          // records, 16 floats each
static int g_recCount = 0;
static float** g_polyPtr = 0;     // per top-level object: stacked polyline, x,y floats
static int* g_polyCount = 0;

static double g_prevFrameT = 0;
static double g_stats[32];

static int actsFromMask(int m) {
    int a = 0;
    if (m & (1 | 4)) a |= ACT_LEFT;
    if (m & (2 | 8)) a |= ACT_RIGHT;
    return a;
}

// Allocates the float mirrors used by the C API after a successful load.
static bool allocMirrors() {
    g_colourF = (float*)arenaAlloc(sizeof(float) * 3 * (unsigned long)(g_colours.n > 0 ? g_colours.n : 1));
    for (int i = 0; i < g_colours.n; i++) {
        g_colourF[i * 3 + 0] = (float)g_colours[i].r;
        g_colourF[i * 3 + 1] = (float)g_colours[i].g;
        g_colourF[i * 3 + 2] = (float)g_colours[i].b;
    }
    int nests = g_nest.n;
    g_recCount = g_top.n + nests;
    g_rec = (float*)arenaAlloc(sizeof(float) * 16 * (unsigned long)(g_recCount > 0 ? g_recCount : 1));
    g_polyPtr = (float**)arenaAlloc(sizeof(float*) * (unsigned long)(g_top.n > 0 ? g_top.n : 1));
    g_polyCount = (int*)arenaAlloc(sizeof(int) * (unsigned long)(g_top.n > 0 ? g_top.n : 1));
    for (int i = 0; i < g_top.n; i++) {
        const Obj& o = g_top[i];
        g_polyCount[i] = o.poly.n;
        g_polyPtr[i] = 0;
        if (o.kind == K_SLIDER && o.poly.n > 0) {
            float* f = (float*)arenaAlloc(sizeof(float) * 2 * (unsigned long)o.poly.n);
            if (!f) return false;
            for (int k = 0; k < o.poly.n; k++) {
                f[2 * k] = (float)o.poly[k].x;
                f[2 * k + 1] = (float)o.poly[k].y;
            }
            g_polyPtr[i] = f;
        }
    }
    return !g_arenaOverflow && g_rec != 0 && g_colourF != 0 && g_polyPtr != 0 && g_polyCount != 0;
}

static void writeRec(float* r, int kind, Vec2 pos, double rad, double st, double en, int colour, int combo,
                     bool judged, int res, double judgedAt, double progress, Vec2 ball, bool tracking, int topIdx) {
    r[0] = (float)kind;
    r[1] = (float)pos.x;
    r[2] = (float)pos.y;
    r[3] = (float)rad;
    r[4] = (float)st;
    r[5] = (float)en;
    r[6] = (float)colour;
    r[7] = (float)combo;
    r[8] = !judged ? 0.0f : (resIsHit(res) ? 1.0f : 2.0f);
    r[9] = judged ? (float)judgedAt : -1.0f;
    r[10] = judged ? (float)res : 0.0f;
    r[11] = (float)progress;
    r[12] = (float)ball.x;
    r[13] = (float)ball.y;
    r[14] = tracking ? 1.0f : 0.0f;
    r[15] = (float)topIdx;
}

// Fills g_rec from the current state (osu_fill_records).
static int fillRecords() {
    int w = 0;
    for (int i = 0; i < g_top.n; i++) {
        const Obj& o = g_top[i];
        float* r = g_rec + 16 * w;
        if (o.kind == K_CIRCLE) {
            writeRec(r, 0, o.stackedPos, o.radius, o.time, o.end, o.colour, o.number, o.judged, o.res, o.judgedAt, 0, V(0, 0), false, -1);
        } else if (o.kind == K_SLIDER) {
            double prog = (o.end - o.time) > 0 ? clampd((g_now - o.time) / (o.end - o.time), 0, 1) : 0;
            Vec2 ball = o.stackedPos + curvePosition(o, prog);
            writeRec(r, 1, o.stackedPos, o.radius, o.time, o.end, o.colour, o.number, o.judged, o.res, o.judgedAt, prog, ball, o.tracking, i);
        } else {
            double prog = 1;
            if (o.spinsRequired > 0) {
                float tr = 360.0f * (float)o.spinDirs.n + o.histMax;
                float p = tr / 360.0f / (float)o.spinsRequired;
                prog = p < 0 ? 0 : (p > 1 ? 1 : p);
            }
            writeRec(r, 2, V(PLAYFIELD_CX, PLAYFIELD_CY), o.radius, o.time, o.end, o.colour, o.number, o.judged, o.res, o.judgedAt, prog, V(0, 0), o.tracking, i);
        }
        w++;
    }
    for (int i = 0; i < g_top.n; i++) {
        const Obj& o = g_top[i];
        for (int k = 0; k < o.nestCount; k++) {
            const Nest& n = g_nest[o.nestBegin + k];
            float* r = g_rec + 16 * w;
            int kind;
            switch (n.kind) {
                case N_HEAD: kind = 3; break;
                case N_TICK: kind = 4; break;
                case N_REPEAT: kind = 5; break;
                case N_TAIL: kind = 6; break;
                case N_SPIN_TICK: kind = 7; break;
                default: kind = 8; break;
            }
            Vec2 pos = o.kind == K_SLIDER ? n.pos : o.stackedPos;
            writeRec(r, kind, pos, o.radius, n.time, n.time, o.colour, o.number, n.judged, n.res, n.judgedAt, n.progress, V(0, 0), false, i);
            w++;
        }
    }
    return w;
}

static void fillStats() {
    double* s = g_stats;
    for (int i = 0; i < 32; i++) s[i] = 0;
    s[0] = g_totalScore;
    s[1] = accuracyValue();
    s[2] = g_combo;
    s[3] = g_highestCombo;
    s[4] = g_resCount[RES_GREAT];
    s[5] = g_resCount[RES_OK];
    s[6] = g_resCount[RES_MEH];
    s[7] = g_resCount[RES_MISS];
    s[8] = g_health;
    s[9] = g_failed ? 1 : 0;
    s[10] = (g_judgedCount >= g_maxJudgedCount && g_now >= g_gameplayEnd) ? 1 : 0;
    s[11] = rankValue();
    s[12] = g_now;
    s[13] = g_gameplayEnd;
    s[14] = g_preempt;
    s[15] = g_fadeIn;
    s[16] = g_radius;
    s[17] = g_map.od;
    s[18] = g_map.ar;
    s[19] = g_map.cs;
    s[20] = g_map.hp;
    s[21] = g_windowGreat;
    s[22] = g_windowOk;
    s[23] = g_windowMeh;
    s[24] = g_windowMiss;
    s[25] = g_drainRate;
    s[26] = g_top.n;
    s[27] = g_firstTime;
    s[28] = g_colours.n;
    s[29] = g_loaded ? 1 : 0;
    s[30] = g_maxCombo;
    s[31] = g_maxJudgedCount;
}

// ----------------------------------------------------------- C API ----
extern "C" {

char* osu_input_buffer(int capacity) {
    if (capacity < 0 || capacity > INPUT_CAP) return 0;
    return g_input;
}

int osu_load(int length) {
    g_loaded = false;
    if (length < 0 || length > INPUT_CAP) {
        g_err = "Input too large.";
        return 0;
    }
    const char* err = "";
    if (!loadBeatmap(g_input, length, g_skinRgb, g_skinCount, &err)) {
        g_err = err;
        return 0;
    }
    if (!allocMirrors()) {
        g_err = "Beatmap does not fit in the core arena.";
        return 0;
    }
    simulateBeatmap();
    judgeReset();
    scoreResetLive();
    g_now = 0;
    g_prevFrameT = g_drainStart;
    g_err = "";
    g_loaded = true;
    return 1;
}

const char* osu_error(void) { return g_err; }

const char* osu_meta(int which) {
    switch (which) {
        case 0: return g_map.title;
        case 1: return g_map.artist;
        case 2: return g_map.version;
        case 3: return g_map.audio;
        default: return "";
    }
}

float* osu_skin_buffer(int count) {
    if (count < 0 || count > 256) return 0;
    return g_skinF;
}

void osu_set_skin_colours(int count) {
    if (count < 0) count = 0;
    if (count > 256) count = 256;
    g_skinCount = count;
    for (int i = 0; i < count; i++) {
        g_skinRgb[i].r = g_skinF[i * 3 + 0];
        g_skinRgb[i].g = g_skinF[i * 3 + 1];
        g_skinRgb[i].b = g_skinF[i * 3 + 2];
    }
}

// Failure mods (MOD_* bits in game.h). Any time before or during play; the next result or health step uses it.
void osu_set_mods(int bits) { g_mods = bits; }

int osu_colour_count(void) { return g_colours.n; }

const float* osu_colours(void) { return g_colourF; }

void osu_restart(void) {
    if (!g_loaded) return;
    judgeReset();
    scoreResetLive();
    g_now = 0;
    g_prevFrameT = g_drainStart;
}

void osu_update(double timeMs, float x, float y, int mask) {
    if (!g_loaded) return;
    g_mx = x;
    g_my = y;
    g_held = actsFromMask(mask);
    double prev = g_started ? g_prevFrameT : timeMs;
    judgeFrame(timeMs);
    healthDrain(prev, timeMs);
    g_prevFrameT = timeMs;
    g_started = true;
}

void osu_press(double timeMs, float x, float y, int mask) {
    if (!g_loaded) return;
    g_mx = x;
    g_my = y;
    int acts = actsFromMask(mask);
    if (acts & ACT_LEFT) judgePress(timeMs, ACT_LEFT);
    if (acts & ACT_RIGHT) judgePress(timeMs, ACT_RIGHT);
}

int osu_fill_records(void) {
    if (!g_loaded) return 0;
    return fillRecords();
}

const float* osu_records(void) { return g_rec; }

int osu_top_count(void) { return g_top.n; }

int osu_slider_point_count(int topIndex) {
    if (topIndex < 0 || topIndex >= g_top.n) return 0;
    return g_polyCount[topIndex];
}

const float* osu_slider_points(int topIndex) {
    if (topIndex < 0 || topIndex >= g_top.n) return 0;
    return g_polyPtr[topIndex];
}

const double* osu_stats(void) {
    fillStats();
    return g_stats;
}

}  // extern "C"
