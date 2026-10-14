'use strict';

// Everything the UI can ask for.
//
// Deliberately a plain module over a DuckDB connection rather than a pile of
// ipcMain handlers: the renderer boundary is a thin forwarder, and all of this
// stays unit-testable without launching a browser window.
//
// Chart series come back COLUMNAR ([xs], [ys]) rather than as arrays of
// objects. uPlot consumes that shape directly, and it serialises across the
// IPC boundary at a fraction of the size.

const A = require('../analysis/compare');
const { deriveTrackSegments } = require('../analysis/corners');
const E = require('../engineer/engine');
const FB = require('../engineer/feedback');
const { planRace } = require('../strategy/planner');
const DEG = require('../analysis/degradation');
const LC = require('../strategy/lift-and-coast');
const FC = require('../strategy/forecast');
const { syntheticForecast } = require('../reader/synthetic-source');
const { assessLive } = require('../strategy/live');

const rows = async (con, sql, params) =>
    (await con.runAndReadAll(sql, params)).getRowObjects();
const n = (v) => (v == null ? null : Number(v));

async function listSessions(con) {
    const r = await rows(con, `
        SELECT s.session_id, s.started_at, s.track, s.car, s.car_class, s.session_type,
               s.driver, s.sample_rate_hz,
               count(l.lap_id)                                   AS lap_count,
               min(l.lap_time_s) FILTER (WHERE l.valid)          AS best_lap_s
        FROM sessions s LEFT JOIN laps l USING (session_id)
        GROUP BY ALL ORDER BY s.started_at DESC
    `);
    return r.map((x) => ({
        session_id: String(x.session_id),
        started_at: String(x.started_at),
        track: String(x.track),
        car: String(x.car),
        car_class: x.car_class == null ? null : String(x.car_class),
        session_type: x.session_type == null ? null : String(x.session_type),
        driver: x.driver == null ? null : String(x.driver),
        sample_rate_hz: n(x.sample_rate_hz),
        lap_count: Number(x.lap_count),
        best_lap_s: n(x.best_lap_s),
    }));
}

async function listLaps(con, { sessionId = null, track = null } = {}) {
    const where = [];
    const params = [];
    if (sessionId) { where.push('l.session_id = ?::UUID'); params.push(sessionId); }
    if (track) { where.push('s.track = ?'); params.push(track); }

    const r = await rows(con, `
        SELECT l.lap_id, l.session_id, l.lap_num, l.lap_time_s, l.valid,
               l.is_out_lap, l.is_in_lap, s.track, s.car, s.driver
        FROM laps l JOIN sessions s USING (session_id)
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.started_at, l.lap_num
    `, params);

    return r.map((x) => ({
        lap_id: String(x.lap_id),
        session_id: String(x.session_id),
        lap_num: Number(x.lap_num),
        lap_time_s: n(x.lap_time_s),
        valid: x.valid === true,
        is_out_lap: x.is_out_lap === true,
        is_in_lap: x.is_in_lap === true,
        track: String(x.track),
        car: String(x.car),
        driver: x.driver == null ? null : String(x.driver),
    }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(id, label) {
    if (!UUID_RE.test(String(id))) throw new Error(`${label} is not a UUID`);
    return id;
}

/** Columnar channel traces on the 1 m grid, ready to hand straight to uPlot. */
async function lapTrace(con, { lapId }) {
    assertUuid(lapId, 'lapId');
    const r = await rows(con, `
        SELECT dist_bin, speed_ms, throttle, brake, steer, gear
        FROM lap_binned WHERE lap_id = '${lapId}' ORDER BY dist_bin
    `);
    const len = r.length;
    const dist = new Float64Array(len), speed = new Float64Array(len);
    const throttle = new Float64Array(len), brake = new Float64Array(len);
    const steer = new Float64Array(len), gear = new Float64Array(len);
    for (let i = 0; i < len; i++) {
        dist[i] = Number(r[i].dist_bin);
        speed[i] = Number(r[i].speed_ms) * 3.6;      // charts speak km/h
        throttle[i] = Number(r[i].throttle ?? 0) * 100;
        brake[i] = Number(r[i].brake ?? 0) * 100;
        steer[i] = Number(r[i].steer ?? 0);
        gear[i] = Number(r[i].gear ?? 0);
    }
    return {
        dist: Array.from(dist), speed: Array.from(speed),
        throttle: Array.from(throttle), brake: Array.from(brake),
        steer: Array.from(steer), gear: Array.from(gear),
    };
}

/** The delta trace: positive means lapA is losing time to lapB. */
async function lapDelta(con, { lapA, lapB }) {
    assertUuid(lapA, 'lapA'); assertUuid(lapB, 'lapB');
    const r = await rows(con,
        `SELECT dist_bin, delta_t_s FROM lap_delta('${lapA}', '${lapB}') ORDER BY dist_bin`);
    return {
        dist: r.map((x) => Number(x.dist_bin)),
        delta: r.map((x) => Number(x.delta_t_s)),
    };
}

async function trackSegments(con, { track }) {
    const r = await rows(con,
        `SELECT seg_num, kind, name, start_m, apex_m, end_m, min_speed_ms
         FROM track_segments WHERE track = ? ORDER BY seg_num`, [track]);
    return r.map((x) => ({
        seg_num: Number(x.seg_num), kind: String(x.kind),
        name: x.name == null ? null : String(x.name),
        start_m: n(x.start_m), apex_m: n(x.apex_m), end_m: n(x.end_m),
        min_speed_ms: n(x.min_speed_ms),
    }));
}

async function segmentLosses(con, opts) { return A.segmentDeltas(con, opts); }
async function deriveSegments(con, opts) { return deriveTrackSegments(con, opts); }

async function runEngineer(con, opts) {
    const { findings } = await E.analyse(con, opts);
    return findings.map((f) => ({
        advice_id: f.advice_id, rule_id: f.rule_id, seg_num: f.seg_num,
        severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence,
    }));
}

async function pastAdvice(con, { lapId }) {
    assertUuid(lapId, 'lapId');
    const r = await rows(con, `
        SELECT a.advice_id, a.rule_id, a.severity, a.title, a.detail, a.evidence, a.created_at,
               f.rating, f.applied, f.driver_note
        FROM advice a LEFT JOIN feedback f USING (advice_id)
        WHERE a.lap_id = '${lapId}'
        -- Severity first. The engine ranks its findings carefully; replaying
        -- them in insertion order would put a 'suggest' above a 'strong' and
        -- quietly undo that ranking in the only place the driver sees it.
        ORDER BY CASE a.severity WHEN 'strong' THEN 3 WHEN 'suggest' THEN 2 ELSE 1 END DESC,
                 a.created_at DESC
    `);
    return r.map((x) => ({
        advice_id: String(x.advice_id), rule_id: String(x.rule_id),
        severity: String(x.severity), title: String(x.title),
        detail: x.detail == null ? null : String(x.detail),
        evidence: x.evidence == null ? null : JSON.parse(String(x.evidence)),
        rating: n(x.rating),
        applied: x.applied == null ? null : x.applied === true,
        driver_note: x.driver_note == null ? null : String(x.driver_note),
    }));
}

/**
 * Wear and degradation for a session's stint.
 *
 * Lap fuel comes from the sample stream rather than the laps table, because
 * fuel_used_l is only populated once a stint is closed and the correction
 * needs a value for every lap as it happens.
 */
async function degradation(con, { sessionId, fuelEffectSPerL, wearLimit } = {}) {
    if (!UUID_RE.test(String(sessionId))) throw new Error('sessionId is not a UUID');

    const lapRows = await rows(con, `
        SELECT l.lap_id, l.lap_num, l.lap_time_s, l.valid, l.is_out_lap, l.is_in_lap,
               (SELECT max(s.fuel_l) FROM samples s WHERE s.lap_id = l.lap_id) AS fuel_l,
               (SELECT avg(s.tyre_wear_fl) FROM samples s WHERE s.lap_id = l.lap_id) AS fl,
               (SELECT avg(s.tyre_wear_fr) FROM samples s WHERE s.lap_id = l.lap_id) AS fr,
               (SELECT avg(s.tyre_wear_rl) FROM samples s WHERE s.lap_id = l.lap_id) AS rl,
               (SELECT avg(s.tyre_wear_rr) FROM samples s WHERE s.lap_id = l.lap_id) AS rr
        FROM laps l WHERE l.session_id = '${sessionId}' ORDER BY l.lap_num
    `);

    const laps = lapRows.map((r, i) => ({
        stintLap: i + 1,
        lapNum: Number(r.lap_num),
        lapTimeS: n(r.lap_time_s),
        fuelL: n(r.fuel_l),
        valid: r.valid === true,
        isOutLap: r.is_out_lap === true,
        isInLap: r.is_in_lap === true,
    }));

    const wear = lapRows.map((r, i) => ({
        stintLap: i + 1, fl: n(r.fl), fr: n(r.fr), rl: n(r.rl), rr: n(r.rr),
    }));

    const model = DEG.fitDegradation(laps, fuelEffectSPerL == null ? {} : { fuelEffectSPerL });
    const wearProj = DEG.wearProjection(wear, wearLimit == null ? {} : { wearLimit });

    return {
        model: {
            degSPerLap: model.degSPerLap, baseLapS: model.baseLapS, r2: model.r2,
            lapsUsed: model.lapsUsed, dropped: model.dropped,
            fuelCorrected: model.fuelCorrected, warning: model.warning, cliff: model.cliff,
        },
        wear: wearProj,
        laps: (model.corrected ?? []).map((l) => ({
            stintLap: l.stintLap, lapTimeS: l.lapTimeS, correctedS: l.correctedS, fuelL: l.fuelL,
        })),
    };
}

function optimalStint(_con, params) { return DEG.optimalStintLaps(params); }

/**
 * Lift-and-coast coaching for a lap.
 *
 * Coast deceleration and fuel flow are MEASURED from this lap rather than
 * assumed, because a guessed drag figure makes the advice decorative. If the
 * driver never coasts there is nothing to learn from and the physical fallback
 * is used -- the result says which happened.
 */
async function liftAndCoast(con, { track, lapId, targetSaving, maxTimeLossS } = {}) {
    assertUuid(lapId, 'lapId');

    // Coast deceleration, from samples with neither pedal applied. Consecutive
    // samples only -- a gap spans two separate coasting episodes and the
    // apparent deceleration across it is meaningless.
    const coastRows = await rows(con, `
        WITH c AS (
            SELECT t_s, speed_ms,
                   lag(t_s)      OVER (ORDER BY t_s) AS pt,
                   lag(speed_ms) OVER (ORDER BY t_s) AS pv
            FROM samples
            WHERE lap_id = '${lapId}' AND throttle < 0.05 AND brake < 0.05 AND speed_ms > 15
        )
        SELECT speed_ms, (pv - speed_ms) / (t_s - pt) AS decel_ms2
        FROM c WHERE pt IS NOT NULL AND t_s - pt BETWEEN 0.005 AND 0.2
    `);
    const coast = LC.fitCoastModel(coastRows.map((r) => ({
        speed_ms: n(r.speed_ms), decel_ms2: n(r.decel_ms2),
    })));

    // Fuel flow while on throttle, from what the lap actually burned.
    const [fuelRow] = await rows(con, `
        SELECT max(fuel_l) - min(fuel_l)                                   AS used,
               max(t_s)                                                    AS lap_s,
               count(*) FILTER (WHERE throttle > 0.5)::DOUBLE / count(*)   AS on_throttle
        FROM samples WHERE lap_id = '${lapId}'
    `);
    const used = n(fuelRow?.used) ?? 0;
    const lapS = n(fuelRow?.lap_s) ?? 0;
    const onThrottle = n(fuelRow?.on_throttle) ?? 0;
    const fuelRatePerS = lapS > 0 && onThrottle > 0 ? used / (lapS * onThrottle) : 0;

    // Zones: each corner, with the straight that leads into it.
    const segs = await rows(con,
        `SELECT seg_num, kind, start_m, end_m, apex_m, min_speed_ms, entry_speed_ms
         FROM track_segments WHERE track = ? ORDER BY seg_num`, [track]);

    const zones = [];
    for (let i = 0; i < segs.length; i++) {
        if (String(segs[i].kind) !== 'corner') continue;
        const prev = segs[i - 1];
        const approachM = prev && String(prev.kind) === 'straight'
            ? n(prev.end_m) - n(prev.start_m) : 0;
        const entry = n(segs[i].entry_speed_ms);
        const apex = n(segs[i].min_speed_ms);
        if (!(entry > 0) || !(apex > 0) || approachM < 20) continue;
        zones.push({
            seg_num: Number(segs[i].seg_num),
            entrySpeedMs: entry, apexSpeedMs: apex, approachM,
            capacityM: LC.maxUsableLiftM({ entrySpeedMs: entry, apexSpeedMs: apex, approachM }, coast, LC.DEFAULTS.brakeDecel),
            dropKmh: (entry - apex) * 3.6,
        });
    }

    const plan = targetSaving > 0
        ? LC.planLiftAndCoast({ zones, coast, fuelRatePerS, targetSaving, maxTimeLossS: maxTimeLossS ?? Infinity })
        : null;

    return {
        coast: { k: coast.k, c: coast.c, measured: coast.measured, samples: coast.samples,
                 atKmh: [150, 250, 320].map((kmh) => ({ kmh, decel: coast.at(kmh / 3.6) })) },
        fuel: { usedPerLap: used, lapS, onThrottleFraction: onThrottle, ratePerS: fuelRatePerS },
        zones: zones.sort((a, b) => b.capacityM - a.capacityM),
        plan,
    };
}

/**
 * Forecast, projected wetness, and what it means for the stops.
 *
 * Current wetness is taken from the last recorded conditions so the projection
 * starts from where the track actually is -- a forecast applied to a dry track
 * and to a soaked one give very different crossovers.
 */
async function forecast(con, { sessionId, horizonS = 7200, plan, currentLap = 1, lapTimeS,
                               pitLossS, tyreChangeS, maxLapsPerStint } = {}) {
    let currentWetness = 0;
    let nowS = 0;
    if (sessionId && UUID_RE.test(String(sessionId))) {
        const [last] = await rows(con,
            `SELECT at_s, wetness_avg FROM conditions WHERE session_id = ?::UUID
             ORDER BY at_s DESC LIMIT 1`, [sessionId]);
        if (last) { currentWetness = n(last.wetness_avg) ?? 0; nowS = n(last.at_s) ?? 0; }
    }

    const points = syntheticForecast({ fromS: nowS, horizonS });
    const timeline = FC.projectWetness({ forecast: points, currentWetness, nowS });
    const events = FC.crossoverEvents(timeline);

    const adaptation = plan && lapTimeS > 0
        ? FC.adaptStrategy({ plan, timeline, currentLap, lapTimeS, nowS,
                             pitLossS, tyreChangeS, maxLapsPerStint })
        : null;

    return {
        nowS, currentWetness, synthetic: true,
        forecast: points, timeline, events, adaptation,
    };
}

const recordFeedback = (con, opts) => FB.recordFeedback(con, opts);
const ruleScores = (con) => FB.ruleScores(con);

/** Strategy is pure computation -- no connection needed. */
function strategy(_con, params) { return planRace(params); }
function strategyLive(_con, params) { return assessLive(params); }

const API = {
    listSessions, listLaps, lapTrace, lapDelta, trackSegments, segmentLosses,
    deriveSegments, runEngineer, pastAdvice, recordFeedback, ruleScores,
    strategy, strategyLive, degradation, optimalStint, liftAndCoast, forecast,
};

/** Names the preload bridge exposes; keeps main and renderer in step. */
const API_NAMES = Object.keys(API);

module.exports = { ...API, API, API_NAMES };
