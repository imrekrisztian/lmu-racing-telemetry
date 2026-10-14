'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeConditions } = require('../src/ingest/normalize.js');
const { syntheticFrames } = require('../src/reader/synthetic-source.js');
const U = require('../src/ingest/units.js');

test('scoring temps pass through as Celsius and are NOT converted', () => {
    // The trap: tyre temps in Telemetry are Kelvin, ambient and track in
    // Scoring are already Celsius. Running kToC over these would report -251C.
    const c = normalizeConditions({ ambientTemp: 21.5, trackTemp: 33.8 });
    assert.equal(c.air_temp_c, 21.5);
    assert.equal(c.track_temp_c, 33.8);
    assert.equal(U.celsius(21.5), 21.5);
});

test('rain, cloud and wetness are clamped to 0..1', () => {
    const c = normalizeConditions({
        raining: 1.4, darkCloud: -0.2,
        minPathWetness: 0.1, avgPathWetness: 0.5, maxPathWetness: 1.9,
    });
    assert.equal(c.raining, 1);
    assert.equal(c.cloud, 0);
    assert.equal(c.wetness_max, 1);
    assert.equal(c.wetness_avg, 0.5);
});

test('the wind vector reduces to a speed and a bearing', () => {
    const c = normalizeConditions({ wind: { x: 3, y: 0, z: 4 } });
    assert.ok(Math.abs(c.wind_ms - 5) < 1e-9, '3-4-5');
    assert.ok(Math.abs(c.wind_dir_rad - Math.atan2(4, 3)) < 1e-9);
});

test('absent conditions degrade to null rather than zero', () => {
    const c = normalizeConditions({});
    for (const k of ['air_temp_c', 'track_temp_c', 'raining', 'cloud', 'wind_ms', 'wetness_avg']) {
        assert.equal(c[k], null, `${k} should be null, not 0`);
    }
});

test('wetness lags rain: the track is still wet after the shower passes', () => {
    const series = [];
    let n = 0;
    for (const f of syntheticFrames({ laps: 9, sampleRateHz: 90 })) {
        if (n++ % 4500 === 0 && f.conditions) {
            const c = normalizeConditions(f.conditions);
            series.push({ t: f.elapsedTime, rain: c.raining, wet: c.wetness_avg });
        }
    }
    const peakRain = series.reduce((a, b) => (b.rain > a.rain ? b : a));
    const peakWet = series.reduce((a, b) => (b.wet > a.wet ? b : a));

    assert.ok(peakWet.t > peakRain.t, 'peak wetness must come after peak rain');

    // After the rain has essentially stopped, the circuit is still wet --
    // which is the entire reason crossover timing is a decision.
    const afterShower = series.filter((p) => p.t > peakRain.t && p.rain < 0.1);
    assert.ok(afterShower.length > 0);
    assert.ok(afterShower[0].wet > 0.25,
        `track should stay wet after the rain stops, was ${afterShower[0].wet.toFixed(2)}`);
});

test('track temperature falls with rain and recovers after', () => {
    const series = [];
    let n = 0;
    for (const f of syntheticFrames({ laps: 9, sampleRateHz: 90 })) {
        if (n++ % 4500 === 0 && f.conditions) series.push(normalizeConditions(f.conditions));
    }
    const start = series[0].track_temp_c;
    const coldest = Math.min(...series.map((c) => c.track_temp_c));
    const end = series[series.length - 1].track_temp_c;

    assert.ok(coldest < start - 8, 'a shower should cool the surface markedly');
    assert.ok(end > coldest + 5, 'and it should recover once the track dries');
    // Air moves far less than the surface does.
    const airSwing = Math.max(...series.map((c) => c.air_temp_c)) - Math.min(...series.map((c) => c.air_temp_c));
    const trackSwing = start - coldest;
    assert.ok(trackSwing > airSwing * 2, 'track temp must swing more than ambient');
});

test('the racing line is drier than the rest of the circuit', () => {
    let found = null;
    let n = 0;
    for (const f of syntheticFrames({ laps: 6, sampleRateHz: 90 })) {
        if (n++ % 4500 === 0 && f.conditions) {
            const c = normalizeConditions(f.conditions);
            if (c.wetness_avg > 0.3) { found = c; break; }
        }
    }
    assert.ok(found, 'expected a wet sample');
    assert.ok(found.wetness_min < found.wetness_avg);
    assert.ok(found.wetness_max > found.wetness_avg);
});
