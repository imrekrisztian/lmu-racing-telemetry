'use strict';

// Automatic session logging.
//
// A telemetry tool you have to remember to arm is a telemetry tool that misses
// the lap you actually wanted. This watches for the sim, starts recording on
// its own when LMU begins publishing, and stops cleanly when it goes away --
// so going out for a practice run is the only action required.
//
// It also opens a NEW session when the track or car changes, because lumping a
// Le Mans run and a Monza run into one session makes every per-track query
// wrong.

const { ShmSource, available } = require('./shm-source');
const { LapTracker } = require('../ingest/lap-tracker');
const { Writer } = require('../ingest/writer');
const { LiveSession } = require('./session');

const WATCH_INTERVAL_MS = 4000;

const STATE = {
    OFF: 'off',
    WATCHING: 'watching',     // armed, no sim yet
    LOGGING: 'logging',       // connected and recording
    ERROR: 'error',
};

class AutoLogger {
    constructor(con, { onStatus = null, onTick = null, onLap = null } = {}) {
        this.con = con;
        this.onStatus = onStatus;
        this.onTick = onTick;
        this.onLap = onLap;
        this.state = STATE.OFF;
        this.watchTimer = null;
        this.source = null;
        this.writer = null;
        this.tracker = null;
        this.session = null;
        this.sessionId = null;
        this.context = null;        // { track, car }
        this.lapsRecorded = 0;
        this.reason = null;
    }

    _status(extra = {}) {
        const s = {
            state: this.state, reason: this.reason,
            track: this.context?.track ?? null, car: this.context?.car ?? null,
            lapsRecorded: this.lapsRecorded, sessionId: this.sessionId,
            ...extra,
        };
        this.onStatus?.(s);
        return s;
    }

    /** Arm the watcher. Harmless to call when the sim is not running. */
    arm() {
        if (this.state !== STATE.OFF) return this._status();
        const check = available();
        this.state = STATE.WATCHING;
        this.reason = check.ok ? null : check.reason;

        this.watchTimer = setInterval(() => this._poll(), WATCH_INTERVAL_MS);
        this._poll();
        return this._status();
    }

    disarm() {
        if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
        this._closeSession();
        this.state = STATE.OFF;
        this.reason = null;
        return this._status();
    }

    _poll() {
        if (this.state === STATE.LOGGING) return;      // already connected
        const check = available();
        if (!check.ok) { this.reason = check.reason; this._status(); return; }
        this._connect().catch((e) => {
            this.state = STATE.WATCHING;
            this.reason = e.message;
            this._status();
        });
    }

    async _connect() {
        const source = new ShmSource().open();
        const first = source.readOnce();
        if (!first) { source.stop(); throw new Error('sim is publishing but no coherent frame yet'); }

        const track = first.trackName || 'Unknown';
        const car = first.vehicleName || 'Unknown';

        this.writer = await new Writer(this.con).init();
        this.sessionId = await this.writer.createSession({
            track, car, session_type: 'live', sim_version: 'lmu',
        });
        this.context = { track, car };
        this.tracker = new LapTracker();
        this.session = new LiveSession({});
        this.lapsRecorded = 0;
        this.source = source;
        this.state = STATE.LOGGING;
        this.reason = null;
        this._status({ connected: true });

        source.start(
            (sample) => this._onSample(sample),
            (err) => { this.reason = err?.message ?? null; this._backToWatching(); },
        );
    }

    _onSample(sample) {
        // A track or car change means a different session, not more of this one.
        const track = sample.trackName || this.context.track;
        const car = sample.vehicleName || this.context.car;
        if (track !== this.context.track || car !== this.context.car) {
            this._closeSession();
            this._poll();
            return;
        }

        const snap = this.session.update(sample);
        this.onTick?.({ ...snap, live: true, lapsRecorded: this.lapsRecorded });

        const done = this.tracker.push(sample);
        if (!done) return;

        this.writer.writeLap(this.sessionId, done)
            .then(async () => {
                this.lapsRecorded++;
                this.onLap?.({ lap: done.lap_num, lapsRecorded: this.lapsRecorded });
                // Set the track up the first time a clean lap exists, so corner
                // analysis and the map are there without anyone asking.
                await this._ensureSegments();
                this._status();
            })
            .catch((e) => { this.reason = `recording failed: ${e.message}`; this._status(); });
    }

    async _ensureSegments() {
        try {
            const api = require('../app/api');
            await api.ensureTrackSegments(this.con, { track: this.context.track });
        } catch { /* segments are a bonus; never interrupt recording for them */ }
    }

    _backToWatching() {
        this._closeSession();
        this.state = STATE.WATCHING;
        this._status();
    }

    _closeSession() {
        try { this.source?.stop(); } catch { /* already gone */ }
        try { this.writer?.close(); } catch { /* already gone */ }
        this.source = null; this.writer = null; this.tracker = null;
        this.session = null; this.sessionId = null; this.context = null;
    }

    get status() { return this._status(); }
}

module.exports = { AutoLogger, STATE, WATCH_INTERVAL_MS };
