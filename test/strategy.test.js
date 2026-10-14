'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const F = require('../src/strategy/fuel');
const { planRace } = require('../src/strategy/planner');

// --- the class rule -------------------------------------------------------

test('car class selects the right limiter', () => {
    assert.equal(F.limiterFor('Hyper'), 'virtual-energy');
    assert.equal(F.limiterFor('Hypercar'), 'virtual-energy');
    assert.equal(F.limiterFor('GT3'), 'virtual-energy');
    assert.equal(F.limiterFor('LMGT3'), 'virtual-energy');
    assert.equal(F.limiterFor('LMP2'), 'fuel');
    assert.equal(F.limiterFor('GTE'), 'fuel');
    assert.throws(() => F.limiterFor('Formula1'), /Unknown car class/);
});

test('VE classes default to a 100% allowance; fuel classes must state a tank', () => {
    assert.equal(F.defaultCapacity('Hyper'), 100);
    assert.equal(F.defaultCapacity('LMP2'), null);
    assert.throws(
        () => planRace({ totalLaps: 10, lapTimeS: 100, carClass: 'LMP2',
            consumptionPerLap: 3, pitLaneDeltaS: 25, refuelRate: 2.5 }),
        /capacity is required/
    );
});

test('stint length floors -- a lap you cannot finish is not a lap', () => {
    assert.equal(F.lapsPerStint({ capacity: 100, perLap: 4.2 }), 23);       // 23.8 -> 23
    assert.equal(F.lapsPerStint({ capacity: 75, perLap: 3.0 }), 25);
    assert.equal(F.lapsPerStint({ capacity: 75, perLap: 3.0, reserve: 1 }), 24);
});

test('stints split evenly rather than max-then-remainder', () => {
    assert.deepEqual(F.splitStints(90, 4), [23, 23, 22, 22]);
    assert.deepEqual(F.splitStints(100, 4), [25, 25, 25, 25]);
    assert.deepEqual(F.splitStints(7, 3), [3, 2, 2]);
});

// --- a fully hand-computable race ----------------------------------------

test('lap-limited race matches hand calculation exactly', () => {
    // 75 L / 3.0 L per lap = 25 laps a stint. 100 laps => 4 stints, 3 stops.
    // Each stop adds 75 L at 2.5 L/s = 30s stationary, +28s pit lane = 58s.
    // On track 100 x 210s = 21000s. Total 21000 + 3x58 = 21174s.
    const p = planRace({
        totalLaps: 100, lapTimeS: 210, carClass: 'LMP2',
        consumptionPerLap: 3.0, capacity: 75,
        pitLaneDeltaS: 28, refuelRate: 2.5,
    });

    assert.equal(p.limiter, 'fuel');
    assert.equal(p.unit, 'L');
    assert.equal(p.maxLapsPerStint, 25);
    assert.equal(p.stints.length, 4);
    assert.equal(p.stops, 3);
    assert.deepEqual(p.stints.map((s) => s.laps), [25, 25, 25, 25]);
    assert.equal(p.stints[0].pitAfter.refuelS, 30);
    assert.equal(p.stints[0].pitAfter.totalS, 58);
    assert.equal(p.onTrackS, 21000);
    assert.equal(p.totalPitTimeS, 174);
    assert.equal(p.totalRaceTimeS, 21174);
});

test('stint boundaries are contiguous and cover every lap exactly once', () => {
    const p = planRace({
        totalLaps: 137, lapTimeS: 205, carClass: 'Hyper',
        consumptionPerLap: 4.2, pitLaneDeltaS: 30, refuelRate: 3.0,
    });
    assert.equal(p.stints.reduce((n, s) => n + s.laps, 0), 137);
    assert.equal(p.stints[0].fromLap, 1);
    assert.equal(p.stints.at(-1).toLap, 137);
    for (let i = 1; i < p.stints.length; i++) {
        assert.equal(p.stints[i].fromLap, p.stints[i - 1].toLap + 1, 'no gap or overlap');
    }
    for (const s of p.stints) assert.ok(s.laps <= p.maxLapsPerStint);
    assert.equal(p.stints.at(-1).pitAfter, null, 'no stop after the final stint');
});

// --- the circular timed-race solve ---------------------------------------

test('timed race converges and lands within one lap of the clock', () => {
    const durationS = 6 * 3600;
    const lapTimeS = 212;
    const p = planRace({
        durationS, lapTimeS, carClass: 'Hyper',
        consumptionPerLap: 4.4, pitLaneDeltaS: 30, refuelRate: 3.0, tyreChangeS: 26,
    });

    assert.ok(p.converged, 'fixed point reached');
    assert.ok(p.iterations <= 6, `settled quickly, took ${p.iterations}`);
    // The race ends on the lap in progress when the clock expires, so total
    // time is at least the duration and less than one lap beyond it.
    assert.ok(p.totalRaceTimeS >= durationS, 'cannot finish before the clock');
    assert.ok(p.totalRaceTimeS < durationS + lapTimeS, 'cannot overrun by a whole lap');
});

test('pit time feeds back into lap count', () => {
    const base = { durationS: 6 * 3600, lapTimeS: 212, carClass: 'Hyper',
        consumptionPerLap: 4.4, refuelRate: 3.0 };
    const quick = planRace({ ...base, pitLaneDeltaS: 20 });
    const slow = planRace({ ...base, pitLaneDeltaS: 90 });
    assert.ok(slow.totalPitTimeS > quick.totalPitTimeS);
    assert.ok(slow.totalLaps <= quick.totalLaps,
        'a slower pit lane costs laps over a fixed race duration');
});

test('thirstier consumption means more stops', () => {
    const base = { totalLaps: 120, lapTimeS: 210, carClass: 'Hyper',
        pitLaneDeltaS: 28, refuelRate: 3.0 };
    const economical = planRace({ ...base, consumptionPerLap: 4.0 });
    const thirsty = planRace({ ...base, consumptionPerLap: 5.5 });
    assert.ok(thirsty.stops > economical.stops,
        `${thirsty.stops} stops vs ${economical.stops}`);
});

// --- tyres as the binding constraint -------------------------------------

test('tyre life can bind before energy does, and says so', () => {
    const p = planRace({
        totalLaps: 100, lapTimeS: 210, carClass: 'Hyper',
        consumptionPerLap: 4.2,              // 23 laps of energy
        tyreStintLaps: 15,                   // but only 15 of rubber
        pitLaneDeltaS: 28, refuelRate: 3.0, tyreChangeS: 26,
    });
    assert.equal(p.energyLapsPerStint, 23);
    assert.equal(p.maxLapsPerStint, 15);
    assert.equal(p.boundBy, 'tyres');
    assert.match(p.warnings.join(' '), /Tyres bind before/);
    assert.ok(p.stints[0].pitAfter.tyreS > 0, 'tyre change is actually timed');
});

test('refuel time scales with load taken on, not a flat figure', () => {
    const p = planRace({
        totalLaps: 40, lapTimeS: 200, carClass: 'LMP2',
        consumptionPerLap: 3.0, capacity: 75,
        pitLaneDeltaS: 25, refuelRate: 2.5,
    });
    // 40 laps / 25 per stint => 2 stints of 20; the stop adds 20x3 = 60 L.
    assert.equal(p.stints[0].pitAfter.added, 60);
    assert.equal(p.stints[0].pitAfter.refuelS, 24);   // 60 / 2.5
});

// --- driver rotation ------------------------------------------------------

test('drivers rotate and continuous-time limits are respected', () => {
    const p = planRace({
        totalLaps: 100, lapTimeS: 210, carClass: 'Hyper',
        consumptionPerLap: 4.2, pitLaneDeltaS: 28, refuelRate: 3.0,
        drivers: [
            { name: 'Krisztian', maxStintS: 2 * 3600 },
            { name: 'Co-driver', maxStintS: 2 * 3600 },
        ],
    });
    assert.ok(p.stints.every((s) => s.driver));
    assert.notEqual(p.stints[0].driver, p.stints[1].driver, 'drivers alternate');
    assert.equal(p.warnings.filter((w) => /breaches/.test(w)).length, 0);
});

test('an impossible stint is flagged rather than silently assigned', () => {
    const p = planRace({
        totalLaps: 30, lapTimeS: 400, carClass: 'Hyper',
        consumptionPerLap: 3.0, pitLaneDeltaS: 28, refuelRate: 3.0,
        drivers: [{ name: 'Solo', maxStintS: 600 }],   // 10 min cap, stints are far longer
    });
    assert.match(p.warnings.join(' '), /breaches every driver's limits/);
});
