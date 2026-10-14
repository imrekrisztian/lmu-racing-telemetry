'use strict';

// Track geometry, derived from a lap's world positions.
//
// The sim publishes mPos per frame, so the circuit's actual shape is already
// in the recording -- no track file, no SVG to source per venue, and it works
// for any circuit the moment one lap has been driven on it.
//
// Points are normalised into a unit box so the renderer never has to know
// anything about world coordinates or which way round the circuit runs.

const DEFAULT_STEP_M = 20;

/** @returns {{points: Array<{x,y,dist}>, bounds, lengthM}} */
async function buildTrackMap(con, { lapId, stepM = DEFAULT_STEP_M }) {
    if (!/^[0-9a-f-]{36}$/i.test(String(lapId))) throw new Error('lapId is not a UUID');

    // One sample per step: a 13.6km lap at 20m is ~680 points, which draws as
    // a single smooth path without shipping 13,600 coordinates to the UI.
    const res = await con.runAndReadAll(`
        SELECT CAST(floor(dist_m / ${Number(stepM)}) AS INTEGER) AS bucket,
               avg(pos_x) AS x, avg(pos_z) AS z, min(dist_m) AS dist
        FROM samples
        WHERE lap_id = '${lapId}' AND pos_x IS NOT NULL
        GROUP BY bucket ORDER BY bucket
    `);
    const rows = res.getRowObjects();
    if (rows.length < 10) throw new Error('not enough position data to build a map');

    const raw = rows.map((r) => ({ x: Number(r.x), y: Number(r.z), dist: Number(r.dist) }));

    const xs = raw.map((p) => p.x), ys = raw.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    // One scale for both axes, or the circuit comes out stretched.
    const span = Math.max(maxX - minX, maxY - minY) || 1;

    const points = raw.map((p) => ({
        x: (p.x - minX) / span,
        y: (p.y - minY) / span,
        dist: p.dist,
    }));

    return {
        points,
        lengthM: raw[raw.length - 1].dist,
        bounds: { minX, maxX, minY, maxY, span },
        aspect: (maxX - minX) / (maxY - minY || 1),
    };
}

/** Nearest map point to a distance around the lap -- where to draw the car. */
function pointAtDistance(map, distM) {
    if (!map?.points?.length) return null;
    const n = map.points.length;
    // Points are evenly spaced in distance, so index arithmetic beats a search.
    const i = Math.max(0, Math.min(n - 1, Math.round((distM / map.lengthM) * (n - 1))));
    return map.points[i];
}

module.exports = { buildTrackMap, pointAtDistance, DEFAULT_STEP_M };
