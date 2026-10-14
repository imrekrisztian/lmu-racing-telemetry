'use strict';

// Compounds and the wet-tyre call.
//
// Operating windows are Michelin's published ones for WEC, which is what LMU
// models:
//
//   Soft    track 0-15C,  dry or slightly damp      sidewall white
//   Medium  track 15-25C, dry                       sidewall yellow
//   Hard    track >25C,   dry, abrasive surface     sidewall red
//   Wet     wet or drying conditions                sidewall blue
//
// THERE IS NO INTERMEDIATE. WEC runs slicks or full wets, nothing between,
// which is precisely why the crossover is the hardest call on the pit wall --
// get it wrong in either direction and it costs far more than a tenth.
//
// Wets also sit outside the dry allocation, so fitting them never costs a set
// of slicks later in the race.

const COMPOUNDS = {
    Hyper: [
        { id: 'soft', name: 'Soft', colour: '#e5e7eb', wet: false, trackTempC: [0, 15] },
        { id: 'medium', name: 'Medium', colour: '#eab308', wet: false, trackTempC: [15, 25] },
        { id: 'hard', name: 'Hard', colour: '#ef4444', wet: false, trackTempC: [25, 60] },
        { id: 'wet', name: 'Wet', colour: '#3b82f6', wet: true, trackTempC: null },
    ],
    GT3: [
        { id: 'soft', name: 'Soft', colour: '#e5e7eb', wet: false, trackTempC: [0, 20] },
        { id: 'medium', name: 'Medium', colour: '#eab308', wet: false, trackTempC: [20, 60] },
        { id: 'wet', name: 'Wet', colour: '#3b82f6', wet: true, trackTempC: null },
    ],
    LMP2: [
        { id: 'medium', name: 'Medium', colour: '#eab308', wet: false, trackTempC: [0, 60] },
        { id: 'wet', name: 'Wet', colour: '#3b82f6', wet: true, trackTempC: null },
    ],
};

const THRESHOLDS = {
    // Average wetness on the line at which wets beat slicks outright.
    wetCrossover: 0.30,
    // Below this the track is effectively dry.
    dryCrossover: 0.12,
    // Rain falling hard enough to commit regardless of current wetness.
    heavyRain: 0.45,
    // Standing water off-line while the line is dry: slicks, but with care.
    offLineSpread: 0.35,
};

function compoundsFor(carClass) {
    return COMPOUNDS[carClass] ?? COMPOUNDS.Hyper;
}

/** Best slick for the surface temperature, nearest window if none contains it. */
function slickForTemp(carClass, trackTempC) {
    const slicks = compoundsFor(carClass).filter((c) => !c.wet);
    if (trackTempC == null) return slicks[Math.floor(slicks.length / 2)];
    const inWindow = slicks.find((c) => trackTempC >= c.trackTempC[0] && trackTempC < c.trackTempC[1]);
    if (inWindow) return inWindow;
    return trackTempC < slicks[0].trackTempC[0] ? slicks[0] : slicks[slicks.length - 1];
}

/**
 * Rate of change of wetness, and when it will reach a threshold.
 *
 * Theil-Sen (the median of all pairwise slopes), not least squares.
 *
 * Least squares was the first implementation and it is the wrong tool here: a
 * single corrupt sample at the end of the window sits at maximum leverage and
 * can flatten a real trend to "steady", which in the crossover band flips the
 * tyre call. Theil-Sen has a ~29% breakdown point, so a handful of bad reads
 * cannot move it. The window is a couple of hundred samples at most, so the
 * O(n^2) cost is irrelevant.
 */
function wetnessTrend(history, { windowS = 240, maxPoints = 180 } = {}) {
    if (!history || history.length < 3) return { slopePerS: 0, direction: 'steady' };
    const latest = history[history.length - 1].t;
    let pts = history.filter((p) => p.t >= latest - windowS);
    if (pts.length < 3) return { slopePerS: 0, direction: 'steady' };

    // Thin evenly if the window is dense; the median is unaffected by density.
    if (pts.length > maxPoints) {
        const step = Math.ceil(pts.length / maxPoints);
        pts = pts.filter((_, i) => i % step === 0);
    }

    const slopes = [];
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            const dt = pts[j].t - pts[i].t;
            if (dt > 0) slopes.push((pts[j].wet - pts[i].wet) / dt);
        }
    }
    if (slopes.length === 0) return { slopePerS: 0, direction: 'steady' };

    slopes.sort((a, b) => a - b);
    const mid = slopes.length >> 1;
    const slopePerS = slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;

    const direction = slopePerS > 1e-5 ? 'wetting' : slopePerS < -1e-5 ? 'drying' : 'steady';
    return { slopePerS, direction };
}

/** Seconds until wetness reaches `target`, or null if it is not heading there. */
function secondsToWetness(current, trend, target) {
    if (!trend || Math.abs(trend.slopePerS) < 1e-6) return null;
    const delta = target - current;
    if (Math.sign(delta) !== Math.sign(trend.slopePerS)) return null;
    const s = delta / trend.slopePerS;
    return s > 0 && s < 7200 ? s : null;
}

/**
 * The call, with its reasoning.
 *
 * Deliberately returns why, not just what: a pit wall that says "wets" without
 * saying the track is at 38% and still rising is not something a strategist
 * can argue with or override.
 */
function recommendCompound({
    carClass = 'Hyper', conditions, history = [], current = null, thresholds = {},
} = {}) {
    const T = { ...THRESHOLDS, ...thresholds };
    if (!conditions) return { compound: null, confidence: 0, reasons: ['No conditions yet.'] };

    const wet = conditions.wetness_avg ?? 0;
    const wetMin = conditions.wetness_min ?? wet;
    const wetMax = conditions.wetness_max ?? wet;
    const rain = conditions.raining ?? 0;
    const trackTemp = conditions.track_temp_c;

    const trend = wetnessTrend(history);
    const reasons = [];
    const all = compoundsFor(carClass);
    const wetTyre = all.find((c) => c.wet);
    const slick = slickForTemp(carClass, trackTemp);

    let pick, confidence;

    if (rain >= T.heavyRain) {
        pick = wetTyre; confidence = 0.95;
        reasons.push(`Rain at ${Math.round(rain * 100)}% — wets regardless of current track state.`);
    } else if (wet >= T.wetCrossover) {
        pick = wetTyre;
        confidence = trend.direction === 'drying' ? 0.7 : 0.9;
        reasons.push(`Track ${Math.round(wet * 100)}% wet, past the ${Math.round(T.wetCrossover * 100)}% crossover.`);
        if (trend.direction === 'drying') {
            const s = secondsToWetness(wet, trend, T.wetCrossover);
            reasons.push(s
                ? `Drying — back under the crossover in about ${Math.round(s / 60)} min, so a short wet stint may be enough.`
                : `Drying, but not fast enough to gamble on slicks yet.`);
        }
    } else if (wet <= T.dryCrossover && rain < 0.05) {
        pick = slick; confidence = 0.9;
        reasons.push(`Track effectively dry at ${Math.round(wet * 100)}%.`);
        reasons.push(trackTemp == null
            ? `${slick.name} by default.`
            : `${slick.name} suits ${trackTemp.toFixed(0)}°C surface` +
              (slick.trackTempC ? ` (window ${slick.trackTempC[0]}–${slick.trackTempC[1]}°C).` : '.'));
    } else {
        // The crossover band: no intermediate exists, so this is a gamble
        // either way and the trend decides which way to lean.
        if (trend.direction === 'wetting') {
            pick = wetTyre; confidence = 0.6;
            const s = secondsToWetness(wet, trend, T.wetCrossover);
            reasons.push(`In the crossover band at ${Math.round(wet * 100)}% and getting wetter` +
                (s ? ` — past the crossover in about ${Math.round(s / 60)} min.` : '.'));
            reasons.push('No intermediate exists, so committing early beats being caught out.');
        } else {
            pick = slick; confidence = trend.direction === 'drying' ? 0.65 : 0.5;
            reasons.push(`Crossover band at ${Math.round(wet * 100)}% wet` +
                (trend.direction === 'drying' ? ' and drying — stay out on slicks.' : ' and steady — marginal.'));
        }
    }

    if (!pick.wet && wetMax - wetMin >= T.offLineSpread) {
        reasons.push(`Line is far drier than off it (${Math.round(wetMin * 100)}% vs ` +
            `${Math.round(wetMax * 100)}%) — grip falls away sharply off the dry line.`);
        confidence = Math.max(0.4, confidence - 0.15);
    }

    const change = current != null && current !== pick.id;
    return {
        compound: pick.id,
        name: pick.name,
        colour: pick.colour,
        isWet: pick.wet,
        confidence: Math.round(confidence * 100) / 100,
        change,
        trend: trend.direction,
        wetnessPct: Math.round(wet * 100),
        secondsToWetCrossover: secondsToWetness(wet, trend, T.wetCrossover),
        secondsToDry: secondsToWetness(wet, trend, T.dryCrossover),
        reasons,
    };
}

module.exports = { COMPOUNDS, THRESHOLDS, compoundsFor, slickForTemp, wetnessTrend, secondsToWetness, recommendCompound };
