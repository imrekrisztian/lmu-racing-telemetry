'use strict';

// The rule that shapes every LMU endurance strategy:
//
//   Hypercar + LMGT3  ->  limited by a VIRTUAL ENERGY allowance (0..100%)
//   LMP2 / LMP3 / GTE ->  limited by the FUEL TANK (litres)
//
// Get this branch wrong and every number downstream is wrong, so it is a
// single lookup used by the planner rather than a flag callers pass in.
//
// Virtual Energy lives only on the REST API (:6397). It is not in shared
// memory, which is why the strategy module takes measured consumption as an
// input rather than reading telemetry itself.

const ENERGY_CLASSES = new Set(['Hyper', 'Hypercar', 'GT3', 'LMGT3']);
const FUEL_CLASSES = new Set(['LMP2', 'LMP3', 'GTE', 'LMGTE']);

/** @returns {'virtual-energy'|'fuel'} */
function limiterFor(carClass) {
    if (ENERGY_CLASSES.has(carClass)) return 'virtual-energy';
    if (FUEL_CLASSES.has(carClass)) return 'fuel';
    throw new Error(
        `Unknown car class "${carClass}". Known: ${[...ENERGY_CLASSES, ...FUEL_CLASSES].join(', ')}`
    );
}

/** Default full-tank capacity in the limiter's own unit. */
function defaultCapacity(carClass) {
    return limiterFor(carClass) === 'virtual-energy' ? 100 : null;
}

const UNIT = { 'virtual-energy': '%VE', fuel: 'L' };

/**
 * Laps a full load covers, keeping `reserve` back.
 * Deliberately floor() -- a stint you cannot finish is not a stint.
 */
function lapsPerStint({ capacity, perLap, reserve = 0 }) {
    if (!(perLap > 0)) throw new Error('consumption per lap must be > 0');
    if (!(capacity > reserve)) throw new Error('capacity must exceed reserve');
    return Math.floor((capacity - reserve) / perLap);
}

/**
 * Time lost for one stop.
 *
 * Refuel time scales with the load taken on, so a stop after a short stint is
 * cheaper than one after a long stint. Most planners use a flat figure and
 * quietly overstate short-stint strategies.
 */
function pitStopTime({
    load,
    refuelRate,
    pitLaneDeltaS,
    tyreChangeS = 0,
    changingTyres = true,
    tyreChangeOverlapsRefuel = true,
}) {
    const refuelS = refuelRate > 0 ? load / refuelRate : 0;
    const tyreS = changingTyres ? tyreChangeS : 0;
    const stationaryS = tyreChangeOverlapsRefuel
        ? Math.max(refuelS, tyreS)
        : refuelS + tyreS;
    return {
        refuelS,
        tyreS,
        stationaryS,
        totalS: pitLaneDeltaS + stationaryS,
    };
}

/**
 * Split `totalLaps` across `stintCount` stints as evenly as possible.
 *
 * Evenly, not max-then-remainder: an even split avoids ending the race on a
 * two-lap splash, and carries less load (so less weight) through every stint.
 */
function splitStints(totalLaps, stintCount) {
    if (stintCount < 1) throw new Error('stintCount must be >= 1');
    const base = Math.floor(totalLaps / stintCount);
    const extra = totalLaps % stintCount;
    return Array.from({ length: stintCount }, (_, i) => base + (i < extra ? 1 : 0));
}

module.exports = {
    limiterFor, defaultCapacity, lapsPerStint, pitStopTime, splitStints,
    UNIT, ENERGY_CLASSES, FUEL_CLASSES,
};
