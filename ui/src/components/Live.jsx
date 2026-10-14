import React, { useEffect, useRef, useState, useCallback } from 'react';
import api from '../api.js';
import DeltaStrip from './DeltaStrip.jsx';
import TrackMap from './TrackMap.jsx';
import Standings from './Standings.jsx';
import { lapTime, delta } from '../format.js';

const SPEEDS = [1, 2, 4, 10];

/** Tyre colour by working temperature — cold grey, in-window green, hot red. */
function tyreColour(c) {
    if (c == null) return 'var(--muted)';
    if (c < 70) return '#60a5fa';
    if (c < 85) return '#22c55e';
    if (c < 100) return '#f59e0b';
    return '#ef4444';
}

export default function Live({ laps, lapA, lapB, track }) {
    const [snap, setSnap] = useState(null);
    const [running, setRunning] = useState(false);
    const [speed, setSpeed] = useState(2);
    const [error, setError] = useState(null);
    const trace = useRef([]);
    const lastLapNum = useRef(null);
    const [map, setMap] = useState(null);
    const [losses, setLosses] = useState([]);

    useEffect(() => {
        const offTick = api.onLiveTick((s) => {
            // A new lap wipes the strip; it only ever shows the lap in progress.
            if (s.lap.num !== lastLapNum.current) {
                trace.current = [];
                lastLapNum.current = s.lap.num;
            }
            if (s.lap.deltaS != null) {
                trace.current = [...trace.current, { x: s.lap.distM, d: s.lap.deltaS }];
            }
            setSnap(s);
        });
        const offEnd = api.onLiveEnd(() => setRunning(false));
        return () => { offTick(); offEnd(); };
    }, []);

    // The circuit is drawn from the reference lap's own positions, and the
    // worst segments are highlighted on it, so the map answers "where" rather
    // than merely showing where the car is.
    useEffect(() => {
        if (!lapA) return;
        let cancelled = false;
        (async () => {
            try {
                const m = await api.trackMap({ lapId: (lapB ?? lapA).lap_id });
                if (!cancelled) setMap(m);
                if (lapB && track) {
                    const l = await api.segmentLosses({ track, lapA: lapA.lap_id, lapB: lapB.lap_id });
                    if (!cancelled) setLosses(l);
                }
            } catch { /* a map is a bonus, never a blocker */ }
        })();
        return () => { cancelled = true; };
    }, [lapA?.lap_id, lapB?.lap_id, track]);

    const start = useCallback(async () => {
        if (!lapA) return;
        setError(null);
        trace.current = [];
        try {
            // Replay this lap and everything after it in the same session.
            const session = laps.filter((l) => l.session_id === lapA.session_id);
            const from = session.findIndex((l) => l.lap_id === lapA.lap_id);
            await api.liveStart({
                lapIds: session.slice(Math.max(0, from)).map((l) => l.lap_id),
                referenceLapId: lapB?.lap_id ?? null,
                speed,
            });
            setRunning(true);
        } catch (e) { setError(e.message); }
    }, [lapA?.lap_id, lapB?.lap_id, laps, speed]);

    const stop = useCallback(async () => { await api.liveStop(); setRunning(false); }, []);

    if (!lapA) return <div className="empty">Pick a lap from the left to replay.</div>;

    const d = snap?.lap.deltaS;
    const ahead = d != null && d < 0;
    const lapsLeft = snap?.stint.lapsLeft;

    return (
        <>
            {error && <div className="err">{error}</div>}

            <div className="panel live-controls">
                <div>
                    <button className="act" onClick={running ? stop : start}>
                        {running ? 'Stop' : 'Start replay'}
                    </button>
                    {SPEEDS.map((s) => (
                        <button key={s} className={`act ${speed === s ? 'done' : ''}`}
                                onClick={() => setSpeed(s)} disabled={running}>{s}×</button>
                    ))}
                </div>
                <span className="where">
                    from lap {lapA.lap_num}
                    {lapB ? ` · reference lap ${lapB.lap_num} (${lapTime(lapB.lap_time_s)})` : ' · no reference'}
                </span>
            </div>

            <div className={`delta-hero ${d == null ? '' : ahead ? 'ahead' : 'behind'}`}>
                <div className="delta-value num">{d == null ? '—' : delta(d)}</div>
                <div className="delta-bar">
                    <div className="delta-fill" style={{
                        width: `${Math.min(50, Math.abs(d ?? 0) * 50)}%`,
                        [ahead ? 'right' : 'left']: '50%',
                    }} />
                    <div className="delta-zero" />
                </div>
                <div className="delta-row num">
                    <span>LAP <b>{snap?.lap.num ?? '—'}</b></span>
                    <span>{lapTime(snap?.lap.timeS)}</span>
                    <span>LAST <b>{lapTime(snap?.lap.lastLapS)}</b></span>
                    <span>BEST <b>{lapTime(snap?.lap.bestLapS)}</b></span>
                    <span>REF <b>{lapTime(snap?.lap.refLapS)}</b></span>
                </div>
            </div>

            <div className="live-grid">
                <div className="panel">
                    <h3>Car</h3>
                    <div className="big num">{Math.round(snap?.car.speedKmh ?? 0)}<small>km/h</small></div>
                    {snap?.car.refSpeedKmh != null && (
                        <div className="where num">ref {Math.round(snap.car.refSpeedKmh)} km/h</div>
                    )}
                    <div className="gear num">{snap?.car.gear > 0 ? snap.car.gear : 'N'}</div>
                    <div className="bars">
                        <div className="bar"><i style={{ width: `${snap?.car.throttle ?? 0}%`, background: '#22c55e' }} /><label>THR</label></div>
                        <div className="bar"><i style={{ width: `${snap?.car.brake ?? 0}%`, background: '#ef4444' }} /><label>BRK</label></div>
                    </div>
                </div>

                <div className="panel">
                    <h3>Track</h3>
                    <TrackMap map={map} carDistM={snap?.lap.distM}
                              rivals={snap?.standings ?? []} deltaBySegment={losses} height={230} />
                </div>

                <div className="panel">
                    <h3>Delta this lap</h3>
                    <DeltaStrip points={trace.current} lapLength={snap?.lap.lapLengthM ?? 1} />
                    <div className="progress"><i style={{ width: `${(snap?.lap.progress ?? 0) * 100}%` }} /></div>
                </div>

                <div className="panel">
                    <h3>Stint</h3>
                    <div className="kv num">
                        <span>Level</span><b>{snap?.car.level?.toFixed(1) ?? '—'}</b>
                        <span>Per lap</span><b>{snap?.stint.perLap?.toFixed(2) ?? '—'}</b>
                        <span>Laps left</span>
                        <b className={lapsLeft != null && lapsLeft <= 2 ? 'loss' : ''}>{lapsLeft ?? '—'}</b>
                        <span>Stint laps</span><b>{snap?.stint.laps ?? 0}</b>
                        <span>Consistency</span>
                        <b>{snap?.stint.consistencySd != null ? `±${snap.stint.consistencySd.toFixed(2)}s` : '—'}</b>
                    </div>
                    {lapsLeft != null && lapsLeft <= 2 && <div className="pit-now">BOX THIS LAP</div>}
                </div>

                <div className="panel">
                    <h3>Tyres</h3>
                    <div className="tyres">
                        {(snap?.tyres ?? []).map((t) => (
                            <div key={t.wheel} className="tyre">
                                <div className="tyre-label">{t.wheel.toUpperCase()}</div>
                                <div className="tyre-temp num" style={{ color: tyreColour(t.tempC) }}>
                                    {t.tempC == null ? '—' : Math.round(t.tempC)}°
                                </div>
                                <div className="tyre-sub num">
                                    {t.innerC == null ? '' : `${Math.round(t.innerC)}/${Math.round(t.outerC)}`}
                                </div>
                                <div className="tyre-sub num">
                                    {t.pressureKpa == null ? '' : `${Math.round(t.pressureKpa)} kPa`}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="panel" style={{ gridColumn: '1 / -1' }}>
                    <h3>Field</h3>
                    <Standings cars={snap?.standings ?? []} myClass="Hyper" />
                    <div className="inferred-note">
                        Energy per car comes from <code>/rest/watch/standings</code>. What a rival did
                        in the box is inferred: the energy jump across the stop says whether they
                        fuelled, and stationary time the fuel cannot account for says they probably
                        took tyres. Nothing in the sim reports a tyre change directly.
                    </div>
                </div>

                <div className="panel" style={{ gridColumn: '1 / -1' }}>
                    <h3>Recent laps</h3>
                    <table>
                        <thead>
                            <tr><th>Lap</th><th className="r">Time</th><th className="r">To best</th><th className="r">Used</th></tr>
                        </thead>
                        <tbody>
                            {[...(snap?.history ?? [])].reverse().map((l) => (
                                <tr key={l.lap}>
                                    <td className="num">{l.lap}</td>
                                    <td className="r num">{lapTime(l.timeS)}</td>
                                    {/* Float noise made an identical lap read as slower. */}
                                    <td className={`r num ${snap.lap.bestLapS && l.timeS > snap.lap.bestLapS + 1e-3 ? 'loss' : 'gain'}`}>
                                        {snap.lap.bestLapS ? delta(l.timeS - snap.lap.bestLapS) : '—'}
                                    </td>
                                    <td className="r num">{l.fuelUsed == null ? '—' : l.fuelUsed.toFixed(2)}</td>
                                </tr>
                            ))}
                            {(snap?.history ?? []).length === 0 && (
                                <tr><td colSpan={4} className="where">No completed laps yet.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </>
    );
}
