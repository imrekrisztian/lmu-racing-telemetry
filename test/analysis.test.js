'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const { open } = require('../db/open.js');
const { Writer } = require('../src/ingest/writer.js');
const { LapTracker } = require('../src/ingest/lap-tracker.js');
const { syntheticFrames, DEFAULT_TRACK } = require('../src/reader/synthetic-source.js');
const { detectSegments, deriveTrackSegments } = require('../src/analysis/corners.js');
const A = require('../src/analysis/compare.js');

const DB = '/tmp/lmu-analysis-test.duckdb';
const TRACK = DEFAULT_TRACK.name;
let con, mine, ref, segments;

before(async () => {
    for (const f of [DB, DB + '.wal']) fs.rmSync(f, { force: true });
    ({ con } = await open(DB));
    const w = await new Writer(con).init();

    const run = async (skill, driver) => {
        const sid = await w.createSession({
            track: TRACK, track_length_m: DEFAULT_TRACK.lengthM, car: 'Porsche 963',
            car_class: 'Hyper', session_type: 'practice', driver, sample_rate_hz: 90,
        });
        const ids = []; const t = new LapTracker();
        for (const f of syntheticFrames({ laps: 4, sampleRateHz: 90, skill })) {
            const d = t.push(f); if (d) ids.push(await w.writeLap(sid, d));
        }
        return ids;
    };
    mine = await run(1.00, 'me');
    ref = await run(1.03, 'reference');
    w.close();

    segments = await deriveTrackSegments(con, { track: TRACK, lapId: ref[1] });
});

after(() => { try { con.closeSync(); } catch {} });

// --- corner detection -----------------------------------------------------

test('finds every corner the track actually has', () => {
    const corners = segments.filter((s) => s.kind === 'corner');
    assert.equal(corners.length, DEFAULT_TRACK.corners.length);

    for (const known of DEFAULT_TRACK.corners) {
        const hit = corners.find((c) => Math.abs(c.apex_m - known.dist) < 25);
        assert.ok(hit, `no apex detected within 25m of ${known.dist}m`);
    }
});

test('segments partition the lap exactly -- no gaps, no overlaps', () => {
    // This is the invariant that broke first time: walking out to the local
    // maximum ran adjacent corners across the flat top of a straight.
    for (let i = 1; i < segments.length; i++) {
        assert.equal(segments[i].start_m, segments[i - 1].end_m,
            `segment ${segments[i].seg_num} does not start where ${segments[i - 1].seg_num} ends`);
    }
    for (const s of segments) assert.ok(s.end_m > s.start_m, 'every segment has positive length');
});

test('corners and straights alternate', () => {
    for (let i = 1; i < segments.length; i++) {
        assert.notEqual(segments[i].kind, segments[i - 1].kind);
    }
});

test('an apex lies strictly inside its own corner', () => {
    for (const c of segments.filter((s) => s.kind === 'corner')) {
        assert.ok(c.apex_m > c.start_m && c.apex_m < c.end_m);
        assert.equal(segments.find((s) => s.kind === 'straight' && s.apex_m != null), undefined,
            'straights carry no apex');
    }
});

test('constant speed yields no corners at all', () => {
    const flat = Array.from({ length: 3000 }, (_, i) => ({ dist_bin: i, speed_ms: 70 }));
    assert.equal(detectSegments(flat).filter((s) => s.kind === 'corner').length, 0);
});

test('a shallow kink is not promoted to a corner', () => {
    const trace = Array.from({ length: 3000 }, (_, i) => ({
        dist_bin: i,
        speed_ms: i > 1400 && i < 1600 ? 68 : 70,   // a 3% dip
    }));
    assert.equal(detectSegments(trace).filter((s) => s.kind === 'corner').length, 0);
});

test('too short a trace is rejected rather than guessed at', () => {
    assert.throws(() => detectSegments([{ dist_bin: 0, speed_ms: 50 }]), /too short/);
});

// --- time-loss attribution ------------------------------------------------

test('segment losses sum to the total lap delta', async () => {
    const all = await A.segmentDeltas(con, { track: TRACK, lapA: mine[1], lapB: ref[1] });
    const summed = all.reduce((n, s) => n + s.lost_s, 0);

    const [{ delta_t_s: total }] = (await con.runAndReadAll(
        `SELECT delta_t_s FROM lap_delta('${mine[1]}', '${ref[1]}')
         ORDER BY dist_bin DESC LIMIT 1`)).getRowObjects();

    // Attribution must conserve the whole delta, or it is pointing at the
    // wrong corners.
    assert.ok(Math.abs(summed - Number(total)) < 0.05,
        `segments sum to ${summed.toFixed(3)}s but the lap delta is ${Number(total).toFixed(3)}s`);
});

test('worst segments come back ranked, worst first', async () => {
    const worst = await A.worstSegments(con, { track: TRACK, lapA: mine[1], lapB: ref[1] }, 5);
    assert.equal(worst.length, 5);
    for (let i = 1; i < worst.length; i++) {
        assert.ok(worst[i].lost_s <= worst[i - 1].lost_s);
    }
    assert.ok(worst[0].lost_s > 0, 'the slower lap loses time somewhere');
});

test('a lap compared against itself loses nothing anywhere', async () => {
    const all = await A.segmentDeltas(con, { track: TRACK, lapA: mine[1], lapB: mine[1] });
    for (const s of all) assert.ok(Math.abs(s.lost_s) < 1e-9, `segment ${s.seg_num} drifted`);
});

// --- corner metrics -------------------------------------------------------

test('braking precedes the apex, throttle follows it', async () => {
    const cm = await A.cornerMetrics(con, { track: TRACK, lapId: mine[1] });
    assert.equal(cm.length, 8);
    for (const c of cm) {
        assert.ok(c.brake_point_m <= c.apex_m, `seg ${c.seg_num}: braking after the apex`);
        assert.ok(c.throttle_point_m > c.apex_m, `seg ${c.seg_num}: throttle before the apex`);
        assert.ok(c.min_speed_ms > 0);
    }
});

test('the faster driver carries more apex speed', async () => {
    const slow = await A.cornerMetrics(con, { track: TRACK, lapId: mine[1] });
    const fast = await A.cornerMetrics(con, { track: TRACK, lapId: ref[1] });
    let faster = 0;
    for (let i = 0; i < slow.length; i++) {
        if (fast[i].min_speed_ms > slow[i].min_speed_ms) faster++;
    }
    assert.ok(faster >= 7, `expected the 3% driver quicker at nearly every apex, got ${faster}/8`);
});

// --- consistency ----------------------------------------------------------

test('consistency reports lap spread and per-corner variation', async () => {
    const c = await A.consistency(con, { track: TRACK, lapIds: mine });
    assert.ok(c.laps >= 3);
    assert.ok(c.bestLapS <= c.meanLapS);
    assert.ok(c.sdLapS >= 0);
    assert.equal(c.corners.length, 8);
    for (const k of c.corners) {
        assert.ok(k.apex_speed_sd >= 0);
        assert.ok(k.apex_speed_mean > 0);
    }
});

test('lap ids are validated before being inlined into SQL', async () => {
    await assert.rejects(
        () => A.segmentDeltas(con, { track: TRACK, lapA: "' OR 1=1 --", lapB: ref[1] }),
        /Not a UUID/
    );
});
