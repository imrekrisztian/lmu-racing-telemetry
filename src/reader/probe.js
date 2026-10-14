'use strict';

// Phase 0 spike: how fast does LMU actually publish telemetry?
//
// Answers two questions independently, so they cross-check each other:
//   1. mDeltaTime  -- the physics interval the sim itself reports
//   2. observed    -- how often mVersionUpdateEnd actually changes
// If those disagree, trust neither until you know why.

const { openMapping } = require('./win-shm');
const L = require('./layout');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? dflt : args[i + 1];
};

const bufferName = argOf('buffer', 'Telemetry');
const durationSec = Number(argOf('seconds', 20));

if (!L.BUFFERS[bufferName]) {
    console.error(`Unknown buffer "${bufferName}". Options: ${Object.keys(L.BUFFERS).join(', ')}`);
    process.exit(1);
}

/**
 * Torn-read protocol. The writer bumps mVersionUpdateBegin before writing and
 * mVersionUpdateEnd after. A snapshot is coherent only if they match.
 * Returns null if we lost every race (writer mid-update).
 */
function readFrame(live, snapshot, retries = 8) {
    for (let i = 0; i < retries; i++) {
        const begin = live.readUInt32LE(L.HEADER.mVersionUpdateBegin);
        live.copy(snapshot, 0, 0, snapshot.length);
        const end = live.readUInt32LE(L.HEADER.mVersionUpdateEnd);
        if (begin === end && snapshot.readUInt32LE(L.HEADER.mVersionUpdateBegin) === end) {
            return end;
        }
    }
    return null;
}

function sanityCheck(snap) {
    const numVehicles = snap.readInt32LE(L.TELEMETRY.mNumVehicles);
    const deltaTime = snap.readDoubleLE(L.VEHICLE0.mDeltaTime);
    const elapsed = snap.readDoubleLE(L.VEHICLE0.mElapsedTime);
    const vehicleName = L.readFixedString(snap, L.VEHICLE0.mVehicleName, 64);
    const trackName = L.readFixedString(snap, L.VEHICLE0.mTrackName, 64);

    // Every field the live reader depends on, so a layout mismatch is caught
    // here rather than showing up as a plausible-but-wrong dashboard.
    const d = (k) => snap.readDoubleLE(L.VEHICLE0[k]);
    const speed = Math.hypot(d('mLocalVel'),
        snap.readDoubleLE(L.VEHICLE0.mLocalVel + 8),
        snap.readDoubleLE(L.VEHICLE0.mLocalVel + 16));
    const gear = snap.readInt32LE(L.VEHICLE0.mGear);
    const rpm = d('mEngineRPM');
    const thr = d('mUnfilteredThrottle');
    const brk = d('mUnfilteredBrake');
    const steer = d('mUnfilteredSteering');
    const fuel = d('mFuel');
    const bias = d('mRearBrakeBias');
    const water = d('mEngineWaterTemp');

    const checks = [
        ['mNumVehicles in 1..128', numVehicles >= 1 && numVehicles <= 128, numVehicles],
        ['mDeltaTime in 0.0005..0.5 s', deltaTime > 0.0005 && deltaTime < 0.5, deltaTime],
        ['mElapsedTime > 0', elapsed > 0, elapsed.toFixed(2)],
        ['mVehicleName is printable', /^[\x20-\x7E]{1,63}$/.test(vehicleName), JSON.stringify(vehicleName)],
        ['mTrackName is printable', /^[\x20-\x7E]{1,63}$/.test(trackName), JSON.stringify(trackName)],
        ['speed 0..130 m/s', speed >= 0 && speed < 130, (speed * 3.6).toFixed(1) + ' km/h'],
        ['mGear in -1..9', gear >= -1 && gear <= 9, gear],
        ['mEngineRPM 0..20000', rpm >= 0 && rpm < 20000, Math.round(rpm)],
        ['throttle 0..1', thr >= -0.01 && thr <= 1.01, thr.toFixed(3)],
        ['brake 0..1', brk >= -0.01 && brk <= 1.01, brk.toFixed(3)],
        ['steering -1..1', steer >= -1.01 && steer <= 1.01, steer.toFixed(3)],
        ['mFuel 0..200 L', fuel >= 0 && fuel < 200, fuel.toFixed(1)],
        ['mRearBrakeBias 0..1', bias >= 0 && bias <= 1, bias.toFixed(3)],
        ['water temp 0..200 C', water > 0 && water < 200, water.toFixed(1)],
    ];

    return { checks, deltaTime, elapsed, numVehicles, vehicleName, trackName };
}

function main() {
    const mappingName = L.BUFFERS[bufferName];
    console.log(`Opening ${mappingName} ...`);

    const { live, close } = openMapping(mappingName, L.PROBE_WINDOW_BYTES);
    const snapshot = Buffer.allocUnsafe(L.PROBE_WINDOW_BYTES);

    const first = readFrame(live, snapshot);
    if (first === null) {
        console.error('Could not get a coherent frame. Is the sim paused or in the menu?');
        close();
        process.exit(1);
    }

    const s = sanityCheck(snapshot);
    console.log('\n--- OFFSET SANITY CHECK ---');
    let allPass = true;
    for (const [label, ok, value] of s.checks) {
        if (!ok) allPass = false;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} = ${value}`);
    }
    if (!allPass) {
        console.log('\n  >> At least one check FAILED. The offsets in src/layout.js do not match');
        console.log('     your plugin build. Fix those before trusting any rate number below.\n');
    } else {
        console.log(`\n  Track: ${s.trackName}   Car: ${s.vehicleName}   Vehicles: ${s.numVehicles}`);
        console.log(`  Sim-reported physics rate: ${(1 / s.deltaTime).toFixed(1)} Hz (mDeltaTime=${s.deltaTime})`);
    }

    console.log(`\n--- MEASURING FOR ${durationSec}s (busy-polls one core by design) ---`);

    let lastVersion = first;
    let lastElapsed = s.elapsed;
    let frames = 0, polls = 0, tornGiveUps = 0;
    let elapsedDeltas = [];

    const startNs = process.hrtime.bigint();
    let windowStartNs = startNs;
    let windowFrames = 0;
    const endNs = startNs + BigInt(Math.round(durationSec * 1e9));

    while (process.hrtime.bigint() < endNs) {
        polls++;
        const version = readFrame(live, snapshot);
        if (version === null) { tornGiveUps++; continue; }

        if (version !== lastVersion) {
            lastVersion = version;
            frames++; windowFrames++;

            const et = snapshot.readDoubleLE(L.VEHICLE0.mElapsedTime);
            if (et > lastElapsed) { elapsedDeltas.push(et - lastElapsed); lastElapsed = et; }
        }

        const nowNs = process.hrtime.bigint();
        if (nowNs - windowStartNs >= 1_000_000_000n) {
            const secs = Number(nowNs - windowStartNs) / 1e9;
            console.log(`  ${(windowFrames / secs).toFixed(1).padStart(6)} Hz observed   (${polls} polls)`);
            windowStartNs = nowNs; windowFrames = 0; polls = 0;
        }
    }

    const totalSec = Number(process.hrtime.bigint() - startNs) / 1e9;
    close();

    const median = (xs) => {
        if (!xs.length) return NaN;
        const a = [...xs].sort((p, q) => p - q);
        return a[Math.floor(a.length / 2)];
    };
    const medET = median(elapsedDeltas);

    console.log('\n--- RESULT ---');
    console.log(`  Observed update rate : ${(frames / totalSec).toFixed(1)} Hz  (${frames} frames in ${totalSec.toFixed(1)}s)`);
    console.log(`  Sim mDeltaTime rate  : ${(1 / s.deltaTime).toFixed(1)} Hz`);
    if (!Number.isNaN(medET)) {
        console.log(`  Median mElapsedTime step: ${(medET * 1000).toFixed(2)} ms  -> ${(1 / medET).toFixed(1)} Hz`);
    }
    console.log(`  Torn-read give-ups   : ${tornGiveUps}`);

    const hz = frames / totalSec;
    console.log('\n--- VERDICT ---');
    if (hz >= 40) {
        console.log(`  ${hz.toFixed(0)} Hz: good. Corner-level telemetry coaching is viable.`);
        console.log('  Proceed with feature #1 as specced.');
    } else if (hz >= 20) {
        console.log(`  ${hz.toFixed(0)} Hz: usable but tight (~${(60 / hz).toFixed(1)} m between samples at 200 km/h).`);
        console.log('  Braking-point work will need interpolation; validate before committing to it.');
    } else {
        console.log(`  ${hz.toFixed(0)} Hz: too coarse for brake-point coaching`);
        console.log(`  (~${(55.6 / hz).toFixed(1)} m between samples at 200 km/h).`);
        console.log('  Re-scope #1 toward lap/sector analytics, and check that');
        console.log('  EnableDirectMemoryAccess=1 is actually set before accepting this.');
    }
}

try {
    main();
} catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
}
