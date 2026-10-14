'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { open } = require('../db/open.js');
const api = require('../src/app/api.js');

const DB = '/tmp/lmu-api-test.duckdb';
let con, sessions, laps, track;

before(async () => {
    for (const f of [DB, DB + '.wal']) fs.rmSync(f, { force: true });
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed.js'), DB],
        { stdio: 'ignore' });
    ({ con } = await open(DB));
    sessions = await api.listSessions(con);
    laps = await api.listLaps(con);
    track = sessions[0].track;
});

after(() => { try { con.closeSync(); } catch {} });

test('the seed script produces a usable database', () => {
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => s.lap_count > 0 && s.best_lap_s > 0));
    assert.ok(laps.length >= 8);
});

test('laps can be filtered by session', async () => {
    const one = await api.listLaps(con, { sessionId: sessions[0].session_id });
    assert.ok(one.length > 0);
    assert.ok(one.every((l) => l.session_id === sessions[0].session_id));
});

test('traces come back columnar and aligned, in display units', async () => {
    const t = await api.lapTrace(con, { lapId: laps[1].lap_id });
    const len = t.dist.length;
    assert.ok(len > 10000, 'a 13.6km lap on a 1m grid');
    for (const k of ['speed', 'throttle', 'brake', 'steer', 'gear']) {
        assert.equal(t[k].length, len, `${k} must align with dist`);
    }
    // km/h not m/s, percent not fraction -- the chart layer should not convert.
    assert.ok(Math.max(...t.speed) > 250 && Math.max(...t.speed) < 400);
    assert.ok(Math.max(...t.throttle) <= 100.001);
    assert.ok(Math.min(...t.brake) >= 0);
    for (let i = 1; i < t.dist.length; i++) assert.ok(t.dist[i] > t.dist[i - 1], 'monotonic');
});

test('the delta trace aligns with the lap-time gap', async () => {
    const mine = laps.filter((l) => l.driver === 'Krisztian' && l.lap_time_s);
    const ref = laps.filter((l) => l.driver === 'Reference' && l.lap_time_s);
    const d = await api.lapDelta(con, { lapA: mine[1].lap_id, lapB: ref[1].lap_id });

    assert.equal(d.dist.length, d.delta.length);
    const final = d.delta.at(-1);
    const gap = mine[1].lap_time_s - ref[1].lap_time_s;
    assert.ok(Math.abs(final - gap) < 1.0, `delta ${final.toFixed(3)}s vs gap ${gap.toFixed(3)}s`);
});

test('segments and losses are available for the track', async () => {
    const segs = await api.trackSegments(con, { track });
    assert.equal(segs.length, 17);
    assert.equal(segs.filter((s) => s.kind === 'corner').length, 8);

    const mine = laps.filter((l) => l.driver === 'Krisztian' && l.lap_time_s);
    const ref = laps.filter((l) => l.driver === 'Reference' && l.lap_time_s);
    const losses = await api.segmentLosses(con, { track, lapA: mine[1].lap_id, lapB: ref[1].lap_id });
    assert.equal(losses.length, 17);
});

test('the engineer has pre-run findings the UI can open with', async () => {
    const mine = laps.filter((l) => l.driver === 'Krisztian' && l.lap_time_s);
    const advice = await api.pastAdvice(con, { lapId: mine[1].lap_id });
    assert.ok(advice.length > 0);
    for (const a of advice) {
        assert.ok(a.title && a.severity && a.rule_id);
        assert.ok(a.evidence && typeof a.evidence === 'object', 'evidence survives the JSON round trip');
    }
});

test('feedback from the UI lands and shows up in the scorecard', async () => {
    const mine = laps.filter((l) => l.driver === 'Krisztian' && l.lap_time_s);
    const [first] = await api.pastAdvice(con, { lapId: mine[1].lap_id });
    await api.recordFeedback(con, {
        adviceId: first.advice_id, rating: 1, applied: true, driverNote: 'from the UI',
    });
    const after = await api.pastAdvice(con, { lapId: mine[1].lap_id });
    const updated = after.find((a) => a.advice_id === first.advice_id);
    assert.equal(updated.applied, true);
    assert.equal(updated.driver_note, 'from the UI');

    const scores = await api.ruleScores(con);
    assert.ok(scores.some((s) => s.applied >= 1));
});

test('strategy needs no database connection', () => {
    const plan = api.strategy(null, {
        durationS: 6 * 3600, lapTimeS: 212, carClass: 'Hyper',
        consumptionPerLap: 4.4, pitLaneDeltaS: 30, refuelRate: 3.0,
    });
    assert.ok(plan.stints.length > 1);
    assert.equal(plan.limiter, 'virtual-energy');
});

test('a bad lap id is rejected before it reaches SQL', async () => {
    await assert.rejects(() => api.lapTrace(con, { lapId: "'; DROP TABLE laps; --" }),
        /lapId is not a UUID/);
    await assert.rejects(() => api.lapDelta(con, { lapA: 'nope', lapB: laps[0].lap_id }),
        /lapA is not a UUID/);
});

test('advice replays in severity order, not insertion order', async () => {
    const mine = laps.filter((l) => l.driver === 'Krisztian' && l.lap_time_s);
    const advice = await api.pastAdvice(con, { lapId: mine[1].lap_id });
    const rank = { strong: 3, suggest: 2, info: 1 };
    for (let i = 1; i < advice.length; i++) {
        assert.ok(rank[advice[i].severity] <= rank[advice[i - 1].severity],
            `${advice[i].severity} appeared above ${advice[i - 1].severity}`);
    }
});

test('the renderer bundle exists for production loading', () => {
    const dist = path.join(__dirname, '..', 'ui', 'dist', 'index.html');
    assert.ok(fs.existsSync(dist), 'run "npm run ui:build" before packaging');
    const html = fs.readFileSync(dist, 'utf8');
    assert.match(html, /Content-Security-Policy/, 'CSP must survive the build');
    assert.match(html, /\.\/assets\//, 'asset paths must be relative for file:// loading');
});
