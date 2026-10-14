'use strict';

// The rule set.
//
// Deliberately a rule-based expert system, not a model. On day one there is no
// training data, and an advisor that cannot say WHY it said something cannot
// be scored or corrected. Every finding carries the numbers that produced it
// in `evidence`, which is what makes the feedback loop able to rank rules
// later -- and what a language layer would narrate from. Nothing here invents
// a measurement.
//
// A rule fires only when it is actionable. "Your apex speed is 0.3 km/h low in
// a corner where you lose 8ms" is noise, so most rules gate on real time lost.

const THRESHOLDS = {
    // driving
    minTimeLostS: 0.05,        // ignore anything under 50ms
    brakePointM: 8,            // metres of brake-point difference worth naming
    apexSpeedMs: 1.0,          // ~3.6 km/h
    throttlePointM: 10,
    brakePointSdM: 12,         // consistency: spread of brake points

    // technique
    coastM: 25,                // metres coasting within one corner
    coastLapM: 150,            // metres coasting across the lap
    brakeReleaseM: 30,         // brakes fully off this far before the apex
    plateauFraction: 0.25,     // share of the corner spent at minimum speed
    throttleDrops: 2,          // times the driver backs off after the apex
    steerReversals: 8,
    overlapM: 10,              // both pedals applied
    brakeBuildM: 25,           // first touch to peak brake pressure
    balanceDeltaC: 8,          // front vs rear mean tyre temperature

    // tyres -- heuristics, and they need per-car calibration
    pressureSpreadC: 5,        // middle vs shoulder average
    camberSpreadC: 15,         // inner vs outer

    // severity ladder, by time lost in the segment
    strongS: 0.25,
    suggestS: 0.10,
};

const msToKmh = (v) => v * 3.6;
const round = (v, dp = 2) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

function severityFor(lostS, T = THRESHOLDS) {
    if (lostS >= T.strongS) return 'strong';
    if (lostS >= T.suggestS) return 'suggest';
    return 'info';
}

/** Pair up my corner metrics with the reference's, keyed by segment. */
function pairCorners(ctx) {
    const refBySeg = new Map(ctx.ref.map((c) => [c.seg_num, c]));
    const lostBySeg = new Map(ctx.deltas.map((d) => [d.seg_num, d.lost_s]));
    return ctx.mine
        .filter((m) => refBySeg.has(m.seg_num))
        .map((m) => ({ seg: m.seg_num, mine: m, ref: refBySeg.get(m.seg_num), lostS: lostBySeg.get(m.seg_num) ?? 0 }));
}

const RULES = [
    {
        id: 'braking.early',
        evaluate(ctx, T) {
            const out = [];
            for (const p of pairCorners(ctx)) {
                if (p.lostS < T.minTimeLostS) continue;
                if (p.mine.brake_point_m == null || p.ref.brake_point_m == null) continue;
                const earlierM = p.ref.brake_point_m - p.mine.brake_point_m;
                if (earlierM < T.brakePointM) continue;
                out.push({
                    seg_num: p.seg,
                    severity: severityFor(p.lostS, T),
                    title: `Braking ${Math.round(earlierM)}m early`,
                    detail: `You brake at ${Math.round(p.mine.brake_point_m)}m, the reference at ` +
                        `${Math.round(p.ref.brake_point_m)}m. Worth ${p.lostS.toFixed(3)}s through this corner.`,
                    evidence: {
                        my_brake_point_m: round(p.mine.brake_point_m),
                        ref_brake_point_m: round(p.ref.brake_point_m),
                        earlier_m: round(earlierM),
                        time_lost_s: round(p.lostS, 3),
                    },
                });
            }
            return out;
        },
    },

    {
        id: 'apex.slow',
        evaluate(ctx, T) {
            const out = [];
            for (const p of pairCorners(ctx)) {
                if (p.lostS < T.minTimeLostS) continue;
                const diff = p.ref.min_speed_ms - p.mine.min_speed_ms;
                if (diff < T.apexSpeedMs) continue;
                out.push({
                    seg_num: p.seg,
                    severity: severityFor(p.lostS, T),
                    title: `${msToKmh(diff).toFixed(1)} km/h less apex speed`,
                    detail: `Minimum ${msToKmh(p.mine.min_speed_ms).toFixed(1)} km/h against the ` +
                        `reference's ${msToKmh(p.ref.min_speed_ms).toFixed(1)} km/h.`,
                    evidence: {
                        my_apex_kmh: round(msToKmh(p.mine.min_speed_ms)),
                        ref_apex_kmh: round(msToKmh(p.ref.min_speed_ms)),
                        deficit_kmh: round(msToKmh(diff)),
                        time_lost_s: round(p.lostS, 3),
                    },
                });
            }
            return out;
        },
    },

    {
        id: 'throttle.late',
        evaluate(ctx, T) {
            const out = [];
            for (const p of pairCorners(ctx)) {
                if (p.lostS < T.minTimeLostS) continue;
                if (p.mine.throttle_point_m == null || p.ref.throttle_point_m == null) continue;
                const laterM = p.mine.throttle_point_m - p.ref.throttle_point_m;
                if (laterM < T.throttlePointM) continue;
                out.push({
                    seg_num: p.seg,
                    severity: severityFor(p.lostS, T),
                    title: `Throttle ${Math.round(laterM)}m late`,
                    detail: `Power comes back at ${Math.round(p.mine.throttle_point_m)}m versus ` +
                        `${Math.round(p.ref.throttle_point_m)}m. Exit speed carries down the next straight.`,
                    evidence: {
                        my_throttle_point_m: round(p.mine.throttle_point_m),
                        ref_throttle_point_m: round(p.ref.throttle_point_m),
                        later_m: round(laterM),
                        time_lost_s: round(p.lostS, 3),
                    },
                });
            }
            return out;
        },
    },

    {
        // The classic: later on the brakes than the reference, yet slower at
        // the apex. Entry speed is being bought back with interest on exit.
        id: 'entry.overdriving',
        evaluate(ctx, T) {
            const out = [];
            for (const p of pairCorners(ctx)) {
                if (p.lostS < T.suggestS) continue;
                if (p.mine.brake_point_m == null || p.ref.brake_point_m == null) continue;
                const laterBrakeM = p.mine.brake_point_m - p.ref.brake_point_m;
                const apexDeficit = p.ref.min_speed_ms - p.mine.min_speed_ms;
                if (laterBrakeM < T.brakePointM || apexDeficit < T.apexSpeedMs) continue;
                out.push({
                    seg_num: p.seg,
                    severity: 'strong',
                    title: `Overdriving the entry`,
                    detail: `Braking ${Math.round(laterBrakeM)}m later than the reference but still ` +
                        `${msToKmh(apexDeficit).toFixed(1)} km/h slower at the apex — the entry speed is ` +
                        `costing more than it gains. Brake earlier and release sooner.`,
                    evidence: {
                        later_brake_m: round(laterBrakeM),
                        apex_deficit_kmh: round(msToKmh(apexDeficit)),
                        time_lost_s: round(p.lostS, 3),
                    },
                });
            }
            return out;
        },
    },

    {
        id: 'braking.inconsistent',
        evaluate(ctx, T) {
            if (!ctx.consistency) return [];
            const out = [];
            for (const c of ctx.consistency.corners) {
                if (c.brake_point_sd == null || c.brake_point_sd < T.brakePointSdM) continue;
                if (c.laps < 3) continue;
                out.push({
                    seg_num: c.seg_num,
                    severity: 'suggest',
                    title: `Brake point varies by ${Math.round(c.brake_point_sd)}m`,
                    detail: `Across ${c.laps} laps the braking point moves ±${Math.round(c.brake_point_sd)}m. ` +
                        `In an endurance stint, repeatability here is worth more than the last tenth.`,
                    evidence: {
                        brake_point_sd_m: round(c.brake_point_sd),
                        brake_point_mean_m: round(c.brake_point_mean),
                        laps: c.laps,
                    },
                });
            }
            return out;
        },
    },

    {
        // Middle of the tread hotter than both shoulders means the tyre is
        // crowning -- classic over-inflation. Colder middle means the opposite.
        id: 'tyre.pressure',
        evaluate(ctx, T) {
            if (!ctx.tyres) return [];
            const out = [];
            for (const w of ctx.tyres) {
                if (w.inner_c == null || w.mid_c == null || w.outer_c == null) continue;
                const shoulders = (w.inner_c + w.outer_c) / 2;
                const crown = w.mid_c - shoulders;
                if (Math.abs(crown) < T.pressureSpreadC) continue;
                const high = crown > 0;
                out.push({
                    seg_num: null,
                    severity: 'suggest',
                    title: `${w.wheel.toUpperCase()} pressure looks ${high ? 'high' : 'low'}`,
                    detail: `Middle of the tread runs ${Math.abs(crown).toFixed(1)}°C ` +
                        `${high ? 'hotter' : 'cooler'} than the shoulders ` +
                        `(${w.mid_c.toFixed(1)} vs ${shoulders.toFixed(1)}°C). ` +
                        `Heuristic — confirm against this car's target window.`,
                    evidence: {
                        wheel: w.wheel, inner_c: round(w.inner_c), mid_c: round(w.mid_c),
                        outer_c: round(w.outer_c), crown_c: round(crown),
                        pressure_kpa: round(w.pressure_kpa),
                    },
                });
            }
            return out;
        },
    },

    {
        id: 'tyre.camber',
        evaluate(ctx, T) {
            if (!ctx.tyres) return [];
            const out = [];
            for (const w of ctx.tyres) {
                if (w.inner_c == null || w.outer_c == null) continue;
                const spread = w.inner_c - w.outer_c;
                if (Math.abs(spread) < T.camberSpreadC) continue;
                const tooMuch = spread > 0;
                out.push({
                    seg_num: null,
                    severity: 'info',
                    title: `${w.wheel.toUpperCase()} camber spread ${spread.toFixed(1)}°C`,
                    detail: tooMuch
                        ? `Inner shoulder ${spread.toFixed(1)}°C hotter than outer — more negative camber ` +
                          `than the tyre is using. Consider reducing it.`
                        : `Outer shoulder ${(-spread).toFixed(1)}°C hotter than inner — the tyre is rolling ` +
                          `onto its outer edge. Consider more negative camber.`,
                    evidence: {
                        wheel: w.wheel, inner_c: round(w.inner_c), outer_c: round(w.outer_c),
                        spread_c: round(spread),
                    },
                });
            }
            return out;
        },
    },
];


// ---------------------------------------------------------------------------
// Technique rules.
//
// These encode what a race engineer looks for on a trace, rather than simple
// differences against a reference. Several of them fire even with no reference
// lap at all, because they are absolute faults rather than relative ones.
// ---------------------------------------------------------------------------

const byTech = (ctx) => new Map((ctx.technique ?? []).map((t) => [t.seg_num, t]));
const lostFor = (ctx, seg) =>
    (ctx.deltas ?? []).find((d) => d.seg_num === seg)?.lost_s ?? 0;

RULES.push(
    {
        // The highest-value single number in telemetry coaching. Neither pedal
        // applied means the car is doing nothing useful -- not slowing, not
        // accelerating. It is almost always recoverable time.
        id: 'technique.coasting',
        evaluate(ctx, T) {
            const out = [];
            for (const t of ctx.technique ?? []) {
                if (t.coast_m < T.coastM) continue;
                out.push({
                    seg_num: t.seg_num,
                    severity: t.coast_m > T.coastM * 2 ? 'strong' : 'suggest',
                    title: `${Math.round(t.coast_m)}m coasting`,
                    detail: `${Math.round(t.coast_m)}m of this corner has neither throttle nor brake ` +
                        `(${Math.round((t.coast_m / t.length_m) * 100)}% of it). The car is neither slowing ` +
                        `nor driving — brake later and harder, or get to throttle sooner. Coasting is the ` +
                        `cheapest time on the lap to recover.`,
                    evidence: {
                        coast_m: t.coast_m, corner_length_m: t.length_m,
                        coast_fraction: round(t.coast_m / t.length_m, 3),
                        time_lost_s: round(lostFor(ctx, t.seg_num), 3),
                    },
                });
            }
            return out;
        },
    },

    {
        // Brakes fully released before turn-in unloads the front axle exactly
        // when you need it planted. The car then pushes at entry and the
        // driver usually blames the setup.
        id: 'technique.no-trail-braking',
        evaluate(ctx, T) {
            const out = [];
            for (const t of ctx.technique ?? []) {
                if (t.brake_release_m == null || t.brake_release_m < T.brakeReleaseM) continue;
                out.push({
                    seg_num: t.seg_num,
                    severity: 'suggest',
                    title: `Brakes released ${Math.round(t.brake_release_m)}m before the apex`,
                    detail: `Braking stops well before turn-in, so there is no longitudinal load left on ` +
                        `the front axle to help the car rotate. Carry a trailing 10–20% brake pressure in ` +
                        `to the apex and release it progressively — the car will turn without needing more ` +
                        `steering lock, and entry understeer usually disappears.`,
                    evidence: {
                        brake_release_before_apex_m: round(t.brake_release_m),
                        apex_m: round(t.apex_m),
                        time_lost_s: round(lostFor(ctx, t.seg_num), 3),
                    },
                });
            }
            return out;
        },
    },

    {
        // A good corner is a V. A U means speed was scrubbed off too early and
        // the car sat at minimum speed waiting -- almost always over-braking.
        id: 'technique.minimum-speed-plateau',
        evaluate(ctx, T) {
            const out = [];
            for (const t of ctx.technique ?? []) {
                const frac = t.plateau_m / t.length_m;
                if (frac < T.plateauFraction) continue;
                out.push({
                    seg_num: t.seg_num,
                    severity: 'suggest',
                    title: `Sitting at minimum speed for ${Math.round(t.plateau_m)}m`,
                    detail: `${Math.round(frac * 100)}% of the corner is spent within 2% of minimum speed. ` +
                        `A quick corner is a V, not a U — this shape means the speed came off too early and ` +
                        `the car waited. Brake later into a higher minimum, or release the brake sooner so ` +
                        `the car is already accelerating through the apex.`,
                    evidence: {
                        plateau_m: t.plateau_m, corner_length_m: t.length_m,
                        plateau_fraction: round(frac, 3),
                    },
                });
            }
            return out;
        },
    },

    {
        // Soft initial brake application wastes the start of the braking zone,
        // which is where downforce and therefore braking capacity are highest.
        id: 'technique.soft-initial-brake',
        evaluate(ctx, T) {
            const out = [];
            for (const t of ctx.technique ?? []) {
                if (t.brake_build_m == null || t.brake_build_m < T.brakeBuildM) continue;
                out.push({
                    seg_num: t.seg_num,
                    severity: 'info',
                    title: `${Math.round(t.brake_build_m)}m to reach peak brake`,
                    detail: `Pressure builds slowly after the first touch. Braking capacity is highest at ` +
                        `the START of the zone, where speed and therefore downforce are greatest — hit peak ` +
                        `pressure almost immediately and bleed off as speed falls. A slow build wastes the ` +
                        `most effective metres you have.`,
                    evidence: {
                        brake_build_m: round(t.brake_build_m),
                        peak_brake: round(t.peak_brake, 3),
                    },
                });
            }
            return out;
        },
    },

    {
        // Backing off after committing to throttle: either the rear is letting
        // go, or the driver got on power before the car was pointed.
        id: 'technique.throttle-modulation',
        evaluate(ctx, T) {
            const out = [];
            for (const t of ctx.technique ?? []) {
                if (t.throttle_drops < T.throttleDrops) continue;
                out.push({
                    seg_num: t.seg_num,
                    severity: 'suggest',
                    title: `Backing off ${t.throttle_drops}x on exit`,
                    detail: `The throttle is lifted ${t.throttle_drops} times after the apex. Either the rear ` +
                        `is letting go — in which case take traction out of the setup or wait for the car to ` +
                        `be straighter — or power is arriving before the car is pointed. A single progressive ` +
                        `squeeze beats several stabs, and it is kinder to the rear tyres over a stint.`,
                    evidence: { throttle_drops: t.throttle_drops, apex_m: round(t.apex_m) },
                });
            }
            return out;
        },
    },

    {
        // Busy hands cost time and, over an endurance stint, tyres.
        id: 'technique.steering-reversals',
        evaluate(ctx, T) {
            const out = [];
            for (const t of ctx.technique ?? []) {
                if (t.steer_reversals < T.steerReversals) continue;
                out.push({
                    seg_num: t.seg_num,
                    severity: 'info',
                    title: `${t.steer_reversals} steering corrections`,
                    detail: `A lot of steering direction changes through this corner — the car is being ` +
                        `fought rather than placed. Each correction scrubs the front tyres, which over a ` +
                        `full stint costs more than the lap time does. One smooth arc, set early.`,
                    evidence: { steer_reversals: t.steer_reversals },
                });
            }
            return out;
        },
    },

    {
        id: 'technique.pedal-overlap',
        evaluate(ctx, T) {
            const out = [];
            for (const t of ctx.technique ?? []) {
                if (t.overlap_m < T.overlapM) continue;
                out.push({
                    seg_num: t.seg_num,
                    severity: 'info',
                    title: `${Math.round(t.overlap_m)}m with both pedals applied`,
                    detail: `Throttle and brake are both meaningfully applied. Unless this is deliberate ` +
                        `left-foot stabilisation, it burns fuel and brakes to fight itself — and in a car ` +
                        `running to an energy allowance, wasted fuel is wasted stint length.`,
                    evidence: { overlap_m: t.overlap_m },
                });
            }
            return out;
        },
    },

    {
        // The engineer's staple balance read. One wheel's temperature tells
        // you about that corner of the car; the axle delta tells you how the
        // car is actually behaving.
        id: 'balance.axle-temperature',
        evaluate(ctx, T) {
            if (!ctx.balance) return [];
            const d = ctx.balance.frontRearDelta;
            if (Math.abs(d) < T.balanceDeltaC) return [];
            const understeer = d > 0;
            return [{
                seg_num: null,
                severity: 'suggest',
                title: understeer ? 'Front axle overworked — understeer' : 'Rear axle overworked — oversteer',
                detail: understeer
                    ? `Fronts average ${d.toFixed(1)}°C hotter than rears (${ctx.balance.frontMean.toFixed(1)} ` +
                      `vs ${ctx.balance.rearMean.toFixed(1)}°C). The front tyres are doing the sliding, which ` +
                      `is understeer showing up as heat. Soften the front anti-roll bar, reduce front wing ` +
                      `rake or add rear wing, or take mechanical grip out of the rear.`
                    : `Rears average ${(-d).toFixed(1)}°C hotter than fronts (${ctx.balance.rearMean.toFixed(1)} ` +
                      `vs ${ctx.balance.frontMean.toFixed(1)}°C). The rear is working hardest and will give up ` +
                      `first in a stint. Soften the rear bar, add rear wing, or ease the differential on power.`,
                evidence: {
                    front_mean_c: round(ctx.balance.frontMean),
                    rear_mean_c: round(ctx.balance.rearMean),
                    front_rear_delta_c: round(d),
                },
            }];
        },
    },

    {
        // Endurance-specific, and the LMU meta. The place to save energy is
        // immediately before a braking zone, where lifting costs almost
        // nothing because you were about to shed the speed anyway.
        id: 'energy.lift-and-coast',
        evaluate(ctx, T) {
            if (!ctx.liftCandidates || ctx.liftCandidates.length === 0) return [];
            const best = ctx.liftCandidates.slice(0, 3);
            return [{
                seg_num: best[0].seg_num,
                severity: 'info',
                title: `Lift-and-coast candidates: ${best.length} heavy braking zones`,
                detail: `The cheapest energy on the lap is immediately before a heavy braking zone — ` +
                    `lifting 30–50m early costs a fraction of what it saves, because that speed was about ` +
                    `to be thrown away under braking regardless. Best zones here: ` +
                    best.map((b) => `seg ${b.seg_num} (entry ${msToKmh(b.entry_speed_ms).toFixed(0)} km/h, ` +
                        `${Math.round(b.speed_drop_ms * 3.6)} km/h shed)`).join(', ') + `.`,
                evidence: {
                    candidates: best.map((b) => ({
                        seg_num: b.seg_num,
                        entry_kmh: round(msToKmh(b.entry_speed_ms)),
                        drop_kmh: round(msToKmh(b.speed_drop_ms)),
                    })),
                },
            }];
        },
    },
);

module.exports = { RULES, THRESHOLDS, severityFor, pairCorners };
