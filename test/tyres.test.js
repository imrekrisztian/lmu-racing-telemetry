'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const T = require('../src/strategy/tyres.js');

const dry = (trackTemp) => ({ wetness_avg: 0.02, wetness_min: 0.0, wetness_max: 0.04, raining: 0, track_temp_c: trackTemp });

// --- the compound set -----------------------------------------------------

test('there is no intermediate -- slicks or full wets only', () => {
    for (const cls of Object.keys(T.COMPOUNDS)) {
        const names = T.compoundsFor(cls).map((c) => c.name.toLowerCase());
        assert.ok(!names.some((n) => n.includes('inter')), `${cls} must not offer an intermediate`);
        assert.equal(T.compoundsFor(cls).filter((c) => c.wet).length, 1, `${cls} has exactly one wet`);
    }
});

test('Michelin sidewall colours are carried through', () => {
    const byId = Object.fromEntries(T.compoundsFor('Hyper').map((c) => [c.id, c.colour]));
    assert.equal(byId.soft, '#e5e7eb');    // white
    assert.equal(byId.medium, '#eab308');  // yellow
    assert.equal(byId.hard, '#ef4444');    // red
    assert.equal(byId.wet, '#3b82f6');     // blue
});

// --- temperature windows --------------------------------------------------

test('slick choice follows the published operating windows', () => {
    assert.equal(T.slickForTemp('Hyper', 8).id, 'soft');     // 0-15
    assert.equal(T.slickForTemp('Hyper', 20).id, 'medium');  // 15-25
    assert.equal(T.slickForTemp('Hyper', 34).id, 'hard');    // >25
});

test('temperatures outside every window clamp to the nearest', () => {
    assert.equal(T.slickForTemp('Hyper', -5).id, 'soft');
    assert.equal(T.slickForTemp('Hyper', 75).id, 'hard');
});

test('window boundaries resolve to the warmer compound', () => {
    assert.equal(T.slickForTemp('Hyper', 15).id, 'medium');
    assert.equal(T.slickForTemp('Hyper', 25).id, 'hard');
});

test('classes carry their own compound sets', () => {
    assert.equal(T.compoundsFor('LMP2').filter((c) => !c.wet).length, 1, 'LMP2 runs one dry spec');
    assert.equal(T.compoundsFor('Hyper').filter((c) => !c.wet).length, 3);
});

// --- the call -------------------------------------------------------------

test('a dry track picks the slick suited to the surface', () => {
    assert.equal(T.recommendCompound({ conditions: dry(34) }).compound, 'hard');
    assert.equal(T.recommendCompound({ conditions: dry(20) }).compound, 'medium');
    assert.equal(T.recommendCompound({ conditions: dry(10) }).compound, 'soft');
});

test('heavy rain commits to wets whatever the track currently reads', () => {
    const r = T.recommendCompound({
        conditions: { wetness_avg: 0.05, raining: 0.7, track_temp_c: 18 },
    });
    assert.equal(r.compound, 'wet');
    assert.ok(r.confidence >= 0.9);
    assert.match(r.reasons.join(' '), /regardless of current track state/);
});

test('past the crossover means wets', () => {
    const r = T.recommendCompound({ conditions: { wetness_avg: 0.62, raining: 0.2, track_temp_c: 18 } });
    assert.equal(r.compound, 'wet');
});

test('in the crossover band the trend decides', () => {
    const wetting = Array.from({ length: 10 }, (_, i) => ({ t: i * 30, wet: 0.10 + i * 0.012 }));
    const drying = Array.from({ length: 10 }, (_, i) => ({ t: i * 30, wet: 0.30 - i * 0.012 }));
    const cond = { wetness_avg: 0.20, raining: 0.1, track_temp_c: 20 };

    const up = T.recommendCompound({ conditions: cond, history: wetting });
    assert.equal(up.compound, 'wet');
    assert.equal(up.trend, 'wetting');
    assert.match(up.reasons.join(' '), /No intermediate exists/);

    const down = T.recommendCompound({ conditions: cond, history: drying });
    assert.equal(down.compound, 'medium', 'drying track stays out on slicks');
    assert.equal(down.trend, 'drying');
    assert.ok(down.confidence < 0.8, 'and it is still a gamble');
});

test('a drying track past the crossover gets a shorter wet stint, not full confidence', () => {
    const drying = Array.from({ length: 10 }, (_, i) => ({ t: i * 30, wet: 0.60 - i * 0.02 }));
    const r = T.recommendCompound({
        conditions: { wetness_avg: 0.42, raining: 0.05, track_temp_c: 19 }, history: drying,
    });
    assert.equal(r.compound, 'wet');
    assert.ok(r.confidence < 0.9, 'drying lowers conviction');
    assert.match(r.reasons.join(' '), /short wet stint/);
});

test('a dry line with standing water off it lowers confidence and says why', () => {
    const r = T.recommendCompound({
        conditions: { wetness_avg: 0.08, wetness_min: 0.01, wetness_max: 0.6, raining: 0, track_temp_c: 22 },
    });
    assert.equal(r.compound, 'medium');
    assert.ok(r.confidence < 0.9);
    assert.match(r.reasons.join(' '), /off the dry line/);
});

test('a change is flagged against what is currently fitted', () => {
    const cond = { wetness_avg: 0.65, raining: 0.3, track_temp_c: 18 };
    assert.equal(T.recommendCompound({ conditions: cond, current: 'medium' }).change, true);
    assert.equal(T.recommendCompound({ conditions: cond, current: 'wet' }).change, false);
});

// --- trend maths ----------------------------------------------------------

test('the trend survives corrupt samples at maximum leverage', () => {
    // Least squares fails this: an outlier at the end of the window has the
    // highest leverage and flattens the slope to "steady", which in the
    // crossover band flips the tyre call. Theil-Sen does not care.
    const noisy = Array.from({ length: 12 }, (_, i) => ({ t: i * 20, wet: 0.2 + i * 0.01 }));
    noisy[11].wet = 0.05;
    assert.equal(T.wetnessTrend(noisy).direction, 'wetting');

    const several = Array.from({ length: 16 }, (_, i) => ({ t: i * 20, wet: 0.2 + i * 0.01 }));
    several[15].wet = 0.02; several[14].wet = 0.9; several[0].wet = 0.8;
    assert.equal(T.wetnessTrend(several).direction, 'wetting', 'three bad reads in sixteen');
});

test('a flat trace reads as steady, and short history does not guess', () => {
    const flat = Array.from({ length: 8 }, (_, i) => ({ t: i * 20, wet: 0.4 }));
    assert.equal(T.wetnessTrend(flat).direction, 'steady');
    assert.equal(T.wetnessTrend([{ t: 0, wet: 0.2 }]).direction, 'steady');
});

test('time-to-threshold is null when the track is heading the other way', () => {
    const drying = { slopePerS: -0.0004, direction: 'drying' };
    assert.equal(T.secondsToWetness(0.2, drying, 0.30), null, 'drying never reaches a wetter target');
    assert.ok(T.secondsToWetness(0.2, drying, 0.12) > 0, 'but it does reach a drier one');
});

test('no conditions yields no recommendation rather than a guess', () => {
    const r = T.recommendCompound({ conditions: null });
    assert.equal(r.compound, null);
    assert.equal(r.confidence, 0);
});

test('with nothing fitted there is no change to report', () => {
    // `change` must stay false when no compound is on the car, so the UI can
    // say "fit" rather than "stay on" something that is not there.
    const r = T.recommendCompound({
        conditions: { wetness_avg: 0.65, raining: 0.3, track_temp_c: 18 }, current: null,
    });
    assert.equal(r.change, false);
    assert.equal(r.compound, 'wet');
});
