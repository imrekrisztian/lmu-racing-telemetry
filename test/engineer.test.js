'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RULES, THRESHOLDS } = require('../src/engineer/rules');
const { evaluate } = require('../src/engineer/engine');

const rule = (id) => RULES.find((r) => r.id === id);
const T = THRESHOLDS;

/** Minimal context; each test fills in only what its rule reads. */
const ctx = (over = {}) => ({
    mine: [], ref: [], deltas: [], technique: [], tyres: [],
    balance: null, consistency: null, priority: new Map(), liftCandidates: [],
    ...over,
});

const corner = (seg, o = {}) => ({
    seg_num: seg, brake_point_m: 1000, min_speed_ms: 30, apex_m: 1100,
    throttle_point_m: 1150, entry_speed_ms: 70, exit_speed_ms: 60, ...o,
});
const tech = (seg, o = {}) => ({
    seg_num: seg, apex_m: 1100, length_m: 400, coast_m: 0, overlap_m: 0,
    plateau_m: 10, peak_brake: 0.9, brake_release_m: 5, brake_build_m: 5,
    throttle_drops: 0, steer_reversals: 0, ...o,
});

// --- technique rules ------------------------------------------------------

test('coasting fires with the fraction of the corner wasted', () => {
    const c = ctx({ technique: [tech(4, { coast_m: 80, length_m: 400 })] });
    const [f] = rule('technique.coasting').evaluate(c, T);
    assert.ok(f);
    assert.equal(f.severity, 'strong');              // 80 > 2x threshold
    assert.equal(f.evidence.coast_m, 80);
    assert.equal(f.evidence.coast_fraction, 0.2);
    assert.match(f.detail, /neither throttle nor brake/);
});

test('coasting stays quiet below the threshold', () => {
    const c = ctx({ technique: [tech(4, { coast_m: T.coastM - 1 })] });
    assert.equal(rule('technique.coasting').evaluate(c, T).length, 0);
});

test('releasing the brakes long before the apex is called out as no trail braking', () => {
    const c = ctx({ technique: [tech(6, { brake_release_m: 55 })] });
    const [f] = rule('technique.no-trail-braking').evaluate(c, T);
    assert.ok(f);
    assert.equal(f.evidence.brake_release_before_apex_m, 55);
    assert.match(f.detail, /rotate/);
});

test('trail braking into the apex produces no finding', () => {
    const c = ctx({ technique: [tech(6, { brake_release_m: 3 })] });
    assert.equal(rule('technique.no-trail-braking').evaluate(c, T).length, 0);
});

test('a U-shaped corner is flagged, a V-shaped one is not', () => {
    const u = ctx({ technique: [tech(2, { plateau_m: 160, length_m: 400 })] });
    const [f] = rule('technique.minimum-speed-plateau').evaluate(u, T);
    assert.ok(f);
    assert.equal(f.evidence.plateau_fraction, 0.4);
    assert.match(f.detail, /V, not a U/);

    const v = ctx({ technique: [tech(2, { plateau_m: 20, length_m: 400 })] });
    assert.equal(rule('technique.minimum-speed-plateau').evaluate(v, T).length, 0);
});

test('a slow brake build is flagged against where downforce is highest', () => {
    const c = ctx({ technique: [tech(3, { brake_build_m: 40 })] });
    const [f] = rule('technique.soft-initial-brake').evaluate(c, T);
    assert.ok(f);
    assert.match(f.detail, /downforce/);
});

test('repeated lifts on exit are flagged', () => {
    const c = ctx({ technique: [tech(5, { throttle_drops: 4 })] });
    const [f] = rule('technique.throttle-modulation').evaluate(c, T);
    assert.equal(f.evidence.throttle_drops, 4);
    assert.match(f.detail, /rear is letting go/);
});

test('busy steering is flagged for tyre wear, not just lap time', () => {
    const c = ctx({ technique: [tech(7, { steer_reversals: 14 })] });
    const [f] = rule('technique.steering-reversals').evaluate(c, T);
    assert.match(f.detail, /scrubs the front tyres/);
});

test('pedal overlap is flagged against the energy allowance', () => {
    const c = ctx({ technique: [tech(9, { overlap_m: 30 })] });
    const [f] = rule('technique.pedal-overlap').evaluate(c, T);
    assert.match(f.detail, /energy allowance/);
});

// --- balance --------------------------------------------------------------

test('hotter fronts read as understeer, hotter rears as oversteer', () => {
    const under = ctx({ balance: { frontMean: 95, rearMean: 83, frontRearDelta: 12 } });
    const [u] = rule('balance.axle-temperature').evaluate(under, T);
    assert.match(u.title, /understeer/);
    assert.match(u.detail, /anti-roll bar/);

    const over = ctx({ balance: { frontMean: 82, rearMean: 96, frontRearDelta: -14 } });
    const [o] = rule('balance.axle-temperature').evaluate(over, T);
    assert.match(o.title, /oversteer/);
    assert.match(o.detail, /differential/);
});

test('a balanced car produces no balance finding', () => {
    const c = ctx({ balance: { frontMean: 90, rearMean: 87, frontRearDelta: 3 } });
    assert.equal(rule('balance.axle-temperature').evaluate(c, T).length, 0);
});

test('tread crown reads as pressure, shoulder spread as camber', () => {
    const hot = ctx({ tyres: [{ wheel: 'fl', inner_c: 85, mid_c: 95, outer_c: 85, pressure_kpa: 170 }] });
    const [p] = rule('tyre.pressure').evaluate(hot, T);
    assert.match(p.title, /pressure looks high/);
    assert.equal(p.evidence.crown_c, 10);

    const camber = ctx({ tyres: [{ wheel: 'fr', inner_c: 102, mid_c: 92, outer_c: 82 }] });
    const [c] = rule('tyre.camber').evaluate(camber, T);
    assert.equal(c.evidence.spread_c, 20);
    assert.match(c.detail, /reducing it/);
});

// --- comparative rules ----------------------------------------------------

test('overdriving needs BOTH a later brake point and a slower apex', () => {
    const over = ctx({
        mine: [corner(4, { brake_point_m: 1040, min_speed_ms: 28 })],
        ref: [corner(4, { brake_point_m: 1000, min_speed_ms: 32 })],
        deltas: [{ seg_num: 4, lost_s: 0.3 }],
    });
    const [f] = rule('entry.overdriving').evaluate(over, T);
    assert.ok(f);
    assert.equal(f.severity, 'strong');
    assert.match(f.detail, /costing more than it gains/);

    // Later brake but FASTER apex is just a better corner, not overdriving.
    const good = ctx({
        mine: [corner(4, { brake_point_m: 1040, min_speed_ms: 34 })],
        ref: [corner(4, { brake_point_m: 1000, min_speed_ms: 32 })],
        deltas: [{ seg_num: 4, lost_s: 0.3 }],
    });
    assert.equal(rule('entry.overdriving').evaluate(good, T).length, 0);
});

test('comparative rules stay silent where no time is actually lost', () => {
    const c = ctx({
        mine: [corner(4, { brake_point_m: 900 })],
        ref: [corner(4, { brake_point_m: 1000 })],
        deltas: [{ seg_num: 4, lost_s: 0.001 }],      // 1ms: not worth saying
    });
    assert.equal(rule('braking.early').evaluate(c, T).length, 0);
});

// --- engine behaviour -----------------------------------------------------

test('a corner feeding a long straight is promoted', () => {
    const base = {
        technique: [tech(2, { coast_m: 30, length_m: 400 })],
        deltas: [{ seg_num: 2, lost_s: 0.1 }],
    };
    const low = evaluate(ctx({ ...base, priority: new Map([[2, 50], [4, 1000]]) }));
    const high = evaluate(ctx({ ...base, priority: new Map([[2, 1000], [4, 50]]) }));

    assert.equal(low[0].severity, 'suggest');
    assert.equal(high[0].severity, 'strong', 'exit priority should promote it');
    assert.match(high[0].detail, /carried the whole way down/);
});

test('findings are ranked by severity and capped', () => {
    const c = ctx({
        technique: [
            tech(1, { coast_m: 100, length_m: 400 }),     // strong
            tech(2, { steer_reversals: 20 }),             // info
            tech(3, { brake_release_m: 60 }),             // suggest
            tech(4, { brake_build_m: 50 }),               // info
        ],
    });
    const out = evaluate(c, { limit: 2 });
    assert.equal(out.length, 2, 'capped');
    assert.equal(out[0].severity, 'strong', 'worst first');
});

test('one broken rule does not take the engineer down', () => {
    const original = RULES[0].evaluate;
    RULES[0].evaluate = () => { throw new Error('boom'); };
    try {
        const out = evaluate(ctx({ technique: [tech(1, { coast_m: 100 })] }), { limit: 10 });
        assert.ok(out.some((f) => f._failed), 'the failure is surfaced');
        assert.ok(out.some((f) => f.rule_id === 'technique.coasting'), 'other rules still ran');
    } finally {
        RULES[0].evaluate = original;
    }
});

test('a clean lap produces nothing', () => {
    const out = evaluate(ctx({ technique: [tech(1)], balance: { frontMean: 90, rearMean: 89, frontRearDelta: 1 } }));
    assert.equal(out.length, 0);
});
