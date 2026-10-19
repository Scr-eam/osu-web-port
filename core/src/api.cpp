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

// ---- practice: rewind / fast forward ----
// Objects passed over by a fast forward are skipped: marked judged with no result, so they score nothing,
// break nothing and are not drawn (judgedAt far in the past). They still count towards the end of the map.
static int g_skipCount = 0;
static double* g_stBuf = 0;   // osu_state_save / osu_state_load buffer (in the arena; reset by a load)
static int g_stCap = 0;
static const double SKIPPED_AT = -1e9;

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
    s[10] = (g_judgedCount + g_skipCount >= g_maxJudgedCount && g_now >= g_gameplayEnd) ? 1 : 0;
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
    g_skipCount = 0;
    g_stBuf = 0;              // the arena was reset by the load
    g_stCap = 0;
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
    g_skipCount = 0;
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

// ---- state save / load (rewind) ----
// Layout, all doubles: [topN, nestN, varLen] [G globals] [TB per top-level object] [NB per nested object]
// [var: per spinner, its spin history: count, times..., count, dirs...]
static const int ST_G = 52, ST_TB = 22, ST_NB = 3;

static int stateVarLen() {
    int v = 0;
    for (int i = 0; i < g_top.n; i++)
        if (g_top[i].kind == K_SPINNER) v += 2 + g_top[i].spinTimes.n + g_top[i].spinDirs.n;
    return v;
}

double* osu_state_buffer(int length) {
    if (length < 0) return 0;
    if (length > g_stCap) {
        double* nb = (double*)arenaAlloc(sizeof(double) * (unsigned long)(length + 1024));
        if (!nb) return 0;
        g_stBuf = nb;
        g_stCap = length + 1024;
    }
    return g_stBuf;
}

int osu_state_save(void) {
    if (!g_loaded) return 0;
    int var = stateVarLen();
    int len = 3 + ST_G + ST_TB * g_top.n + ST_NB * g_nest.n + var;
    double* b = osu_state_buffer(len);
    if (!b) return 0;
    b[0] = g_top.n; b[1] = g_nest.n; b[2] = var;
    double* g = b + 3;
    g[0] = g_now; g[1] = g_mx; g[2] = g_my; g[3] = g_held; g[4] = g_started ? 1 : 0; g[5] = g_prevFrameT;
    g[6] = g_combo; g[7] = g_highestCombo; g[8] = g_curBase; g[9] = g_curMaxBase; g[10] = g_curComboPortion;
    g[11] = g_curBonus; g[12] = g_curAccCount; g[13] = g_totalScore; g[14] = g_health; g[15] = g_failed ? 1 : 0;
    g[16] = g_judgedCount; g[17] = g_comboResult; g[18] = 0; g[19] = g_skipCount;
    for (int i = 0; i < 32; i++) g[20 + i] = g_resCount[i];
    double* t = g + ST_G;
    for (int i = 0; i < g_top.n; i++, t += ST_TB) {
        const Obj& o = g_top[i];
        t[0] = o.judged; t[1] = o.res; t[2] = o.judgedAt; t[3] = o.tracking; t[4] = o.acceptAny; t[5] = o.headAction;
        t[6] = o.totalRot; t[7] = o.atLast; t[8] = o.curMax; t[9] = o.completedSpins; t[10] = o.lastAngle;
        t[11] = o.hasLastAngle; t[12] = o.ticksHit; t[13] = o.acceptAnyAfter; t[14] = o.hasAcceptAfter; t[15] = o.prevHeld;
        t[16] = o.histAccum; t[17] = o.histAtLast; t[18] = o.histMax; t[19] = o.histLastReport;
        t[20] = o.completedFullSpins; t[21] = o.spinLastAngle;
    }
    for (int i = 0; i < g_nest.n; i++, t += ST_NB) {
        const Nest& n = g_nest[i];
        t[0] = n.judged; t[1] = n.res; t[2] = n.judgedAt;
    }
    for (int i = 0; i < g_top.n; i++) {
        const Obj& o = g_top[i];
        if (o.kind != K_SPINNER) continue;
        *t++ = o.spinTimes.n;
        for (int k = 0; k < o.spinTimes.n; k++) *t++ = o.spinTimes[k];
        *t++ = o.spinDirs.n;
        for (int k = 0; k < o.spinDirs.n; k++) *t++ = o.spinDirs[k];
    }
    return len;
}

// Restores a state written by osu_state_save (for this same loaded map). 1 = ok.
int osu_state_load(int length) {
    if (!g_loaded || !g_stBuf || length < 3 + ST_G) return 0;
    double* b = g_stBuf;
    if ((int)b[0] != g_top.n || (int)b[1] != g_nest.n) return 0;
    int var = (int)b[2];
    if (length != 3 + ST_G + ST_TB * g_top.n + ST_NB * g_nest.n + var) return 0;
    double* g = b + 3;
    g_now = g[0]; g_mx = g[1]; g_my = g[2]; g_held = (int)g[3]; g_started = g[4] != 0; g_prevFrameT = g[5];
    g_combo = (int)g[6]; g_highestCombo = (int)g[7]; g_curBase = g[8]; g_curMaxBase = g[9]; g_curComboPortion = g[10];
    g_curBonus = g[11]; g_curAccCount = (int)g[12]; g_totalScore = g[13]; g_health = g[14]; g_failed = g[15] != 0;
    g_judgedCount = (int)g[16]; g_comboResult = (int)g[17]; g_skipCount = (int)g[19];
    for (int i = 0; i < 32; i++) g_resCount[i] = (int)g[20 + i];
    double* t = g + ST_G;
    for (int i = 0; i < g_top.n; i++, t += ST_TB) {
        Obj& o = g_top[i];
        o.judged = t[0] != 0; o.res = (int)t[1]; o.judgedAt = t[2]; o.tracking = t[3] != 0; o.acceptAny = t[4] != 0;
        o.headAction = (int)t[5]; o.totalRot = t[6]; o.atLast = t[7]; o.curMax = t[8]; o.completedSpins = (int)t[9];
        o.lastAngle = t[10]; o.hasLastAngle = t[11] != 0; o.ticksHit = (int)t[12]; o.acceptAnyAfter = t[13];
        o.hasAcceptAfter = t[14] != 0; o.prevHeld = (int)t[15]; o.histAccum = (float)t[16]; o.histAtLast = (float)t[17];
        o.histMax = (float)t[18]; o.histLastReport = t[19]; o.completedFullSpins = (int)t[20]; o.spinLastAngle = (float)t[21];
    }
    for (int i = 0; i < g_nest.n; i++, t += ST_NB) {
        Nest& n = g_nest[i];
        n.judged = t[0] != 0; n.res = (int)t[1]; n.judgedAt = t[2];
    }
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.kind != K_SPINNER) continue;
        int nt = (int)*t++;
        o.spinTimes.clear();
        for (int k = 0; k < nt; k++) o.spinTimes.push(*t++);
        int nd = (int)*t++;
        o.spinDirs.clear();
        for (int k = 0; k < nd; k++) o.spinDirs.push((int)*t++);
    }
    scoreUpdate();
    return 1;
}

// Fast forward: every object (and its nested objects) that starts before t and is not judged yet is skipped.
void osu_skip_until(double t) {
    if (!g_loaded) return;
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time >= t) continue;
        if (!o.judged) {
            o.judged = true; o.res = RES_NONE; o.judgedAt = SKIPPED_AT; o.tracking = false;
            g_skipCount++;
        }
        for (int k = 0; k < o.nestCount; k++) {
            Nest& n = g_nest[o.nestBegin + k];
            if (n.judged) continue;
            n.judged = true; n.res = RES_NONE; n.judgedAt = SKIPPED_AT;
            g_skipCount++;
        }
    }
    if (t > g_now) g_now = t;
    g_prevFrameT = t;
}

}  // extern "C"
