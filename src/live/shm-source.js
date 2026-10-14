'use strict';

// Live telemetry straight from the sim.
//
// Exposes the same start/stop shape as ReplaySource, so the pit-wall view
// cannot tell which it is attached to -- and the whole analysis stack behind
// it is unchanged.
//
// DISTANCE: lap distance lives in the Scoring buffer, not Telemetry, and this
// reader only decodes Telemetry. So distance is integrated from speed using
// mDeltaTime -- the sim's OWN physics timestep, not wall clock -- and reset at
// each lap boundary. That is accurate over a lap; anchoring to scoring's
// mLapDist would remove the drift entirely and is the obvious next step once
// the scoring layout is confirmed.
//
// TYRES: absent, deliberately. The wheel offsets are not derivable from the
// layout this module has, and inventing them would produce a dashboard full
// of plausible wrong numbers. See src/reader/layout.js.

const { openMapping } = require('../reader/win-shm');
const L = require('../reader/layout');

const UI_HZ = 30;
const WINDOW_BYTES = 4096;

class ShmSource {
    constructor({ uiHz = UI_HZ } = {}) {
        this.uiHz = uiHz;
        this.mapping = null;
        this.snapshot = Buffer.allocUnsafe(WINDOW_BYTES);
        this.timer = null;
        this.lastVersion = null;
        this.lastElapsed = null;
        this.lapStartET = null;
        this.dist = 0;
        this.frames = 0;
        this.torn = 0;
    }

    /** Throws with an actionable message when the sim or plugin is not there. */
    open() {
        this.mapping = openMapping(L.BUFFERS.Telemetry, WINDOW_BYTES);
        return this;
    }

    /** Torn-read protocol: accept a frame only when the version counters agree. */
    _read() {
        const live = this.mapping.live;
        for (let i = 0; i < 8; i++) {
            const begin = live.readUInt32LE(L.HEADER.mVersionUpdateBegin);
            live.copy(this.snapshot, 0, 0, WINDOW_BYTES);
            const end = live.readUInt32LE(L.HEADER.mVersionUpdateEnd);
            if (begin === end && this.snapshot.readUInt32LE(L.HEADER.mVersionUpdateBegin) === end) {
                return end;
            }
        }
        this.torn++;
        return null;
    }

    _decode() {
        const s = this.snapshot;
        const V = L.VEHICLE0;
        const vec = (off) => ({
            x: s.readDoubleLE(off), y: s.readDoubleLE(off + 8), z: s.readDoubleLE(off + 16),
        });

        const elapsedTime = s.readDoubleLE(V.mElapsedTime);
        const lapStartET = s.readDoubleLE(V.mLapStartET);
        const dt = s.readDoubleLE(V.mDeltaTime);
        const vel = vec(V.mLocalVel);
        const speed = Math.hypot(vel.x, vel.y, vel.z);

        // Reset the integration at each lap boundary.
        if (this.lapStartET === null || lapStartET !== this.lapStartET) {
            this.lapStartET = lapStartET;
            this.dist = 0;
        } else if (dt > 0 && dt < 0.5) {
            this.dist += speed * dt;
        }

        return {
            lapNumber: s.readInt32LE(V.mLapNumber),
            lapStartET,
            elapsedTime,
            lastLapTime: -1,            // Scoring carries this; Telemetry does not.
            t_s: elapsedTime - lapStartET,
            dist_m: this.dist,

            speed_ms: speed,
            throttle: s.readDoubleLE(V.mUnfilteredThrottle),
            brake: s.readDoubleLE(V.mUnfilteredBrake),
            steer: s.readDoubleLE(V.mUnfilteredSteering),
            clutch: s.readDoubleLE(V.mUnfilteredClutch),
            gear: s.readInt32LE(V.mGear),
            rpm: s.readDoubleLE(V.mEngineRPM),
            fuel_l: s.readDoubleLE(V.mFuel),
            // The sim reports REAR bias; the rest of this codebase speaks front.
            brake_bias_frac: 1 - s.readDoubleLE(V.mRearBrakeBias),

            water_temp_c: s.readDoubleLE(V.mEngineWaterTemp),
            oil_temp_c: s.readDoubleLE(V.mEngineOilTemp),

            pos_x: s.readDoubleLE(V.mPos),
            pos_y: s.readDoubleLE(V.mPos + 8),
            pos_z: s.readDoubleLE(V.mPos + 16),
            accel_lat: s.readDoubleLE(V.mLocalAccel),
            accel_long: s.readDoubleLE(V.mLocalAccel + 16),

            vehicleName: L.readFixedString(s, V.mVehicleName, 64),
            trackName: L.readFixedString(s, V.mTrackName, 64),
        };
    }

    /** One decoded frame, or null if the writer was mid-update. */
    readOnce() {
        const version = this._read();
        if (version === null) return null;
        this.lastVersion = version;
        this.frames++;
        return this._decode();
    }

    start(onSample, onEnd) {
        if (!this.mapping) this.open();
        this.timer = setInterval(() => {
            try {
                const frame = this.readOnce();
                if (frame) onSample(frame, null);
            } catch (err) {
                this.stop();
                onEnd?.(err);
            }
        }, 1000 / this.uiHz);
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        try { this.mapping?.close(); } catch { /* already gone */ }
        this.mapping = null;
    }

    get stats() { return { frames: this.frames, tornGiveUps: this.torn }; }
}

/** Whether a live connection is even possible here. */
function available() {
    if (process.platform !== 'win32') {
        return { ok: false, reason: 'Live telemetry needs Windows — the sim publishes to Win32 shared memory.' };
    }
    try {
        const m = openMapping(L.BUFFERS.Telemetry, 256);
        m.close();
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

module.exports = { ShmSource, available, UI_HZ };
