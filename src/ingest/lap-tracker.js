'use strict';

// Turns a frame stream into laps, and solves the rate mismatch between the
// two buffers that matter:
//
//   Telemetry  fast   speed, inputs, temps -- but no lap distance
//   Scoring    ~5 Hz  mLapDist, the only authoritative distance there is
//
// Sampling distance at scoring's rate would throw away most of the telemetry
// resolution we measured the probe for. So integrate speed between scoring
// updates and re-anchor whenever a fresh scoring value lands: high-rate
// distance, with no accumulating drift.

const { normalizeSample } = require('./normalize');

// Longer than this between frames and we assume a pause, hitch or alt-tab
// rather than real elapsed motion -- integrating across it would invent metres.
const MAX_INTEGRATION_DT_S = 0.5;

class LapTracker {
    constructor({ onLapComplete = null } = {}) {
        this.onLapComplete = onLapComplete;
        this.reset();
    }

    reset() {
        this.current = null;        // { lapStartET, lapNum, samples, startedInPits, enteredPits }
        this.prevElapsed = null;
        this.prevScoringDist = null;
        this.dist = 0;
        this.stats = { anchors: 0, integratedFrames: 0, skippedDt: 0, laps: 0 };
    }

    /**
     * @param {object} f frame: { elapsedTime, lapStartET, lapNumber, speed,
     *                            lapDist?, inPits?, ... }
     * @returns {object|null} the completed lap, if this frame closed one
     */
    push(f) {
        let completed = null;

        // --- lap boundary -------------------------------------------------
        // lapStartET is authoritative: it changes exactly once per lap and
        // survives the lapNumber reset that happens on a session restart.
        if (this.current === null || f.lapStartET !== this.current.lapStartET) {
            if (this.current !== null) {
                completed = this._close(f);
            }
            this.current = {
                lapStartET: f.lapStartET,
                lapNum: f.lapNumber,
                samples: [],
                startedInPits: f.inPits === true,
                enteredPits: false,
            };
            this.dist = 0;
            this.prevScoringDist = null;
        }

        if (f.inPits === true) this.current.enteredPits = true;

        // --- distance -----------------------------------------------------
        const scoringMoved =
            f.lapDist != null && f.lapDist !== this.prevScoringDist;

        if (scoringMoved) {
            // Fresh truth from the scoring buffer. Trust it absolutely.
            this.dist = f.lapDist;
            this.prevScoringDist = f.lapDist;
            this.stats.anchors++;
        } else if (this.prevElapsed != null) {
            const dt = f.elapsedTime - this.prevElapsed;
            if (dt > 0 && dt <= MAX_INTEGRATION_DT_S) {
                this.dist += (f.speed ?? 0) * dt;
                this.stats.integratedFrames++;
            } else if (dt !== 0) {
                this.stats.skippedDt++;
            }
        }

        this.prevElapsed = f.elapsedTime;

        const sample = normalizeSample({ ...f, lapDist: this.dist });
        this.current.samples.push(sample);

        return completed;
    }

    /** Close the in-flight lap using the frame that started the next one. */
    _close(nextFrame) {
        const lap = this.current;
        const durationS = nextFrame.lapStartET - lap.lapStartET;

        const result = {
            lap_num: lap.lapNum,
            // Prefer the sim's own last-lap time; fall back to the lapStartET
            // delta, which is correct but includes no sector detail.
            lap_time_s: nextFrame.lastLapTime > 0 ? nextFrame.lastLapTime : durationS,
            is_out_lap: lap.startedInPits,
            is_in_lap: lap.enteredPits && !lap.startedInPits,
            samples: lap.samples,
        };

        this.stats.laps++;
        if (this.onLapComplete) this.onLapComplete(result);
        return result;
    }

    /** Flush a partial lap at session end (usually discarded). */
    finish() {
        if (!this.current || this.current.samples.length === 0) return null;
        const lap = this.current;
        this.current = null;
        return {
            lap_num: lap.lapNum,
            lap_time_s: null,          // never completed, so it has no time
            is_out_lap: lap.startedInPits,
            is_in_lap: lap.enteredPits,
            partial: true,
            samples: lap.samples,
        };
    }
}

module.exports = { LapTracker, MAX_INTEGRATION_DT_S };
