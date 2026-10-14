'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { open } = require('../db/open.js');
const { loadReference } = require('../src/live/reference.js');
const { LiveSession } = require('../src/live/session.js');
const { ReplaySource } = require('../src/live/replay.js');
const api = require('../src/app/api.js');

const DB = '/tmp/lmu-live-test.duckdb';
let con, laps, mine, ref;

before(async () => {
    for (const f of [DB, DB + '.wal']) fs.rmSync(f, { force: true });
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed.js'), DB], { stdio: 'ignore' });
    ({ con } = await open(DB));
    laps = await api.listLaps(con);
    mine = laps.filter((l) => l.driver === 'Krisztian' && l.lap_time_s);
    ref = laps.filter((l) => l.driver === 'Reference' && l.lap_time_s);
});

after(() => { try { con.closeSync(); } catch {} });

// --- reference curve ------------------------------------------------------

test('the reference curve is monotonic in time and spans the lap', async () => {
    const r = await loadReference(con, { lapId: ref[1].lap_id });
    assert.ok(r.maxDist > 13000);
    assert.ok(Math.abs(r.lapTimeS - ref[1].lap_time_s) < 1.0);

    let prev = -1;
    for (let d = 0; d <= r.maxDist; d += 100) {
        const t = r.timeAt(d);
        assert.ok(t >= prev, `time went backwards at ${d}m`);
        prev = t;
    }
});

test('reference lookups interpolate and clamp at the ends', async () => {
    const r = await loadReference(con, { lapId: ref[1].lap_id });
    assert.equal(r.timeAt(0), 0);
    assert.equal(r.timeAt(-50), 0, 'before the line clamps to zero');
    assert.equal(r.timeAt(r.maxDist + 5000), r.timeAt(r.maxDist), 'past the line clamps');

    const mid = r.timeAt(5000.5);
    assert.ok(mid > r.timeAt(5000) && mid < r.timeAt(5001), 'interpolated between bins');
});

// --- live delta -----------------------------------------------------------

test('a lap replayed against itself holds delta at zero', async () => {
    const r = await loadReference(con, { lapId: mine[1].lap_id });
    const live = new LiveSession({ reference: r });
    const src = await new ReplaySource(con, { lapIds: [mine[1].lap_id] }).load();

    let maxAbsDelta = 0;
    for (const s of src.timeline) {
        const snap = live.update(s);
        if (snap.lap.deltaS != null) maxAbsDelta = Math.max(maxAbsDelta, Math.abs(snap.lap.deltaS));
    }
    assert.ok(maxAbsDelta < 0.05, `self-delta drifted to ${maxAbsDelta.toFixed(3)}s`);
});

test('live delta converges on the real lap-time gap by the line', async () => {
    const r = await loadReference(con, { lapId: ref[1].lap_id });
    const live = new LiveSession({ reference: r });
    const src = await new ReplaySource(con, { lapIds: [mine[1].lap_id] }).load();

    let last = null;
    for (const s of src.timeline) last = live.update(s);

    const gap = mine[1].lap_time_s - ref[1].lap_time_s;
    assert.ok(Math.abs(last.lap.deltaS - gap) < 0.5,
        `live delta ${last.lap.deltaS.toFixed(3)}s vs actual gap ${gap.toFixed(3)}s`);
    assert.ok(last.lap.deltaS > 0, 'the slower lap should read down');
});

// --- stint tracking -------------------------------------------------------

test('lap rollover records history, best lap and consumption', async () => {
    const r = await loadReference(con, { lapId: ref[1].lap_id });
    const live = new LiveSession({ reference: r, reserve: 0 });
    const src = await new ReplaySource(con, { lapIds: mine.slice(0, 4).map((l) => l.lap_id) }).load();

    for (const s of src.timeline) live.update(s);
    const snap = live.snapshot();

    assert.ok(snap.stint.laps >= 3, `expected several completed laps, got ${snap.stint.laps}`);
    assert.ok(snap.lap.bestLapS > 0);
    assert.ok(snap.history.length >= 3);
    assert.ok(snap.stint.perLap > 0, 'fuel use per lap is measured, not assumed');
    assert.ok(snap.stint.lapsLeft > 0, 'laps remaining derive from measured use');
});

test('consistency needs three laps before it reports anything', async () => {
    const live = new LiveSession({});
    assert.equal(live.consistencySd(), null);
    live.lapHistory = [{ timeS: 100 }, { timeS: 101 }];
    assert.equal(live.consistencySd(), null);
    live.lapHistory.push({ timeS: 102 });
    assert.ok(Math.abs(live.consistencySd() - 1) < 1e-9);
});

test('consumption ignores laps with no fuel figure rather than counting them as zero', () => {
    const live = new LiveSession({});
    live.lapHistory = [{ timeS: 100, fuelUsed: 4 }, { timeS: 100, fuelUsed: null }, { timeS: 100, fuelUsed: 4 }];
    assert.equal(live.consumptionPerLap(), 4);
});

// --- replay source --------------------------------------------------------

test('the replay timeline is continuous across lap boundaries', async () => {
    const src = await new ReplaySource(con, { lapIds: mine.slice(0, 3).map((l) => l.lap_id) }).load();
    assert.ok(src.loaded > 30000);
    for (let i = 1; i < src.timeline.length; i++) {
        assert.ok(src.timeline[i]._at >= src.timeline[i - 1]._at, 'timeline must not go backwards');
    }
    assert.ok(src.duration > 500, 'three laps of Le Mans is several minutes');
});

test('replay emits on a clock and stops at the end', async () => {
    const src = await new ReplaySource(con, { lapIds: [mine[1].lap_id], speed: 400 }).load();
    const seen = [];
    await new Promise((resolve) => {
        src.start((s) => seen.push(s), resolve);
        setTimeout(() => { src.stop(); resolve(); }, 4000);
    });
    assert.ok(seen.length > 5, `expected a stream of samples, got ${seen.length}`);
    assert.equal(src.timer, null, 'timer cleaned up');
});

test('a bad lap id is refused before it reaches SQL', async () => {
    await assert.rejects(() => new ReplaySource(con, { lapIds: ["'; DROP TABLE laps; --"] }).load(),
        /not a UUID/);
    await assert.rejects(() => loadReference(con, { lapId: 'nope' }), /not a UUID/);
});

test('the snapshot carries lap length so the UI need not hardcode a track', async () => {
    const r = await loadReference(con, { lapId: ref[1].lap_id });
    const live = new LiveSession({ reference: r });
    const src = await new ReplaySource(con, { lapIds: [mine[1].lap_id] }).load();
    const snap = live.update(src.timeline[0]);
    assert.ok(snap.lap.lapLengthM > 13000, 'lap length comes from the reference lap');
    assert.equal(snap.lap.lapLengthM, r.maxDist);
});

test('with no reference there is no delta, and nothing throws', async () => {
    const live = new LiveSession({ reference: null });
    const src = await new ReplaySource(con, { lapIds: [mine[1].lap_id] }).load();
    const snap = live.update(src.timeline[500]);
    assert.equal(snap.lap.deltaS, null);
    assert.equal(snap.lap.lapLengthM, null);
    assert.ok(snap.car.speedKmh > 0, 'the rest of the dashboard still works');
});
