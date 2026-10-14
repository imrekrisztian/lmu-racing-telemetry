'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const LC = require('../src/strategy/lift-and-coast.js');

const coast = LC.fitCoastModel([]);          // the physical fallback model
const FUEL_RATE = 0.022;                     // %VE per second on throttle

// A heavy braking zone: 335 km/h down to 72 km/h.
const heavy = { seg_num: 4, entrySpeedMs: 93, apexSpeedMs: 20, approachM: 200 };
// A light one: 250 down to 220 km/h.
const light = { seg_num: 9, entrySpeedMs: 69, apexSpeedMs: 61, approachM: 200 };

// --- the coast model ------------------------------------------------------

test('coast deceleration is fitted from real coasting, not assumed', () => {
    // a = 0.0005 v^2 + 0.6 with a little scatter
    const samples = Array.from({ length: 40 }, (_, i) => {
        const v = 25 + i * 1.7;
        return { speed_ms: v, decel_ms2: 0.0005 * v * v + 0.6 + (i % 3 - 1) * 0.02 };
    });
    const m = LC.fitCoastModel(samples);
    assert.equal(m.measured, true);
    assert.ok(Math.abs(m.k - 0.0005) < 5e-5, `k=${m.k}`);
    assert.ok(Math.abs(m.c - 0.6) < 0.15, `c=${m.c}`);
    assert.ok(m.at(80) > m.at(40), 'drag rises with speed');
});

test('too little coasting falls back rather than fitting noise', () => {
    const m = LC.fitCoastModel([{ speed_ms: 60, decel_ms2: 2 }]);
    assert.equal(m.measured, false);
    assert.ok(m.at(60) > 0);
});

test('an unphysical fit is rejected in favour of the fallback', () => {
    // Deceleration falling as speed rises cannot be drag.
    const bad = Array.from({ length: 20 }, (_, i) => ({ speed_ms: 30 + i * 2, decel_ms2: 8 - i * 0.3 }));
    assert.equal(LC.fitCoastModel(bad).measured, false);
});

// --- the central claim ----------------------------------------------------

test('a heavy braking zone is cheaper per metre of lift than a light one', () => {
    // The energy was about to become brake heat, so surrendering it early is
    // cheap. The advantage is real but MODEST per metre -- coast deceleration
    // is small next to braking deceleration in either zone, so the time cost is
    // second order both times. An earlier version of this test asserted 2x and
    // was simply wrong about the physics.
    const a = LC.evaluateLift({ ...heavy, liftM: 50, coast, brakeDecel: 13, fuelRatePerS: FUEL_RATE });
    const b = LC.evaluateLift({ ...light, liftM: 50, coast, brakeDecel: 13, fuelRatePerS: FUEL_RATE });

    assert.ok(a.efficiency > b.efficiency,
        `heavy ${a.efficiency.toFixed(2)} should beat light ${b.efficiency.toFixed(2)}`);
    assert.ok(a.timeLostS < b.timeLostS, 'and costs less time for the same lift');
});

test('capacity is what actually makes heavy zones dominant', () => {
    // A zone shedding 260 km/h can swallow hundreds of metres of lift; one
    // shedding 30 km/h saturates almost at once. Total energy available from a
    // corner, not efficiency per metre, is why the radio call names the heavy
    // braking zones.
    const big = LC.maxUsableLiftM({ ...heavy, approachM: 2000 }, coast, 13);
    const small = LC.maxUsableLiftM({ ...light, approachM: 2000 }, coast, 13);
    assert.ok(big > small * 4, `heavy absorbs ${big.toFixed(0)}m vs light ${small.toFixed(0)}m`);
});

test('a flat-out section offers no lift capacity at all', () => {
    assert.equal(LC.maxUsableLiftM({ entrySpeedMs: 90, apexSpeedMs: 90, approachM: 500 }, coast, 13), 0);
});

test('lifting earlier saves more energy and costs more time', () => {
    const short = LC.evaluateLift({ ...heavy, liftM: 40, coast, brakeDecel: 13, fuelRatePerS: FUEL_RATE });
    const long = LC.evaluateLift({ ...heavy, liftM: 120, coast, brakeDecel: 13, fuelRatePerS: FUEL_RATE });
    assert.ok(long.energySaved > short.energySaved);
    assert.ok(long.timeLostS > short.timeLostS);
    assert.ok(long.entryAtBrakeMs < short.entryAtBrakeMs, 'and arrives at the brakes slower');
});

test('a lift that would drop below apex speed is refused', () => {
    const r = LC.evaluateLift({
        entrySpeedMs: 69, apexSpeedMs: 61, approachM: 4000, liftM: 3000,
        coast, brakeDecel: 13, fuelRatePerS: FUEL_RATE,
    });
    assert.equal(r, null, 'coasting below the corner speed is not lift and coast, it is slow');
});

test('a lift longer than the approach is refused', () => {
    assert.equal(LC.evaluateLift({ ...heavy, liftM: 400, coast, brakeDecel: 13, fuelRatePerS: FUEL_RATE }), null);
});

test('energy saved scales with fuel flow', () => {
    const a = LC.evaluateLift({ ...heavy, liftM: 60, coast, brakeDecel: 13, fuelRatePerS: 0.02 });
    const b = LC.evaluateLift({ ...heavy, liftM: 60, coast, brakeDecel: 13, fuelRatePerS: 0.04 });
    assert.ok(Math.abs(b.energySaved / a.energySaved - 2) < 1e-9);
    assert.ok(Math.abs(b.timeLostS - a.timeLostS) < 1e-9, 'time cost is physics, not fuel flow');
});

// --- the plan -------------------------------------------------------------

test('a plan meets the target and reports what it cost', () => {
    const zones = [heavy, light, { seg_num: 6, entrySpeedMs: 88, apexSpeedMs: 24, approachM: 180 }];
    const p = LC.planLiftAndCoast({ zones, coast, fuelRatePerS: FUEL_RATE, targetSaving: 0.02 });

    assert.equal(p.met, true);
    assert.ok(p.achieved >= 0.02);
    assert.ok(p.timeLostS > 0);
    assert.ok(p.lifts.length >= 1);
    for (const l of p.lifts) assert.ok(l.liftM > 0 && l.seg_num != null);
});

test('the plan reaches for the heavy zones first', () => {
    const zones = [light, heavy];
    const p = LC.planLiftAndCoast({ zones, coast, fuelRatePerS: FUEL_RATE, targetSaving: 0.005 });
    assert.equal(p.lifts[0].seg_num, heavy.seg_num, 'the cheapest energy is taken first');
});

test('an unreachable target is reported honestly, not approximated', () => {
    const p = LC.planLiftAndCoast({
        zones: [light], coast, fuelRatePerS: FUEL_RATE, targetSaving: 5.0,
    });
    assert.equal(p.met, false);
    assert.ok(p.achieved < 5.0);
});

test('a time-loss ceiling stops the plan rather than being ignored', () => {
    const zones = [heavy, light, { seg_num: 6, entrySpeedMs: 88, apexSpeedMs: 24, approachM: 180 }];
    const p = LC.planLiftAndCoast({
        zones, coast, fuelRatePerS: FUEL_RATE, targetSaving: 5.0, maxTimeLossS: 0.05,
    });
    assert.ok(p.timeLostS <= 0.05 + 0.2, 'stops once the budget is spent');
    assert.equal(p.met, false);
});

test('each zone is used at most once', () => {
    const p = LC.planLiftAndCoast({
        zones: [heavy, light], coast, fuelRatePerS: FUEL_RATE, targetSaving: 1.0,
    });
    const segs = p.lifts.map((l) => l.seg_num);
    assert.equal(new Set(segs).size, segs.length);
});

test('the plan says whether the coast model was measured or assumed', () => {
    const p = LC.planLiftAndCoast({ zones: [heavy], coast, fuelRatePerS: FUEL_RATE, targetSaving: 0.01 });
    assert.equal(p.coastMeasured, false, 'fallback model must be declared as such');
});
