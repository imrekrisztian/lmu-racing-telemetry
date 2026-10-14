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

/**
 * Technique metrics -- the things a race engineer actually reads off a trace,
 * as opposed to the summary numbers above.
 *
 *  coast_m        throttle and brake both released. Pure wasted time; the
 *                 single most actionable number in real telemetry coaching.
 *  plateau_m      distance held within 2% of minimum speed. A good corner is
 *                 a V, not a U -- a long plateau means speed was scrubbed off
 *                 too early and the car is waiting to rotate.
 *  brake_release_m  gap between the last brake input and the apex. A large
 *                 gap means the brakes came fully off before turn-in, so
 *                 there is no load on the front axle to rotate the car.
 *                 That is the signature of no trail braking.
 *  brake_build_m  distance from first brake touch to peak pressure. Long
 *                 means a soft initial hit, wasting the most effective part
 *                 of the braking zone where downforce is highest.
 *  throttle_drops counts of the driver backing off after getting on power.
 *                 Traction-limited exit, or hesitancy.
 *  steer_reversals direction changes in steering input. Fighting the car,
 *                 and a direct contributor to tyre wear over a stint.
 *  overlap_m      both pedals meaningfully applied. Burns fuel and brakes.
 */
async function cornerTechnique(con, { track, lapId }) {
    const r = await rows(con, `
        WITH b AS (
            SELECT dist_bin, speed_ms, throttle, brake, steer
            FROM lap_binned WHERE lap_id = ${uuidLit(lapId)}
        ),
        seg AS (SELECT * FROM track_segments WHERE track = ? AND kind = 'corner'),
        j AS (
            SELECT seg.seg_num, b.dist_bin, b.speed_ms, b.throttle, b.brake, b.steer
            FROM seg JOIN b ON b.dist_bin BETWEEN seg.start_m AND seg.end_m
        ),
        apex AS (
            SELECT seg_num, arg_min(dist_bin, speed_ms) AS apex_m, min(speed_ms) AS vmin
            FROM j GROUP BY seg_num
        ),
        d AS (
            SELECT j.*, a.apex_m, a.vmin,
                   j.throttle - lag(j.throttle) OVER (PARTITION BY j.seg_num ORDER BY j.dist_bin) AS d_thr,
                   j.steer    - lag(j.steer)    OVER (PARTITION BY j.seg_num ORDER BY j.dist_bin) AS d_steer
            FROM j JOIN apex a USING (seg_num)
        ),
        d2 AS (
            SELECT *, lag(d_steer) OVER (PARTITION BY seg_num ORDER BY dist_bin) AS prev_d_steer
            FROM d
        )
        -- apex_m and vmin are constant within a segment, so they go in the
        -- GROUP BY and are referenced directly: an aggregate cannot be nested
        -- inside another aggregate's FILTER clause.
        SELECT seg_num, apex_m, vmin,
               count(*)                                                           AS length_m,
               count(*) FILTER (WHERE throttle < 0.05 AND brake < 0.05)           AS coast_m,
               count(*) FILTER (WHERE throttle > 0.2 AND brake > 0.2)             AS overlap_m,
               count(*) FILTER (WHERE speed_ms <= vmin * 1.02)                    AS plateau_m,
               max(brake)                                                         AS peak_brake,
               max(dist_bin) FILTER (WHERE brake > 0.05)                          AS last_brake_m,
               min(dist_bin) FILTER (WHERE brake > 0.05)                          AS first_brake_m,
               arg_max(dist_bin, brake)                                           AS peak_brake_m,
               count(*) FILTER (WHERE dist_bin > apex_m AND d_thr < -0.05)        AS throttle_drops,
               count(*) FILTER (WHERE d_steer * prev_d_steer < 0
                                  AND abs(d_steer) > 0.02)                        AS steer_reversals
        FROM d2 GROUP BY seg_num, apex_m, vmin ORDER BY seg_num
    `, [track]);

    return r.map((x) => {
        const apex = num(x.apex_m);
        const lastBrake = num(x.last_brake_m);
        const firstBrake = num(x.first_brake_m);
        const peakBrake = num(x.peak_brake_m);
        return {
            seg_num: Number(x.seg_num),
            apex_m: apex,
            length_m: Number(x.length_m),
            coast_m: Number(x.coast_m),
            overlap_m: Number(x.overlap_m),
            plateau_m: Number(x.plateau_m),
            peak_brake: num(x.peak_brake),
            // Positive: brakes fully released this far BEFORE the apex.
            brake_release_m: lastBrake == null || apex == null ? null : apex - lastBrake,
            brake_build_m: firstBrake == null || peakBrake == null ? null : peakBrake - firstBrake,
            throttle_drops: Number(x.throttle_drops),
            steer_reversals: Number(x.steer_reversals),
        };
    });
}

/**
 * Tyre working temperatures, per axle and per side.
 *
 * The front/rear balance is the engineer's staple read: fronts consistently
 * hotter than rears means the front axle is doing more sliding -- understeer.
 * Rears hotter means the car is loose. It is a balance diagnosis that no
 * single-wheel number gives you.
 */
async function tyreBalance(con, { lapId }) {
    const [x] = await rows(con, `
        SELECT
          avg((tyre_temp_fl_in_c + tyre_temp_fl_mid_c + tyre_temp_fl_out_c)/3) AS fl,
          avg((tyre_temp_fr_in_c + tyre_temp_fr_mid_c + tyre_temp_fr_out_c)/3) AS fr,
          avg((tyre_temp_rl_in_c + tyre_temp_rl_mid_c + tyre_temp_rl_out_c)/3) AS rl,
          avg((tyre_temp_rr_in_c + tyre_temp_rr_mid_c + tyre_temp_rr_out_c)/3) AS rr,
          avg(brake_temp_fl_c) AS bt_fl, avg(brake_temp_fr_c) AS bt_fr,
          avg(brake_temp_rl_c) AS bt_rl, avg(brake_temp_rr_c) AS bt_rr
        FROM samples WHERE lap_id = ${uuidLit(lapId)}
    `);
    if (!x) return null;
    const f = (num(x.fl) + num(x.fr)) / 2;
    const r = (num(x.rl) + num(x.rr)) / 2;
    return {
        fl: num(x.fl), fr: num(x.fr), rl: num(x.rl), rr: num(x.rr),
        frontMean: f, rearMean: r,
        frontRearDelta: f - r,
        brakeFront: (num(x.bt_fl) + num(x.bt_fr)) / 2,
        brakeRear: (num(x.bt_rl) + num(x.bt_rr)) / 2,
    };
}

/** Per-wheel tread profile, for pressure and camber reads. */
async function tyreProfile(con, { lapId }) {
    const [x] = await rows(con, `
        SELECT
          avg(tyre_temp_fl_in_c) fl_i, avg(tyre_temp_fl_mid_c) fl_m, avg(tyre_temp_fl_out_c) fl_o, avg(tyre_press_fl_kpa) fl_p,
          avg(tyre_temp_fr_in_c) fr_i, avg(tyre_temp_fr_mid_c) fr_m, avg(tyre_temp_fr_out_c) fr_o, avg(tyre_press_fr_kpa) fr_p,
          avg(tyre_temp_rl_in_c) rl_i, avg(tyre_temp_rl_mid_c) rl_m, avg(tyre_temp_rl_out_c) rl_o, avg(tyre_press_rl_kpa) rl_p,
          avg(tyre_temp_rr_in_c) rr_i, avg(tyre_temp_rr_mid_c) rr_m, avg(tyre_temp_rr_out_c) rr_o, avg(tyre_press_rr_kpa) rr_p
        FROM samples WHERE lap_id = ${uuidLit(lapId)}
    `);
    if (!x) return [];
    return ['fl', 'fr', 'rl', 'rr'].map((w) => ({
        wheel: w,
        inner_c: num(x[`${w}_i`]), mid_c: num(x[`${w}_m`]), outer_c: num(x[`${w}_o`]),
        pressure_kpa: num(x[`${w}_p`]),
    }));
}

/** Length of the straight that follows each corner -- exit priority. */
async function exitPriority(con, { track }) {
    const segs = await rows(con,
        `SELECT seg_num, kind, start_m, end_m FROM track_segments WHERE track = ? ORDER BY seg_num`, [track]);
    const out = new Map();
    for (let i = 0; i < segs.length; i++) {
        if (String(segs[i].kind) !== 'corner') continue;
        const next = segs[i + 1];
        const len = next && String(next.kind) === 'straight'
            ? num(next.end_m) - num(next.start_m) : 0;
        out.set(Number(segs[i].seg_num), len);
    }
    return out;
}

module.exports.cornerTechnique = cornerTechnique;
module.exports.tyreBalance = tyreBalance;
module.exports.tyreProfile = tyreProfile;
module.exports.exitPriority = exitPriority;
