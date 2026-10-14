'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { planRace } = require('../src/strategy/planner');
const { assessLive } = require('../src/strategy/live');
const { parseDuration, parseLapTime } = require('../src/strategy/format');

const plan = () => planRace({
    totalLaps: 100, lapTimeS: 210, carClass: 'Hyper',
    consumptionPerLap: 4.0,                 // 25 laps a stint
    pitLaneDeltaS: 28, refuelRate: 3.0,
});

test('over-consumption is caught, with the saving needed to recover', () => {
    const p = plan();
    // Stint 1 is laps 1-25. At lap 1 with 100%VE, planned burn is 4.0/lap.
    const a = assessLive({ plan: p, currentLap: 1, levelNow: 100, measuredPerLap: 4.5 });

    assert.equal(a.lapsLeftOnLoad, 22);               // floor(100 / 4.5)
    assert.equal(a.plannedPitLap, 25);
    assert.equal(a.pitLapDelta, -3, 'three laps short of the window');
    assert.ok(a.savingNeeded > 0);
    assert.ok(Math.abs(a.targetPerLap - 4.0) < 1e-9, '100%VE over 25 laps = 4.0/lap');
    assert.ok(Math.abs(a.savingNeeded - 0.5) < 1e-9);
    assert.ok(Math.abs(a.consumptionDriftPct - 12.5) < 1e-9);
    assert.match(a.advice.join(' '), /Short by 3 laps/);
    assert.match(a.advice.join(' '), /Save 0\.50%VE\/lap/);
});

test('under-consumption reports laps in hand', () => {
    const p = plan();
    const a = assessLive({ plan: p, currentLap: 1, levelNow: 100, measuredPerLap: 3.5 });
    assert.equal(a.lapsLeftOnLoad, 28);
    assert.equal(a.pitLapDelta, 3);
    assert.match(a.advice.join(' '), /3 laps in hand/);
});

test('hitting the planned rate exactly reads as on target', () => {
    const p = plan();
    const a = assessLive({ plan: p, currentLap: 1, levelNow: 100, measuredPerLap: 4.0 });
    assert.equal(a.pitLapDelta, 0);
    assert.match(a.advice.join(' '), /On target for the planned stop on lap 25/);
});

test('reserve is excluded from what is plannable', () => {
    const p = planRace({
        totalLaps: 100, lapTimeS: 210, carClass: 'Hyper',
        consumptionPerLap: 4.0, reserve: 5, pitLaneDeltaS: 28, refuelRate: 3.0,
    });
    const a = assessLive({ plan: p, currentLap: 1, levelNow: 100, measuredPerLap: 4.0 });
    assert.equal(a.lapsLeftOnLoad, 23, '(100 - 5 reserve) / 4.0 = 23, not 25');
});

test('spots when the current load would reach the flag', () => {
    const p = plan();
    // Lap 90 of 100: 11 laps to run, and plenty in the car.
    const a = assessLive({ plan: p, currentLap: 90, levelNow: 90, measuredPerLap: 4.0 });
    assert.equal(a.canFinishOnThisLoad, true);
});

test('a mid-stint lap is attributed to the right stint', () => {
    const p = plan();
    assert.equal(assessLive({ plan: p, currentLap: 30, levelNow: 80, measuredPerLap: 4.0 }).stintIndex, 2);
    assert.equal(assessLive({ plan: p, currentLap: 76, levelNow: 80, measuredPerLap: 4.0 }).stintIndex, 4);
});

test('a revised plan is produced when remaining time and pace are known', () => {
    const p = planRace({
        durationS: 6 * 3600, lapTimeS: 210, carClass: 'Hyper',
        consumptionPerLap: 4.0, pitLaneDeltaS: 28, refuelRate: 3.0,
    });
    const a = assessLive({
        plan: p, currentLap: 30, levelNow: 70, measuredPerLap: 4.6,
        remainingS: 4 * 3600, lapTimeS: 212,
    });
    assert.ok(a.revised, 'revision produced');
    assert.ok(a.projectedStopsRemaining >= 1);
    assert.ok(a.revised.totalLaps > 0);
});

test('zero or negative measured consumption is rejected, not divided by', () => {
    const p = plan();
    assert.throws(() => assessLive({ plan: p, currentLap: 1, levelNow: 100, measuredPerLap: 0 }),
        /measuredPerLap must be > 0/);
});

// --- input parsing --------------------------------------------------------

test('durations and lap times parse the way people write them', () => {
    assert.equal(parseDuration('6h'), 21600);
    assert.equal(parseDuration('90m'), 5400);
    assert.equal(parseDuration('1h30m'), 5400);
    assert.equal(parseDuration('21600'), 21600);
    assert.throws(() => parseDuration('soon'), /Cannot parse duration/);

    assert.equal(parseLapTime('3:32'), 212);
    assert.ok(Math.abs(parseLapTime('3:32.456') - 212.456) < 1e-9);
    assert.equal(parseLapTime('212'), 212);
});
