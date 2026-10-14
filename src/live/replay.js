'use strict';

// Plays recorded laps back at wall-clock pace.
//
// Two reasons this exists rather than being test scaffolding: the live view
// can be built and used on a machine with no sim attached, and a recorded
// stint can be replayed for review afterwards. The real reader on Windows
// exposes the same start/stop shape, so the view never knows which it has.
//
// Emission is driven by a clock rather than by the samples: each tick picks
// the sample nearest the current playback time. That keeps the UI at a steady
// rate whether the source recorded at 10 Hz or 90 Hz.

const UI_HZ = 30;

const WHEEL_COLS = ['fl', 'fr', 'rl', 'rr'].flatMap((w) => [
    `tyre_temp_${w}_in_c`, `tyre_temp_${w}_mid_c`, `tyre_temp_${w}_out_c`,
    `tyre_press_${w}_kpa`, `brake_temp_${w}_c`, `tyre_wear_${w}`,
]);

class ReplaySource {
    constructor(con, { lapIds, speed = 1 }) {
        this.con = con;
        this.lapIds = lapIds;
        this.speed = speed;
        this.timeline = [];
        this.timer = null;
        this.startedAt = null;
        this.cursor = 0;
    }

    async load() {
        const cols = ['dist_m', 't_s', 'speed_ms', 'throttle', 'brake', 'steer', 'gear',
            'rpm', 'fuel_l', ...WHEEL_COLS].join(', ');

        let clock = 0;
        let lapNumber = 0;
        let lastLapTime = -1;

        for (const lapId of this.lapIds) {
            if (!/^[0-9a-f-]{36}$/i.test(String(lapId))) throw new Error('lapId is not a UUID');
            const meta = (await this.con.runAndReadAll(
                `SELECT lap_num, lap_time_s FROM laps WHERE lap_id = '${lapId}'`)).getRowObjects()[0];
            const res = await this.con.runAndReadAll(
                `SELECT ${cols} FROM samples WHERE lap_id = '${lapId}' ORDER BY t_s`);
            const rows = res.getRowObjects();
            if (rows.length === 0) continue;

            lapNumber = meta ? Number(meta.lap_num) : lapNumber + 1;
            const lapStartET = clock;

            for (const r of rows) {
                const s = { lapNumber, lapStartET, lastLapTime };
                for (const k of Object.keys(r)) {
                    s[k] = r[k] == null ? null : Number(r[k]);
                }
                s.elapsedTime = lapStartET + s.t_s;
                s._at = s.elapsedTime;
                this.timeline.push(s);
            }

            const lapDuration = Number(rows[rows.length - 1].t_s);
            clock = lapStartET + lapDuration;
            lastLapTime = meta?.lap_time_s != null ? Number(meta.lap_time_s) : lapDuration;
        }

        this.duration = clock;
        return this;
    }

    /** @param {(sample:object, progress:number) => void} onSample */
    start(onSample, onEnd) {
        if (this.timeline.length === 0) throw new Error('nothing loaded to replay');
        this.startedAt = Date.now();
        this.cursor = 0;

        this.timer = setInterval(() => {
            const playbackS = ((Date.now() - this.startedAt) / 1000) * this.speed;

            // Advance to the sample at or just before the playback clock.
            while (this.cursor < this.timeline.length - 1 &&
                   this.timeline[this.cursor + 1]._at <= playbackS) {
                this.cursor++;
            }

            onSample(this.timeline[this.cursor], playbackS / this.duration);

            if (playbackS >= this.duration) {
                this.stop();
                onEnd?.();
            }
        }, 1000 / UI_HZ);
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    get loaded() { return this.timeline.length; }
}

module.exports = { ReplaySource, UI_HZ };
