// .osu parsing and beatmap processing (port of lazer's LegacyBeatmapDecoder,
// ConvertHitObjectParser, OsuBeatmapProcessor (combo + stacking), Slider,
// SliderEventGenerator and Spinner setup).
#include "core.h"

namespace oc {

// ------------------------------------------------------------ globals ----
BeatmapData g_map;
Buf<Obj> g_top;
Buf<Nest> g_nest;
Buf<Rgb> g_colours;
double g_preempt = 1200;
double g_fadeIn = 400;
double g_radius = 32;
double g_scale = 0.5;
double g_windowGreat = 0;
double g_windowOk = 0;
double g_windowMeh = 0;
double g_windowMiss = 400;
double g_drainRate = 0;
double g_drainStart = 0;
double g_gameplayEnd = 0;
double g_firstTime = 0;

// ------------------------------------------------------- difficulty ----
// IBeatmapDifficultyInfo.DifficultyRange(difficulty, min, mid, max)
double diffRange(double v, double mn, double mid, double mx) {
    if (v > 5) return mid + (mx - mid) * ((v - 5) / 5);
    if (v < 5) return mid + (mid - mn) * ((v - 5) / 5);
    return mid;
}

// ------------------------------------------------------------ parsing ----
struct Span {
    const char* p;
    int n;
};

static bool isWs(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }

static Span trimSpan(Span s) {
    while (s.n > 0 && isWs(s.p[0])) {
        s.p++;
        s.n--;
    }
    while (s.n > 0 && isWs(s.p[s.n - 1])) s.n--;
    return s;
}

static bool spanEq(Span s, const char* lit) {
    int i = 0;
    for (; lit[i]; i++) {
        if (i >= s.n || s.p[i] != lit[i]) return false;
    }
    return i == s.n;
}

static bool spanStarts(Span s, const char* lit) {
    int i = 0;
    for (; lit[i]; i++) {
        if (i >= s.n || s.p[i] != lit[i]) return false;
    }
    return true;
}

// Plain decimal parser (sign, digits, optional fraction). Good to ~1e-15 for the
// magnitudes used in .osu files.
static bool parseNum(Span s, double& out) {
    s = trimSpan(s);
    if (s.n == 0) return false;
    int i = 0;
    bool neg = false;
    if (s.p[0] == '-') {
        neg = true;
        i++;
    } else if (s.p[0] == '+') {
        i++;
    }
    double v = 0;
    bool any = false;
    for (; i < s.n && s.p[i] >= '0' && s.p[i] <= '9'; i++) {
        v = v * 10 + (s.p[i] - '0');
        any = true;
    }
    if (i < s.n && s.p[i] == '.') {
        i++;
        double scale = 0.1;
        for (; i < s.n && s.p[i] >= '0' && s.p[i] <= '9'; i++) {
            v += (s.p[i] - '0') * scale;
            scale *= 0.1;
            any = true;
        }
    }
    if (!any) return false;
    out = neg ? -v : v;
    return true;
}

static double numOr(Span s, double def) {
    double v;
    return parseNum(s, v) ? v : def;
}

static int countOn(Span s, char sep) {
    int count = 1;
    for (int i = 0; i < s.n; i++)
        if (s.p[i] == sep) count++;
    return count;
}

// Splits on a single character. Returns number of parts written (max `cap`).
static int splitOn(Span s, char sep, Span* out, int cap) {
    int count = 0;
    int start = 0;
    for (int i = 0; i <= s.n; i++) {
        if (i == s.n || s.p[i] == sep) {
            if (count < cap) {
                Span part;
                part.p = s.p + start;
                part.n = i - start;
                out[count] = part;
            }
            count++;
            start = i + 1;
        }
    }
    return count;
}

static void copyStr(char* dst, int cap, Span s) {
    s = trimSpan(s);
    int n = s.n < cap - 1 ? s.n : cap - 1;
    for (int i = 0; i < n; i++) dst[i] = s.p[i];
    dst[n] = 0;
}

static bool isLetter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

// ------------------------------------------------------- path parsing ----
static int convertPathTypeLetter(char c) {
    switch (c) {
        case 'L': return PK_LINEAR;
        case 'P': return PK_PERFECT;
        case 'B': return PK_BEZIER;
        case 'C':
        default: return PK_CATMULL;
    }
}

// Port of ConvertHitObjectParser.convertPoints for the legacy (< v128) rules.
// Writes segment control points into `out`.
static void convertPointsLegacy(int type, const Vec2* verts, int n, bool hasEnd, Buf<PathPt>& out) {
    int t = type;
    int endLen = hasEnd ? 1 : 0;
    if (t == PK_PERFECT) {
        if (n + endLen != 3) {
            t = PK_BEZIER;
        } else {
            // colinear check on the first three points
            Vec2 p0 = verts[0], p1 = verts[1];
            Vec2 p2 = n > 2 ? verts[2] : verts[0];
            double cross = (p1.y - p0.y) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.y - p0.y);
            if (absd(cross) < 1e-3) t = PK_LINEAR;
        }
    }

    PathPt* v = (PathPt*)arenaAlloc(sizeof(PathPt) * (unsigned long)(n > 0 ? n : 1));
    for (int i = 0; i < n; i++) {
        v[i].p = verts[i];
        v[i].type = PK_NONE;
    }
    if (n == 0) return;
    v[0].type = t;

    int startIndex = 0;
    int endIndex = 0;
    while (++endIndex < n) {
        if (!veq(v[endIndex].p, v[endIndex - 1].p)) continue;
        // Legacy catmull: adjacent catmull duplicates merge into one segment.
        if (t == PK_CATMULL && endIndex > 1) continue;
        if (endIndex == n - 1) continue;
        v[endIndex - 1].type = t;
        for (int k = startIndex; k < endIndex; k++) out.push(v[k]);
        startIndex = endIndex + 1;
    }
    if (startIndex < endIndex) {
        for (int k = startIndex; k < endIndex && k < n; k++) out.push(v[k]);
    }
}

// Builds the control points for a slider. `head` is the slider start position.
static void buildSliderPath(Span curve, Vec2 head, SliderPath& path, int formatVersion) {
    path.init();
    // Tokens split on '|'.
    int tokCount = countOn(curve, '|');
    Span* toks = (Span*)arenaAlloc(sizeof(Span) * (unsigned long)(tokCount + 1));
    splitOn(curve, '|', toks, tokCount);

    Vec2* pts = (Vec2*)arenaAlloc(sizeof(Vec2) * (unsigned long)(tokCount + 2));
    int ptCount = 0;
    int segType[256];
    int segStart[256];
    int segCount = 0;

    for (int i = 0; i < tokCount; i++) {
        Span tk = trimSpan(toks[i]);
        if (tk.n == 0) continue;
        if (isLetter(tk.p[0])) {
            if (segCount >= 256) break;
            segType[segCount] = convertPathTypeLetter(tk.p[0]);
            segStart[segCount] = ptCount;
            segCount++;
            if (ptCount == 0) pts[ptCount++] = V(0, 0);  // first segment prepends the head
        } else {
            Span parts[2];
            int np = splitOn(tk, ':', parts, 2);
            if (np < 2) continue;
            double x = numOr(parts[0], 0), y = numOr(parts[1], 0);
            if (formatVersion < 128) {
                // old formats truncate coordinates to integers
                x = x < 0 ? -(double)(long long)(-x) : (double)(long long)x;
                y = y < 0 ? -(double)(long long)(-y) : (double)(long long)y;
            }
            pts[ptCount++] = V(x - head.x, y - head.y);
        }
    }

    if (segCount == 0 || ptCount == 0) {
        // Degenerate path: a single point.
        path.cps.push(PathPt{V(0, 0), PK_LINEAR});
        return;
    }

    for (int s = 0; s < segCount; s++) {
        int startIndex = segStart[s];
        int endIndex = s < segCount - 1 ? segStart[s + 1] : ptCount;
        int count = endIndex - startIndex;
        bool hasEnd = s < segCount - 1;
        Buf<PathPt> seg;
        seg.init();
        convertPointsLegacy(segType[s], pts + startIndex, count, hasEnd, seg);
        for (int k = 0; k < seg.n; k++) path.cps.push(seg[k]);
    }
}

// --------------------------------------------------- timing helpers ----
static TimingPoint timingAt(double t) {
    TimingPoint best;
    best.time = 0;
    best.beatLength = 500;
    best.uninherited = true;
    bool found = false;
    for (int i = 0; i < g_map.timing.n; i++) {
        const TimingPoint& tp = g_map.timing[i];
        if (!tp.uninherited) continue;
        if (tp.time <= t || !found) {
            if (!found || tp.time <= t) best = tp;
            found = true;
        }
    }
    return best;
}

// Slider velocity multiplier at time t (DifficultyPointAt().SliderVelocity), clamped to [0.1, 10].
static double sliderVelocityAt(double t) {
    double sv = 1;
    for (int i = 0; i < g_map.timing.n; i++) {
        const TimingPoint& tp = g_map.timing[i];
        if (tp.time > t) break;
        if (tp.uninherited) {
            sv = 1;
        } else {
            double bl = tp.beatLength;
            sv = bl < 0 ? -100.0 / bl : 1;
            sv = clampd(sv, 0.1, 10);
        }
    }
    return sv;
}

// -------------------------------------------------- slider events ----
enum EvType { EV_HEAD = 0, EV_TICK = 1, EV_REPEAT = 2, EV_TAIL = 3 };
struct Ev {
    int type;
    double time;
    int spanIndex;
    double progress;
};

static const double TAIL_LENIENCY = -36;

// Port of SliderEventGenerator.Generate.
static void sliderEvents(double startTime, double spanDuration, double velocity, double tickDistance, double totalDistance, int spanCount, Buf<Ev>& out) {
    const double max_length = 100000;
    double length = totalDistance < max_length ? totalDistance : max_length;
    tickDistance = clampd(tickDistance, 0, length);
    double minDistanceFromEnd = velocity * 10;

    Ev head;
    head.type = EV_HEAD;
    head.time = startTime;
    head.spanIndex = 0;
    head.progress = 0;
    out.push(head);

    for (int span = 0; span < spanCount; span++) {
        double spanStart = startTime + span * spanDuration;
        bool reversed = span % 2 == 1;
        if (tickDistance != 0) {
            // Ticks are generated along the path, mapped to time in span order.
            int first = out.n;
            for (double d = tickDistance; d <= length; d += tickDistance) {
                if (d >= length - minDistanceFromEnd) break;
                double pathProgress = d / length;
                double timeProgress = reversed ? 1 - pathProgress : pathProgress;
                Ev e;
                e.type = EV_TICK;
                e.time = spanStart + timeProgress * spanDuration;
                e.spanIndex = span;
                e.progress = pathProgress;
                out.push(e);
            }
            if (reversed) {
                // reverse the ticks just added
                int last = out.n - 1;
                for (int a = first, b = last; a < b; a++, b--) {
                    Ev tmp = out[a];
                    out.d[a] = out.d[b];
                    out.d[b] = tmp;
                }
            }
        }
        if (span < spanCount - 1) {
            Ev r;
            r.type = EV_REPEAT;
            r.time = spanStart + spanDuration;
            r.spanIndex = span;
            r.progress = (span + 1) % 2;
            out.push(r);
        }
    }

    double totalDuration = spanCount * spanDuration;
    Ev tail;
    tail.type = EV_TAIL;
    tail.time = startTime + totalDuration;
    tail.spanIndex = spanCount - 1;
    tail.progress = spanCount % 2;
    out.push(tail);
    (void)TAIL_LENIENCY;
}

// ------------------------------------------------------- stacking ----
static const double STACK_DISTANCE = 3;

static Vec2 stackEnd(const Obj& o) { return o.pos + endPositionRel(o); }

static bool isSpinner(const Obj& o) { return o.kind == K_SPINNER; }
static bool isSlider(const Obj& o) { return o.kind == K_SLIDER; }
static bool isCircle(const Obj& o) { return o.kind == K_CIRCLE; }

static double stackThreshold(const Obj& o) { return floord(o.preempt) * g_map.stackLeniency; }

static void applyStacking() {
    int n = g_top.n;
    if (n == 0) return;
    for (int i = 0; i < n; i++) g_top[i].stack = 0;
    int startIndex = 0, endIndex = n - 1;

    int extendedEnd = endIndex;
    if (endIndex < n - 1) {
        for (int i = endIndex; i >= startIndex; i--) {
            int stackBase = i;
            for (int k = stackBase + 1; k < n; k++) {
                Obj& sb = g_top[stackBase];
                if (isSpinner(sb)) break;
                Obj& on = g_top[k];
                if (isSpinner(on)) continue;
                double endTime = sb.end;
                double thr = stackThreshold(on);
                if (on.time - endTime > thr) break;
                if (dist(sb.pos, on.pos) < STACK_DISTANCE || (isSlider(sb) && dist(stackEnd(sb), on.pos) < STACK_DISTANCE)) {
                    stackBase = k;
                    on.stack = 0;
                }
            }
            if (stackBase > extendedEnd) {
                extendedEnd = stackBase;
                if (extendedEnd == n - 1) break;
            }
        }
    }

    int extendedStart = startIndex;
    for (int i = extendedEnd; i > startIndex; i--) {
        int k = i;
        Obj* oi = &g_top[i];
        if (oi->stack != 0 || isSpinner(*oi)) continue;
        double thr = stackThreshold(*oi);

        if (isCircle(*oi)) {
            while (--k >= 0) {
                Obj* ok = &g_top[k];
                if (isSpinner(*ok)) continue;
                double endTime = ok->end;
                if ((double)(long long)oi->time - (double)(long long)endTime > thr) break;
                if (k < extendedStart) {
                    ok->stack = 0;
                    extendedStart = k;
                }
                if (isSlider(*ok) && dist(stackEnd(*ok), oi->pos) < STACK_DISTANCE) {
                    int offset = oi->stack - ok->stack + 1;
                    for (int j = k + 1; j <= i; j++) {
                        Obj& oj = g_top[j];
                        if (dist(stackEnd(*ok), oj.pos) < STACK_DISTANCE) oj.stack -= offset;
                    }
                    break;
                }
                if (dist(ok->pos, oi->pos) < STACK_DISTANCE) {
                    ok->stack = oi->stack + 1;
                    oi = ok;
                }
            }
        } else if (isSlider(*oi)) {
            while (--k >= startIndex) {
                Obj* ok = &g_top[k];
                if (isSpinner(*ok)) continue;
                if (oi->time - ok->time > thr) break;
                if (dist(stackEnd(*ok), oi->pos) < STACK_DISTANCE) {
                    ok->stack = oi->stack + 1;
                    oi = ok;
                }
            }
        }
    }
}

// --------------------------------------------------------- loading ----
struct RawHit {
    Span line;
    double time;
};

static bool processHitObjects(RawHit* raws, int rawCount, const char** err) {
    // Stable sort by time (insertion sort, input is nearly sorted).
    for (int i = 1; i < rawCount; i++) {
        RawHit key = raws[i];
        int j = i - 1;
        while (j >= 0 && raws[j].time > key.time) {
            raws[j + 1] = raws[j];
            j--;
        }
        raws[j + 1] = key;
    }

    const double ar = g_map.ar, od = g_map.od, cs = g_map.cs;
    g_preempt = floord(diffRange(ar, 1800, 1200, 450));
    g_fadeIn = 400 * (g_preempt / 450 < 1 ? g_preempt / 450 : 1);
    g_scale = ((1.0 - 0.7 * ((cs - 5) / 5)) / 2) * 1.00041;
    g_radius = 64 * g_scale;
    g_windowGreat = floord(diffRange(od, 80, 50, 20)) - 0.5;
    g_windowOk = floord(diffRange(od, 140, 100, 60)) - 0.5;
    g_windowMeh = floord(diffRange(od, 200, 150, 100)) - 0.5;
    g_windowMiss = 400;

    g_top.clear();
    g_nest.clear();
    g_top.reserve(rawCount);

    for (int r = 0; r < rawCount; r++) {
        Span parts[16];
        int np = splitOn(raws[r].line, ',', parts, 16);
        if (np < 4) continue;
        double x = numOr(parts[0], 0), y = numOr(parts[1], 0);
        double time = numOr(parts[2], 0);
        int type = (int)numOr(parts[3], 1);

        Obj o;
        o.kind = K_CIRCLE;
        o.time = time;
        o.end = time;
        o.pos = V(x, y);
        o.stack = 0;
        o.scale = g_scale;
        o.radius = g_radius;
        o.newCombo = (type & 4) != 0;
        o.comboOffsetSkip = (type >> 4) & 7;
        o.stackedPos = o.pos;
        o.comboIndex = 0;
        o.comboIndexOffsets = 0;
        o.indexInCombo = 0;
        o.colour = 0;
        o.number = 0;
        o.lastInCombo = false;
        o.path = 0;
        o.velocity = 0;
        o.tickDistance = 0;
        o.spanDuration = 0;
        o.spanCount = 1;
        o.pathLen = 0;
        o.poly.init();
        o.preempt = g_preempt;
        o.spinsRequired = 0;
        o.maxBonus = 0;
        o.nestBegin = 0;
        o.nestCount = 0;
        o.judged = false;
        o.res = RES_NONE;
        o.judgedAt = -1;
        o.tracking = false;
        o.acceptAny = false;
        o.headAction = 0;
        o.hasHead = false;
        o.totalRot = 0;
        o.atLast = 0;
        o.curMax = 0;
        o.completedSpins = 0;
        o.lastAngle = 0;
        o.hasLastAngle = false;
        o.ticksHit = 0;
        o.acceptAnyAfter = 0;
        o.hasAcceptAfter = false;
        o.prevHeld = 0;
        o.histAccum = 0;
        o.histAtLast = 0;
        o.histMax = 0;
        o.histLastReport = -1e300;
        o.spinTimes.init();
        o.spinDirs.init();
        o.completedFullSpins = 0;
        o.spinLastAngle = 0;

        if (type & 2) {
            // ---- slider ----
            o.kind = K_SLIDER;
            o.path = (SliderPath*)arenaAlloc(sizeof(SliderPath));
            Span curve = np > 5 ? trimSpan(parts[5]) : Span{0, 0};
            double length = np > 7 ? numOr(parts[7], 0) : 0;
            double slides = np > 6 ? numOr(parts[6], 1) : 1;
            int spanCount = (int)slides;
            if (spanCount < 1) spanCount = 1;
            buildSliderPath(curve, V(x, y), *o.path, g_map.formatVersion);
            if (length < 0) length = 0;
            o.path->hasExpected = true;
            o.path->expected = length;
            o.path->rebuild();
            o.spanCount = spanCount;

            TimingPoint tp = timingAt(time);
            double sv = sliderVelocityAt(time);
            double svBl = -100.0 / sv;
            double bpmMult = (-svBl) < 10 ? 10.0 / 100 : ((-svBl) > 1000 ? 1000.0 / 100 : (-svBl) / 100);
            double pabl = tp.beatLength * bpmMult;
            double velocity = 100 * g_map.sliderMultiplier / pabl;
            o.velocity = velocity;
            double scoringDistance = velocity * tp.beatLength;
            double tickMult = g_map.formatVersion < 8 ? 1.0 / sv : 1.0;
            o.tickDistance = scoringDistance / g_map.tickRate * tickMult;

            double distance = o.path->distance();
            o.pathLen = distance;
            o.end = time + spanCount * distance / velocity;
            o.spanDuration = (o.end - time) / spanCount;

            Buf<Ev> evs;
            evs.init();
            sliderEvents(time, o.spanDuration, velocity, o.tickDistance, distance, spanCount, evs);

            o.nestBegin = g_nest.n;
            for (int e = 0; e < evs.n; e++) {
                const Ev& ev = evs[e];
                Nest nst;
                nst.parent = g_top.n;
                nst.judged = false;
                nst.res = RES_NONE;
                nst.judgedAt = -1;
                nst.progress = ev.progress;
                nst.time = ev.time;
                nst.pos = V(0, 0);
                if (ev.type == EV_HEAD) {
                    nst.kind = N_HEAD;
                    o.hasHead = true;
                } else if (ev.type == EV_TICK) {
                    nst.kind = N_TICK;
                } else if (ev.type == EV_REPEAT) {
                    nst.kind = N_REPEAT;
                } else {
                    nst.kind = N_TAIL;
                }
                g_nest.push(nst);
            }
            o.nestCount = g_nest.n - o.nestBegin;
            // Pass 1: nothing else. Positions are finalised after stacking.
        } else if (type & 8) {
            // ---- spinner ----
            o.kind = K_SPINNER;
            double endTime = np > 5 ? numOr(parts[5], time) : time;
            o.end = endTime;
            double duration = endTime - time;
            double minRps = diffRange(od, 90, 150, 225) / 60;
            double maxRps = diffRange(od, 250, 380, 430) / 60;
            double secs = duration / 1000;
            const double dur_err = 0.0001;
            int spinsRequired = (int)(minRps * secs + dur_err);
            int maxBonus = (int)(maxRps * secs + dur_err) - spinsRequired - 2;
            if (maxBonus < 0) maxBonus = 0;
            o.spinsRequired = spinsRequired;
            o.maxBonus = maxBonus;
            int total = maxBonus + spinsRequired + 2;
            o.nestBegin = g_nest.n;
            for (int i = 0; i < total; i++) {
                Nest nst;
                nst.parent = g_top.n;
                nst.kind = i < spinsRequired + 2 ? N_SPIN_TICK : N_SPIN_BONUS;
                // C#: (float)(i + 1) / totalSpins is float arithmetic, then widened.
                float frac = (float)(i + 1) / (float)total;
                nst.time = time + (double)frac * duration;
                nst.progress = 0;
                nst.pos = V(0, 0);
                nst.judged = false;
                nst.res = RES_NONE;
                nst.judgedAt = -1;
                g_nest.push(nst);
            }
            o.nestCount = total;
        }

        g_top.push(o);
    }

    // ---- PreProcess (OsuBeatmapProcessor): first object and object after a spinner start a combo.
    Obj* lastObj = 0;
    for (int i = 0; i < g_top.n; i++) {
        Obj& ob = g_top[i];
        if (!isSpinner(ob) && (lastObj == 0 || isSpinner(*lastObj))) ob.newCombo = true;
        lastObj = &ob;
    }

    // ---- combo information (OsuHitObject.UpdateComboInformation) ----
    for (int i = 0; i < g_top.n; i++) {
        Obj& ob = g_top[i];
        Obj* prev = i > 0 ? &g_top[i - 1] : 0;
        int index = prev ? prev->comboIndex : 0;
        int indexWithOffsets = prev ? prev->comboIndexOffsets : 0;
        int inCurrent = prev ? prev->indexInCombo + 1 : 0;
        if (!isSpinner(ob) && (ob.newCombo || prev == 0 || isSpinner(*prev))) {
            inCurrent = 0;
            index++;
            // ComboOffset is applied only for objects that start a new combo.
            indexWithOffsets += ob.comboOffsetSkip + 1;
            if (prev) prev->lastInCombo = true;
        }
        ob.comboIndex = index;
        ob.comboIndexOffsets = indexWithOffsets;
        ob.indexInCombo = inCurrent;
        ob.number = inCurrent + 1;
        // Stored unreduced: the palette is applied when drawing, so a skin change during a round
        // picks its own colours (the index is only 0 for a leading spinner, which draws no colour).
        ob.colour = indexWithOffsets > 0 ? indexWithOffsets - 1 : 0;
    }

    // ---- stacking ----
    applyStacking();

    // ---- final positions ----
    for (int i = 0; i < g_top.n; i++) {
        Obj& ob = g_top[i];
        double off = -6.4 * ob.scale * ob.stack;
        Vec2 offset = V(off, off);
        ob.radius = 64 * ob.scale;
        ob.stackedPos = ob.pos + offset;
        if (ob.kind == K_SLIDER) {
            Vec2 stackedHead = ob.pos + offset;
            ob.poly.clear();
            for (int k = 0; k < ob.path->calc.n; k++) {
                Vec2 q = stackedHead + ob.path->calc[k];
                ob.poly.push(q);
            }
            for (int k = 0; k < ob.nestCount; k++) {
                Nest& nst = g_nest[ob.nestBegin + k];
                if (nst.kind == N_HEAD) {
                    nst.pos = stackedHead;
                } else if (nst.kind == N_TAIL) {
                    nst.pos = stackedHead + endPositionRel(ob);
                } else {
                    nst.pos = stackedHead + ob.path->positionAt(nst.progress);
                }
            }
        } else if (ob.kind == K_SPINNER) {
            // spinners never stack
        }
    }

    if (g_top.n == 0) {
        *err = "No hit objects.";
        return false;
    }
    return true;
}

// -------------------------------------------------------- top level ----
bool loadBeatmap(const char* text, int length, const Rgb* skinColours, int skinCount, const char** err) {
    arenaReset();
    // The arena was just reset, so any storage left in these globals from the previous
    // load is gone. clear() would keep that stale pointer, so re-initialise instead.
    g_top.init();
    g_nest.init();
    g_colours.init();

    g_map.formatVersion = 14;
    g_map.stackLeniency = 0.7;
    g_map.hp = 5;
    g_map.cs = 5;
    g_map.od = 5;
    g_map.ar = -1;  // unset => OD
    g_map.sliderMultiplier = 1.4;
    g_map.tickRate = 1;
    g_map.audio[0] = 0;
    g_map.title[0] = 0;
    g_map.artist[0] = 0;
    g_map.version[0] = 0;
    g_map.timing.init();
    g_map.breaks.init();
    g_map.colours.init();
    g_map.hasBeatmapColours = false;
    g_map.timing.clear();
    g_map.breaks.clear();
    g_map.colours.clear();

    Buf<RawHit> raws;
    raws.init();

    Span all = {text, length};
    int section = 0;  // 1 general, 2 metadata, 3 difficulty, 4 timing, 5 colours, 6 events, 7 hitobjects
    int pos = 0;
    bool firstLine = true;
    Rgb colourSlots[64];
    bool colourSet[64];
    int maxColour = 0;
    for (int i = 0; i < 64; i++) colourSet[i] = false;

    while (pos < all.n) {
        int e = pos;
        while (e < all.n && all.p[e] != '\n') e++;
        Span line = trimSpan(Span{all.p + pos, e - pos});
        pos = e + 1;

        if (firstLine) {
            firstLine = false;
            if (spanStarts(line, "osu file format v")) {
                g_map.formatVersion = (int)numOr(Span{line.p + 17, line.n - 17}, 14);
            }
            continue;
        }
        if (line.n == 0 || (line.n >= 2 && line.p[0] == '/' && line.p[1] == '/')) continue;

        if (line.p[0] == '[') {
            if (spanEq(line, "[General]")) section = 1;
            else if (spanEq(line, "[Metadata]")) section = 2;
            else if (spanEq(line, "[Difficulty]")) section = 3;
            else if (spanEq(line, "[TimingPoints]")) section = 4;
            else if (spanEq(line, "[Colours]")) section = 5;
            else if (spanEq(line, "[Events]")) section = 6;
            else if (spanEq(line, "[HitObjects]")) section = 7;
            else section = 0;
            continue;
        }

        if (section == 7) {
            RawHit rh;
            rh.line = line;
            Span parts[8];
            int np = splitOn(line, ',', parts, 8);
            rh.time = np > 2 ? numOr(parts[2], 0) : 0;
            raws.push(rh);
            continue;
        }

        if (section == 4) {
            Span parts[8];
            int np = splitOn(line, ',', parts, 8);
            if (np < 2) continue;
            TimingPoint tp;
            tp.time = numOr(parts[0], 0);
            tp.beatLength = numOr(parts[1], 500);
            tp.uninherited = np >= 7 ? numOr(parts[6], 1) != 0 : true;
            g_map.timing.push(tp);
            continue;
        }

        if (section == 6) {
            // Break periods: "2,start,end"
            if (line.p[0] == '2' && line.n > 1 && line.p[1] == ',') {
                Span parts[4];
                int np = splitOn(line, ',', parts, 4);
                if (np >= 3) {
                    BreakPeriod b;
                    b.start = numOr(parts[1], 0);
                    b.end = numOr(parts[2], 0);
                    g_map.breaks.push(b);
                }
            }
            continue;
        }

        if (section == 5) {
            if (line.n > 5 && spanStarts(line, "Combo")) {
                Span kv[2];
                int np = splitOn(line, ':', kv, 2);
                if (np == 2) {
                    int idx = (int)numOr(Span{line.p + 5, np > 0 ? kv[0].n - 5 : 0}, 0) - 1;
                    Span rgbParts[4];
                    int nr = splitOn(trimSpan(kv[1]), ',', rgbParts, 4);
                    if (idx >= 0 && idx < 64 && nr >= 3) {
                        colourSlots[idx] = Rgb{numOr(rgbParts[0], 0), numOr(rgbParts[1], 0), numOr(rgbParts[2], 0)};
                        colourSet[idx] = true;
                        if (idx + 1 > maxColour) maxColour = idx + 1;
                    }
                }
            }
            continue;
        }

        if (section == 1 || section == 2 || section == 3) {
            int colon = -1;
            for (int k = 0; k < line.n; k++) {
                if (line.p[k] == ':') {
                    colon = k;
                    break;
                }
            }
            if (colon < 0) continue;
            Span key = trimSpan(Span{line.p, colon});
            Span val = trimSpan(Span{line.p + colon + 1, line.n - colon - 1});
            if (section == 1) {
                if (spanEq(key, "AudioFilename")) copyStr(g_map.audio, 256, val);
                else if (spanEq(key, "StackLeniency")) g_map.stackLeniency = numOr(val, 0.7);
            } else if (section == 2) {
                if (spanEq(key, "Title")) copyStr(g_map.title, 256, val);
                else if (spanEq(key, "Artist")) copyStr(g_map.artist, 256, val);
                else if (spanEq(key, "Version")) copyStr(g_map.version, 256, val);
            } else {
                if (spanEq(key, "HPDrainRate")) g_map.hp = numOr(val, 5);
                else if (spanEq(key, "CircleSize")) g_map.cs = numOr(val, 5);
                else if (spanEq(key, "OverallDifficulty")) g_map.od = numOr(val, 5);
                else if (spanEq(key, "ApproachRate")) g_map.ar = numOr(val, -1);
                else if (spanEq(key, "SliderMultiplier")) g_map.sliderMultiplier = numOr(val, 1.4);
                else if (spanEq(key, "SliderTickRate")) g_map.tickRate = numOr(val, 1);
            }
            continue;
        }
    }

    if (g_map.ar < 0) g_map.ar = g_map.od;  // ApproachRate defaults to OverallDifficulty

    // Timing points sorted by time (stable).
    for (int i = 1; i < g_map.timing.n; i++) {
        TimingPoint key = g_map.timing[i];
        int j = i - 1;
        while (j >= 0 && g_map.timing[j].time > key.time) {
            g_map.timing[j + 1] = g_map.timing[j];
            j--;
        }
        g_map.timing[j + 1] = key;
    }

    // Colours: beatmap [Colours] take precedence over the skin.
    g_colours.clear();
    if (maxColour > 0) {
        for (int i = 0; i < maxColour; i++) {
            if (colourSet[i]) g_colours.push(colourSlots[i]);
        }
        g_map.hasBeatmapColours = g_colours.n > 0;
    }
    if (!g_map.hasBeatmapColours) {
        if (skinCount > 0) {
            for (int i = 0; i < skinCount; i++) g_colours.push(skinColours[i]);
        } else {
            g_colours.push(Rgb{255, 192, 0});
            g_colours.push(Rgb{0, 202, 0});
            g_colours.push(Rgb{18, 124, 255});
            g_colours.push(Rgb{242, 24, 57});
        }
    }

    if (raws.n == 0) {
        *err = "No [HitObjects] found.";
        return false;
    }

    if (!processHitObjects(raws.d, raws.n, err)) return false;

    g_firstTime = g_top[0].time;
    g_gameplayEnd = g_top[g_top.n - 1].end;
    g_drainStart = g_top[0].time;
    g_drainRate = 0;
    return true;
}

}  // namespace oc
