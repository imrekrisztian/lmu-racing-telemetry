'use strict';

// Where the time actually goes.
//
// A delta trace tells you that you are 1.2s down; it does not tell you where
// to spend tomorrow's practice. Attributing the delta to named segments does,
// and it is the single highest-value readout in the whole telemetry feature.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Macro arguments cannot be bound, so lap ids are validated before inlining. */
function uuidLit(id) {
    if (!UUID_RE.test(String(id))) throw new Error(`Not a UUID: ${id}`);
    return `'${id}'`;
}

const rows = async (con, sql, params) =>
    (await con.runAndReadAll(sql, params)).getRowObjects();

const num = (v) => (v == null ? null : Number(v));

/**
 * Per-segment time gained or lost, lapA relative to lapB.
 * Positive lost_s means lapA is slower through that segment.
 *
 * ASOF joins pick the nearest bin at or before each boundary, so a segment
 * boundary that falls on a bin with no sample still resolves.
 */
async function segmentDeltas(con, { track, lapA, lapB }) {
    const r = await rows(con, `
        WITH d AS (SELECT * FROM lap_delta(${uuidLit(lapA)}, ${uuidLit(lapB)}))
        SELECT s.seg_num, s.kind, s.name, s.start_m, s.apex_m, s.end_m,
               de.delta_t_s - ds.delta_t_s AS lost_s
        FROM track_segments s
        ASOF JOIN d ds ON ds.dist_bin <= s.start_m
        ASOF JOIN d de ON de.dist_bin <= s.end_m
        WHERE s.track = ?
        ORDER BY s.seg_num
    `, [track]);

    return r.map((x) => ({
        seg_num: Number(x.seg_num),
        kind: String(x.kind),
        name: x.name == null ? null : String(x.name),
        start_m: num(x.start_m),
        apex_m: num(x.apex_m),
        end_m: num(x.end_m),
        lost_s: num(x.lost_s),
    }));
}

/** The same list, worst first -- what to work on. */
async function worstSegments(con, opts, limit = 5) {
    const all = await segmentDeltas(con, opts);
    return [...all].sort((a, b) => b.lost_s - a.lost_s).slice(0, limit);
}

/**
 * Driving metrics per corner for one lap: where braking starts, how slow the
 * apex is, where the throttle comes back. These are the numbers a comparison
 * turns into advice.
 */
async function cornerMetrics(con, { track, lapId, brakeThreshold = 0.1, throttleThreshold = 0.9 }) {
    const r = await rows(con, `
        WITH b AS (
            SELECT dist_bin, speed_ms, throttle, brake
            FROM lap_binned WHERE lap_id = ${uuidLit(lapId)}
        ),
        seg AS (
            SELECT * FROM track_segments WHERE track = ? AND kind = 'corner'
        ),
        j AS (
            SELECT seg.seg_num, seg.name, b.dist_bin, b.speed_ms, b.throttle, b.brake
            FROM seg JOIN b ON b.dist_bin BETWEEN seg.start_m AND seg.end_m
        ),
        -- Apex has to be resolved first: an aggregate cannot be referenced
        -- from inside another aggregate's FILTER clause.
        apex AS (
            SELECT seg_num,
                   arg_min(dist_bin, speed_ms) AS apex_m,
                   min(speed_ms)               AS min_speed_ms
            FROM j GROUP BY seg_num
        )
        SELECT j.seg_num, any_value(j.name) AS name,
               a.apex_m, a.min_speed_ms,
               min(j.dist_bin) FILTER (WHERE j.brake > ?)                        AS brake_point_m,
               min(j.dist_bin) FILTER (WHERE j.throttle > ? AND j.dist_bin > a.apex_m)
                                                                                 AS throttle_point_m,
               arg_min(j.speed_ms, j.dist_bin)                                   AS entry_speed_ms,
               arg_max(j.speed_ms, j.dist_bin)                                   AS exit_speed_ms
        FROM j JOIN apex a USING (seg_num)
        GROUP BY j.seg_num, a.apex_m, a.min_speed_ms
        ORDER BY j.seg_num
    `, [track, brakeThreshold, throttleThreshold]);

    return r.map((x) => ({
        seg_num: Number(x.seg_num),
        name: x.name == null ? null : String(x.name),
        brake_point_m: num(x.brake_point_m),
        min_speed_ms: num(x.min_speed_ms),
        apex_m: num(x.apex_m),
        throttle_point_m: num(x.throttle_point_m),
        entry_speed_ms: num(x.entry_speed_ms),
        exit_speed_ms: num(x.exit_speed_ms),
    }));
}

/**
 * Consistency across a set of laps.
 *
 * Endurance races are won on the spread, not the single best lap -- a driver
 * two tenths slower but half as variable finishes ahead. Braking-point spread
 * is the most actionable of these: it localises inconsistency to a corner.
 */
async function consistency(con, { track, lapIds, brakeThreshold = 0.1 }) {
    const list = lapIds.map(uuidLit).join(',');

    const [lapStats] = await rows(con, `
        SELECT count(*) AS laps,
               avg(lap_time_s) AS mean_s,
               min(lap_time_s) AS best_s,
               stddev_samp(lap_time_s) AS sd_s
        FROM laps WHERE lap_id IN (${list}) AND lap_time_s IS NOT NULL
    `);

    const perCorner = await rows(con, `
        WITH b AS (
            SELECT lap_id, dist_bin, speed_ms, brake
            FROM lap_binned WHERE lap_id IN (${list})
        ),
        seg AS (SELECT * FROM track_segments WHERE track = ? AND kind = 'corner'),
        j AS (
            SELECT seg.seg_num, b.lap_id, b.dist_bin, b.speed_ms, b.brake
            FROM seg JOIN b ON b.dist_bin BETWEEN seg.start_m AND seg.end_m
        ),
        per_lap AS (
            SELECT seg_num, lap_id,
                   min(speed_ms) AS apex_speed,
                   min(dist_bin) FILTER (WHERE brake > ?) AS brake_point
            FROM j GROUP BY seg_num, lap_id
        )
        SELECT seg_num,
               count(*) AS laps,
               avg(apex_speed) AS apex_speed_mean,
               stddev_samp(apex_speed) AS apex_speed_sd,
               avg(brake_point) AS brake_point_mean,
               stddev_samp(brake_point) AS brake_point_sd
        FROM per_lap GROUP BY seg_num ORDER BY seg_num
    `, [track, brakeThreshold]);

    return {
        laps: Number(lapStats?.laps ?? 0),
        meanLapS: num(lapStats?.mean_s),
        bestLapS: num(lapStats?.best_s),
        sdLapS: num(lapStats?.sd_s),
        corners: perCorner.map((x) => ({
            seg_num: Number(x.seg_num),
            laps: Number(x.laps),
            apex_speed_mean: num(x.apex_speed_mean),
            apex_speed_sd: num(x.apex_speed_sd),
            brake_point_mean: num(x.brake_point_mean),
            brake_point_sd: num(x.brake_point_sd),
        })),
    };
}

module.exports = { segmentDeltas, worstSegments, cornerMetrics, consistency };
