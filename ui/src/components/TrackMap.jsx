import React, { useMemo } from 'react';

/**
 * The circuit, drawn from recorded world positions.
 *
 * No track files and no per-venue artwork: the shape comes out of mPos in the
 * recording, so any circuit draws itself after a single lap has been run on it.
 *
 * The path is coloured by where time is being lost, which turns the map into
 * an answer rather than a decoration.
 */
export default function TrackMap({ map, carDistM, rivals = [], deltaBySegment = [], height = 260 }) {
    const geom = useMemo(() => {
        if (!map?.points?.length) return null;
        const pad = 0.06;
        const sx = (x) => (pad + x * (1 - 2 * pad)) * 100;
        const sy = (y) => (pad + y * (1 - 2 * pad)) * 100;

        const d = map.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' ');

        // Split the path where time is being lost, so the worst corners glow.
        // Only the corner itself, centred on the apex. A detected segment can
        // span several kilometres, and painting all of it red says nothing
        // about where the time actually went.
        const HALF_WIDTH_M = 200;
        const worst = [...deltaBySegment]
            .filter((w) => w.kind === 'corner' && w.apex_m != null)
            .sort((a, b) => b.lost_s - a.lost_s).slice(0, 3);
        const hot = worst.filter((w) => w.lost_s > 0.02).map((w) => {
            const lo = Math.max(w.start_m, w.apex_m - HALF_WIDTH_M);
            const hi = Math.min(w.end_m, w.apex_m + HALF_WIDTH_M);
            const pts = map.points.filter((p) => p.dist >= lo && p.dist <= hi);
            return {
                seg: w.seg_num,
                lost: w.lost_s,
                d: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' '),
            };
        }).filter((h) => h.d.length > 0);

        const at = (dist) => {
            const n = map.points.length;
            const i = Math.max(0, Math.min(n - 1, Math.round((dist / map.lengthM) * (n - 1))));
            return { x: sx(map.points[i].x), y: sy(map.points[i].y) };
        };

        return { d, hot, at };
    }, [map, deltaBySegment]);

    if (!geom) return <div className="where">No position data for this lap.</div>;

    const me = carDistM != null ? geom.at(carDistM) : null;

    return (
        <svg viewBox="0 0 100 100" style={{ width: '100%', height, display: 'block' }}
             preserveAspectRatio="xMidYMid meet">
            <path d={geom.d} fill="none" stroke="#2b3442" strokeWidth="2.4"
                  strokeLinecap="round" strokeLinejoin="round" />
            {geom.hot.map((h) => (
                <path key={h.seg} d={h.d} fill="none" stroke="#ef4444" strokeWidth="2.6"
                      strokeLinecap="round" opacity={0.85}>
                    <title>segment {h.seg}: +{h.lost.toFixed(3)}s</title>
                </path>
            ))}

            {rivals.map((r) => {
                const p = geom.at(r.lapDistM ?? 0);
                return (
                    <circle key={r.id} cx={p.x} cy={p.y} r={r.inPits ? 1.1 : 1.4}
                            fill={r.inPits ? '#6b7a8f' : '#f59e0b'} opacity={r.inPits ? 0.5 : 0.85}>
                        <title>{r.name}{r.inPits ? ' (in pits)' : ''}</title>
                    </circle>
                );
            })}

            {me && (
                <>
                    <circle cx={me.x} cy={me.y} r="3.4" fill="#38bdf8" opacity="0.22" />
                    <circle cx={me.x} cy={me.y} r="1.9" fill="#38bdf8" stroke="#0d0f13" strokeWidth="0.6" />
                </>
            )}
        </svg>
    );
}
