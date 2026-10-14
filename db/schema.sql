-- ===========================================================================
-- lmu-delta storage schema  v1
--
-- UNIT CONTRACT -- normalise once, at ingest, never downstream:
--   distance  m        speed      m/s        time        s
--   temp      Celsius  pressure   kPa        angle       rad
--   throttle/brake/clutch 0..1    steering   -1..1       wear  0..1 (1 = new)
--
-- LMU/rF2 publishes tyre and brake temps in KELVIN and keeps water/oil in
-- Celsius already. Convert at the reader boundary so no query ever has to
-- remember which is which.
--
-- Sentinels: the sim uses -1.0 for "no time" and 0.0 for "no lap".
-- Both become NULL here. Never store a sentinel.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS meta (
    key             VARCHAR PRIMARY KEY,
    value           VARCHAR NOT NULL
);

-- Identity for ATTACH compatibility checks (feature: compare against a
-- reference .duckdb someone else recorded).
INSERT OR REPLACE INTO meta VALUES
    ('schema_version', '1'),
    ('unit_contract',  'si-celsius-kpa-v1');


-- --------------------------------------------------------------------------
-- Sessions
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    session_id      UUID PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL,
    track           VARCHAR NOT NULL,
    track_length_m  DOUBLE,
    car             VARCHAR NOT NULL,
    car_class       VARCHAR,            -- 'Hyper' | 'LMP2' | 'GT3' (LMU's literal strings)
    session_type    VARCHAR,            -- practice | qualifying | race
    driver          VARCHAR,
    sim_version     VARCHAR,
    plugin_version  VARCHAR,
    sample_rate_hz  DOUBLE,             -- measured by the Phase 0 probe; provenance matters
    notes           VARCHAR
);


-- --------------------------------------------------------------------------
-- Setups -- identified by content hash, so identical setups dedupe across
-- sessions automatically and lap times join straight onto setup changes.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS setups (
    setup_id        VARCHAR PRIMARY KEY,   -- sha256 of canonicalised values
    car             VARCHAR NOT NULL,
    track           VARCHAR,
    captured_at     TIMESTAMPTZ NOT NULL,
    source          VARCHAR,               -- 'rest:getPlayerGarageData' | 'svm'
    -- LMU returns ORDINAL INDICES, not physical values. Until the per-car
    -- calibration table exists, keep the raw payload and the indices; add
    -- resolved physical columns later without losing anything.
    raw             JSON NOT NULL,
    tc_index        INTEGER,
    abs_index       INTEGER,
    engine_map_index INTEGER,
    brake_bias_frac DOUBLE,
    tyre_compound   VARCHAR
);


-- --------------------------------------------------------------------------
-- Laps
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS laps (
    lap_id          UUID PRIMARY KEY,
    session_id      UUID NOT NULL REFERENCES sessions(session_id),
    setup_id        VARCHAR REFERENCES setups(setup_id),
    lap_num         INTEGER NOT NULL,
    started_at      TIMESTAMPTZ,
    lap_time_s      DOUBLE,             -- NULL when the sim reported -1 or 0
    sector1_s       DOUBLE,
    sector2_s       DOUBLE,
    sector3_s       DOUBLE,
    valid           BOOLEAN DEFAULT TRUE,
    is_out_lap      BOOLEAN DEFAULT FALSE,
    is_in_lap       BOOLEAN DEFAULT FALSE,
    fuel_used_l     DOUBLE,
    ve_used_frac    DOUBLE,             -- Virtual Energy; REST-only, Hyper/GT3
    tyre_compound   VARCHAR,
    tyre_age_laps   INTEGER,
    track_temp_c    DOUBLE,
    air_temp_c      DOUBLE,
    UNIQUE (session_id, lap_num)
);


-- --------------------------------------------------------------------------
-- Samples -- the big one. FLOAT not DOUBLE for channels: telemetry has no use
-- for 15 significant digits, and halving width halves scan cost.
-- dist_m and t_s stay DOUBLE because delta-time integrates over them.
--
-- INSERT IN (lap_id, dist_m) ORDER. DuckDB's zone maps then make range scans
-- cheap without any index on this table.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS samples (
    lap_id          UUID NOT NULL,
    dist_m          DOUBLE NOT NULL,    -- LapDist: distance travelled around the lap
    t_s             DOUBLE NOT NULL,    -- seconds since lap start

    speed_ms        FLOAT,
    throttle        FLOAT,              -- unfiltered 0..1
    brake           FLOAT,
    clutch          FLOAT,
    steer           FLOAT,              -- -1..1
    gear            TINYINT,            -- -1 reverse, 0 neutral
    rpm             FLOAT,

    fuel_l          FLOAT,
    brake_bias_frac FLOAT,              -- live-adjustable, worth per-sample

    pos_x           FLOAT,              -- world position, for the track map
    pos_y           FLOAT,
    pos_z           FLOAT,
    accel_lat       FLOAT,
    accel_long      FLOAT,

    -- Per wheel: fl, fr, rl, rr. Flat columns beat nested STRUCTs here --
    -- columnar storage means unread columns cost nothing, and every chart
    -- query stays a plain SELECT.
    tyre_temp_fl_in_c FLOAT, tyre_temp_fl_mid_c FLOAT, tyre_temp_fl_out_c FLOAT,
    tyre_temp_fr_in_c FLOAT, tyre_temp_fr_mid_c FLOAT, tyre_temp_fr_out_c FLOAT,
    tyre_temp_rl_in_c FLOAT, tyre_temp_rl_mid_c FLOAT, tyre_temp_rl_out_c FLOAT,
    tyre_temp_rr_in_c FLOAT, tyre_temp_rr_mid_c FLOAT, tyre_temp_rr_out_c FLOAT,

    tyre_press_fl_kpa FLOAT, tyre_press_fr_kpa FLOAT,
    tyre_press_rl_kpa FLOAT, tyre_press_rr_kpa FLOAT,

    brake_temp_fl_c FLOAT, brake_temp_fr_c FLOAT,
    brake_temp_rl_c FLOAT, brake_temp_rr_c FLOAT,

    tyre_wear_fl    FLOAT, tyre_wear_fr FLOAT,       -- 1.0 = new
    tyre_wear_rl    FLOAT, tyre_wear_rr FLOAT,

    susp_defl_fl    FLOAT, susp_defl_fr FLOAT,
    susp_defl_rl    FLOAT, susp_defl_rr FLOAT,

    ride_height_fl  FLOAT, ride_height_fr FLOAT,
    ride_height_rl  FLOAT, ride_height_rr FLOAT
);


-- --------------------------------------------------------------------------
-- Engineer advice + driver feedback.
--
-- Exists from day one deliberately. The advisor starts dumb, but this pair of
-- tables is the only thing that accumulates into something proprietary:
-- advice given -> was it applied -> what happened to the lap time.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advice (
    advice_id       UUID PRIMARY KEY,
    lap_id          UUID REFERENCES laps(lap_id),
    rule_id         VARCHAR NOT NULL,   -- stable id so rules can be scored later
    severity        VARCHAR,            -- info | suggest | strong
    title           VARCHAR NOT NULL,
    detail          VARCHAR,
    evidence        JSON,               -- the numbers behind it; never model-generated
    created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
    feedback_id     UUID PRIMARY KEY,
    advice_id       UUID REFERENCES advice(advice_id),
    rating          SMALLINT,           -- -1 unhelpful, 0 neutral, 1 helpful
    applied         BOOLEAN,
    driver_note     VARCHAR,            -- free text; parsed into symptoms later
    result_lap_id   UUID REFERENCES laps(lap_id),
    created_at      TIMESTAMPTZ NOT NULL
);


-- --------------------------------------------------------------------------
-- Derived views
-- --------------------------------------------------------------------------

-- Distance-normalised laps on a 1 m grid. Comparing two laps -- the same lap
-- recorded twice, or yours against an attached reference file -- is a join on
-- dist_bin and nothing else. Promote to a real table if it ever gets slow.
CREATE OR REPLACE VIEW lap_binned AS
SELECT
    lap_id,
    CAST(floor(dist_m) AS INTEGER)  AS dist_bin,
    avg(speed_ms)                   AS speed_ms,
    avg(throttle)                   AS throttle,
    avg(brake)                      AS brake,
    avg(steer)                      AS steer,
    max(gear)                       AS gear,
    avg(rpm)                        AS rpm,
    min(t_s)                        AS t_s,
    avg(pos_x)                      AS pos_x,
    avg(pos_z)                      AS pos_z,
    count(*)                        AS n_samples
FROM samples
GROUP BY lap_id, CAST(floor(dist_m) AS INTEGER);


-- Delta time between two laps, accumulated over distance:
--     d(x) = integral from 0 to x of (1/v_a - 1/v_b) ds
-- Positive = lap A is losing time to lap B.
--
-- NOTE: the sum is not multiplied by a step width, so this is only correct
-- while lap_binned uses a 1 m grid (ds = 1). If you ever change the bin size,
-- multiply the running sum by it here.
-- The value at bin N includes bin N (inclusive right endpoint).
CREATE OR REPLACE MACRO lap_delta(lap_a, lap_b) AS TABLE
SELECT
    a.dist_bin,
    a.speed_ms                                      AS speed_a,
    b.speed_ms                                      AS speed_b,
    a.speed_ms - b.speed_ms                         AS d_speed,
    a.throttle - b.throttle                         AS d_throttle,
    a.brake    - b.brake                            AS d_brake,
    sum( 1.0 / nullif(a.speed_ms, 0)
       - 1.0 / nullif(b.speed_ms, 0) )
        OVER (ORDER BY a.dist_bin
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS delta_t_s
FROM lap_binned a
JOIN lap_binned b USING (dist_bin)
WHERE a.lap_id = lap_a AND b.lap_id = lap_b
ORDER BY a.dist_bin;


-- Session leaderboard: fastest valid lap per session, with its setup.
CREATE OR REPLACE VIEW session_best AS
SELECT
    s.session_id, s.track, s.car, s.car_class, s.session_type, s.started_at,
    min(l.lap_time_s) FILTER (WHERE l.valid)        AS best_lap_s,
    count(*) FILTER (WHERE l.valid)                 AS valid_laps,
    stddev_samp(l.lap_time_s) FILTER (WHERE l.valid) AS consistency_sd_s
FROM sessions s
LEFT JOIN laps l USING (session_id)
GROUP BY ALL;


CREATE INDEX IF NOT EXISTS idx_laps_session ON laps(session_id);
CREATE INDEX IF NOT EXISTS idx_advice_lap   ON advice(lap_id);
