'use strict';

// Persists laps and samples.
//
// samples is the hot path -- a 90 Hz session is ~5k rows per lap -- so it goes
// through DuckDB's appender rather than INSERT. Column order is read from the
// live database at construction, so adding or reordering a column in
// schema.sql can never silently shift values into the wrong field.

const { DuckDBUUIDValue } = require('@duckdb/node-api');
const crypto = require('node:crypto');

const uuid = () => crypto.randomUUID();

/** 'f47ac10b-58cc-...' -> DuckDBUUIDValue (the API only takes a uint128). */
function uuidVal(s) {
    return DuckDBUUIDValue.fromUint128(BigInt('0x' + s.replace(/-/g, '')));
}

class Writer {
    constructor(con) {
        this.con = con;
        this.columns = null;
        this.appender = null;
        this.pending = 0;
    }

    async init() {
        const res = await this.con.runAndReadAll(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_name = 'samples' ORDER BY ordinal_position`
        );
        this.columns = res.getRowObjects().map((r) => ({
            name: String(r.column_name),
            type: String(r.data_type),
        }));
        this.appender = await this.con.createAppender('samples');
        return this;
    }

    async createSession(meta) {
        const id = meta.session_id ?? uuid();
        await this.con.run(
            `INSERT INTO sessions (session_id, started_at, track, track_length_m, car,
                 car_class, session_type, driver, sim_version, plugin_version, sample_rate_hz, notes)
             VALUES (?::UUID, ?::TIMESTAMPTZ, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, meta.started_at ?? new Date().toISOString(), meta.track, meta.track_length_m ?? null,
             meta.car, meta.car_class ?? null, meta.session_type ?? null, meta.driver ?? null,
             meta.sim_version ?? null, meta.plugin_version ?? null, meta.sample_rate_hz ?? null,
             meta.notes ?? null]
        );
        return id;
    }

    /** Write one completed lap and all of its samples. */
    async writeLap(sessionId, lap) {
        const lapId = lap.lap_id ?? uuid();

        await this.con.run(
            `INSERT INTO laps (lap_id, session_id, lap_num, lap_time_s, sector1_s, sector2_s,
                 sector3_s, valid, is_out_lap, is_in_lap, fuel_used_l, ve_used_frac,
                 tyre_compound, tyre_age_laps, track_temp_c, air_temp_c)
             VALUES (?::UUID, ?::UUID, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [lapId, sessionId, lap.lap_num, lap.lap_time_s ?? null,
             lap.sector1_s ?? null, lap.sector2_s ?? null, lap.sector3_s ?? null,
             lap.valid ?? true, lap.is_out_lap ?? false, lap.is_in_lap ?? false,
             lap.fuel_used_l ?? null, lap.ve_used_frac ?? null, lap.tyre_compound ?? null,
             lap.tyre_age_laps ?? null, lap.track_temp_c ?? null, lap.air_temp_c ?? null]
        );

        const lapUuid = uuidVal(lapId);
        for (const s of lap.samples) this._appendSample(lapUuid, s);
        this.appender.flushSync();
        this.pending = 0;

        return lapId;
    }

    _appendSample(lapUuid, row) {
        const a = this.appender;
        for (const col of this.columns) {
            if (col.name === 'lap_id') { a.appendUUID(lapUuid); continue; }

            const v = row[col.name];
            if (v == null || Number.isNaN(v)) { a.appendNull(); continue; }

            switch (col.type) {
                case 'DOUBLE':  a.appendDouble(v); break;
                case 'FLOAT':   a.appendFloat(v); break;
                case 'TINYINT': a.appendTinyInt(v); break;
                case 'SMALLINT':a.appendSmallInt(v); break;
                case 'INTEGER': a.appendInteger(v); break;
                case 'BOOLEAN': a.appendBoolean(v); break;
                default:        a.appendVarchar(String(v)); break;
            }
        }
        a.endRow();
        this.pending++;
    }

    close() {
        if (this.appender) { this.appender.flushSync(); this.appender.closeSync(); }
    }
}

module.exports = { Writer, uuid, uuidVal };
