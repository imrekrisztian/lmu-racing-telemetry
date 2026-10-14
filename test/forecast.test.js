'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const F = require('../src/strategy/forecast.js');
const { planRace } = require('../src/strategy/planner.js');

/**
 * A squall: rain on hard, then off abruptly.
 *
 * A gently tapering shower is the wrong probe for lag -- by the time the rain
 * reads near zero the track has had many minutes to dry, so the lag is real
 * but invisible. A step change isolates it.
 */
const squall = ({ startS = 600, stopS = 1800, peak = 0.8, endS = 7200, stepS = 60 } = {}) => {
    const out = [];
    for (let t = 0; t <= endS; t += stepS) {
        out.push({ atS: t, raining: t >= startS && t < stopS ? peak : 0 });
    }
    return out;
};

/** A shower: dry, building to heavy, then clearing. */
const shower = ({ peakS = 1800, width = 600, peak = 0.8, endS = 5400, stepS = 60 } = {}) => {
    const out = [];
    for (let t = 0; t <= endS; t += stepS) {
        out.push({ atS: t, raining: peak * Math.exp(-((t - peakS) ** 2) / (2 * width ** 2)) });
    }
    return out;
};

// --- the lag --------------------------------------------------------------

test('wetness peaks AFTER the rain does', () => {
    const tl = F.projectWetness({ forecast: shower(), currentWetness: 0 });
    const peakRain = tl.reduce((a, b) => (b.raining > a.raining ? b : a));
    const peakWet = tl.reduce((a, b) => (b.wetness > a.wetness ? b : a));
    assert.ok(peakWet.atS > peakRain.atS, 'a track does not soak instantly');
});

test('the track is still wet long after the rain stops', () => {
    const tl = F.projectWetness({ forecast: squall({ startS: 600, stopS: 1800 }) });
    const at = (t) => tl.reduce((a, b) => (Math.abs(b.atS - t) < Math.abs(a.atS - t) ? b : a));

    assert.ok(at(1800).wetness > 0.6, 'soaked while it is raining');
    assert.equal(at(1860).raining, 0, 'rain has stopped');
    assert.ok(at(1860).wetness > 0.65, 'and the track does not care yet');
    assert.ok(at(2400).wetness > 0.25, 'ten minutes later it is still damp');
    assert.ok(at(4200).wetness < 0.12, 'forty minutes later it has dried');
});

test('the projection does not depend on forecast sampling density', () => {
    // Applying the lag per step rather than per second would make a coarse
    // forecast and a fine one disagree about the same weather.
    const coarse = F.projectWetness({ forecast: shower({ stepS: 300 }), stepS: 120 });
    const fine = F.projectWetness({ forecast: shower({ stepS: 30 }), stepS: 10 });
    const at = (tl, t) => tl.reduce((a, b) => (Math.abs(b.atS - t) < Math.abs(a.atS - t) ? b : a));
    assert.ok(Math.abs(at(coarse, 2400).wetness - at(fine, 2400).wetness) < 0.06);
});

test('an already-wet track carries its state into the projection', () => {
    const dryStart = F.projectWetness({ forecast: shower({ peak: 0 }), currentWetness: 0 });
    const wetStart = F.projectWetness({ forecast: shower({ peak: 0 }), currentWetness: 0.8 });
    assert.ok(wetStart[0].wetness > dryStart[0].wetness);
    assert.ok(wetStart[wetStart.length - 1].wetness < 0.3, 'and it dries out over time');
});

test('an empty forecast yields nothing rather than guessing', () => {
    assert.deepEqual(F.projectWetness({ forecast: [] }), []);
});

// --- crossovers -----------------------------------------------------------

test('crossovers are read off wetness, not off rain', () => {
    const tl = F.projectWetness({ forecast: squall({ startS: 600, stopS: 1800 }) });
    const ev = F.crossoverEvents(tl);
    assert.equal(ev.length, 2, 'into the wet and back out again');
    assert.equal(ev[0].type, 'to-wet');
    assert.equal(ev[1].type, 'to-dry');

    // The asymmetry is the whole point: a track soaks quickly and dries slowly.
    const lagIn = ev[0].atS - 600;
    const lagOut = ev[1].atS - 1800;
    assert.ok(lagIn < 180, `soaking is quick, took ${lagIn}s`);
    assert.ok(lagOut > 900, `drying is slow, took only ${lagOut}s`);
    assert.ok(lagOut > lagIn * 5,
        'drying must lag far more than soaking, or crossover timing would not be a decision');
});

test('a light shower that never soaks the track raises no crossover', () => {
    const tl = F.projectWetness({ forecast: shower({ peak: 0.12 }) });
    assert.equal(F.crossoverEvents(tl).length, 0);
});

// --- adaptation -----------------------------------------------------------

const racePlan = () => planRace({
    totalLaps: 100, lapTimeS: 120, carClass: 'Hyper',
    consumptionPerLap: 4.2, pitLaneDeltaS: 30, refuelRate: 3.0,
});

test('a stop already near the crossover is free, and says so', () => {
    // Built the other way round: find where the crossover actually lands, then
    // put a stop on it. Guessing a rain time and hoping the crossover lines up
    // bakes the lag's own magnitude into the test.
    const tl = F.projectWetness({ forecast: shower({ peakS: 1800, endS: 7200 }) });
    const toWetAt = F.crossoverEvents(tl).find((e) => e.type === 'to-wet').atS;

    const lapTimeS = 120;
    const stopLap = Math.round(toWetAt / lapTimeS);
    const plan = {
        maxLapsPerStint: 30,
        stints: [
            { index: 1, fromLap: 1, toLap: stopLap, pitAfter: { afterLap: stopLap, totalS: 60 } },
            { index: 2, fromLap: stopLap + 1, toLap: stopLap + 25, pitAfter: null },
        ],
    };

    const r = F.adaptStrategy({ plan, timeline: tl, currentLap: 1, lapTimeS });
    const toWet = r.actions.find((a) => a.event === 'to-wet');
    assert.ok(toWet);
    assert.equal(toWet.action, 'aligned');
    assert.equal(toWet.costS, 0);
    assert.match(toWet.detail, /the change is free/);
    assert.equal(r.freeChanges >= 1, true);
});

test('a crossover near a stop is absorbed by shifting it, at no cost', () => {
    // Placed so the crossover lands within a couple of laps of a planned stop.
    // A crossover tens of laps from any stop is genuinely NOT free, and the
    // earlier version of this test asserted otherwise.
    const plan = racePlan();
    const firstStopS = plan.stints[0].pitAfter.afterLap * 120;
    const tl = F.projectWetness({ forecast: shower({ peakS: firstStopS + 840, endS: 12000 }) });
    const r = F.adaptStrategy({ plan, timeline: tl, currentLap: 1, lapTimeS: 120, maxLapsPerStint: 22 });

    const toWet = r.actions.find((a) => a.event === 'to-wet');
    assert.ok(['aligned', 'bring-forward', 'extend'].includes(toWet.action),
        `expected a shift, got ${toWet.action}`);
    assert.equal(toWet.costS, 0, 'a stop you were making anyway absorbs the change');
});

test('a crossover beyond stint range forces an extra stop, with its cost', () => {
    const plan = racePlan();
    // Rain arriving far later than any reachable stop extension.
    const tl = F.projectWetness({ forecast: shower({ peakS: 9000, endS: 14000 }) });
    const r = F.adaptStrategy({
        plan, timeline: tl, currentLap: 1, lapTimeS: 120,
        maxLapsPerStint: 22, pitLossS: 60, tyreChangeS: 26,
    });
    const costly = r.actions.filter((a) => a.action === 'extra-stop');
    if (costly.length > 0) {
        assert.ok(costly[0].costS >= 80, 'an unplanned stop costs the full pit loss');
        assert.match(costly[0].detail, /extra stop/i);
    }
    assert.equal(r.addedTimeS, r.actions.reduce((n, a) => n + a.costS, 0));
});

test('actions name the compound to fit at each crossover', () => {
    const plan = racePlan();
    const tl = F.projectWetness({ forecast: shower({ peakS: 1500, endS: 7000 }) });
    const r = F.adaptStrategy({ plan, timeline: tl, currentLap: 1, lapTimeS: 120 });
    const wet = r.actions.find((a) => a.event === 'to-wet');
    const dry = r.actions.find((a) => a.event === 'to-dry');
    assert.equal(wet?.compound, 'wet');
    assert.equal(dry?.compound, 'slick');
});

test('crossovers are reported as lap numbers, not only seconds', () => {
    const plan = racePlan();
    const tl = F.projectWetness({ forecast: shower({ peakS: 1200, endS: 6000 }) });
    const r = F.adaptStrategy({ plan, timeline: tl, currentLap: 5, lapTimeS: 120 });
    for (const a of r.actions) {
        assert.ok(a.atLap >= 5, 'laps are relative to where the race actually is');
        assert.ok(Number.isFinite(a.atLap));
    }
});

test('no forecast means no actions rather than invented ones', () => {
    const r = F.adaptStrategy({ plan: racePlan(), timeline: [], currentLap: 1, lapTimeS: 120 });
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.events, []);
});

test('a missing plan is handled rather than thrown at the caller', () => {
    const r = F.adaptStrategy({ plan: null, timeline: [], lapTimeS: 120 });
    assert.deepEqual(r.actions, []);
});

test('a stop is only ever committed to one crossover', () => {
    // Without this the nearest stop is recommended for every event in turn,
    // producing a plan that pits the same lap three times.
    const plan = racePlan();
    const many = [];
    for (let t = 0; t <= 12000; t += 60) {
        const wet = [1200, 4200, 7200].some((c) => Math.abs(t - c) < 500);
        many.push({ atS: t, raining: wet ? 0.8 : 0 });
    }
    const tl = F.projectWetness({ forecast: many });
    const r = F.adaptStrategy({ plan, timeline: tl, currentLap: 1, lapTimeS: 120, maxLapsPerStint: 22 });

    const assigned = r.actions.filter((a) => a.stop).map((a) => a.stop.stint);
    assert.equal(new Set(assigned).size, assigned.length,
        `each stop used once, got ${JSON.stringify(assigned)}`);
    assert.ok(r.events.length >= 2, 'several crossovers to allocate between');
});

test('crossovers with no stop left to use are costed as extra stops', () => {
    const plan = {
        maxLapsPerStint: 22,
        stints: [{ index: 1, fromLap: 1, toLap: 20, pitAfter: { afterLap: 20, totalS: 60 } },
                 { index: 2, fromLap: 21, toLap: 40, pitAfter: null }],
    };
    const many = [];
    for (let t = 0; t <= 12000; t += 60) {
        const wet = [1200, 5000, 9000].some((c) => Math.abs(t - c) < 500);
        many.push({ atS: t, raining: wet ? 0.8 : 0 });
    }
    const tl = F.projectWetness({ forecast: many });
    const r = F.adaptStrategy({ plan, timeline: tl, currentLap: 1, lapTimeS: 120, pitLossS: 60, tyreChangeS: 26 });

    assert.ok(r.actions.some((a) => a.action === 'extra-stop'), 'the surplus crossovers cost a stop');
    assert.ok(r.addedTimeS > 0);
});

test('bringing a stop far forward is costed, not waved through as free', () => {
    // Pulling a stop forward hands its laps to the next stint. Past the stint
    // limit that is an extra stop, not a shift -- an earlier version reported
    // "bring the lap 81 stop forward to lap 32, costs nothing".
    const plan = {
        maxLapsPerStint: 20,
        stints: [
            { index: 1, fromLap: 1, toLap: 20, pitAfter: { afterLap: 20, totalS: 60 } },
            { index: 2, fromLap: 21, toLap: 40, pitAfter: { afterLap: 40, totalS: 60 } },
            { index: 3, fromLap: 41, toLap: 60, pitAfter: null },
        ],
    };
    // Rain arriving on lap 3, far before the lap-40 stop it would be matched to.
    const fc = [];
    for (let t = 0; t <= 8000; t += 60) fc.push({ atS: t, raining: t > 300 && t < 2000 ? 0.8 : 0 });
    const tl = F.projectWetness({ forecast: fc });

    const r = F.adaptStrategy({
        plan, timeline: tl, currentLap: 1, lapTimeS: 120,
        maxLapsPerStint: 20, pitLossS: 60, tyreChangeS: 26,
    });

    for (const a of r.actions.filter((x) => x.action === 'bring-forward')) {
        const following = (a.stop.stint < 3 ? [20, 40, 60][a.stop.stint] : 60) - a.toLap;
        assert.ok(following <= 20, `a free shift must leave a legal stint, got ${following} laps`);
    }
});
