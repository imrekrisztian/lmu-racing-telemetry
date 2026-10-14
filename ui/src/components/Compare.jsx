import React, { useEffect, useState } from 'react';
import api from '../api.js';
import Chart from './Chart.jsx';
import { lapTime, delta, metres } from '../format.js';

const SYNC = 'lap';

export default function Compare({ track, lapA, lapB }) {
    const [state, setState] = useState({ loading: false });

    useEffect(() => {
        if (!lapA || !track) return;
        let cancelled = false;
        setState({ loading: true });

        (async () => {
            try {
                // A reference lap can live in an ATTACHed file rather than this
                // database, in which case the cross-file queries are used. Same
                // mathematics, different source.
                const ext = lapB?.external === true;
                const [ta, tb, segs] = await Promise.all([
                    api.lapTrace({ lapId: lapA.lap_id }),
                    !lapB ? Promise.resolve(null)
                        : ext ? api.referenceLapTrace({ lapId: lapB.lap_id })
                              : api.lapTrace({ lapId: lapB.lap_id }),
                    api.trackSegments({ track }),
                ]);
                const d = !lapB ? null
                    : ext ? await api.referenceLapDelta({ lapA: lapA.lap_id, refLapId: lapB.lap_id })
                          : await api.lapDelta({ lapA: lapA.lap_id, lapB: lapB.lap_id });
                const losses = !lapB ? []
                    : ext ? await api.referenceSegmentLosses({ track, lapA: lapA.lap_id, refLapId: lapB.lap_id })
                          : await api.segmentLosses({ track, lapA: lapA.lap_id, lapB: lapB.lap_id });
                if (!cancelled) setState({ loading: false, ta, tb, d, segs, losses });
            } catch (e) {
                if (!cancelled) setState({ loading: false, error: e.message });
            }
        })();
        return () => { cancelled = true; };
    }, [track, lapA?.lap_id, lapB?.lap_id]);

    if (!lapA) return <div className="empty">Pick a lap from the left.</div>;
    if (state.loading) return <div className="empty">Loading…</div>;
    if (state.error) return <div className="err">{state.error}</div>;
    if (!state.ta) return <div className="empty">No trace for this lap.</div>;

    const { ta, tb, d, segs, losses } = state;
    const bands = (segs ?? [])
        .filter((s) => s.kind === 'corner')
        .map((s) => ({ start: s.start_m, end: s.end_m }));

    // uPlot needs every series on one x-axis. Laps differ in length and in
    // where their bins fall, so the reference is resampled onto THIS lap's
    // distance grid by lookup. Aligning by array index instead would drift
    // progressively whenever the two laps have different bin counts.
    const alignTo = (xs, other, key) => {
        if (!other) return null;
        const byDist = new Map();
        for (let i = 0; i < other.dist.length; i++) byDist.set(other.dist[i], other[key][i]);
        const out = new Array(xs.length);
        for (let i = 0; i < xs.length; i++) out[i] = byDist.get(xs[i]) ?? null;
        return out;
    };

    const speedData = [ta.dist, ta.speed, alignTo(ta.dist, tb, 'speed')].filter(Boolean);
    const xAxis = { label: 'dist', value: (u, v) => (v == null ? '—' : `${Math.round(v)}m`) };
    const speedSeries = [
        xAxis,
        { label: 'speed', stroke: '#38bdf8', width: 1.25, value: (u, v) => (v == null ? '—' : `${v.toFixed(0)} km/h`) },
        tb && { label: 'ref', stroke: '#f59e0b', width: 1.1, value: (u, v) => (v == null ? '—' : `${v.toFixed(0)} km/h`) },
    ].filter(Boolean);

    const pedalData = [ta.dist, ta.throttle, ta.brake];
    const pedalSeries = [
        xAxis,
        { label: 'throttle', stroke: '#22c55e', width: 1.1, value: (u, v) => (v == null ? '—' : `${v.toFixed(0)}%`) },
        { label: 'brake', stroke: '#ef4444', width: 1.1, value: (u, v) => (v == null ? '—' : `${v.toFixed(0)}%`) },
    ];

    const worst = [...losses].sort((x, y) => y.lost_s - x.lost_s).slice(0, 8);
    const gap = lapB && lapA.lap_time_s && lapB.lap_time_s ? lapA.lap_time_s - lapB.lap_time_s : null;

    return (
        <>
            <div className="panel">
                <div className="legend">
                    <span><i className="swatch" style={{ background: '#38bdf8' }} />
                        lap {lapA.lap_num} · <b className="num">{lapTime(lapA.lap_time_s)}</b></span>
                    {lapB && <span><i className="swatch" style={{ background: '#f59e0b' }} />
                        {lapB.external ? '◆ ' : ''}ref lap {lapB.lap_num}
                        {lapB.external && lapB.driver ? ` (${lapB.driver})` : ''}
                        {' · '}<b className="num">{lapTime(lapB.lap_time_s)}</b></span>}
                    {gap != null && <span>gap <b className={`num ${gap > 0 ? 'loss' : 'gain'}`}>{delta(gap)}s</b></span>}
                </div>
            </div>

            {d && (
                <div className="panel">
                    <h3>Delta — above zero is time lost</h3>
                    <Chart
                        data={[d.dist, d.delta]}
                        series={[{ label: 'dist', value: (u, v) => (v == null ? '—' : `${Math.round(v)}m`) }, {
                            label: 'delta', stroke: '#e2e8f0', width: 1.4, fill: 'rgba(239,68,68,.12)',
                            value: (u, v) => (v == null ? '—' : `${delta(v)}s`),
                        }]}
                        height={150} syncKey={SYNC} bands={bands}
                    />
                </div>
            )}

            <div className="panel">
                <h3>Speed</h3>
                <Chart data={speedData} series={speedSeries} height={190} syncKey={SYNC} bands={bands} />
            </div>

            <div className="panel">
                <h3>Throttle and brake</h3>
                <Chart data={pedalData} series={pedalSeries} height={140} syncKey={SYNC}
                       bands={bands} yRange={[0, 100]} />
            </div>

            {worst.length > 0 && (
                <div className="panel">
                    <h3>Where the time goes</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>Segment</th><th>Type</th><th className="r">From</th>
                                <th className="r">To</th><th className="r">Time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {worst.map((s) => (
                                <tr key={s.seg_num}>
                                    <td className="num">{s.seg_num}</td>
                                    <td>{s.name ?? s.kind}</td>
                                    <td className="r num">{metres(s.start_m)}</td>
                                    <td className="r num">{metres(s.end_m)}</td>
                                    <td className={`r num ${s.lost_s > 0 ? 'loss' : 'gain'}`}>
                                        {delta(s.lost_s)}s
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}
