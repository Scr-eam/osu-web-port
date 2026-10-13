// Slider paths: port of osu.Game/Rulesets/Objects/SliderPath.cs (lazer 2026.1005.0).
//
// NOTE: osu-framework's PathApproximator / CircularArcProperties are not part of the
// lazer source archive, and the framework file could not be fetched from here. The
// approximators below are reimplemented from the published osu! algorithms (bezier
// flatness tolerance 0.25, catmull detail 50, circular arc tolerance 0.1). Check them
// against the framework source before relying on exact slider lengths.
#include "core.h"

namespace oc {

static const double BEZIER_TOLERANCE = 0.25;
static const int CATMULL_DETAIL = 50;
static const double CIRCULAR_ARC_TOLERANCE = 0.1;

// ------------------------------------------------------------ bezier ----
static bool bezierFlat(const Vec2* p, int n) {
    double tol2 = BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4.0;
    for (int i = 1; i < n - 1; i++) {
        Vec2 d = p[i - 1] - p[i] * 2.0 + p[i + 1];
        if (len2(d) > tol2) return false;
    }
    return true;
}

// Appends end points of flat sub-curves. The caller adds the start point.
static void bezierRecurse(const Vec2* p, int n, Buf<Vec2>& out, int depth) {
    if (n <= 1 || depth > 24 || bezierFlat(p, n)) {
        out.push(p[n - 1]);
        return;
    }
    Vec2* w = (Vec2*)arenaAlloc(sizeof(Vec2) * (unsigned long)n);
    Vec2* l = (Vec2*)arenaAlloc(sizeof(Vec2) * (unsigned long)n);
    Vec2* r = (Vec2*)arenaAlloc(sizeof(Vec2) * (unsigned long)n);
    for (int i = 0; i < n; i++) w[i] = p[i];
    // De Casteljau split at t = 0.5
    for (int i = 0; i < n; i++) {
        l[i] = w[0];
        r[n - 1 - i] = w[n - 1 - i];
        for (int j = 0; j < n - 1 - i; j++) w[j] = (w[j] + w[j + 1]) * 0.5;
    }
    bezierRecurse(l, n, out, depth + 1);
    bezierRecurse(r, n, out, depth + 1);
}

static Buf<Vec2> bezierToPiecewise(const Vec2* p, int n) {
    Buf<Vec2> out;
    out.init();
    if (n == 0) return out;
    out.push(p[0]);
    if (n == 1) return out;
    bezierRecurse(p, n, out, 0);
    return out;
}

// ---------------------------------------------------------- catmull ----
static Vec2 catmullPoint(Vec2 v0, Vec2 v1, Vec2 v2, Vec2 v3, double t) {
    double t2 = t * t, t3 = t2 * t;
    double x = 0.5 * (2 * v1.x + (-v0.x + v2.x) * t + (2 * v0.x - 5 * v1.x + 4 * v2.x - v3.x) * t2 + (-v0.x + 3 * v1.x - 3 * v2.x + v3.x) * t3);
    double y = 0.5 * (2 * v1.y + (-v0.y + v2.y) * t + (2 * v0.y - 5 * v1.y + 4 * v2.y - v3.y) * t2 + (-v0.y + 3 * v1.y - 3 * v2.y + v3.y) * t3);
    return V(x, y);
}

static Buf<Vec2> catmullToPiecewise(const Vec2* p, int n) {
    Buf<Vec2> out;
    out.init();
    if (n == 0) return out;
    if (n == 1) {
        out.push(p[0]);
        return out;
    }
    for (int i = 0; i < n - 1; i++) {
        Vec2 v0 = p[i > 0 ? i - 1 : 0];
        Vec2 v1 = p[i];
        Vec2 v2 = p[i + 1];
        Vec2 v3 = p[i + 2 < n ? i + 2 : n - 1];
        for (int c = 0; c < CATMULL_DETAIL; c++) {
            out.push(catmullPoint(v0, v1, v2, v3, (double)c / CATMULL_DETAIL));
            out.push(catmullPoint(v0, v1, v2, v3, (double)(c + 1) / CATMULL_DETAIL));
        }
    }
    return out;
}

// ---------------------------------------------------------- circle ----
struct Arc {
    Vec2 c;
    double r;
    double thStart;
    double thRange;
    double dir;
    bool valid;
};

static Arc arcFrom(Vec2 a, Vec2 b, Vec2 c) {
    Arc arc;
    arc.valid = false;
    arc.c = V(0, 0);
    arc.r = 0;
    arc.thStart = 0;
    arc.thRange = 0;
    arc.dir = 1;
    double aSq = len2(b - c), bSq = len2(a - c), cSq = len2(a - b);
    if (aSq < 1e-9 || bSq < 1e-9 || cSq < 1e-9) return arc;
    double s = aSq * (bSq + cSq - aSq);
    double t = bSq * (aSq + cSq - bSq);
    double u = cSq * (aSq + bSq - cSq);
    double sum = s + t + u;
    if (absd(sum) < 1e-12) return arc;
    Vec2 center = (a * s + b * t + c * u) * (1.0 / sum);
    Vec2 dA = a - center, dC = c - center;
    arc.c = center;
    arc.r = vlen(dA);
    arc.thStart = __builtin_atan2(dA.y, dA.x);
    double thEnd = __builtin_atan2(dC.y, dC.x);
    while (thEnd < arc.thStart) thEnd += 2 * PI;
    arc.dir = 1;
    arc.thRange = thEnd - arc.thStart;
    Vec2 ortho = c - a;
    ortho = V(ortho.y, -ortho.x);
    Vec2 ab = b - a;
    if (ortho.x * ab.x + ortho.y * ab.y < 0) {
        arc.dir = -arc.dir;
        arc.thRange = 2 * PI - arc.thRange;
    }
    arc.valid = arc.r > 0;
    return arc;
}

static int arcSubPoints(const Arc& arc) {
    if (2 * arc.r <= 0.1) return 2;
    double step = 2.0 * __builtin_acos(1.0 - CIRCULAR_ARC_TOLERANCE / arc.r);
    double v = __builtin_ceil(arc.thRange / step);
    if (v < 2) return 2;
    return (int)v;
}

// -------------------------------------------------- sub-path dispatch ----
static Buf<Vec2> calcSubPath(const Vec2* pts, int n, int type, double* optimisedAcc) {
    Buf<Vec2> out;
    out.init();
    if (type == PK_LINEAR) {
        for (int i = 0; i < n; i++) out.push(pts[i]);
        return out;
    }
    if (type == PK_PERFECT && n == 3) {
        Arc arc = arcFrom(pts[0], pts[1], pts[2]);
        if (arc.valid) {
            int sub = arcSubPoints(arc);
            if (sub < 1000) {
                for (int i = 0; i < sub; i++) {
                    double f = (double)i / (sub - 1);
                    double th = arc.thStart + arc.dir * f * arc.thRange;
                    out.push(arc.c + V(arc.r * __builtin_cos(th), arc.r * __builtin_sin(th)));
                }
                return out;
            }
        }
        // fall through to bezier
    }
    if (type == PK_CATMULL) {
        Buf<Vec2> sub = catmullToPiecewise(pts, n);
        // Stable's path optimisation, as lazer applies it for sliders
        // (SliderPath.OptimiseCatmull = true).
        const int segLen = CATMULL_DETAIL * 2;
        bool hasLast = false;
        Vec2 lastStart = V(0, 0);
        double lengthRemoved = 0;
        for (int i = 0; i < sub.n; i++) {
            if (!hasLast) {
                out.push(sub[i]);
                lastStart = sub[i];
                hasLast = true;
                continue;
            }
            double distFromStart = dist(lastStart, sub[i]);
            lengthRemoved += dist(sub[i - 1], sub[i]);
            if (distFromStart > 6 || (i + 1) % segLen == 0 || i == sub.n - 1) {
                out.push(sub[i]);
                *optimisedAcc += lengthRemoved - distFromStart;
                hasLast = false;
                lengthRemoved = 0;
            }
        }
        return out;
    }
    // Bezier (and B-spline fallback: a B-spline with degree == point count is a bezier)
    return bezierToPiecewise(pts, n);
}

// ---------------------------------------------------- SliderPath ----
void SliderPath::rebuild() {
    calc.clear();
    cum.clear();
    optimised = 0;
    calcLen = 0;
    if (cps.n == 0) return;

    Vec2* verts = (Vec2*)arenaAlloc(sizeof(Vec2) * (unsigned long)cps.n);
    for (int i = 0; i < cps.n; i++) verts[i] = cps[i].p;

    int start = 0;
    for (int i = 0; i < cps.n; i++) {
        if (cps[i].type == PK_NONE && i < cps.n - 1) continue;
        int segCount = i - start + 1;
        int segType = cps[start].type == PK_NONE ? PK_LINEAR : cps[start].type;
        if (segCount == 1) {
            calc.push(verts[start]);
        } else if (segCount > 1) {
            Buf<Vec2> sub = calcSubPath(verts + start, segCount, segType, &optimised);
            bool skipFirst = calc.n > 0 && sub.n > 0 && veq(calc.last(), sub[0]);
            for (int j = skipFirst ? 1 : 0; j < sub.n; j++) calc.push(sub[j]);
        }
        start = i;
    }

    // calculateLength
    calcLen = optimised;
    cum.push(0);
    for (int i = 0; i < calc.n - 1; i++) {
        calcLen += vlen(calc[i + 1] - calc[i]);
        cum.push(calcLen);
    }

    if (hasExpected && calcLen != expected) {
        if (calc.n >= 2 && veq(calc[calc.n - 1], calc[calc.n - 2]) && expected > calcLen) {
            cum.push(calcLen);
            return;
        }
        cum.removeLast();
        int pathEndIndex = calc.n - 1;
        if (calcLen > expected) {
            while (cum.n > 0 && cum[cum.n - 1] >= expected) {
                cum.removeLast();
                calc.removeAt(pathEndIndex--);
            }
        }
        if (pathEndIndex <= 0) {
            cum.push(0);
            return;
        }
        Vec2 d = calc[pathEndIndex] - calc[pathEndIndex - 1];
        double dl = vlen(d);
        Vec2 dir = dl > 0 ? d * (1.0 / dl) : V(0, 0);
        calc[pathEndIndex] = calc[pathEndIndex - 1] + dir * (expected - cum[cum.n - 1]);
        cum.push(expected);
    }
}

Vec2 SliderPath::positionAt(double progress) const {
    if (calc.n == 0) return V(0, 0);
    double d = clampd(progress, 0, 1) * distance();
    // First index whose cumulative distance is >= d (BinarySearch insertion point).
    int lo = 0, hi = cum.n;
    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        if (cum[mid] < d) lo = mid + 1;
        else hi = mid;
    }
    int i = lo;
    if (i <= 0) return calc[0];
    if (i >= calc.n) return calc[calc.n - 1];
    Vec2 p0 = calc[i - 1], p1 = calc[i];
    double d0 = cum[i - 1], d1 = cum[i];
    if (absd(d0 - d1) < 1e-3) return p0;  // Precision.AlmostEquals
    double w = (d - d0) / (d1 - d0);
    return p0 + (p1 - p0) * w;
}

// ------------------------------------------------- repeat handling ----
double curveProgress(const Obj& o, double progress) {
    double p = progress * o.spanCount;
    int spanAt = (int)p;
    double frac = p - floord(p);
    if (spanAt % 2 == 1) frac = 1 - frac;
    return frac;
}

Vec2 curvePosition(const Obj& o, double progress) {
    return o.path->positionAt(curveProgress(o, progress));
}

Vec2 endPositionRel(const Obj& o) {
    return curvePosition(o, 1.0);
}

}  // namespace oc
