'use strict';

// Weather forecast and strategy adaptation.
//
// A forecast tells you about RAIN. What decides a race is WETNESS, and the two
// are not the same thing: a circuit does not soak the instant it rains, and it
// stays wet long after the rain stops. Reading the forecast directly therefore
// gets the crossover wrong in both directions -- too early going in, far too
// early coming out.
//
// So the forecast is run through the same first-order lag the track itself
// obeys, and the crossovers are read off the projected WETNESS curve.
//
// LMU exposes forecast data on /rest/sessions/weather and on the
// RepairAndRefuel garage screen. The shape below is deliberately generic --
// time offset plus rain, cloud and temperature -- so mapping the real payload
// onto it is a adapter, not a rewrite.

const DEFAULTS = {
    // A circuit soaks in about a minute and takes the best part of twenty to
    // dry. These are the single most load-bearing constants in the module and
    // they are ESTIMATES -- they should be calibrated against recorded sessions
    // per circuit, since surface, drainage and air temperature all move them.
    wetTauS: 70,
    dryTauS: 600,
    stepS: 30,
    wetThreshold: 0.30,     // past this, wets beat slicks
    dryThreshold: 0.12,     // below this, the track is effectively dry
    // A stop within this of a crossover can absorb the tyre change for free.
    alignWindowS: 420,
};

/**
 * Project track wetness forward from a rain forecast.
 *
 * The lag is applied in SECONDS with an exponential, so the result does not
 * depend on how finely the forecast is sampled. Doing it per step would make a
 * 30-second forecast and a 5-second one disagree.
 */
function projectWetness({ forecast, currentWetness = 0, nowS = 0, ...opts } = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (!forecast || forecast.length === 0) return [];

    const points = [...forecast].sort((a, b) => a.atS - b.atS);
    const endS = points[points.length - 1].atS;

    // Rain at an arbitrary time, linearly interpolated between forecast points.
    const rainAt = (t) => {
        if (t <= points[0].atS) return points[0].raining ?? 0;
        if (t >= endS) return points[points.length - 1].raining ?? 0;
        for (let i = 1; i < points.length; i++) {
            if (points[i].atS >= t) {
                const a = points[i - 1], b = points[i];
                const f = (t - a.atS) / (b.atS - a.atS || 1);
                return (a.raining ?? 0) + ((b.raining ?? 0) - (a.raining ?? 0)) * f;
            }
        }
        return 0;
    };
    const fieldAt = (t, key) => {
        const near = points.reduce((best, p) =>
            Math.abs(p.atS - t) < Math.abs(best.atS - t) ? p : best, points[0]);
        return near[key] ?? null;
    };

    const out = [];
    let wetness = currentWetness;
    for (let t = nowS; t <= endS; t += o.stepS) {
        const rain = rainAt(t);
        const tau = rain > wetness ? o.wetTauS : o.dryTauS;
        wetness += (rain - wetness) * (1 - Math.exp(-o.stepS / tau));
        out.push({
            atS: t,
            raining: rain,
            wetness: Math.min(1, Math.max(0, wetness)),
            airTempC: fieldAt(t, 'airTempC'),
            trackTempC: fieldAt(t, 'trackTempC'),
        });
    }
    return out;
}

/** Where the projected wetness crosses into or out of wet-tyre territory. */
function crossoverEvents(timeline, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const events = [];
    let state = timeline.length && timeline[0].wetness >= o.wetThreshold ? 'wet' : 'dry';

    for (const p of timeline) {
        if (state === 'dry' && p.wetness >= o.wetThreshold) {
            events.push({ atS: p.atS, type: 'to-wet', wetness: p.wetness, raining: p.raining });
            state = 'wet';
        } else if (state === 'wet' && p.wetness <= o.dryThreshold) {
            events.push({ atS: p.atS, type: 'to-dry', wetness: p.wetness, raining: p.raining });
            state = 'dry';
        }
    }
    return events;
}

/**
 * Line the planned stops up against the weather.
 *
 * The point: a tyre change at a stop you were making anyway is FREE, while one
 * at a stop you would not otherwise have made costs the whole pit loss. So the
 * question is never "when does it rain" but "does a stop already fall near
 * enough to the crossover, and if not, can one be moved there".
 *
 * Moving a stop EARLIER is nearly always possible -- you simply run a shorter
 * stint. Moving it LATER is bounded by fuel, so it is only offered when the
 * stint can actually reach.
 */
function adaptStrategy({
    plan, timeline, currentLap = 1, lapTimeS, nowS = 0,
    pitLossS = 60, tyreChangeS = 26, maxLapsPerStint = null, ...opts
} = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (!plan?.stints?.length || !(lapTimeS > 0)) return { events: [], actions: [], timeline: timeline ?? [] };

    const events = crossoverEvents(timeline ?? [], o);
    const maxStint = maxLapsPerStint ?? plan.maxLapsPerStint ?? Infinity;

    // Planned stops still ahead of us, in race time.
    const stops = plan.stints
        .filter((s) => s.pitAfter && s.pitAfter.afterLap >= currentLap)
        .map((s) => ({
            stint: s.index,
            atLap: s.pitAfter.afterLap,
            atRaceS: nowS + (s.pitAfter.afterLap - currentLap + 1) * lapTimeS,
            stintStartLap: s.fromLap,
        }));

    // Where the stint AFTER each stop currently ends. Moving a stop earlier
    // lengthens that stint, and past the limit it stops being free.
    const lastLap = plan.stints[plan.stints.length - 1].toLap;
    const nextEnd = new Map();
    for (let i = 0; i < stops.length; i++) {
        nextEnd.set(stops[i].stint, i + 1 < stops.length ? stops[i + 1].atLap : lastLap);
    }

    const actions = [];
    // A stop can serve one crossover and one only. Without this the nearest
    // stop gets recommended for every event in turn, producing a plan that
    // pits the same lap three times.
    const usedStops = new Set();

    for (const ev of events) {
        const lapAt = currentLap + Math.max(0, Math.round((ev.atS - nowS) / lapTimeS));
        const nearest = stops
            .filter((s) => !usedStops.has(s.stint))
            .map((s) => ({ ...s, gapS: s.atRaceS - ev.atS }))
            .sort((a, b) => Math.abs(a.gapS) - Math.abs(b.gapS))[0];

        const wantWets = ev.type === 'to-wet';
        const base = {
            event: ev.type, atS: ev.atS, atLap: lapAt,
            wetness: ev.wetness, compound: wantWets ? 'wet' : 'slick',
        };

        if (!nearest) {
            actions.push({ ...base, action: 'extra-stop', costS: pitLossS + tyreChangeS,
                detail: `No stop remains near ${wantWets ? 'the rain' : 'the dry'} on lap ${lapAt}. ` +
                        `An extra stop costs about ${Math.round(pitLossS + tyreChangeS)}s.` });
            continue;
        }

        usedStops.add(nearest.stint);

        if (Math.abs(nearest.gapS) <= o.alignWindowS) {
            actions.push({ ...base, action: 'aligned', stop: nearest, costS: 0,
                detail: `Stop on lap ${nearest.atLap} already falls within ` +
                        `${Math.round(Math.abs(nearest.gapS) / 60)} min of the crossover — ` +
                        `take ${wantWets ? 'wets' : 'slicks'} there and the change is free.` });
            continue;
        }

        const shiftLaps = Math.round(-nearest.gapS / lapTimeS);
        const newLap = nearest.atLap + shiftLaps;
        const stintLaps = newLap - nearest.stintStartLap + 1;

        if (shiftLaps < 0) {
            // Pulling a stop forward hands its laps to the NEXT stint. Beyond
            // the stint limit that is not a shift at all, it is an extra stop.
            const followingEnd = nextEnd.get(nearest.stint) ?? lastLap;
            const followingLaps = followingEnd - newLap;
            if (followingLaps > maxStint) {
                actions.push({ ...base, action: 'extra-stop', stop: nearest, toLap: newLap,
                    costS: pitLossS + tyreChangeS,
                    detail: `The crossover is on lap ${lapAt}, ${-shiftLaps} laps before the lap ` +
                            `${nearest.atLap} stop. Moving it there would leave ${followingLaps} laps ` +
                            `to the next stop, past the ${maxStint}-lap limit — so this needs an extra ` +
                            `stop, costing about ${Math.round(pitLossS + tyreChangeS)}s.` });
            } else {
                actions.push({ ...base, action: 'bring-forward', stop: nearest, toLap: newLap,
                    costS: 0,
                    detail: `Bring the lap ${nearest.atLap} stop forward to lap ${newLap} ` +
                            `(${-shiftLaps} laps early) and fit ${wantWets ? 'wets' : 'slicks'}. ` +
                            `The following stint becomes ${followingLaps} laps, still within the limit.` });
            }
        } else if (stintLaps <= maxStint) {
            actions.push({ ...base, action: 'extend', stop: nearest, toLap: newLap, costS: 0,
                detail: `Extend to lap ${newLap} (${shiftLaps} laps longer, within the ` +
                        `${maxStint}-lap limit) and fit ${wantWets ? 'wets' : 'slicks'} there.` });
        } else {
            actions.push({ ...base, action: 'extra-stop', stop: nearest,
                costS: pitLossS + tyreChangeS,
                detail: `The crossover on lap ${lapAt} is ${shiftLaps} laps past the lap ` +
                        `${nearest.atLap} stop, beyond the ${maxStint}-lap stint limit. ` +
                        `An extra stop is needed, costing about ${Math.round(pitLossS + tyreChangeS)}s.` });
        }
    }

    return {
        events,
        actions,
        timeline: timeline ?? [],
        freeChanges: actions.filter((a) => a.costS === 0).length,
        addedTimeS: actions.reduce((n, a) => n + a.costS, 0),
    };
}

module.exports = { DEFAULTS, projectWetness, crossoverEvents, adaptStrategy };
