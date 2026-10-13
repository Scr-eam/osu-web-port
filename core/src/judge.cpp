// Hit judgement: port of DrawableHitCircle / DrawableSlider / DrawableSliderHead /
// SliderInputManager / DrawableSpinner / SpinnerRotationTracker / SpinnerSpinHistory and
// the default StartTimeOrderedHitPolicy (lazer 2026.1005.0).
//
// Time model: judgeFrame(t) is the per-frame Update step (timeouts, tracking, nested
// judgements). judgePress(t, act) is an input event at time t with the cursor at
// (g_mx, g_my). Both use the same rules the drawables use.
#include "game.h"

namespace oc {

double g_now;
double g_mx, g_my;
int g_held;
bool g_started;

// -------------------------------------------------------- helpers ----
int roleOfNest(int kind) {
    switch (kind) {
        case N_HEAD: return ROLE_HEAD;
        case N_TICK: return ROLE_SLIDER_TICK;
        case N_REPEAT: return ROLE_REPEAT;
        case N_TAIL: return ROLE_TAIL;
        case N_SPIN_TICK: return ROLE_SPIN_TICK;
        case N_SPIN_BONUS: return ROLE_SPIN_BONUS;
    }
    return ROLE_SLIDER_TICK;
}

static int topRole(const Obj& o) {
    if (o.kind == K_CIRCLE) return ROLE_CIRCLE;
    if (o.kind == K_SLIDER) return ROLE_SLIDER_IGNORE;
    return ROLE_SPINNER;
}

// OsuHitWindows.ResultFor (Perfect is not allowed, so Great is the first check).
static int resultFor(double dt) {
    double a = absd(dt);
    if (a <= g_windowGreat) return RES_GREAT;
    if (a <= g_windowOk) return RES_OK;
    if (a <= g_windowMeh) return RES_MEH;
    if (a <= g_windowMiss) return RES_MISS;
    return RES_NONE;
}

// HitWindows.CanBeHit: lowest allowed result is Meh.
static bool canBeHit(double dt) { return dt <= g_windowMeh; }

// Ref to a blocking-capable object (circle, or slider head), for the hit policy.
struct Ref {
    bool nest;
    int idx;
};

static double refTime(Ref r) { return r.nest ? g_nest[r.idx].time : g_top[r.idx].time; }
static bool refJudged(Ref r) { return r.nest ? g_nest[r.idx].judged : g_top[r.idx].judged; }

// StartTimeOrderedHitPolicy.enumerateHitObjectsUpTo + hitObjectCanBlockFutureHits.
// Calls visit(ref) for every yielded object that can block (circles and heads), in order.
// Returns the last such object seen (the policy's blockingObject), via `last`.
static bool blockingRefs(double target, Ref* last, bool* hasLast, Ref* all, int* count, int cap) {
    *hasLast = false;
    int c = 0;
    for (int i = 0; i < g_top.n; i++) {
        const Obj& o = g_top[i];
        if (o.time >= target) break;
        if (o.kind == K_CIRCLE) {
            Ref r = {false, i};
            *last = r;
            *hasLast = true;
            if (c < cap) all[c] = r;
            c++;
        }
        for (int k = 0; k < o.nestCount; k++) {
            int ni = o.nestBegin + k;
            const Nest& n = g_nest[ni];
            if (n.time >= target) break;
            if (n.kind == N_HEAD) {
                Ref r = {true, ni};
                *last = r;
                *hasLast = true;
                if (c < cap) all[c] = r;
                c++;
            }
        }
    }
    *count = c;
    return true;
}

static const int MAX_BLOCKERS = 4096;
static Ref g_blockBuf[MAX_BLOCKERS];

// StartTimeOrderedHitPolicy.HandleHit: a judged circle/head forcibly misses every earlier
// unjudged circle/head.
static void handleHitAfter(double target);

// StartTimeOrderedHitPolicy.CheckHittable for a circle/head starting at `start`.
static bool checkHittable(double start, double time, int res) {
    Ref last;
    bool hasLast;
    int cnt;
    blockingRefs(start, &last, &hasLast, g_blockBuf, &cnt, MAX_BLOCKERS);
    if (hasLast) {
        if (!refJudged(last) && time < refTime(last)) return false;  // Shake
    }
    if (res == RES_NONE) return false;
    return true;
}

// ----------------------------------------------------- applying results ----
void judgeApplyTop(int ti, int type) {
    Obj& o = g_top[ti];
    if (o.judged) return;
    o.judged = true;
    o.res = type;
    o.judgedAt = g_now;
    int role = topRole(o);
    applyCore(role, o.newCombo, o.lastInCombo, type, o.end);
    if (o.kind == K_CIRCLE) handleHitAfter(o.time);
}

void judgeApplyNest(int ni, int type) {
    Nest& n = g_nest[ni];
    if (n.judged) return;
    n.judged = true;
    n.res = type;
    n.judgedAt = g_now;
    int role = roleOfNest(n.kind);
    applyCore(role, false, false, type, n.time);
    if (n.kind == N_HEAD) handleHitAfter(n.time);
}

static void handleHitAfter(double target) {
    for (int i = 0; i < g_top.n; i++) {
        if (g_top[i].time >= target) break;
        if (g_top[i].kind == K_CIRCLE && !g_top[i].judged) judgeApplyTop(i, RES_MISS);
        Obj& o = g_top[i];
        for (int k = 0; k < o.nestCount; k++) {
            int ni = o.nestBegin + k;
            if (g_nest[ni].time >= target) break;
            if (g_nest[ni].kind == N_HEAD && !g_nest[ni].judged) judgeApplyNest(ni, RES_MISS);
        }
    }
}

bool sliderAllJudged(int ti) {
    const Obj& o = g_top[ti];
    if (!o.judged) return false;
    for (int k = 0; k < o.nestCount; k++)
        if (!g_nest[o.nestBegin + k].judged) return false;
    return true;
}

// ------------------------------------------------------- slider geometry ----
static double sliderProgressAt(const Obj& o, double t) {
    double dur = o.end - o.time;
    if (dur <= 0) return 0;
    return clampd((t - o.time) / dur, 0, 1);
}

static Vec2 relMouse(const Obj& o) { return V(g_mx - o.stackedPos.x, g_my - o.stackedPos.y); }

// SliderInputManager.IsMouseInFollowArea
static bool inFollowArea(const Obj& o, double t, bool expanded) {
    double r = o.radius * (expanded ? FOLLOW_AREA : 1.0);
    Vec2 follow = curvePosition(o, sliderProgressAt(o, t));
    Vec2 d = relMouse(o) - follow;
    return len2(d) <= r * r;
}

// SliderInputManager.isValidTrackingAction (action bits are ACT_LEFT / ACT_RIGHT).
static bool isValidTrackingAction(const Obj& o, int act, double t) {
    int hit = o.headAction;
    if (hit != 0 && (!o.hasAcceptAfter || t <= o.acceptAnyAfter)) return act == hit;
    return act == ACT_LEFT || act == ACT_RIGHT;
}

// SliderInputManager.updateTracking
static void updateTracking(int ti, double t, bool validPos) {
    Obj& o = g_top[ti];
    if (o.headAction == 0) o.hasAcceptAfter = false;
    if (o.headAction != 0 && !o.hasAcceptAfter) {
        int other = o.headAction == ACT_RIGHT ? ACT_LEFT : ACT_RIGHT;
        if (!(o.prevHeld & other)) {
            o.acceptAnyAfter = t;
            o.hasAcceptAfter = true;
        }
    }
    int heldActs = g_held & (ACT_LEFT | ACT_RIGHT);
    bool validAction = false;
    if (heldActs & ACT_LEFT)
        if (isValidTrackingAction(o, ACT_LEFT, t)) validAction = true;
    if (heldActs & ACT_RIGHT)
        if (isValidTrackingAction(o, ACT_RIGHT, t)) validAction = true;
    o.prevHeld = heldActs;
    o.tracking = (!sliderAllJudged(ti) || t <= o.end) && validPos && validAction;
}

// SliderInputManager.PostProcessHeadJudgement (called after a hit head).
static void postProcessHead(int ti, double t) {
    Obj& o = g_top[ti];
    if (!inFollowArea(o, t, true)) return;
    Vec2 mrel = relMouse(o);
    bool allInRange = true;
    double r = o.radius * FOLLOW_AREA;
    for (int k = 0; k < o.nestCount; k++) {
        const Nest& n = g_nest[o.nestBegin + k];
        if (n.judged) continue;
        if (n.time > t) break;
        double dur = o.end - o.time;
        double prog = dur > 0 ? clampd((n.time - o.time) / dur, 0, 1) : 0;
        Vec2 p = curvePosition(o, prog);
        if (len2(p - mrel) > r * r) {
            allInRange = false;
            break;
        }
    }
    for (int k = 0; k < o.nestCount; k++) {
        int ni = o.nestBegin + k;
        const Nest& n = g_nest[ni];
        if (n.judged) continue;
        if (n.time > t) break;
        int role = roleOfNest(n.kind);
        int maxRes = roleMax(role);
        judgeApplyNest(ni, allInRange ? maxRes : roleMin(role, maxRes));
    }
    updateTracking(ti, t, allInRange || inFollowArea(o, t, false));
}

// ------------------------------------------------------------ spinner ----
static float spinTotalRotation(const Obj& o) {
    return 360.0f * (float)o.spinDirs.n + o.histMax;
}

// SpinnerSpinHistory.ReportDelta
static void spinReportDelta(Obj& o, double t, float delta) {
    if (delta == 0) return;
    o.histAccum += delta;
    if (t >= o.histLastReport) {
        float cur = o.histAccum - o.histAtLast;
        o.histMax = (cur < 0 ? -cur : cur) > o.histMax ? (cur < 0 ? -cur : cur) : o.histMax;
        while (o.histMax >= 360) {
            float c2 = o.histAccum - o.histAtLast;
            int dir = c2 > 0 ? 1 : (c2 < 0 ? -1 : 0);
            o.spinTimes.push(t);
            o.spinDirs.push(dir);
            o.histAtLast += (float)dir * 360.0f;
            float c3 = o.histAccum - o.histAtLast;
            o.histMax = c3 < 0 ? -c3 : c3;
        }
    } else {
        while (o.spinTimes.n > 0 && o.spinTimes[o.spinTimes.n - 1] > t) {
            int dir = o.spinDirs[o.spinDirs.n - 1];
            o.spinTimes.removeLast();
            o.spinDirs.removeLast();
            o.histAtLast -= (float)dir * 360.0f;
        }
        float c = o.histAccum - o.histAtLast;
        o.histMax = c < 0 ? -c : c;
    }
    o.histLastReport = t;
}

// DrawableSpinner.updateBonusScore: each full revolution triggers the next spin tick.
static void spinUpdateBonus(int ti) {
    Obj& o = g_top[ti];
    if (o.nestCount == 0) return;
    int spins = (int)(spinTotalRotation(o) / 360.0f);
    if (spins < o.completedFullSpins) {
        o.completedFullSpins = spins;
        return;
    }
    while (o.completedFullSpins != spins) {
        int pick = -1;
        for (int k = 0; k < o.nestCount; k++) {
            if (!g_nest[o.nestBegin + k].judged) {
                pick = o.nestBegin + k;
                break;
            }
        }
        if (pick >= 0) {
            int role = roleOfNest(g_nest[pick].kind);
            judgeApplyNest(pick, roleMax(role));
        }
        o.completedFullSpins++;
    }
}

static float spinProgress(const Obj& o) {
    if (o.spinsRequired == 0) return 1;
    float p = spinTotalRotation(o) / 360.0f / (float)o.spinsRequired;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
}

// SpinnerRotationTracker.Update + AddRotation, then DrawableSpinner.updateBonusScore.
static void spinnerFrame(int ti, double t) {
    Obj& o = g_top[ti];
    bool spinnable = o.time <= t && o.end > t;
    bool tracking = spinnable && !o.judged && (g_held & (ACT_LEFT | ACT_RIGHT)) != 0;
    o.tracking = tracking;

    float dx = (float)(g_mx - PLAYFIELD_CX);
    float dy = (float)(g_my - PLAYFIELD_CY);
    float rad = (float)__builtin_atan2((double)dx, (double)dy);
    float thisAngle = -(rad * 57.29578f);
    if (o.hasLastAngle) {
        float delta = thisAngle - o.spinLastAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        if (tracking && spinnable) spinReportDelta(o, t, delta);
    }
    o.spinLastAngle = thisAngle;
    o.hasLastAngle = true;

    spinUpdateBonus(ti);
}

// DrawableSpinner.CheckForResult (non-user path): at the end, untriggered ticks miss and
// the spinner is judged by its progress.
static void spinnerResult(int ti, double t) {
    Obj& o = g_top[ti];
    if (o.judged || t < o.end) return;
    for (int k = 0; k < o.nestCount; k++) {
        int ni = o.nestBegin + k;
        if (!g_nest[ni].judged) {
            int role = roleOfNest(g_nest[ni].kind);
            judgeApplyNest(ni, roleMin(role, roleMax(role)));
        }
    }
    float p = spinProgress(o);
    int res;
    if (p >= 1) res = RES_GREAT;
    else if (p > 0.9f) res = RES_OK;
    else if (p > 0.75f) res = RES_MEH;
    else res = RES_MISS;
    judgeApplyTop(ti, res);
}

// ----------------------------------------------------------- frame ----
void judgeFrame(double t) {
    g_now = t;

    // 1. slider tracking (SliderInputManager.Update)
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time - g_preempt > t) break;
        if (o.kind != K_SLIDER) continue;
        if (sliderAllJudged(i) && t > o.end) continue;
        updateTracking(i, t, inFollowArea(o, t, o.tracking));
    }

    // 2. spinner rotation (SpinnerRotationTracker + DrawableSpinner.Update)
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time - g_preempt > t) break;
        if (o.kind == K_SPINNER) spinnerFrame(i, t);
    }

    // 3. circle and head timeouts (DrawableHitCircle.CheckForResult, userTriggered = false)
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time - g_preempt > t) break;
        if (o.kind == K_CIRCLE) {
            if (!o.judged && !canBeHit(t - o.time)) judgeApplyTop(i, RES_MISS);
        } else if (o.kind == K_SLIDER) {
            for (int k = 0; k < o.nestCount; k++) {
                int ni = o.nestBegin + k;
                Nest& n = g_nest[ni];
                if (n.kind != N_HEAD || n.judged) continue;
                if (!canBeHit(t - n.time)) judgeApplyNest(ni, RES_MISS);
            }
        }
    }

    // 4. nested slider judgements (SliderInputManager.TryJudgeNestedObject)
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time - g_preempt > t) break;
        if (o.kind != K_SLIDER) continue;
        bool headJudged = o.nestCount > 0 && g_nest[o.nestBegin].judged;
        // last tick or repeat, for the tail's wait condition
        int lastTickIdx = -1;
        for (int k = o.nestCount - 1; k >= 0; k--) {
            int kind = g_nest[o.nestBegin + k].kind;
            if (kind == N_TICK || kind == N_REPEAT) {
                lastTickIdx = o.nestBegin + k;
                break;
            }
        }
        for (int k = 0; k < o.nestCount; k++) {
            int ni = o.nestBegin + k;
            Nest& n = g_nest[ni];
            if (n.judged || n.kind == N_HEAD) continue;
            double dt = t - n.time;
            int role = roleOfNest(n.kind);
            int maxRes = roleMax(role);
            if (n.kind == N_TICK || n.kind == N_REPEAT) {
                if (dt < 0) continue;
                if (!headJudged) continue;
                if (o.tracking) judgeApplyNest(ni, maxRes);
                else judgeApplyNest(ni, roleMin(role, maxRes));  // dt >= 0 here
            } else if (n.kind == N_TAIL) {
                if (dt < -36) continue;  // TAIL_LENIENCY
                if (lastTickIdx >= 0 && !g_nest[lastTickIdx].judged) continue;
                if (!headJudged) continue;
                if (o.tracking) judgeApplyNest(ni, maxRes);
                else if (dt >= 0) judgeApplyNest(ni, roleMin(role, maxRes));
            }
        }
    }

    // 5. slider parent result after the tail (DrawableSlider.CheckForResult, non-classic)
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time - g_preempt > t) break;
        if (o.kind != K_SLIDER || o.judged) continue;
        if (o.nestCount == 0) continue;
        const Nest& tail = g_nest[o.nestBegin + o.nestCount - 1];
        if (!tail.judged || t < o.end) continue;
        bool anyHit = false;
        for (int k = 0; k < o.nestCount; k++)
            if (g_nest[o.nestBegin + k].judged && resIsHit(g_nest[o.nestBegin + k].res)) anyHit = true;
        judgeApplyTop(i, anyHit ? RES_IGNORE_HIT : RES_IGNORE_MISS);
    }

    // 6. spinner end (DrawableSpinner.CheckForResult)
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time - g_preempt > t) break;
        if (o.kind == K_SPINNER) spinnerResult(i, t);
    }
}

// -------------------------------------------------------- press ----
// DrawableHitCircle.HitReceptor.OnPressed + CheckForResult(userTriggered = true).
// Returns true when the receptor consumes the press (it is unjudged and hovered).
static bool pressReceptor(bool nest, int idx, int act, double t) {
    double sx, sy, r, start;
    int parent = -1;
    if (nest) {
        const Nest& n = g_nest[idx];
        parent = n.parent;
        sx = g_top[parent].stackedPos.x;
        sy = g_top[parent].stackedPos.y;
        r = g_top[parent].radius;
        start = n.time;
    } else {
        const Obj& o = g_top[idx];
        sx = o.stackedPos.x;
        sy = o.stackedPos.y;
        r = o.radius;
        start = o.time;
    }
    double dx = g_mx - sx, dy = g_my - sy;
    if (dx * dx + dy * dy > r * r) return false;  // not hovered

    // HitAction is set on the first hovered press, even if no judgement follows.
    if (nest && g_top[parent].headAction == 0) g_top[parent].headAction = act;

    double dt = t - start;
    int res = resultFor(dt);
    if (res == RES_NONE || !checkHittable(start, t, res)) return true;  // consumed, nothing applied

    if (nest) {
        judgeApplyNest(idx, res);
        if (resIsHit(res)) postProcessHead(parent, t);
    } else {
        judgeApplyTop(idx, res);
    }
    return true;
}

void judgePress(double t, int act) {
    g_held |= act;
    judgeFrame(t);
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        if (o.time - g_preempt > t) break;
        if (o.kind == K_CIRCLE) {
            if (o.judged) continue;
            if (pressReceptor(false, i, act, t)) return;
        } else if (o.kind == K_SLIDER && o.nestCount > 0) {
            int head = o.nestBegin;
            if (g_nest[head].judged) continue;
            if (g_nest[head].time - g_preempt > t) continue;
            if (pressReceptor(true, head, act, t)) return;
        }
    }
}

// -------------------------------------------------------- reset ----
void judgeReset() {
    g_now = 0;
    g_held = 0;
    g_started = false;
    for (int i = 0; i < g_top.n; i++) {
        Obj& o = g_top[i];
        o.judged = false;
        o.res = RES_NONE;
        o.judgedAt = -1;
        o.tracking = false;
        o.headAction = 0;
        o.acceptAnyAfter = 0;
        o.hasAcceptAfter = false;
        o.prevHeld = 0;
        o.histAccum = 0;
        o.histAtLast = 0;
        o.histMax = 0;
        o.histLastReport = -1e300;
        o.spinTimes.clear();
        o.spinDirs.clear();
        o.completedFullSpins = 0;
        o.hasLastAngle = false;
        o.spinLastAngle = 0;
    }
    for (int i = 0; i < g_nest.n; i++) {
        g_nest[i].judged = false;
        g_nest[i].res = RES_NONE;
        g_nest[i].judgedAt = -1;
    }
}

}  // namespace oc
