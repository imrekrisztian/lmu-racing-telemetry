'use strict';

// A reference lap, reduced to the only thing a live delta needs: how long the
// reference had taken by each point on track.
//
// Live delta is then a subtraction -- (my time so far) minus (the reference's
// time at this same distance) -- which is exactly what the in-car delta bar
// shows, and it updates at whatever rate frames arrive.

/** Build a distance-indexed time curve from a stored lap. */
async function loadReference(con, { lapId }) {
    if (!/^[0-9a-f-]{36}$/i.test(String(lapId))) throw new Error('lapId is not a UUID');
    const res = await con.runAndReadAll(
        `SELECT dist_bin, t_s, speed_ms FROM lap_binned WHERE lap_id = '${lapId}' ORDER BY dist_bin`
    );
    const r = res.getRowObjects();
    if (r.length === 0) throw new Error('reference lap has no samples');

    const maxDist = Number(r[r.length - 1].dist_bin);
    // Dense array indexed by metre: lookup is O(1) on the hot path.
    const time = new Float64Array(maxDist + 1).fill(NaN);
    const speed = new Float64Array(maxDist + 1).fill(NaN);
    for (const row of r) {
        const d = Number(row.dist_bin);
        time[d] = Number(row.t_s);
        speed[d] = Number(row.speed_ms);
    }
    // Fill gaps so lookups never land on NaN.
    let last = 0;
    for (let i = 0; i <= maxDist; i++) {
        if (Number.isNaN(time[i])) { time[i] = last; speed[i] = speed[i - 1] ?? 0; }
        else last = time[i];
    }

    return {
        lapId: String(lapId),
        maxDist,
        lapTimeS: time[maxDist],
        /** Reference elapsed time at a given distance, linearly interpolated. */
        timeAt(distM) {
            if (!(distM > 0)) return 0;
            if (distM >= maxDist) return time[maxDist];
            const i = Math.floor(distM);
            const frac = distM - i;
            return time[i] + (time[i + 1] - time[i]) * frac;
        },
        speedAt(distM) {
            const i = Math.max(0, Math.min(maxDist, Math.round(distM)));
            return speed[i];
        },
    };
}

module.exports = { loadReference };
