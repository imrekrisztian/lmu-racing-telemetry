'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const DR = require('../src/strategy/drivers.js');

/** A race of `n` stints, each `stintS` long with a stop after. */
const makeStints = (n, stintS = 3600, pitS = 60) =>
    Array.from({ length: n }, (_, i) => ({
        index: i + 1, laps: 20, onTrackS: stintS,
        fromLap: i * 20 + 1, toLap: (i + 1) * 20,
        pitAfter: i < n - 1 ? { totalS: pitS } : null,
    }));

// --- the point of the exercise -------------------------------------------

test('a driver is kept in the car rather than swapped every stop', () => {
    // Round-robin would hand over at every stop. Double stinting is how a team
    // buys that half-minute back, so with no constraints there should be as
    // few handovers as the rules allow.
    const p = DR.planDriverStints({
        stints: makeStints(6),
        drivers: [{ name: 'A' }, { name: 'B' }],
    });
    assert.equal(p.handoverCount, 0, 'with no limits at all, nobody needs to get out');
    assert.equal(p.perDriver.find((d) => d.name === 'A').stints, 6);
});

test('handovers are minimised subject to the continuous-stint limit', () => {
    const p = DR.planDriverStints({
        stints: makeStints(6),
        drivers: [
            { name: 'A', maxContinuousStints: 2 },
            { name: 'B', maxContinuousStints: 2 },
        ],
    });
    // Six stints, two at a time: A A | B B | A A -> two handovers, the minimum.
    assert.equal(p.handoverCount, 2);
    assert.ok(p.stints.slice(0, 2).every((s) => s.driver === p.stints[0].driver));
});

test('each handover carries its time cost', () => {
    const p = DR.planDriverStints({
        stints: makeStints(6),
        drivers: [{ name: 'A', maxContinuousStints: 1 }, { name: 'B', maxContinuousStints: 1 }],
        rules: { driverChangeS: 32 },
    });
    assert.equal(p.handoverCount, 5);
    assert.equal(p.handoverTimeS, 5 * 32);
});

// --- constraints ----------------------------------------------------------

test('continuous time at the wheel is respected', () => {
    const p = DR.planDriverStints({
        stints: makeStints(6, 3600),
        drivers: [{ name: 'A', maxContinuousS: 2 * 3600 }, { name: 'B', maxContinuousS: 2 * 3600 }],
    });
    for (const d of p.perDriver) assert.ok(d.longestRunS <= 2 * 3600 + 1, `${d.name} ran too long`);
    assert.equal(p.violations.length, 0);
});

test('total drive time is respected', () => {
    const p = DR.planDriverStints({
        stints: makeStints(6, 3600),
        drivers: [{ name: 'A', maxTotalS: 3 * 3600 }, { name: 'B', maxTotalS: 3 * 3600 }],
    });
    for (const d of p.perDriver) assert.ok(d.totalS <= 3 * 3600 + 1);
    assert.equal(p.violations.filter((v) => v.issue === 'maximum drive time').length, 0);
});

test('a rolling window is honoured, not just the totals', () => {
    // No more than two hours at the wheel in any three-hour period.
    const p = DR.planDriverStints({
        stints: makeStints(8, 3600, 0),
        drivers: [{ name: 'A' }, { name: 'B' }],
        rules: { rollingWindow: { windowS: 3 * 3600, maxS: 2 * 3600 } },
    });
    for (const d of ['A', 'B']) {
        for (let t = 3600; t <= 8 * 3600; t += 1800) {
            const used = DR.timeInWindow(
                p.stints.reduce((acc, s, i) => {
                    const start = i * 3600;
                    acc.push({ driver: s.driver, startS: start, endS: start + 3600 });
                    return acc;
                }, []), d, t, 3 * 3600);
            assert.ok(used <= 2 * 3600 + 1, `${d} exceeded the window at ${t}s`);
        }
    }
});

// --- minimum seat time ----------------------------------------------------

test('a driver with a minimum gets their time, even against a quicker team-mate', () => {
    const p = DR.planDriverStints({
        stints: makeStints(10, 3600),
        drivers: [
            { name: 'Pro', paceDeltaS: 0 },
            { name: 'Bronze', paceDeltaS: 2.0, minTotalS: 3 * 3600 },
        ],
    });
    const bronze = p.perDriver.find((d) => d.name === 'Bronze');
    assert.ok(bronze.totalS >= 3 * 3600, `Bronze got ${bronze.totalS}s`);
    assert.equal(p.violations.filter((v) => v.issue === 'minimum drive time').length, 0);
});

test('the minimum is protected while stints remain, not discovered at the end', () => {
    // The lookahead exists because without it the planner triple-stints the
    // quick driver and only notices the shortfall when it is unfixable.
    const p = DR.planDriverStints({
        stints: makeStints(4, 3600),
        drivers: [{ name: 'Pro' }, { name: 'Bronze', minTotalS: 2 * 3600 }],
    });
    assert.ok(p.perDriver.find((d) => d.name === 'Bronze').totalS >= 2 * 3600);
});

test('free choices go to the quicker driver', () => {
    const p = DR.planDriverStints({
        stints: makeStints(4, 3600),
        drivers: [
            { name: 'Slow', paceDeltaS: 1.5, maxContinuousStints: 1 },
            { name: 'Quick', paceDeltaS: 0, maxContinuousStints: 1 },
        ],
    });
    assert.equal(p.stints[0].driver, 'Quick', 'first stint to the quicker driver');
});

// --- honesty --------------------------------------------------------------

test('an impossible set of rules is reported, not silently broken', () => {
    const p = DR.planDriverStints({
        stints: makeStints(6, 3600),
        drivers: [{ name: 'Solo', maxTotalS: 2 * 3600 }],
    });
    assert.ok(p.violations.length > 0);
    assert.ok(p.violations.some((v) => v.issue === 'no eligible driver' || v.issue === 'maximum drive time'));
});

test('an unmeetable minimum is surfaced against the finished plan', () => {
    const p = DR.planDriverStints({
        stints: makeStints(2, 3600),
        drivers: [{ name: 'A' }, { name: 'B', minTotalS: 5 * 3600 }],
    });
    assert.ok(p.violations.some((v) => v.issue === 'minimum drive time' && v.driver === 'B'));
});

test('no drivers at all is an error rather than an empty plan', () => {
    assert.throws(() => DR.planDriverStints({ stints: makeStints(3), drivers: [] }), /at least one driver/);
});

// --- the schedule ---------------------------------------------------------

test('handovers resolve to wall-clock times in the team timezone', () => {
    const p = DR.planDriverStints({
        stints: makeStints(4, 3600),
        drivers: [{ name: 'A', maxContinuousStints: 1 }, { name: 'B', maxContinuousStints: 1 }],
    });
    const sched = DR.handoverSchedule(p, {
        startsAt: '2026-06-13T13:00:00Z', timeZone: 'Europe/Budapest',
    });

    assert.equal(sched.length, 3);
    for (const h of sched) {
        assert.ok(h.wallClock, 'a wall-clock time the team can set an alarm by');
        assert.ok(h.readyBy, 'and a be-ready-by time');
        assert.ok(h.from && h.to && h.from !== h.to);
        assert.ok(h.atLap > 0);
    }
    // 13:00 UTC is 15:00 in Budapest; the first stop is an hour and a stop later.
    assert.match(sched[0].wallClock, /16:0\d/);
});

test('without a start time the schedule still gives race time', () => {
    const p = DR.planDriverStints({
        stints: makeStints(3, 3600),
        drivers: [{ name: 'A', maxContinuousStints: 1 }, { name: 'B', maxContinuousStints: 1 }],
    });
    const sched = DR.handoverSchedule(p, {});
    assert.equal(sched[0].wallClock, null);
    assert.ok(sched[0].raceClock);
});

test('a single over-long stint breaches a continuous limit just as much as two', () => {
    // The check used to be skipped unless the driver was already in the car,
    // so a first stint longer than the limit passed unnoticed.
    const p = DR.planDriverStints({
        stints: makeStints(2, 4 * 3600),
        drivers: [{ name: 'A', maxContinuousS: 3600 }],
    });
    assert.ok(p.violations.some((v) => v.issue === 'no eligible driver'));
});

test('omitted rules fall back to defaults instead of becoming undefined', () => {
    // `{ driverChangeS: undefined }` spread over defaults wins, which made
    // 0 * undefined = NaN and poisoned every downstream total.
    const p = DR.planDriverStints({
        stints: makeStints(4), drivers: [{ name: 'A' }], rules: {},
    });
    assert.equal(p.driverChangeS, DR.DEFAULTS.driverChangeS);
    assert.equal(p.handoverTimeS, 0);
    assert.ok(Number.isFinite(p.handoverTimeS));
});
