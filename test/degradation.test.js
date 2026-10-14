'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const D = require('../src/analysis/degradation.js');

/**
 * A synthetic stint with KNOWN degradation and a KNOWN fuel effect, so the fit
 * can be checked against truth rather than against itself.
 */
function stint({ laps = 20, base = 210, deg = 0.05, fuelStart = 90, fuelPerLap = 4,
                 fuelEffect = 0.035, noise = 0 } = {}) {
    const out = [];
    for (let i = 1; i <= laps; i++) {
        const fuelL = fuelStart - fuelPerLap * (i - 1);
        const lapTimeS = base + deg * i + fuelL * fuelEffect
            + (noise ? (Math.sin(i * 12.9898) * noise) : 0);
        out.push({ stintLap: i, lapTimeS, fuelL, valid: true });
    }
    return out;
}

// --- the fuel correction --------------------------------------------------

test('degradation is recovered accurately once fuel is corrected for', () => {
    const laps = stint({ deg: 0.05, fuelEffect: 0.035 });
    const m = D.fitDegradation(laps, { fuelEffectSPerL: 0.035 });
    assert.ok(Math.abs(m.degSPerLap - 0.05) < 1e-6,
        `expected 0.050 s/lap, got ${m.degSPerLap.toFixed(4)}`);
    assert.ok(m.r2 > 0.999);
});

test('fitting RAW lap times hides degradation almost entirely', () => {
    // Burning 4 L/lap at 0.035 s/L makes the car 0.14s/lap faster, which very
    // nearly cancels 0.05s/lap of tyre deg. Fit the raw times and the tyres
    // look like they are IMPROVING. This is the whole reason for the
    // correction, so it is asserted rather than assumed.
    const laps = stint({ deg: 0.05, fuelPerLap: 4, fuelEffect: 0.035 });
    const uncorrected = D.fitDegradation(laps, { fuelEffectSPerL: 0 });
    assert.ok(uncorrected.degSPerLap < 0,
        `raw fit should read negative, got ${uncorrected.degSPerLap.toFixed(4)}`);

    const corrected = D.fitDegradation(laps, { fuelEffectSPerL: 0.035 });
    assert.ok(corrected.degSPerLap > 0.049);
});

test('correction normalises to the heaviest load, not to an empty tank', () => {
    const laps = stint({ laps: 10, base: 210, deg: 0, fuelStart: 90 });
    const c = D.fuelCorrect(laps, 0.035);
    assert.equal(c[0].fuelCorrectionS, 0, 'the heaviest lap is the reference');
    assert.ok(c[9].fuelCorrectionS > 0, 'lighter laps get time added back');
    // Corrected times should stay near the real ones rather than drift away.
    for (const l of c) assert.ok(Math.abs(l.correctedS - l.lapTimeS) < 2);
});

test('with no fuel data the figure is flagged as unreliable, not quietly wrong', () => {
    const laps = stint({ deg: 0.05 }).map(({ fuelL, ...rest }) => rest);
    const m = D.fitDegradation(laps);

    assert.equal(m.fuelCorrected, false);
    assert.match(m.warning, /mixes tyre degradation with fuel burn/);
    // And the number really is wrong: fuel burn outweighs the deg here, so an
    // uncorrected fit says the tyres are getting BETTER. Returning that
    // silently is the failure mode the flag exists to prevent.
    assert.ok(m.degSPerLap < 0);

    const good = D.fitDegradation(stint({ deg: 0.05 }));
    assert.equal(good.fuelCorrected, true);
    assert.equal(good.warning, null);
});

// --- robustness -----------------------------------------------------------

test('traffic laps are dropped, quick laps are kept', () => {
    const laps = stint({ laps: 20, deg: 0.05 });
    laps[7].lapTimeS += 9;     // stuck behind a GT3
    laps[12].lapTimeS += 6;
    const m = D.fitDegradation(laps);

    assert.ok(m.dropped.includes(8) || m.dropped.includes(13), 'slow laps rejected');
    assert.ok(Math.abs(m.degSPerLap - 0.05) < 0.01,
        `deg should survive traffic, got ${m.degSPerLap.toFixed(4)}`);
});

test('out and in laps never enter the fit', () => {
    const laps = stint({ laps: 12, deg: 0.05 });
    laps[0] = { ...laps[0], isOutLap: true, lapTimeS: laps[0].lapTimeS + 25 };
    laps[11] = { ...laps[11], isInLap: true, lapTimeS: laps[11].lapTimeS + 30 };
    const m = D.fitDegradation(laps);
    assert.equal(m.lapsUsed, 10);
    assert.ok(Math.abs(m.degSPerLap - 0.05) < 0.005);
});

test('too few clean laps returns no model rather than a bad one', () => {
    const m = D.fitDegradation(stint({ laps: 3 }));
    assert.equal(m.degSPerLap, null);
    assert.match(m.reason, /at least/);
});

// --- the cliff ------------------------------------------------------------

test('a cliff is detected as degradation accelerating, not merely being high', () => {
    const laps = stint({ laps: 18, deg: 0.03 });
    for (let i = 12; i < 18; i++) laps[i].lapTimeS += (i - 11) * 0.35;   // falls away
    const m = D.fitDegradation(laps);
    assert.ok(m.cliff, 'cliff found');
    assert.ok(m.cliff.ratio > 2);
    assert.ok(m.cliff.lateSPerLap > m.cliff.earlySPerLap);
});

test('steady high degradation is not reported as a cliff', () => {
    const m = D.fitDegradation(stint({ laps: 18, deg: 0.25 }));
    assert.ok(m.degSPerLap > 0.2, 'degradation is high');
    assert.equal(m.cliff, null, 'but it is not accelerating');
});

// --- wear -----------------------------------------------------------------

test('wear projects per wheel and names the limiting corner', () => {
    const wear = Array.from({ length: 12 }, (_, i) => ({
        stintLap: i + 1,
        fl: 1 - i * 0.030,     // front-left goes first
        fr: 1 - i * 0.022,
        rl: 1 - i * 0.018,
        rr: 1 - i * 0.018,
    }));
    const p = D.wearProjection(wear, { wearLimit: 0.15 });

    assert.ok(Math.abs(p.wheels.fl.perLap - 0.030) < 1e-6);
    assert.equal(p.limitingWheel, 'fl', 'the fastest-wearing corner limits the stint');
    assert.ok(p.wheels.fl.lapsLeft < p.wheels.rl.lapsLeft);
    assert.equal(p.lapsLeft, p.wheels.fl.lapsLeft);
});

test('wear counts down from new, so the rate is positive', () => {
    const wear = Array.from({ length: 8 }, (_, i) => ({ stintLap: i + 1, fl: 1 - i * 0.02 }));
    const p = D.wearProjection(wear);
    assert.ok(p.wheels.fl.perLap > 0, 'a wearing tyre reports positive wear per lap');
    assert.equal(p.wheels.fr, null, 'a wheel with no data is null, not zero');
});

// --- stint length ---------------------------------------------------------

test('optimal stint length balances pit loss against degradation', () => {
    // n = sqrt(2 * 60 / 0.05) = ~49 laps
    const a = D.optimalStintLaps({ degSPerLap: 0.05, pitLossS: 60 });
    assert.equal(a.laps, Math.round(Math.sqrt(2 * 60 / 0.05)));
    assert.equal(a.limitedBy, 'degradation');

    // Heavier degradation shortens the stint.
    const b = D.optimalStintLaps({ degSPerLap: 0.4, pitLossS: 60 });
    assert.ok(b.laps < a.laps);
});

test('fuel or tyres cap the stint when they bite before degradation does', () => {
    const r = D.optimalStintLaps({ degSPerLap: 0.02, pitLossS: 60, maxLaps: 22 });
    assert.equal(r.laps, 22);
    assert.equal(r.limitedBy, 'fuel or tyres');
});

test('with no measurable degradation the stint runs to its physical limit', () => {
    const r = D.optimalStintLaps({ degSPerLap: 0, pitLossS: 60, maxLaps: 22 });
    assert.equal(r.laps, 22);
});

test('projection extrapolates the fitted line', () => {
    const m = D.fitDegradation(stint({ laps: 15, deg: 0.05 }));
    const at10 = D.projectLapTime(m, 10);
    const at20 = D.projectLapTime(m, 20);
    assert.ok(Math.abs((at20 - at10) - 0.5) < 0.01, 'ten more laps costs ten times the deg');
});
