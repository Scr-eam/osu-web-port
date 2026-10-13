// Internal definitions for the osu!standard core.
// Freestanding style: no libc, no STL, no exceptions, no RTTI.
#ifndef OSU_CORE_INTERNAL_H
#define OSU_CORE_INTERNAL_H

typedef unsigned long long u64;
typedef unsigned int u32;
typedef unsigned char u8;

namespace oc {

// ---------------------------------------------------------------- math ----
struct Vec2 {
    double x, y;
};
inline Vec2 V(double x, double y) { Vec2 v; v.x = x; v.y = y; return v; }
inline Vec2 operator+(Vec2 a, Vec2 b) { return V(a.x + b.x, a.y + b.y); }
inline Vec2 operator-(Vec2 a, Vec2 b) { return V(a.x - b.x, a.y - b.y); }
inline Vec2 operator*(Vec2 a, double s) { return V(a.x * s, a.y * s); }
inline double len2(Vec2 a) { return a.x * a.x + a.y * a.y; }
inline double vlen(Vec2 a) { return __builtin_sqrt(len2(a)); }
inline double dist(Vec2 a, Vec2 b) { return vlen(a - b); }
inline bool veq(Vec2 a, Vec2 b) { return a.x == b.x && a.y == b.y; }
inline double clampd(double v, double a, double b) { return v < a ? a : (v > b ? b : v); }
inline double absd(double v) { return v < 0 ? -v : v; }
inline double signd(double v) { return v > 0 ? 1.0 : (v < 0 ? -1.0 : 0.0); }
inline double floord(double v) { return __builtin_floor(v); }

const double PI = 3.14159265358979323846;

// --------------------------------------------------------------- arena ----
// Bump allocator over a static arena. Reset on every load.
void* arenaAlloc(unsigned long bytes);
void arenaReset();
unsigned long arenaUsed();

template <class T>
struct Buf {
    T* d;
    int n;
    int cap;
    void init() { d = 0; n = 0; cap = 0; }
    void reserve(int c) {
        if (c <= cap) return;
        int nc = cap ? cap * 2 : 16;
        if (nc < c) nc = c;
        T* nd = (T*)arenaAlloc(sizeof(T) * (unsigned long)nc);
        for (int i = 0; i < n; i++) nd[i] = d[i];
        d = nd;
        cap = nc;
    }
    void push(const T& v) {
        if (n == cap) reserve(n + 1);
        d[n++] = v;
    }
    T& operator[](int i) { return d[i]; }
    const T& operator[](int i) const { return d[i]; }
    T& last() { return d[n - 1]; }
    void clear() { n = 0; }
    void removeLast() { n--; }
    void removeAt(int i) {
        for (int k = i; k + 1 < n; k++) d[k] = d[k + 1];
        n--;
    }
};

// ----------------------------------------------------------- results ----
enum Res {
    RES_NONE = 0,
    RES_MISS = 1,
    RES_MEH = 2,
    RES_OK = 3,
    RES_GOOD = 4,
    RES_GREAT = 5,
    RES_PERFECT = 6,
    RES_SMALL_TICK_MISS = 7,
    RES_SMALL_TICK_HIT = 8,
    RES_LARGE_TICK_MISS = 9,
    RES_LARGE_TICK_HIT = 10,
    RES_SMALL_BONUS = 11,
    RES_LARGE_BONUS = 12,
    RES_IGNORE_MISS = 13,
    RES_IGNORE_HIT = 14,
    RES_COMBO_BREAK = 15,
    RES_SLIDER_TAIL_HIT = 16,
};

bool resIsHit(int r);
bool resAffectsCombo(int r);
bool resIncreasesCombo(int r);
bool resBreaksCombo(int r);
bool resIsScorable(int r);
bool resIsBonus(int r);
bool resAffectsAccuracy(int r);
int resBaseScore(int r);

// Judgement roles: which kind of object produced a result. Determines the
// judgement's MaxResult / MinResult and the health increase.
enum Role {
    ROLE_CIRCLE = 0,
    ROLE_HEAD,
    ROLE_SPINNER,
    ROLE_SPIN_TICK,
    ROLE_SPIN_BONUS,
    ROLE_SLIDER_TICK,
    ROLE_REPEAT,
    ROLE_TAIL,
    ROLE_SLIDER_IGNORE,
};
int roleMax(int role);
int roleMin(int role, int maxRes);

// ----------------------------------------------------------- path ----
enum PathKind { PK_NONE = -1, PK_LINEAR = 0, PK_PERFECT = 1, PK_BEZIER = 2, PK_CATMULL = 3 };

struct PathPt {
    Vec2 p;
    int type;  // PathKind for the first point of a segment, PK_NONE otherwise
};

struct SliderPath {
    Buf<PathPt> cps;
    bool hasExpected;
    double expected;
    Buf<Vec2> calc;
    Buf<double> cum;
    double optimised;
    double calcLen;

    void init() {
        cps.init();
        calc.init();
        cum.init();
        hasExpected = false;
        expected = 0;
        optimised = 0;
        calcLen = 0;
    }
    // Recomputes calc / cum after cps or expected changed.
    void rebuild();
    double distance() const { return cum.n == 0 ? 0 : cum.d[cum.n - 1]; }
    Vec2 positionAt(double progress) const;
};

// ----------------------------------------------------------- beatmap ----
struct TimingPoint {
    double time;
    double beatLength;
    bool uninherited;
};

struct BreakPeriod {
    double start, end;
};

struct Rgb {
    double r, g, b;
};

// Objects are stored in two arrays: top-level (circles, sliders, spinners) and
// nested (slider head/ticks/repeats/tail, spinner ticks). A top-level object owns
// the nested range [nestBegin, nestBegin + nestCount).
enum Kind { K_CIRCLE = 0, K_SLIDER = 1, K_SPINNER = 2 };

enum NestKind {
    N_HEAD = 0,
    N_TICK = 1,
    N_REPEAT = 2,
    N_TAIL = 3,
    N_SPIN_TICK = 4,
    N_SPIN_BONUS = 5,
};

struct Nest {
    int kind;
    int parent;       // index into g_top
    double time;
    double progress;  // path progress for slider nested objects
    Vec2 pos;         // stacked position, used for drawing
    bool judged;
    int res;
    double judgedAt;
};

struct Obj {
    int kind;
    double time;
    double end;
    Vec2 pos;          // unstacked position
    int stack;
    double scale;
    double radius;
    bool newCombo;
    bool lastInCombo;
    int comboIndex;
    int comboIndexOffsets;
    int comboOffsetSkip;  // ComboOffset from the file's type bits (used only on new combos)
    int indexInCombo;
    int colour;
    int number;
    Vec2 stackedPos;   // pos + stack offset (drawn and hit-tested position)

    // slider
    SliderPath* path;
    double velocity;
    double tickDistance;
    double spanDuration;
    int spanCount;
    double pathLen;
    Buf<Vec2> poly;  // stacked polyline for drawing
    double preempt;

    // spinner
    int spinsRequired;
    int maxBonus;

    int nestBegin;
    int nestCount;

    // judgement state
    bool judged;
    int res;
    double judgedAt;

    // tracking state (slider)
    bool tracking;
    bool acceptAny;
    int headAction;
    bool hasHead;     // nested head index is nestBegin

    // spin history (spinner)
    double totalRot;
    double atLast;
    double curMax;
    int completedSpins;
    double lastAngle;
    bool hasLastAngle;
    int ticksHit;     // number of spinner ticks already judged (in order)

    // slider tracking (SliderInputManager)
    double acceptAnyAfter;
    bool hasAcceptAfter;
    int prevHeld;       // held action bits in the previous frame (1 left, 2 right)

    // spinner rotation history (SpinnerSpinHistory), float like the C# source
    float histAccum;
    float histAtLast;
    float histMax;
    double histLastReport;
    Buf<double> spinTimes;   // completed full spins: completion time
    Buf<int> spinDirs;       // completed full spins: direction (+1 / -1)
    int completedFullSpins;
    float spinLastAngle;
};

struct BeatmapData {
    int formatVersion;
    double stackLeniency;
    double hp, cs, od, ar;
    double sliderMultiplier;
    double tickRate;
    char audio[256];
    char title[256];
    char artist[256];
    char version[256];
    Buf<TimingPoint> timing;
    Buf<BreakPeriod> breaks;
    Buf<Rgb> colours;
    bool hasBeatmapColours;
};

// Entry point used by api.cpp. Returns false and sets err on failure.
bool loadBeatmap(const char* text, int length, const Rgb* skinColours, int skinCount, const char** err);

// Shared state between beatmap loader and gameplay.
extern BeatmapData g_map;
extern Buf<Obj> g_top;
extern Buf<Nest> g_nest;
extern Buf<Rgb> g_colours;     // active colour table (beatmap or skin)
extern double g_preempt;
extern double g_fadeIn;
extern double g_radius;
extern double g_scale;
extern double g_windowGreat;
extern double g_windowOk;
extern double g_windowMeh;
extern double g_windowMiss;
extern double g_drainRate;
extern double g_drainStart;
extern double g_gameplayEnd;
extern double g_firstTime;

// Path / slider helpers (path.cpp)
double curveProgress(const Obj& o, double progress);   // ProgressAt
Vec2 curvePosition(const Obj& o, double progress);      // relative to slider head
Vec2 endPositionRel(const Obj& o);                      // relative end position

}  // namespace oc

#endif
