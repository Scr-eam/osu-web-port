// Internal gameplay state shared by score.cpp (ScoreProcessor / OsuHealthProcessor /
// DrainingHealthProcessor) and judge.cpp (DrawableHitCircle, DrawableSlider,
// SliderInputManager, DrawableSpinner, StartTimeOrderedHitPolicy).
#ifndef OSU_CORE_GAME_H
#define OSU_CORE_GAME_H

#include "core.h"

namespace oc {

// Action bits. The JS mask is converted to these in api.cpp:
//   key 1 (mask 1) -> LEFT, key 2 (mask 2) -> RIGHT, left mouse (mask 4) -> LEFT, right mouse (mask 8) -> RIGHT.
enum { ACT_LEFT = 1, ACT_RIGHT = 2 };

// Playfield centre (spinner centre) and the follow-area multiplier
// (DrawableSliderBall.FOLLOW_AREA).
const double PLAYFIELD_CX = 256;
const double PLAYFIELD_CY = 192;
const double FOLLOW_AREA = 2.4;

// ---- input / clock state (judge.cpp) ----
extern double g_now;      // time of the last processed event (ms)
extern double g_mx, g_my; // cursor position (playfield px)
extern int g_held;        // currently held action bits (ACT_*)
extern bool g_started;    // at least one frame or press processed

// ---- score / health state (score.cpp) ----
extern int g_resCount[32];        // statistics per HitResult (live, non-simulated)
extern int g_maxResCount[32];     // maximum statistics (from simulation)
extern int g_combo;
extern int g_highestCombo;
extern int g_maxCombo;
extern double g_curBase;          // ScoreProcessor.currentBaseScore
extern double g_curMaxBase;       // currentMaximumBaseScore
extern double g_curComboPortion;
extern double g_curBonus;
extern int g_curAccCount;
extern double g_maxBase;          // maximumBaseScore (from simulation)
extern double g_maxComboPortion;
extern int g_maxAccCount;
extern double g_totalScore;       // TotalScoreWithoutMods (scoreMultiplier 1)
extern double g_maxTotalScore;
extern double g_health;           // 0..1
extern bool g_failed;
// Mods that change failure (MOD_* bits, set by osu_set_mods). NoFail never fails; SuddenDeath fails on
// a miss; Perfect fails on any result below the top one. Health can still fail the play with SD or PF.
enum { MOD_NF = 1, MOD_SD = 2, MOD_PF = 4 };
extern int g_mods;
extern int g_judgedCount;
extern int g_maxJudgedCount;
extern int g_comboResult;         // OsuHealthProcessor.currentComboResult: 0 none, 1 good, 2 perfect
extern bool g_simulating;

// ---- result model helpers (score.cpp) ----
bool resIsHit(int r);
bool resAffectsCombo(int r);
bool resIsBonus(int r);
bool resIsScorable(int r);
bool resAffectsAccuracy(int r);
int resBaseScore(int r);

// Applies one judgement's effect on score and health (ScoreProcessor.ApplyResult
// + OsuHealthProcessor.GetHealthIncreaseFor). `role` picks the max/min results and
// the health table. `newCombo` / `lastInCombo` come from the result's HitObject.
void applyCore(int role, bool newCombo, bool lastInCombo, int type, double endTime);

// DifficultyRange from beatmap.cpp.
double diffRange(double v, double mn, double mid, double mx);

// Simulation pass (JudgementProcessor.ApplyBeatmap): max results for every object,
// then stores maxima and the drain rate.
void simulateBeatmap();
// Resets live score/health state; keeps the stored maxima. (ScoreProcessor.Reset(false))
void scoreResetLive();
// Refreshes accuracy / total score from the counters (ScoreProcessor.updateScore).
void scoreUpdate();
// Drain between prevT and t (DrainingHealthProcessor.Update). Applies to health only.
void healthDrain(double prevT, double t);
bool inNoDrain(double t);
double accuracyValue();
int rankValue();     // 0 D .. 5 X

// ---- judgement (judge.cpp) ----
void judgeReset();                 // clears per-object state (keeps geometry)
void judgeFrame(double t);         // time-based checks at time t (current mouse/held state)
void judgePress(double t, int pressedBits);  // press at t with the cursor at (g_mx, g_my)
void judgeApplyTop(int ti, int type);   // ApplyResult on a top-level object
void judgeApplyNest(int ni, int type);  // ApplyResult on a nested object
int roleOfNest(int kind);
bool sliderAllJudged(int ti);

}  // namespace oc

#endif  // OSU_CORE_GAME_H
