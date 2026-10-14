'use strict';

// Full pipeline on synthetic data: frames -> LapTracker -> Writer -> DuckDB,
// then compare two drivers through lap_delta(). Runs anywhere; no sim needed.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { open } = require('../db/open.js');
const { Writer } = require('../src/ingest/writer.js');
const { LapTracker } = require('../src/ingest/lap-tracker.js');
const { syntheticFrames, DEFAULT_TRACK } = require('../src/reader/synthetic-source.js');

const DB = '/tmp/lmu-e2e.duckdb';

async function ingestRun(writer, { skill, driver }) {
    const sessionId = await writer.createSession({
        track: DEFAULT_TRACK.name, track_length_m: DEFAULT_TRACK.lengthM,
        car: 'Porsche 963', car_class: 'Hyper', session_type: 'practice',
        driver, sample_rate_hz: 90,
    });

    const lapIds = [];
    const tracker = new LapTracker();
    for (const f of syntheticFrames({ laps: 2, sampleRateHz: 90, skill })) {
        const done = tracker.push(f);
        if (done) lapIds.push(await writer.writeLap(sessionId, done));
    }
    return { sessionId, lapIds, stats: tracker.stats };
}

test('end-to-end: ingest two drivers and compare them', async (t) => {
    fs.rmSync(DB, { force: true });
    const { con } = await open(DB);
    const writer = await new Writer(con).init();

    const t0 = Date.now();
    const slow = await ingestRun(writer, { skill: 1.00, driver: 'baseline' });
    const fast = await ingestRun(writer, { skill: 1.03, driver: 'reference' });
    const ms = Date.now() - t0;
    writer.close();

    const rows = async (sql) => (await con.runAndReadAll(sql)).getRowObjects();

    // --- ingest sanity ----------------------------------------------------
    assert.equal(slow.lapIds.length, 2, 'two completed laps per run');
    assert.ok(slow.stats.anchors > 0 && slow.stats.integratedFrames > 0,
        'both the scoring anchor and the integration path were exercised');

    const [counts] = await rows('SELECT count(*) AS n FROM samples');
    const total = Number(counts.n);
    t.diagnostic(`${total} samples from 4 laps in ${ms}ms (${Math.round(total / (ms / 1000))} rows/s)`);
    assert.ok(total > 60000, `expected >60k samples, got ${total}`);

    // --- distance reconstruction -----------------------------------------
    // Proves integrate-between-anchors actually tracked the full lap.
    const [d] = await rows(`SELECT max(dist_m) AS max_d FROM samples
                            WHERE lap_id = '${slow.lapIds[1]}'`);
    const maxD = Number(d.max_d);
    assert.ok(Math.abs(maxD - DEFAULT_TRACK.lengthM) < DEFAULT_TRACK.lengthM * 0.02,
        `lap distance ${maxD.toFixed(0)}m should land within 2% of ${DEFAULT_TRACK.lengthM}m`);

    // --- the faster driver is actually faster -----------------------------
    const slowLap = await rows(`SELECT lap_time_s FROM laps WHERE lap_id = '${slow.lapIds[1]}'`);
    const fastLap = await rows(`SELECT lap_time_s FROM laps WHERE lap_id = '${fast.lapIds[1]}'`);
    const gap = Number(slowLap[0].lap_time_s) - Number(fastLap[0].lap_time_s);
    t.diagnostic(`lap times: ${Number(slowLap[0].lap_time_s).toFixed(3)}s vs ` +
                 `${Number(fastLap[0].lap_time_s).toFixed(3)}s  (gap ${gap.toFixed(3)}s)`);
    assert.ok(gap > 0, 'the 3%-more-apex-speed driver should be quicker');

    // --- lap_delta agrees with the lap times ------------------------------
    const delta = await rows(
        `SELECT delta_t_s FROM lap_delta('${slow.lapIds[1]}', '${fast.lapIds[1]}')
         ORDER BY dist_bin DESC LIMIT 1`);
    const finalDelta = Number(delta[0].delta_t_s);
    t.diagnostic(`lap_delta accumulated ${finalDelta.toFixed(3)}s vs ${gap.toFixed(3)}s from lap times`);
    assert.ok(finalDelta > 0, 'delta should show lap A losing time');
    assert.ok(Math.abs(finalDelta - gap) < 1.0,
        `integrated delta (${finalDelta.toFixed(3)}s) should track the lap-time gap (${gap.toFixed(3)}s)`);

    // --- the delta is monotonic through braking zones ---------------------
    const prof = await rows(
        `SELECT dist_bin, delta_t_s FROM lap_delta('${slow.lapIds[1]}', '${fast.lapIds[1]}')
         WHERE dist_bin IN (2000, 5000, 9000, 13000) ORDER BY dist_bin`);
    const vals = prof.map((r) => Number(r.delta_t_s));
    t.diagnostic('delta at 2/5/9/13km: ' + vals.map((v) => v.toFixed(3) + 's').join('  '));
    for (let i = 1; i < vals.length; i++) {
        assert.ok(vals[i] >= vals[i - 1] - 1e-6, 'delta should accumulate, not oscillate');
    }

    con.closeSync();
});
