// Scoring and health: port of osu.Game/Rulesets/Scoring/ScoreProcessor.cs (ScoreV2),
// osu.Game.Rulesets.Osu/Scoring/OsuHealthProcessor.cs, DrainingHealthProcessor.cs,
// HitResult.cs helpers, and Judgement.cs MinResult / roles (lazer 2026.1005.0).
#include "game.h"

namespace oc {

// ------------------------------------------------------------ state ----
int g_resCount[32];
int g_maxResCount[32];
int g_combo;
int g_highestCombo;
int g_maxCombo;
double g_curBase;
double g_curMaxBase;
double g_curComboPortion;
double g_curBonus;
int g_curAccCount;
double g_maxBase;
double g_maxComboPortion;
int g_maxAccCount;
double g_totalScore;
double g_maxTotalScore;
double g_health = 1;
bool g_failed;
int g_mods;
int g_judgedCount;
int g_maxJudgedCount;
int g_comboResult = 2;   // Perfect
bool g_simulating;

static double g_targetMinHealth;
static double g_lastDrainT = 0;

struct HealthInc {
    double time;
    double amount;
};
struct Period {
    double s, e;
};
static Buf<HealthInc> g_healthIncs;   // simulated health increases, in simulation order
static Buf<Period> g_noDrain;

// ----------------------------------------------------- HitResult helpers ----
bool resIsHit(int r) {
    switch (r) {
        case RES_NONE:
        case RES_IGNORE_MISS:
        case RES_MISS:
        case RES_SMALL_TICK_MISS:
        case RES_LARGE_TICK_MISS:
        case RES_COMBO_BREAK:
            return false;
        default:
            return true;
    }
}

static bool affectsCombo(int r) {
    switch (r) {
        case RES_MISS:
        case RES_MEH:
        case RES_OK:
        case RES_GOOD:
        case RES_GREAT:
        case RES_PERFECT:
        case RES_LARGE_TICK_HIT:
        case RES_LARGE_TICK_MISS:
        case RES_COMBO_BREAK:
        case RES_SLIDER_TAIL_HIT:
            return true;
        default:
            return false;
    }
}

bool resAffectsCombo(int r) { return affectsCombo(r); }
bool resIncreasesCombo(int r) { return affectsCombo(r) && resIsHit(r); }
bool resBreaksCombo(int r) { return affectsCombo(r) && !resIsHit(r); }

bool resIsBonus(int r) { return r == RES_SMALL_BONUS || r == RES_LARGE_BONUS; }

bool resIsScorable(int r) {
    if (r == RES_COMBO_BREAK || r == RES_SLIDER_TAIL_HIT) return true;
    return r >= RES_MISS && r < RES_IGNORE_MISS;
}

bool resAffectsAccuracy(int r) {
    if (r == RES_COMBO_BREAK) return false;
    return resIsScorable(r) && !resIsBonus(r);
}

int resBaseScore(int r) {
    switch (r) {
        case RES_SMALL_TICK_HIT: return 10;
        case RES_LARGE_TICK_HIT: return 30;
        case RES_SLIDER_TAIL_HIT: return 150;
        case RES_MEH: return 50;
        case RES_OK: return 100;
        case RES_GOOD: return 200;
        case RES_GREAT:
        case RES_PERFECT: return 300;
        case RES_SMALL_BONUS: return 10;
        case RES_LARGE_BONUS: return 50;
        default: return 0;
    }
}

// Judgement roles -> MaxResult (Judgement.MaxResult of each class).
int roleMax(int role) {
    switch (role) {
        case ROLE_CIRCLE:
        case ROLE_HEAD:
        case ROLE_SPINNER: return RES_GREAT;
        case ROLE_SPIN_TICK: return RES_SMALL_BONUS;
        case ROLE_SPIN_BONUS: return RES_LARGE_BONUS;
        case ROLE_SLIDER_TICK:
        case ROLE_REPEAT: return RES_LARGE_TICK_HIT;
        case ROLE_TAIL: return RES_SLIDER_TAIL_HIT;
        case ROLE_SLIDER_IGNORE: return RES_IGNORE_HIT;
        default: return RES_GREAT;
    }
}

// Judgement.MinResult for a given MaxResult (Judgement.cs switch).
int roleMin(int role, int maxRes) {
    (void)role;
    switch (maxRes) {
        case RES_SMALL_BONUS:
        case RES_LARGE_BONUS:
        case RES_IGNORE_HIT:
        case RES_SLIDER_TAIL_HIT: return RES_IGNORE_MISS;
        case RES_SMALL_TICK_HIT: return RES_SMALL_TICK_MISS;
        case RES_LARGE_TICK_HIT: return RES_LARGE_TICK_MISS;
        default: return RES_MISS;
    }
}

// ------------------------------------------------------------ health ----
static double hpRange(double mn, double mid, double mx) { return diffRange(g_map.hp, mn, mid, mx); }

// OsuHealthProcessor.getHealthIncreaseFor without the combo bonus. This is the
// value used while simulating (IsSimulating path).
static double baseHealthIncrease(int role, int type) {
    switch (type) {
        case RES_LARGE_TICK_MISS: return hpRange(-0.02, -0.075, -0.14);
        case RES_MISS: return hpRange(-0.03, -0.125, -0.2);
        case RES_LARGE_TICK_HIT:
        case RES_SLIDER_TAIL_HIT:
            if (role == ROLE_SLIDER_TICK) return 0.015;
            if (role == ROLE_HEAD || role == ROLE_REPEAT || role == ROLE_TAIL) return 0.02;
            return 0;
        case RES_MEH: return 0.002;
        case RES_OK: return 0.011;
        case RES_GREAT: return 0.03;
        case RES_SMALL_BONUS: return 0.0085;
        case RES_LARGE_BONUS: return 0.01;
        default: return 0;
    }
}

static void setComboResult(int cr) {
    if (cr < g_comboResult) g_comboResult = cr;
}

// Live (non-simulated) OsuHealthProcessor.GetHealthIncreaseFor, including the
// combo-end bonus driven by currentComboResult.
static double liveHealthIncrease(int role, bool newCombo, bool lastInCombo, int type) {
    if (newCombo) g_comboResult = 2;
    switch (type) {
        case RES_LARGE_TICK_MISS:
        case RES_OK:
            setComboResult(1);
            break;
        case RES_MEH:
        case RES_MISS:
            setComboResult(0);
            break;
        default:
            break;
    }
    if (role == ROLE_TAIL && !resIsHit(type)) setComboResult(1);
    double inc = baseHealthIncrease(role, type);
    if (lastInCombo && resIsHit(type)) {
        if (g_comboResult == 2) inc += 0.07;
        else if (g_comboResult == 1) inc += 0.05;
        else inc += 0.03;
    }
    return inc;
}

// ------------------------------------------------------------- score ----
static double comboPowHalf(int combo) { return __builtin_sqrt((double)combo); }

void scoreUpdate() {
    double acc = accuracyValue();
    double comboProgress = g_maxComboPortion > 0 ? g_curComboPortion / g_maxComboPortion : 1;
    double accProgress = g_maxAccCount > 0 ? (double)g_curAccCount / (double)g_maxAccCount : 1;
    double a5 = acc * acc * acc * acc * acc;
    double total = 500000.0 * acc * comboProgress + 500000.0 * a5 * accProgress + g_curBonus;
    // Math.Round in C# is round-half-to-even; rint in the default rounding mode matches.
    g_totalScore = __builtin_rint(total);
}

double accuracyValue() {
    double v = g_curMaxBase > 0 ? g_curBase / g_curMaxBase : 1;
    return clampd(v, 0, 1);
}

int rankValue() {
    double acc = accuracyValue();
    int rank;  // 0 D .. 5 X
    if (acc == 1) rank = 5;
    else if (acc >= 0.95) rank = 4;
    else if (acc >= 0.9) rank = 3;
    else if (acc >= 0.8) rank = 2;
    else if (acc >= 0.7) rank = 1;
    else rank = 0;
    // OsuScoreProcessor.RankFromScore: S / X with any miss becomes A.
    if ((rank == 4 || rank == 5) && g_resCount[RES_MISS] > 0) rank = 3;
    return rank;
}

// ScoreProcessor.ApplyResultInternal + DrainingHealthProcessor/HealthProcessor.
void applyCore(int role, bool newCombo, bool lastInCombo, int type, double endTime) {
    int maxType = roleMax(role);
    // FailedAtJudgement: once failed, later results are not applied.
    if (!g_simulating && g_failed) return;

    g_resCount[type]++;
    g_judgedCount++;
    if (resIncreasesCombo(type)) g_combo++;
    else if (resBreaksCombo(type)) g_combo = 0;
    if (g_combo > g_highestCombo) g_highestCombo = g_combo;

    if (resAffectsAccuracy(maxType)) {
        g_curMaxBase += resBaseScore(maxType);
        g_curAccCount++;
    }
    if (resAffectsAccuracy(type)) g_curBase += resBaseScore(type);

    if (resIsBonus(type)) {
        g_curBonus += resBaseScore(type);
    } else if (resIsScorable(type)) {
        g_curComboPortion += resBaseScore(maxType) * comboPowHalf(g_combo);
    }
    scoreUpdate();

    if (g_simulating) {
        // DrainingHealthProcessor records non-bonus simulated increases in order.
        if (!resIsBonus(type)) {
            HealthInc h;
            h.time = endTime;
            h.amount = baseHealthIncrease(role, type);
            g_healthIncs.push(h);
        }
        return;
    }

    double inc = liveHealthIncrease(role, newCombo, lastInCombo, type);
    g_health = clampd(g_health + inc, 0, 1);
    // DrainingHealthProcessor.CheckDefaultFailCondition: bonus max results and
    // IgnoreHit never fail; otherwise health at (or below) zero fails.
    // NoFail (IApplicableFailOverride.PerformFail = false): the health bar still moves, nothing fails.
    if (g_mods & MOD_NF) return;
    bool canFail = !resIsBonus(maxType) && type != RES_IGNORE_HIT;
    if (canFail && g_health <= 1e-7) g_failed = true;
    // ModSuddenDeath.FailCondition: any result that breaks combo, i.e. a miss.
    if ((g_mods & MOD_SD) && resBreaksCombo(type)) g_failed = true;
    // ModPerfect.FailCondition: any result below the top one that affects accuracy or combo.
    if ((g_mods & MOD_PF) && type != maxType && type != RES_IGNORE_HIT &&
        (resAffectsAccuracy(type) || resAffectsCombo(type) || resAffectsAccuracy(maxType) || resAffectsCombo(maxType)))
        g_failed = true;
}

// ------------------------------------------------------- drain rate ----
static double computeDrainRate() {
    if (g_healthIncs.n <= 1) return 0;
    int adjustment = 1;
    double result = 1;
    for (int guard = 0; adjustment > 0 && guard < 40; guard++) {
        double currentHealth = 1;
        double lowestHealth = 1;
        int currentBreak = 0;
        for (int i = 0; i < g_healthIncs.n; i++) {
            double currentTime = g_healthIncs[i].time;
            double lastTime = i > 0 ? g_healthIncs[i - 1].time : g_drainStart;
            while (currentBreak < g_map.breaks.n && g_map.breaks[currentBreak].end <= currentTime) {
                lastTime = currentTime;
                currentBreak++;
            }
            currentHealth -= (currentTime - lastTime) * result;
            lowestHealth = lowestHealth < currentHealth ? lowestHealth : currentHealth;
            currentHealth = currentHealth + g_healthIncs[i].amount;
            if (currentHealth > 1) currentHealth = 1;
            if (lowestHealth < 0) break;
        }
        if (absd(lowestHealth - g_targetMinHealth) <= 0.01) break;
        adjustment *= 2;
        result += (1.0 / adjustment) * signd(lowestHealth - g_targetMinHealth);
    }
    return result;
}

// DrainingHealthProcessor.ApplyBeatmap: break periods between the surrounding objects.
static void buildNoDrainPeriods() {
    g_noDrain.clear();
    for (int b = 0; b < g_map.breaks.n; b++) {
        const BreakPeriod& br = g_map.breaks[b];
        // .Last() / .First() over the top-level objects in list order.
        double s = -1e300;
        for (int i = 0; i < g_top.n; i++)
            if (g_top[i].end <= br.start) s = g_top[i].end;
        double e = 1e300;
        for (int i = 0; i < g_top.n; i++)
            if (g_top[i].time >= br.end) {
                e = g_top[i].time;
                break;
            }
        Period p;
        p.s = s;
        p.e = e;
        g_noDrain.push(p);
    }
}

bool inNoDrain(double t) {
    for (int i = 0; i < g_noDrain.n; i++)
        if (g_noDrain[i].s <= t && t <= g_noDrain[i].e) return true;
    return false;
}

// DrainingHealthProcessor.Update: health drains between the previous and current frame.
void healthDrain(double prevT, double t) {
    if (g_failed) return;
    if (inNoDrain(t)) return;
    double lo = g_drainStart;
    double hi = g_gameplayEnd;
    double last = clampd(prevT, lo, hi);
    double cur = clampd(t, lo, hi);
    g_health = clampd(g_health - g_drainRate * (cur - last), 0, 1);
    if (g_health <= 1e-7 && !(g_mods & MOD_NF)) g_failed = true;
}

// -------------------------------------------------- reset / simulation ----
void scoreResetLive() {
    for (int i = 0; i < 32; i++) g_resCount[i] = 0;
    g_combo = 0;
    g_highestCombo = 0;
    g_curBase = 0;
    g_curMaxBase = 0;
    g_curComboPortion = 0;
    g_curBonus = 0;
    g_curAccCount = 0;
    g_totalScore = 0;
    g_health = 1;
    g_failed = false;
    g_judgedCount = 0;
    g_comboResult = 2;
    g_lastDrainT = g_drainStart;
    scoreUpdate();
}

// JudgementProcessor.ApplyBeatmap: Reset(false), SimulateAutoplay, Reset(true).
void simulateBeatmap() {
    g_targetMinHealth = clampd(diffRange(g_map.hp, 0.99, 0.9, 0.4), 0, 1);
    g_healthIncs.init();  // storage is in the arena, which was reset by the load
    g_noDrain.init();
    buildNoDrainPeriods();

    scoreResetLive();
    g_simulating = true;
    // enumerateRecursively: nested objects first (in order), then the object itself.
    for (int i = 0; i < g_top.n; i++) {
        const Obj& o = g_top[i];
        for (int k = 0; k < o.nestCount; k++) {
            const Nest& n = g_nest[o.nestBegin + k];
            int role = roleOfNest(n.kind);
            applyCore(role, false, false, roleMax(role), n.time);
        }
        int topRole = o.kind == K_CIRCLE ? ROLE_CIRCLE : (o.kind == K_SLIDER ? ROLE_SLIDER_IGNORE : ROLE_SPINNER);
        applyCore(topRole, o.newCombo, o.lastInCombo, roleMax(topRole), o.end);
    }
    g_simulating = false;

    // Reset(storeResults: true)
    g_maxBase = g_curBase;
    g_maxComboPortion = g_curComboPortion;
    g_maxAccCount = g_curAccCount;
    g_maxCombo = g_highestCombo;
    g_maxTotalScore = g_totalScore;
    g_maxJudgedCount = g_judgedCount;
    for (int i = 0; i < 32; i++) g_maxResCount[i] = g_resCount[i];
    g_drainRate = computeDrainRate();
    g_healthIncs.clear();
    scoreResetLive();
}

}  // namespace oc
