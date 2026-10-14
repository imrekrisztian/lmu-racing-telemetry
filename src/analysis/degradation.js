'use strict';

// Tyre wear and degradation.
//
// These are two different quantities and conflating them is the usual error:
//
//   WEAR         rubber physically gone, from the tyre_wear channel (0..1,
//                1.0 = new). Tells you when the tyre is finished.
//   DEGRADATION  lap time lost as the tyre gives up. Tells you when STOPPING
//                is worth the pit loss, which is the strategic question.
//
// A tyre can be 60% worn and still quick, or barely worn and three tenths off
// because it is overheating. Modelling only one of them answers half the race.
//
// THE CORRECTION THAT MATTERS
//   Raw lap times over a stint mix two opposing effects: tyres degrade (slower)
//   while fuel burns off (faster). On a Hypercar carrying ~100kg of fuel the
//   fuel effect is worth more than a second a lap over a stint, so fitting
//   degradation to RAW lap times understates it badly -- often to near zero.
//   Times are fuel-corrected to a common load before anything is fitted.

const DEFAULTS = {
    // Seconds per lap per litre aboard. ~0.03-0.04 for a 1000kg prototype;
    // should be measured per car rather than trusted.
    fuelEffectSPerL: 0.035,
    minLaps: 4,
    // Traffic and mistakes are slow outliers, not degradation. Fit, drop the
    // laps more than this many sigma SLOW, refit. Quick outliers are kept --
    // nobody is accidentally fast.
    outlierSigma: 2.0,
    maxRefits: 3,
    // Wear fraction at which a tyre is considered finished.
    wearLimit: 0.15,
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Ordinary least squares y = a + b x, plus r^2. */
function linfit(xs, ys) {
    const n = xs.length;
    if (n < 2) return { intercept: ys[0] ?? 0, slope: 0, r2: 0 };
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = den === 0 ? 0 : num / den;
    const intercept = my - slope * mx;

    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
        ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
        ssTot += (ys[i] - my) ** 2;
    }
    return { intercept, slope, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

/**
 * Remove the fuel-load effect so what remains is the tyre.
 * @param {Array} laps [{ stintLap, lapTimeS, fuelL }]
 */
function fuelCorrect(laps, fuelEffectSPerL) {
    const withFuel = laps.filter((l) => l.fuelL != null);
    if (withFuel.length === 0 || !(fuelEffectSPerL > 0)) {
        // Nothing to correct with. The caller is told, because an uncorrected
        // figure conflates tyre degradation with fuel burn and can easily come
        // out NEGATIVE on a car that is losing weight faster than grip.
        return laps.map((l) => ({ ...l, correctedS: l.lapTimeS, fuelCorrectionS: 0 }));
    }
    // Normalise to the heaviest load in the stint, so corrected times stay in
    // the same ballpark as real ones instead of drifting off to a fictional
    // empty-tank number.
    const ref = Math.max(...withFuel.map((l) => l.fuelL));
    return laps.map((l) => {
        const corr = l.fuelL == null ? 0 : (ref - l.fuelL) * fuelEffectSPerL;
        return { ...l, correctedS: l.lapTimeS + corr, fuelCorrectionS: corr };
    });
}

/**
 * Fit degradation in seconds per lap.
 *
 * @returns {{degSPerLap, baseLapS, r2, lapsUsed, dropped, cliff}}
 */
function fitDegradation(laps, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const usable = laps.filter((l) => l.lapTimeS > 0 && l.valid !== false
        && !l.isOutLap && !l.isInLap);

    if (usable.length < o.minLaps) {
        return { degSPerLap: null, baseLapS: null, r2: null, lapsUsed: usable.length,
                 dropped: [], cliff: null, reason: `need at least ${o.minLaps} clean laps` };
    }

    const canCorrect = usable.some((l) => l.fuelL != null) && o.fuelEffectSPerL > 0;
    const corrected = fuelCorrect(usable, o.fuelEffectSPerL);
    let kept = corrected;
    const dropped = [];

    for (let pass = 0; pass < o.maxRefits; pass++) {
        const fit = linfit(kept.map((l) => l.stintLap), kept.map((l) => l.correctedS));
        const resid = kept.map((l) => l.correctedS - (fit.intercept + fit.slope * l.stintLap));
        const sd = Math.sqrt(mean(resid.map((r) => r * r)));
        if (sd === 0) break;

        // Slow outliers only: traffic and mistakes cost time, never save it.
        const next = kept.filter((l, i) => resid[i] <= o.outlierSigma * sd);
        if (next.length === kept.length || next.length < o.minLaps) break;
        kept.filter((l, i) => resid[i] > o.outlierSigma * sd).forEach((l) => dropped.push(l.stintLap));
        kept = next;
    }

    const fit = linfit(kept.map((l) => l.stintLap), kept.map((l) => l.correctedS));

    return {
        degSPerLap: fit.slope,
        baseLapS: fit.intercept,
        r2: fit.r2,
        lapsUsed: kept.length,
        dropped,
        fuelCorrected: canCorrect,
        fuelEffectSPerL: canCorrect ? o.fuelEffectSPerL : 0,
        // Without fuel data the slope is tyre degradation MINUS the weight the
        // car shed, which is not degradation and should not be presented as it.
        warning: canCorrect ? null
            : 'No fuel data — figure mixes tyre degradation with fuel burn and will understate it.',
        corrected,
        cliff: detectCliff(kept, fit),
    };
}

/**
 * A cliff is degradation accelerating, not merely being high.
 *
 * Compares the slope of the most recent third of the stint against the first
 * two thirds. Tyres that fall away do so suddenly, and the linear fit averages
 * that into something reassuring and wrong.
 */
function detectCliff(laps, overallFit, { factor = 2.0, minLaps = 6 } = {}) {
    if (laps.length < minLaps) return null;
    const sorted = [...laps].sort((a, b) => a.stintLap - b.stintLap);
    const split = Math.floor(sorted.length * (2 / 3));
    const early = sorted.slice(0, split);
    const late = sorted.slice(split);
    if (early.length < 3 || late.length < 2) return null;

    const e = linfit(early.map((l) => l.stintLap), early.map((l) => l.correctedS));
    const l = linfit(late.map((l) => l.stintLap), late.map((l) => l.correctedS));

    if (e.slope <= 0 || l.slope <= e.slope * factor) return null;
    return {
        fromLap: late[0].stintLap,
        earlySPerLap: e.slope,
        lateSPerLap: l.slope,
        ratio: l.slope / e.slope,
    };
}

/** Wear rate per wheel, and how many laps are left on each. */
function wearProjection(wearByLap, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const wheels = ['fl', 'fr', 'rl', 'rr'];
    const out = {};

    for (const w of wheels) {
        const pts = wearByLap
            .filter((p) => p[w] != null)
            .map((p) => ({ x: p.stintLap, y: p[w] }));
        if (pts.length < 2) { out[w] = null; continue; }

        const fit = linfit(pts.map((p) => p.x), pts.map((p) => p.y));
        const perLap = -fit.slope;                    // wear counts DOWN from 1.0
        const current = pts[pts.length - 1].y;
        const lapsLeft = perLap > 1e-6
            ? Math.max(0, Math.floor((current - o.wearLimit) / perLap)) : null;

        out[w] = { current, perLap, lapsLeft, r2: fit.r2 };
    }

    const rates = wheels.map((w) => out[w]?.perLap).filter((v) => v != null);
    const lefts = wheels.map((w) => out[w]?.lapsLeft).filter((v) => v != null);
    const worst = wheels
        .filter((w) => out[w]?.lapsLeft != null)
        .sort((a, b) => out[a].lapsLeft - out[b].lapsLeft)[0] ?? null;

    return {
        wheels: out,
        limitingWheel: worst,
        lapsLeft: lefts.length ? Math.min(...lefts) : null,
        meanPerLap: rates.length ? mean(rates) : null,
    };
}

/**
 * How long a stint should be once degradation is paid for.
 *
 * Running longer spreads the pit loss over more laps but each extra lap is
 * slower than the last. Total time per lap for a stint of n laps is
 *
 *     pitLoss/n + base + deg*(n-1)/2
 *
 * which is minimised at n = sqrt(2*pitLoss/deg). Capped by whatever the fuel
 * or tyres physically allow.
 */
function optimalStintLaps({ degSPerLap, pitLossS, maxLaps = Infinity }) {
    if (!(degSPerLap > 1e-6) || !(pitLossS > 0)) return { laps: maxLaps, limitedBy: 'fuel or tyres' };
    const ideal = Math.sqrt((2 * pitLossS) / degSPerLap);
    const laps = Math.max(1, Math.min(maxLaps, Math.round(ideal)));
    return {
        laps,
        idealLaps: ideal,
        limitedBy: laps < ideal ? 'fuel or tyres' : 'degradation',
    };
}

/** Projected lap time at a given stint lap. */
function projectLapTime(model, stintLap) {
    if (model?.degSPerLap == null) return null;
    return model.baseLapS + model.degSPerLap * stintLap;
}

module.exports = {
    DEFAULTS, linfit, fuelCorrect, fitDegradation, detectCliff,
    wearProjection, optimalStintLaps, projectLapTime,
};
