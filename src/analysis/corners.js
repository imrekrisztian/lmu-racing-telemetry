'use strict';

// Decompose a lap into corners and straights.
//
// Segments have to be derived once per track and then frozen: if corner
// boundaries shifted between sessions, per-corner comparison across sessions
// would compare different pieces of tarmac.
//
// The signal is the speed trace, not steering. Steering angle varies with
// setup, driver style and controller calibration; speed minima are a property
// of the circuit. A corner is a local speed minimum bounded by the local
// maxima either side -- which also makes every straight fall out for free, as
// the gap between consecutive corners.

const DEFAULTS = {
    smoothWindowM: 25,        // moving average, in metres
    minimaWindowM: 120,       // a minimum must be lowest within +/- this
    minSeparationM: 150,      // merge minima closer than this
    minDropFraction: 0.08,    // apex must be >=8% slower than its bounding maxima
    // A corner runs from where speed first falls below this fraction of the
    // preceding straight's peak, to where it recovers past the same fraction
    // of the following peak. Walking to the local maximum instead would run
    // both neighbours across the flat top of a straight and overlap them.
    cornerSpeedFraction: 0.95,
};

/** Centred moving average over a fixed number of 1 m bins. */
function smooth(values, windowBins) {
    const half = Math.floor(windowBins / 2);
    const out = new Array(values.length);
    let sum = 0, count = 0;

    // Prime with the first window, then slide.
    for (let i = 0; i < values.length; i++) {
        const lo = Math.max(0, i - half);
        const hi = Math.min(values.length - 1, i + half);
        if (i === 0) {
            sum = 0; count = 0;
            for (let j = lo; j <= hi; j++) { sum += values[j]; count++; }
        } else {
            const prevLo = Math.max(0, i - 1 - half);
            const prevHi = Math.min(values.length - 1, i - 1 + half);
            if (lo > prevLo) { sum -= values[prevLo]; count--; }
            if (hi > prevHi) { sum += values[hi]; count++; }
        }
        out[i] = sum / count;
    }
    return out;
}

/**
 * @param {Array<{dist_bin:number, speed_ms:number}>} trace  1 m grid, ascending
 * @param {object} [opts]
 * @returns {Array} segments, alternating straight/corner, covering the lap
 */
function detectSegments(trace, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (trace.length < 100) throw new Error('trace too short to segment');

    const dist = trace.map((t) => t.dist_bin);
    const raw = trace.map((t) => t.speed_ms);
    const sp = smooth(raw, o.smoothWindowM);

    // --- local minima -----------------------------------------------------
    const w = o.minimaWindowM;
    const minima = [];
    for (let i = w; i < sp.length - w; i++) {
        let lowest = true;
        for (let j = i - w; j <= i + w; j++) {
            if (sp[j] < sp[i]) { lowest = false; break; }
        }
        if (lowest) minima.push(i);
    }

    // Collapse plateaux and near-duplicates, keeping the slowest of each group.
    const merged = [];
    for (const i of minima) {
        const last = merged[merged.length - 1];
        if (last != null && dist[i] - dist[last] < o.minSeparationM) {
            if (sp[i] < sp[last]) merged[merged.length - 1] = i;
        } else {
            merged.push(i);
        }
    }

    // --- bound each apex, without letting neighbours overlap ---------------
    // The divider between two corners is the fastest point between them. Each
    // corner then extends outwards only as far as speed stays meaningfully
    // below its bounding peaks, which leaves the fast part as a straight.
    const argmax = (lo, hi) => {
        let best = lo;
        for (let i = lo; i <= hi; i++) if (sp[i] > sp[best]) best = i;
        return best;
    };

    const dividers = [];
    dividers.push(argmax(0, merged[0]));
    for (let i = 1; i < merged.length; i++) dividers.push(argmax(merged[i - 1], merged[i]));
    dividers.push(argmax(merged[merged.length - 1], sp.length - 1));

    const frac = o.cornerSpeedFraction;
    const corners = [];
    for (let i = 0; i < merged.length; i++) {
        const apex = merged[i];
        const L = dividers[i];
        const R = dividers[i + 1];

        const bounding = Math.max(sp[L], sp[R]);
        // Reject shallow dips -- a kink on a straight is not a corner.
        if (bounding <= 0 || (bounding - sp[apex]) / bounding < o.minDropFraction) continue;

        let lo = apex;
        while (lo > L && sp[lo - 1] < frac * sp[L]) lo--;
        let hi = apex;
        while (hi < R && sp[hi + 1] < frac * sp[R]) hi++;

        corners.push({
            start_m: dist[lo], apex_m: dist[apex], end_m: dist[hi],
            min_speed_ms: raw[apex],
            entry_speed_ms: raw[lo],
            exit_speed_ms: raw[hi],
        });
    }

    // --- interleave the straights -----------------------------------------
    const segments = [];
    let cursor = dist[0];
    let n = 1;
    for (const c of corners) {
        if (c.start_m > cursor) {
            segments.push({
                seg_num: n++, kind: 'straight',
                start_m: cursor, apex_m: null, end_m: c.start_m,
                min_speed_ms: null, entry_speed_ms: null,
            });
        }
        segments.push({
            seg_num: n++, kind: 'corner',
            start_m: c.start_m, apex_m: c.apex_m, end_m: c.end_m,
            min_speed_ms: c.min_speed_ms, entry_speed_ms: c.entry_speed_ms,
        });
        cursor = c.end_m;
    }
    const lastDist = dist[dist.length - 1];
    if (cursor < lastDist) {
        segments.push({
            seg_num: n++, kind: 'straight',
            start_m: cursor, apex_m: null, end_m: lastDist,
            min_speed_ms: null, entry_speed_ms: null,
        });
    }

    return segments;
}

/** Read a lap's 1 m trace, detect segments, and persist them for the track. */
async function deriveTrackSegments(con, { track, lapId, opts }) {
    const res = await con.runAndReadAll(
        `SELECT dist_bin, speed_ms FROM lap_binned WHERE lap_id = '${lapId}' ORDER BY dist_bin`
    );
    const trace = res.getRowObjects().map((r) => ({
        dist_bin: Number(r.dist_bin), speed_ms: Number(r.speed_ms),
    }));

    const segments = detectSegments(trace, opts);

    await con.run(`DELETE FROM track_segments WHERE track = ?`, [track]);
    for (const s of segments) {
        await con.run(
            `INSERT INTO track_segments
             (track, seg_num, kind, name, start_m, apex_m, end_m, min_speed_ms, entry_speed_ms, derived_from)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::UUID)`,
            [track, s.seg_num, s.kind, s.name ?? null, s.start_m, s.apex_m, s.end_m,
             s.min_speed_ms, s.entry_speed_ms, lapId]
        );
    }
    return segments;
}

module.exports = { detectSegments, deriveTrackSegments, smooth, DEFAULTS };
