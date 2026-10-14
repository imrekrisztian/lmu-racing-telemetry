'use strict';

// Verifies the two things the schema has to get right:
//   1. lap_delta() returns the analytically correct delta time
//   2. a reference .duckdb can be ATTACHed and joined across

const { open, attachReference } = require('../db/open.js');
const fs = require('node:fs');

const MINE = '/tmp/lmu-test-mine.duckdb';
const REF = '/tmp/lmu-test-ref.duckdb';
for (const f of [MINE, REF]) fs.rmSync(f, { force: true });

const rows = async (con, sql) => (await (await con.run(sql)).getRowObjects());

/** One lap at constant speed: trivially predictable lap time. */
async function seedLap(con, { sessionId, lapId, speed, metres }) {
    await con.run(`INSERT INTO sessions VALUES ('${sessionId}', now(), 'Le Mans', ${metres},
        'Porsche 963', 'Hyper', 'practice', 'test', '1.3.3', 'smm-3.7', 90.0, NULL)`);
    await con.run(`INSERT INTO laps (lap_id, session_id, lap_num, lap_time_s, valid)
        VALUES ('${lapId}', '${sessionId}', 1, ${metres / speed}, TRUE)`);
    // one sample per metre
    await con.run(`INSERT INTO samples (lap_id, dist_m, t_s, speed_ms, throttle, brake, steer, gear, rpm)
        SELECT '${lapId}', d::DOUBLE, d / ${speed}.0, ${speed}, 1.0, 0.0, 0.0, 6, 8000
        FROM range(0, ${metres}) t(d)`);
}

(async () => {
    let failures = 0;
    const check = (label, ok, detail) => {
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
        if (!ok) failures++;
    };

    const A = '11111111-1111-1111-1111-111111111111';
    const B = '22222222-2222-2222-2222-222222222222';

    const mine = await open(MINE);
    await seedLap(mine.con, { sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', lapId: A, speed: 50, metres: 1000 });
    await seedLap(mine.con, { sessionId: 'aaaaaaaa-0000-0000-0000-000000000002', lapId: B, speed: 55, metres: 1000 });

    console.log('\n--- delta-time math ---');
    const d = await rows(mine.con, `SELECT * FROM lap_delta('${A}', '${B}') ORDER BY dist_bin DESC LIMIT 1`);
    const got = Number(d[0].delta_t_s);
    const expected = 1000 / 50 - 1000 / 55;            // 20s - 18.1818s
    check('lap A is 1.818s slower over 1000m',
        Math.abs(got - expected) < 1e-6, `got ${got.toFixed(6)}s, expected ${expected.toFixed(6)}s`);

    // The running sum at bin N includes bin N, so 0..500 is 501 bins.
    // That inclusive right endpoint is correct; assert it exactly.
    const mid = await rows(mine.con, `SELECT delta_t_s FROM lap_delta('${A}', '${B}') WHERE dist_bin = 500`);
    const midExpected = 501 * (1 / 50 - 1 / 55);
    check('delta accumulates linearly (501 bins at dist_bin=500)',
        Math.abs(Number(mid[0].delta_t_s) - midExpected) < 1e-9,
        `${Number(mid[0].delta_t_s).toFixed(6)}s, expected ${midExpected.toFixed(6)}s`);

    const binned = await rows(mine.con, `SELECT count(*) n FROM lap_binned WHERE lap_id = '${A}'`);
    check('lap_binned produced a 1m grid', Number(binned[0].n) === 1000, `${binned[0].n} bins`);

    console.log('\n--- cross-file reference comparison ---');
    const ref = await open(REF);
    await seedLap(ref.con, { sessionId: 'bbbbbbbb-0000-0000-0000-000000000001', lapId: B, speed: 60, metres: 1000 });
    ref.con.closeSync(); ref.instance.closeSync();

    await attachReference(mine.con, REF, 'ref');
    const x = await rows(mine.con, `
        SELECT sum(1.0/m.speed_ms - 1.0/r.speed_ms) AS delta_t_s
        FROM lap_binned m
        JOIN ref.lap_binned r USING (dist_bin)
        WHERE m.lap_id = '${A}' AND r.lap_id = '${B}'`);
    const xExpected = 1000 / 50 - 1000 / 60;
    check('join across ATTACHed reference file',
        Math.abs(Number(x[0].delta_t_s) - xExpected) < 1e-6,
        `${Number(x[0].delta_t_s).toFixed(6)}s vs ${xExpected.toFixed(6)}s expected`);

    console.log('\n--- schema guard ---');
    await mine.con.run(`DETACH ref`);
    await mine.con.run(`ATTACH '/tmp/lmu-notours.duckdb' AS bogus`);
    await mine.con.run(`CREATE TABLE bogus.unrelated(x INT)`);
    await mine.con.run(`DETACH bogus`);
    let rejected = false;
    try { await attachReference(mine.con, '/tmp/lmu-notours.duckdb', 'bogus'); }
    catch (e) { rejected = /not an lmu-racing-telemetry database/.test(e.message); }
    check('rejects a foreign .duckdb instead of joining garbage', rejected);

    console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
