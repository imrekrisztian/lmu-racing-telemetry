'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeSample, normalizeLap } = require('../src/ingest/normalize');
const { LapTracker } = require('../src/ingest/lap-tracker');
const U = require('../src/ingest/units');

// --- unit contract --------------------------------------------------------

test('tyre and brake temps convert Kelvin -> Celsius', () => {
    const s = normalizeSample({
        elapsedTime: 10, lapStartET: 0, lapDist: 0,
        wheels: [{ tempInner: 353.15, tempCenter: 363.15, tempOuter: 343.15, brakeTemp: 673.15 }, {}, {}, {}],
    });
    assert.ok(Math.abs(s.tyre_temp_fl_in_c - 80) < 1e-9);
    assert.ok(Math.abs(s.tyre_temp_fl_mid_c - 90) < 1e-9);
    assert.ok(Math.abs(s.tyre_temp_fl_out_c - 70) < 1e-9);
    assert.ok(Math.abs(s.brake_temp_fl_c - 400) < 1e-9);
});

test('absent wheel channels stay null rather than becoming -273.15', () => {
    const s = normalizeSample({ elapsedTime: 1, lapStartET: 0, lapDist: 0, wheels: [{}, {}, {}, {}] });
    assert.equal(s.tyre_temp_fl_in_c, null);
    assert.equal(s.brake_temp_rr_c, null);
});

test('lap-time sentinels become null, not numbers', () => {
    assert.equal(U.lapTime(-1), null);
    assert.equal(U.lapTime(0), null);
    assert.equal(U.lapTime(92.431), 92.431);
});

test('rear brake bias is flipped to front', () => {
    const s = normalizeSample({ elapsedTime: 1, lapStartET: 0, lapDist: 0, rearBrakeBias: 0.43 });
    assert.ok(Math.abs(s.brake_bias_frac - 0.57) < 1e-9);
});

test('transient zero-fuel reads become null', () => {
    assert.equal(normalizeSample({ elapsedTime: 1, lapStartET: 0, lapDist: 0, fuel: 0 }).fuel_l, null);
    assert.equal(normalizeSample({ elapsedTime: 1, lapStartET: 0, lapDist: 0, fuel: 42.5 }).fuel_l, 42.5);
});

test('control inputs are clamped to their declared ranges', () => {
    const s = normalizeSample({
        elapsedTime: 1, lapStartET: 0, lapDist: 0,
        unfilteredThrottle: 1.0001, unfilteredBrake: -0.0001, unfilteredSteering: -1.4,
    });
    assert.equal(s.throttle, 1);
    assert.equal(s.brake, 0);
    assert.equal(s.steer, -1);
});

test('cumulative sector splits are converted to per-sector times', () => {
    // sim reports S1=30, S2=70 cumulative, lap=100 -> sectors are 30/40/30
    const l = normalizeLap({ lapNumber: 3, lastLapTime: 100, lastSector1: 30, lastSector2: 70 });
    assert.equal(l.sector1_s, 30);
    assert.equal(l.sector2_s, 40);
    assert.equal(l.sector3_s, 30);
});

// --- lap tracking ---------------------------------------------------------

const frame = (o) => ({
    elapsedTime: 0, lapStartET: 0, lapNumber: 1, speed: 50,
    lastLapTime: -1, ...o,
});

test('integrates distance between scoring updates', () => {
    const t = new LapTracker();
    t.push(frame({ elapsedTime: 0.0, lapDist: 0 }));      // anchor
    t.push(frame({ elapsedTime: 0.1, lapDist: 0 }));      // stale scoring -> integrate
    t.push(frame({ elapsedTime: 0.2, lapDist: 0 }));
    const d = t.current.samples.at(-1).dist_m;
    assert.ok(Math.abs(d - 10) < 1e-9, `expected 10m, got ${d}`);
    assert.equal(t.stats.integratedFrames, 2);
});

test('re-anchors to scoring distance, discarding integration drift', () => {
    const t = new LapTracker();
    t.push(frame({ elapsedTime: 0.0, lapDist: 0 }));
    t.push(frame({ elapsedTime: 0.1, lapDist: 0 }));       // integrates to 5m
    t.push(frame({ elapsedTime: 0.2, lapDist: 123.4 }));   // scoring says otherwise
    assert.equal(t.current.samples.at(-1).dist_m, 123.4);
    assert.equal(t.stats.anchors, 2);
});

test('does not invent distance across a pause', () => {
    const t = new LapTracker();
    t.push(frame({ elapsedTime: 0.0, lapDist: 0 }));
    t.push(frame({ elapsedTime: 0.1, lapDist: 0 }));       // +5m
    t.push(frame({ elapsedTime: 95.0, lapDist: 0 }));      // 95s gap = alt-tab
    const d = t.current.samples.at(-1).dist_m;
    assert.ok(Math.abs(d - 5) < 1e-9, `expected 5m, got ${d}`);
    assert.equal(t.stats.skippedDt, 1);
});

test('closes a lap when lapStartET changes, not when lapNumber does', () => {
    const laps = [];
    const t = new LapTracker({ onLapComplete: (l) => laps.push(l) });
    t.push(frame({ elapsedTime: 10, lapStartET: 0, lapNumber: 1, lapDist: 0 }));
    t.push(frame({ elapsedTime: 100, lapStartET: 0, lapNumber: 1, lapDist: 4000 }));
    const done = t.push(frame({ elapsedTime: 101, lapStartET: 101, lapNumber: 2, lastLapTime: 101.5 }));
    assert.ok(done);
    assert.equal(done.lap_num, 1);
    assert.equal(done.lap_time_s, 101.5);         // sim's own time preferred
    assert.equal(laps.length, 1);
});

test('falls back to lapStartET delta when the sim reports no lap time', () => {
    const t = new LapTracker();
    t.push(frame({ elapsedTime: 10, lapStartET: 0, lapDist: 0 }));
    const done = t.push(frame({ elapsedTime: 90, lapStartET: 90, lapNumber: 2, lastLapTime: -1 }));
    assert.equal(done.lap_time_s, 90);
});

test('distance resets at a lap boundary', () => {
    const t = new LapTracker();
    t.push(frame({ elapsedTime: 0, lapDist: 3000 }));
    t.push(frame({ elapsedTime: 50, lapStartET: 50, lapNumber: 2, lapDist: 12 }));
    assert.equal(t.current.samples.at(-1).dist_m, 12);
});

test('flags out laps and in laps', () => {
    const t = new LapTracker();
    t.push(frame({ elapsedTime: 0, lapStartET: 0, inPits: true, lapDist: 0 }));
    t.push(frame({ elapsedTime: 5, lapStartET: 0, inPits: false, lapDist: 200 }));
    const out = t.push(frame({ elapsedTime: 100, lapStartET: 100, lapNumber: 2 }));
    assert.equal(out.is_out_lap, true);
    assert.equal(out.is_in_lap, false);

    t.push(frame({ elapsedTime: 150, lapStartET: 100, inPits: true }));
    const inLap = t.push(frame({ elapsedTime: 200, lapStartET: 200, lapNumber: 3 }));
    assert.equal(inLap.is_in_lap, true);
});

test('a partial lap at session end carries no lap time', () => {
    const t = new LapTracker();
    t.push(frame({ elapsedTime: 0, lapDist: 0 }));
    t.push(frame({ elapsedTime: 10, lapDist: 500 }));
    const p = t.finish();
    assert.equal(p.partial, true);
    assert.equal(p.lap_time_s, null);
    assert.equal(p.samples.length, 2);
});
