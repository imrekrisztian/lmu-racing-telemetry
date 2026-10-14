'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StandingsTracker } = require('../src/live/standings.js');

const car = (o = {}) => ({
    id: 7, name: 'Rival', carClass: 'Hyper', position: 2, lap: 10,
    lapDistM: 100, gapToLeaderS: 12.5, energyFrac: 0.5, inPits: false,
    bestLapS: 210, lastLapS: 211, ...o,
});

test('a fuel-only stop is read as refuelled, tyres not inferred', () => {
    const t = new StandingsTracker();
    t.update([car({ energyFrac: 0.08 })], 0);
    t.update([car({ energyFrac: 0.08, inPits: true })], 100);
    // 30s pit lane + ~29s of fuel for 0.87 of a load = ~59s total.
    const [s] = t.update([car({ energyFrac: 0.95, inPits: false, lap: 11 })], 159);

    assert.equal(s.stops, 1);
    assert.equal(s.lastStop.refuelled, true);
    assert.ok(Math.abs(s.lastStop.energyGained - 0.87) < 1e-9);
    assert.equal(s.lastStop.tyresLikely, false, 'the time is fully explained by fuel');
});

test('a long stop for the same fuel is inferred as a tyre change', () => {
    const t = new StandingsTracker();
    t.update([car({ energyFrac: 0.08 })], 0);
    t.update([car({ energyFrac: 0.08, inPits: true })], 100);
    // Same fuel, but 25s longer standing still.
    const [s] = t.update([car({ energyFrac: 0.95, inPits: false, lap: 11 })], 184);

    assert.equal(s.lastStop.refuelled, true);
    assert.equal(s.lastStop.tyresLikely, true);
    assert.ok(s.lastStop.unexplainedS > 20, 'time the fuel cannot account for');
});

test('a splash-and-dash is neither a refuel nor a tyre stop', () => {
    const t = new StandingsTracker();
    t.update([car({ energyFrac: 0.30 })], 0);
    t.update([car({ energyFrac: 0.30, inPits: true })], 100);
    const [s] = t.update([car({ energyFrac: 0.33, inPits: false, lap: 11 })], 133);
    assert.equal(s.lastStop.refuelled, false, '3% is below the refuel threshold');
    assert.equal(s.lastStop.tyresLikely, false);
});

test('a tyres-only stop is caught even with no fuel taken', () => {
    const t = new StandingsTracker();
    t.update([car({ energyFrac: 0.60 })], 0);
    t.update([car({ energyFrac: 0.60, inPits: true })], 100);
    const [s] = t.update([car({ energyFrac: 0.60, inPits: false, lap: 11 })], 158);
    assert.equal(s.lastStop.refuelled, false);
    assert.equal(s.lastStop.tyresLikely, true, '28s stationary with no fuel is tyres');
});

test('consumption and laps remaining derive from the rival own laps', () => {
    const t = new StandingsTracker();
    let snap;
    for (let lap = 10; lap <= 15; lap++) {
        snap = t.update([car({ lap, energyFrac: 1 - (lap - 10) * 0.04 })], lap * 210);
    }
    const [s] = snap;
    assert.ok(Math.abs(s.perLap - 0.04) < 1e-6, `per lap ${s.perLap}`);
    assert.equal(s.estLapsLeft, Math.floor(s.energyFrac / 0.04));
});

test('the refuel jump does not pollute the consumption estimate', () => {
    const t = new StandingsTracker();
    let snap;
    const energies = [0.20, 0.16, 0.12, 0.95, 0.91, 0.87];   // refuel at lap 13
    energies.forEach((e, i) => {
        snap = t.update([car({ lap: 10 + i, energyFrac: e })], (10 + i) * 210);
    });
    const [s] = snap;
    assert.ok(Math.abs(s.perLap - 0.04) < 1e-6,
        `the +0.83 jump must be ignored, got ${s.perLap}`);
});

test('cars are returned in running order', () => {
    const t = new StandingsTracker();
    const out = t.update([
        car({ id: 1, position: 3 }), car({ id: 2, position: 1 }), car({ id: 3, position: 2 }),
    ], 0);
    assert.deepEqual(out.map((c) => c.position), [1, 2, 3]);
});

test('stint laps reset at a stop and climb again after', () => {
    const t = new StandingsTracker();
    t.update([car({ lap: 10 })], 0);
    t.update([car({ lap: 12 })], 420);
    let [s] = t.update([car({ lap: 13 })], 630);
    assert.equal(s.stintLaps, 3);

    t.update([car({ lap: 13, inPits: true })], 700);
    [s] = t.update([car({ lap: 14, inPits: false })], 760);
    assert.equal(s.stintLaps, 0, 'reset by the stop');
    [s] = t.update([car({ lap: 15 })], 970);
    assert.equal(s.stintLaps, 1);
});
