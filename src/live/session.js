'use strict';

// Live session state.
//
// Consumes normalised samples and maintains everything a pit wall wants to see
// at a glance, without accumulating the samples themselves -- a six-hour race
// at 90 Hz is two million frames, and none of them need to be held in memory
// to answer "am I up or down, and when do I pit".

const DEFAULT_OPTS = {
    // Consumption is noisy frame to frame; rate is taken across completed laps.
    consumptionWindowLaps: 3,
};

class LiveSession {
    constructor({ reference = null, capacity = null, reserve = 0, plan = null, opts = {} } = {}) {
        this.reference = reference;
        this.capacity = capacity;
        this.reserve = reserve;
        this.plan = plan;
        this.opts = { ...DEFAULT_OPTS, ...opts };
        this.reset();
    }

    reset() {
        this.lapNum = null;
        this.lapStartET = null;
        this.lapTimeS = 0;
        this.distM = 0;
        this.deltaS = null;
        this.lastLapS = null;
        this.bestLapS = null;
        this.lapHistory = [];        // { lap, timeS, fuelUsed }
        this.sample = null;
        this.lapStartLevel = null;   // fuel or VE at the start of this lap
        this.level = null;
        this.stintLaps = 0;
        this.frames = 0;
    }

    /**
     * @param {object} s normalised sample: { dist_m, t_s, speed_ms, throttle,
     *   brake, gear, rpm, fuel_l, tyre_* } plus { lapNumber, lapStartET, elapsedTime }
     */
    update(s) {
        this.frames++;

        // --- lap rollover --------------------------------------------------
        if (this.lapStartET === null || s.lapStartET !== this.lapStartET) {
            if (this.lapStartET !== null) this._closeLap(s);
            this.lapStartET = s.lapStartET;
            this.lapNum = s.lapNumber;
            this.lapStartLevel = s.fuel_l ?? null;
        }

        this.lapTimeS = s.t_s ?? 0;
        this.distM = s.dist_m ?? 0;
        this.level = s.fuel_l ?? this.level;
        this.sample = s;

        // --- live delta ----------------------------------------------------
        // Positive means down on the reference at this point on track.
        this.deltaS = this.reference
            ? this.lapTimeS - this.reference.timeAt(this.distM)
            : null;

        return this.snapshot();
    }

    _closeLap(next) {
        const timeS = next.lastLapTime > 0 ? next.lastLapTime : next.lapStartET - this.lapStartET;
        const fuelUsed = this.lapStartLevel != null && this.level != null
            ? Math.max(0, this.lapStartLevel - this.level) : null;

        this.lastLapS = timeS;
        if (timeS > 0 && (this.bestLapS == null || timeS < this.bestLapS)) this.bestLapS = timeS;
        this.lapHistory.push({ lap: this.lapNum, timeS, fuelUsed });
        if (this.lapHistory.length > 60) this.lapHistory.shift();
        this.stintLaps++;
    }

    /** Mean consumption over the recent completed laps that actually have a figure. */
    consumptionPerLap() {
        const withFuel = this.lapHistory.filter((l) => l.fuelUsed > 0);
        if (withFuel.length === 0) return null;
        const recent = withFuel.slice(-this.opts.consumptionWindowLaps);
        return recent.reduce((n, l) => n + l.fuelUsed, 0) / recent.length;
    }

    /** Laps the current load still covers, keeping the reserve back. */
    lapsRemaining() {
        const perLap = this.consumptionPerLap();
        if (!perLap || this.level == null) return null;
        return Math.floor((this.level - this.reserve) / perLap);
    }

    /** Spread of recent lap times -- the number endurance is actually won on. */
    consistencySd() {
        const times = this.lapHistory.map((l) => l.timeS).filter((t) => t > 0);
        if (times.length < 3) return null;
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        const varsum = times.reduce((a, t) => a + (t - mean) ** 2, 0);
        return Math.sqrt(varsum / (times.length - 1));
    }

    snapshot() {
        const s = this.sample ?? {};
        const perLap = this.consumptionPerLap();
        const lapsLeft = this.lapsRemaining();

        return {
            frames: this.frames,
            lap: {
                num: this.lapNum,
                timeS: this.lapTimeS,
                distM: this.distM,
                deltaS: this.deltaS,
                lastLapS: this.lastLapS,
                bestLapS: this.bestLapS,
                refLapS: this.reference?.lapTimeS ?? null,
                lapLengthM: this.reference?.maxDist ?? null,
                progress: this.reference?.maxDist ? Math.min(1, this.distM / this.reference.maxDist) : 0,
            },
            car: {
                speedKmh: (s.speed_ms ?? 0) * 3.6,
                refSpeedKmh: this.reference ? this.reference.speedAt(this.distM) * 3.6 : null,
                gear: s.gear ?? 0,
                rpm: s.rpm ?? 0,
                throttle: (s.throttle ?? 0) * 100,
                brake: (s.brake ?? 0) * 100,
                steer: s.steer ?? 0,
                level: this.level,
            },
            tyres: ['fl', 'fr', 'rl', 'rr'].map((w) => ({
                wheel: w,
                tempC: s[`tyre_temp_${w}_mid_c`] ?? null,
                innerC: s[`tyre_temp_${w}_in_c`] ?? null,
                outerC: s[`tyre_temp_${w}_out_c`] ?? null,
                pressureKpa: s[`tyre_press_${w}_kpa`] ?? null,
                brakeTempC: s[`brake_temp_${w}_c`] ?? null,
                wear: s[`tyre_wear_${w}`] ?? null,
            })),
            stint: {
                laps: this.stintLaps,
                perLap,
                lapsLeft,
                consistencySd: this.consistencySd(),
            },
            history: this.lapHistory.slice(-12),
        };
    }
}

module.exports = { LiveSession };
