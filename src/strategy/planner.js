'use strict';

// Endurance race planner.
//
// In a TIMED race the inputs are circular: how many laps you complete depends
// on how much time you spend in the pits, which depends on how many stops you
// make, which depends on how many laps you complete. So it is solved by
// iterating to a fixed point rather than in closed form -- and because refuel
// time scales with the load taken on, the pit-time term moves between
// iterations instead of being a constant.

const F = require('./fuel');

const MAX_ITERATIONS = 25;

/**
 * @param {object} o
 * @param {number} [o.durationS]      timed race length (use this OR totalLaps)
 * @param {number} [o.totalLaps]      lap-limited race
 * @param {number} o.lapTimeS         representative green-flag lap
 * @param {string} o.carClass         'Hyper' | 'GT3' | 'LMP2' | ...
 * @param {number} o.consumptionPerLap  %VE or litres per lap
 * @param {number} [o.capacity]       defaults to 100 for VE classes; required for fuel
 * @param {number} [o.reserve]        held back, never planned into a stint
 * @param {number} o.pitLaneDeltaS    time lost traversing pit lane vs staying out
 * @param {number} o.refuelRate       %VE/s or L/s
 * @param {number} [o.tyreChangeS]
 * @param {boolean} [o.tyreChangeOverlapsRefuel]
 * @param {number} [o.tyreStintLaps]  max laps on one set; may bind before energy does
 * @param {Array}  [o.drivers]        [{ name, maxStintS?, maxTotalS? }]
 */
function planRace(o) {
    const limiter = F.limiterFor(o.carClass);
    const unit = F.UNIT[limiter];
    const capacity = o.capacity ?? F.defaultCapacity(o.carClass);
    if (capacity == null) {
        throw new Error(`capacity is required for ${limiter}-limited class ${o.carClass}`);
    }

    const reserve = o.reserve ?? 0;
    const warnings = [];

    const energyLaps = F.lapsPerStint({ capacity, perLap: o.consumptionPerLap, reserve });
    const tyreLaps = o.tyreStintLaps ?? Infinity;
    const maxLapsPerStint = Math.min(energyLaps, tyreLaps);
    if (maxLapsPerStint < 1) throw new Error('a stint of less than one lap is not plannable');

    const boundBy = tyreLaps < energyLaps ? 'tyres' : 'energy';
    if (boundBy === 'tyres') {
        warnings.push(
            `Tyres bind before ${unit} does (${tyreLaps} laps vs ${energyLaps}). ` +
            `Stints are tyre-limited; longer tyre life would cut stops.`
        );
    }

    const timed = o.durationS != null;
    if (!timed && o.totalLaps == null) {
        throw new Error('give either durationS (timed race) or totalLaps');
    }

    // --- fixed-point iteration -------------------------------------------
    let totalLaps = timed ? Math.ceil(o.durationS / o.lapTimeS) : o.totalLaps;
    let plan = null;
    let converged = false;
    let iterations = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        iterations = i + 1;
        plan = buildStints({ ...o, totalLaps, maxLapsPerStint, capacity, reserve, limiter, unit });

        if (!timed) { converged = true; break; }

        // Re-derive lap count from the time actually left after pitting.
        // ceil: you complete the lap you are on when the clock expires.
        const available = o.durationS - plan.totalPitTimeS;
        const nextLaps = Math.max(1, Math.ceil(available / o.lapTimeS));
        if (nextLaps === totalLaps) { converged = true; break; }
        totalLaps = nextLaps;
    }

    if (!converged) {
        warnings.push(
            `Lap count did not settle in ${MAX_ITERATIONS} iterations -- it is oscillating ` +
            `between adjacent values. Treat the plan as approximate.`
        );
    }

    assignDrivers(plan.stints, o.drivers, o.lapTimeS, warnings);

    const onTrackS = totalLaps * o.lapTimeS;
    return {
        limiter,
        unit,
        boundBy,
        capacity,
        reserve,
        maxLapsPerStint,
        energyLapsPerStint: energyLaps,
        totalLaps,
        stops: plan.stints.length - 1,
        stints: plan.stints,
        onTrackS,
        totalPitTimeS: plan.totalPitTimeS,
        totalRaceTimeS: onTrackS + plan.totalPitTimeS,
        converged,
        iterations,
        warnings,
    };
}

function buildStints({
    totalLaps, maxLapsPerStint, capacity, reserve, limiter, unit,
    consumptionPerLap, lapTimeS, pitLaneDeltaS, refuelRate,
    tyreChangeS = 0, tyreChangeOverlapsRefuel = true, tyreStintLaps,
}) {
    const stintCount = Math.max(1, Math.ceil(totalLaps / maxLapsPerStint));
    const lapsPer = F.splitStints(totalLaps, stintCount);

    const stints = [];
    let lap = 1;
    let totalPitTimeS = 0;

    for (let i = 0; i < lapsPer.length; i++) {
        const laps = lapsPer[i];
        const used = laps * consumptionPerLap;
        const load = Math.min(capacity, used + reserve);

        const stint = {
            index: i + 1,
            fromLap: lap,
            toLap: lap + laps - 1,
            laps,
            load: round(load, 2),
            used: round(used, 2),
            loadUnit: unit,
            onTrackS: round(laps * lapTimeS, 3),
            driver: null,
            pitAfter: null,
        };

        // A stop happens after every stint but the last. The amount taken on
        // is what the NEXT stint burns -- that is what sets refuel time.
        if (i < lapsPer.length - 1) {
            const nextUsed = lapsPer[i + 1] * consumptionPerLap;
            const added = Math.min(capacity - reserve, nextUsed);
            const changingTyres = tyreStintLaps != null;
            const stop = F.pitStopTime({
                load: added,
                refuelRate,
                pitLaneDeltaS,
                tyreChangeS,
                changingTyres,
                tyreChangeOverlapsRefuel,
            });
            stint.pitAfter = {
                afterLap: stint.toLap,
                added: round(added, 2),
                addedUnit: unit,
                refuelS: round(stop.refuelS, 2),
                tyreS: round(stop.tyreS, 2),
                stationaryS: round(stop.stationaryS, 2),
                totalS: round(stop.totalS, 2),
            };
            totalPitTimeS += stop.totalS;
        }

        stints.push(stint);
        lap += laps;
    }

    return { stints, totalPitTimeS: round(totalPitTimeS, 3) };
}

/** Round-robin, honouring each driver's continuous and total limits. */
function assignDrivers(stints, drivers, lapTimeS, warnings) {
    if (!drivers || drivers.length === 0) return;

    const totals = new Map(drivers.map((d) => [d.name, 0]));
    let cursor = 0;

    for (const s of stints) {
        const stintS = s.laps * lapTimeS;

        // Prefer the next driver in rotation who can legally take this stint.
        let chosen = null;
        for (let probe = 0; probe < drivers.length; probe++) {
            const d = drivers[(cursor + probe) % drivers.length];
            const withinStint = d.maxStintS == null || stintS <= d.maxStintS;
            const withinTotal = d.maxTotalS == null || totals.get(d.name) + stintS <= d.maxTotalS;
            if (withinStint && withinTotal) { chosen = d; cursor = (cursor + probe + 1) % drivers.length; break; }
        }

        if (!chosen) {
            chosen = drivers[cursor % drivers.length];
            cursor = (cursor + 1) % drivers.length;
            warnings.push(
                `Stint ${s.index} (${fmt(stintS)}) breaches every driver's limits; ` +
                `assigned ${chosen.name} anyway.`
            );
        }

        s.driver = chosen.name;
        totals.set(chosen.name, totals.get(chosen.name) + stintS);
    }

    for (const d of drivers) {
        if (d.maxTotalS != null && totals.get(d.name) > d.maxTotalS) {
            warnings.push(`${d.name} is over the total drive-time limit ` +
                `(${fmt(totals.get(d.name))} of ${fmt(d.maxTotalS)}).`);
        }
    }
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

function fmt(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec).padStart(2, '0')}s`;
}

module.exports = { planRace, fmt };
