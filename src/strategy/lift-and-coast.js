'use strict';

// Lift-and-coast coaching.
//
// The cheapest energy on a lap sits immediately before a heavy braking zone.
// Lifting there costs little, because that kinetic energy was about to be
// thrown away as brake heat anyway -- whereas lifting on a straight you are
// still using costs full value. So the question is never "should I lift" but
// "WHERE, and how much is each lift worth".
//
// Everything here is MEASURED from the car's own telemetry rather than assumed:
// coast deceleration is fitted from samples where the driver is already off
// both pedals, and fuel flow comes from what the lap actually burned. A guessed
// drag coefficient would make the whole thing decorative.

const DEFAULTS = {
    // Fallbacks only, used when a lap has no coasting to learn from.
    coastDragPerV2: 0.00042,   // a = k*v^2 + c, the v^2 term (drag)
    coastConstant: 0.45,       // rolling resistance and driveline, m/s^2
    brakeDecel: 13.0,          // m/s^2, matches the probe's reference figure
    minLiftM: 10,
    maxLiftM: 250,
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Fit coast deceleration against speed from real coasting samples.
 *
 * a(v) = k*v^2 + c -- drag rising with the square of speed, plus a constant
 * for rolling resistance and engine braking. Fitted by least squares on v^2,
 * which is linear in the parameters.
 */
function fitCoastModel(coastSamples, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const pts = (coastSamples ?? []).filter(
        (s) => s.speed_ms > 15 && s.decel_ms2 > 0 && s.decel_ms2 < 20);

    if (pts.length < 8) {
        return {
            k: o.coastDragPerV2, c: o.coastConstant, measured: false, samples: pts.length,
            at: (v) => o.coastDragPerV2 * v * v + o.coastConstant,
        };
    }

    const xs = pts.map((p) => p.speed_ms ** 2);
    const ys = pts.map((p) => p.decel_ms2);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    let k = den === 0 ? o.coastDragPerV2 : num / den;
    let c = my - k * mx;

    // A negative drag term or negative baseline is unphysical; fall back rather
    // than coach from nonsense.
    if (!(k > 0) || !(c > -0.5)) return fitCoastModel([], opts);
    c = Math.max(0.1, c);

    return { k, c, measured: true, samples: pts.length, at: (v) => k * v * v + c };
}

/**
 * Time and energy for lifting `liftM` early into one braking zone.
 *
 * The driver lifts `liftM` before their normal braking point and stays off
 * BOTH pedals until the car actually needs to brake. There is no getting back
 * on the throttle in between -- an earlier version modelled a cruise phase at
 * the reduced speed, which is not the technique and badly understated the
 * advantage of heavy braking zones.
 *
 * Because the car arrives slower, it needs less braking distance, so the brake
 * point moves later too. Coasting continues until the distance remaining
 * equals the braking distance for the current speed:
 *
 *     coast distance x = liftM * b / (b - a)
 *
 * which falls out of setting remaining distance equal to braking distance,
 * with the v^2 terms cancelling against the baseline braking distance.
 *
 * Both cases cover the same ground and finish at the same apex speed.
 */
function evaluateLift({ entrySpeedMs, apexSpeedMs, approachM, liftM, coast, brakeDecel, fuelRatePerS }) {
    const v0 = entrySpeedMs;
    const va = Math.min(apexSpeedMs, entrySpeedMs);
    const b = brakeDecel;

    if (liftM <= 0 || liftM > approachM) return null;

    // Coast deceleration at the mid-coast speed; over a few tens of metres the
    // error against integrating the quadratic is negligible.
    const a = coast.at(v0 * 0.96);
    if (!(b > a)) return null;              // cannot out-brake the drag

    const coastM = (liftM * b) / (b - a);
    const vBrakeSq = v0 * v0 - 2 * a * coastM;
    // Coasting below the corner speed is not lift and coast, it is driving slowly.
    if (vBrakeSq <= va * va) return null;
    const vBrake = Math.sqrt(vBrakeSq);

    const tCoast = (v0 - vBrake) / a;
    const tLift = tCoast + (vBrake - va) / b;
    const tBase = liftM / v0 + (v0 - va) / b;
    const timeLostS = tLift - tBase;
    if (!(timeLostS > 0)) return null;

    // Off throttle throughout the coast; the baseline was on throttle for it.
    const energySaved = tCoast * fuelRatePerS;

    return {
        liftM,
        coastM,
        entryAtBrakeMs: vBrake,
        coastTimeS: tCoast,
        timeLostS,
        energySaved,
        // Energy per second surrendered -- the number that ranks the corners.
        efficiency: energySaved / timeLostS,
    };
}

/**
 * The most lift a zone can absorb before the car falls below apex speed.
 *
 * This, not the efficiency ratio, is why heavy braking zones dominate. Energy
 * per second surrendered is only modestly better in a heavy zone (the coast
 * deceleration is small next to the braking deceleration either way), but a
 * zone shedding 260 km/h can swallow hundreds of metres of lift, while one
 * shedding 30 km/h saturates almost immediately. Capacity is the differentiator.
 */
function maxUsableLiftM({ entrySpeedMs, apexSpeedMs, approachM }, coast, brakeDecel) {
    const v0 = entrySpeedMs;
    const va = Math.min(apexSpeedMs, entrySpeedMs);
    const a = coast.at(v0 * 0.96);
    if (!(brakeDecel > a) || v0 <= va) return 0;
    const coastM = (v0 * v0 - va * va) / (2 * a);
    const liftM = (coastM * (brakeDecel - a)) / brakeDecel;
    return Math.max(0, Math.min(approachM, liftM));
}

/** Best lift distance per zone for a given appetite for time loss. */
function zoneOptions(zone, ctx, { steps = 12 } = {}) {
    const o = { ...DEFAULTS, ...ctx };
    const maxLift = Math.min(o.maxLiftM, zone.approachM,
        maxUsableLiftM(zone, ctx.coast, o.brakeDecel));
    const out = [];
    for (let i = 1; i <= steps; i++) {
        const liftM = (maxLift * i) / steps;
        if (liftM < o.minLiftM) continue;
        const r = evaluateLift({
            entrySpeedMs: zone.entrySpeedMs, apexSpeedMs: zone.apexSpeedMs,
            approachM: zone.approachM, liftM,
            coast: ctx.coast, brakeDecel: o.brakeDecel, fuelRatePerS: ctx.fuelRatePerS,
        });
        if (r) out.push({ ...r, seg_num: zone.seg_num });
    }
    return out;
}

/**
 * Hit an energy target for the least time.
 *
 * Greedy on MARGINAL efficiency, not absolute. That distinction is the whole
 * algorithm: within a zone the returns diminish, so the smallest lift always
 * has the best absolute ratio. A greedy that compares absolute ratios
 * therefore takes the minimum lift in every zone, spreads crumbs across the
 * lap and never reaches the target -- which is exactly what the first version
 * did.
 *
 * Instead each zone is a ladder of lift distances, and every round takes the
 * step whose EXTRA energy per EXTRA second is best. On concave frontiers that
 * equalises marginal return across zones, which is the optimal allocation, and
 * it matches how an engineer actually works: lean on the best corner until it
 * stops paying, then move to the next.
 */
function planLiftAndCoast({ zones, coast, fuelRatePerS, targetSaving, maxTimeLossS = Infinity, opts = {} }) {
    const ctx = { coast, fuelRatePerS, ...opts };

    const ladders = [];
    for (const z of zones) {
        const options = zoneOptions(z, ctx).sort((a, b) => a.liftM - b.liftM);
        if (options.length) ladders.push({ zone: z, options, level: -1 });
    }

    let saved = 0, lost = 0;

    for (let guard = 0; guard < 500; guard++) {
        if (saved >= targetSaving || lost >= maxTimeLossS) break;

        let best = null;
        for (const l of ladders) {
            const next = l.options[l.level + 1];
            if (!next) continue;
            const cur = l.level >= 0 ? l.options[l.level] : { energySaved: 0, timeLostS: 0 };
            const dE = next.energySaved - cur.energySaved;
            const dT = next.timeLostS - cur.timeLostS;
            if (!(dE > 0) || !(dT > 0)) continue;
            if (lost + dT > maxTimeLossS) continue;
            const marginal = dE / dT;
            if (!best || marginal > best.marginal) best = { ladder: l, dE, dT, marginal };
        }
        if (!best) break;

        best.ladder.level++;
        saved += best.dE;
        lost += best.dT;
    }

    const lifts = ladders
        .filter((l) => l.level >= 0)
        .map((l) => ({ ...l.options[l.level], seg_num: l.zone.seg_num, zone: l.zone }))
        .sort((a, b) => a.seg_num - b.seg_num);

    return {
        achieved: saved,
        targetSaving,
        timeLostS: lost,
        met: saved >= targetSaving,
        lifts,
        coastMeasured: coast.measured,
    };
}

module.exports = { DEFAULTS, fitCoastModel, evaluateLift, maxUsableLiftM, zoneOptions, planLiftAndCoast };
