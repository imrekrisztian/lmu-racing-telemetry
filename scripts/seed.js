#!/usr/bin/env node
'use strict';

// Generates a demo database so the UI can be built and used on a machine with
// no sim attached. Same pipeline the real reader will feed, just a synthetic
// frame source in front of it.

const path = require('node:path');
const fs = require('node:fs');
const { open } = require('../db/open');
const { Writer } = require('../src/ingest/writer');
const { LapTracker } = require('../src/ingest/lap-tracker');
const { syntheticFrames, DEFAULT_TRACK } = require('../src/reader/synthetic-source');
const { deriveTrackSegments } = require('../src/analysis/corners');
const { analyse } = require('../src/engineer/engine');

const DRIVERS = [
    { driver: 'Krisztian', skill: 1.000, laps: 6 },
    { driver: 'Reference', skill: 1.035, laps: 4 },
];

async function main() {
    const file = process.argv[2] ?? path.join(process.cwd(), 'demo.duckdb');
    for (const f of [file, file + '.wal']) fs.rmSync(f, { force: true });

    const { con } = await open(file);
    const writer = await new Writer(con).init();
    const byDriver = {};

    for (const d of DRIVERS) {
        const sessionId = await writer.createSession({
            track: DEFAULT_TRACK.name, track_length_m: DEFAULT_TRACK.lengthM,
            car: 'Porsche 963', car_class: 'Hyper', session_type: 'practice',
            driver: d.driver, sim_version: 'demo', sample_rate_hz: 90,
        });
        const ids = [];
        const tracker = new LapTracker();
        for (const f of syntheticFrames({ laps: d.laps, sampleRateHz: 90, skill: d.skill })) {
            const done = tracker.push(f);
            if (done) ids.push(await writer.writeLap(sessionId, done));
        }
        byDriver[d.driver] = ids;
        process.stdout.write(`  ${d.driver.padEnd(12)} ${ids.length} laps\n`);
    }
    writer.close();

    const ref = byDriver.Reference.at(-1);
    const segs = await deriveTrackSegments(con, { track: DEFAULT_TRACK.name, lapId: ref });
    process.stdout.write(`  segments     ${segs.length} (${segs.filter((s) => s.kind === 'corner').length} corners)\n`);

    // Pre-run the engineer on the human laps so the UI opens with content.
    const mine = byDriver.Krisztian;
    for (const lapId of mine.slice(1)) {
        await analyse(con, {
            track: DEFAULT_TRACK.name, lapId, referenceLapId: ref, lapIds: mine, limit: 6,
        });
    }
    const [{ n }] = (await con.runAndReadAll('SELECT count(*) AS n FROM advice')).getRowObjects();
    process.stdout.write(`  advice       ${Number(n)} findings\n`);

    con.closeSync();
    process.stdout.write(`\nSeeded ${file}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
