import React, { useEffect, useState } from 'react';
import api from '../api.js';
import { lapTime } from '../format.js';

const WHEELS = [['fl', 'FL'], ['fr', 'FR'], ['rl', 'RL'], ['rr', 'RR']];

/**
 * Wear and degradation.
 *
 * Wear is rubber gone; degradation is lap time lost. They answer different
 * questions — when the tyre is finished, versus when stopping is worth the pit
 * loss — so both are shown rather than one standing in for the other.
 */
export default function Degradation({ sessionId, pitLossS = 60, maxLaps = 22 }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        (async () => {
            try {
                const d = await api.degradation({ sessionId });
                if (!cancelled) { setData(d); setError(null); }
            } catch (e) { if (!cancelled) setError(e.message); }
        })();
        return () => { cancelled = true; };
    }, [sessionId]);

    const [opt, setOpt] = useState(null);
    useEffect(() => {
        if (data?.model?.degSPerLap == null) return;
        let cancelled = false;
        api.optimalStint({ degSPerLap: data.model.degSPerLap, pitLossS, maxLaps })
            .then((o) => { if (!cancelled) setOpt(o); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [data, pitLossS, maxLaps]);

    if (error) return <div className="err">{error}</div>;
    if (!data) return <div className="where">Loading degradation…</div>;

    const { model, wear, laps } = data;
    if (model.degSPerLap == null) {
        return <div className="where">Not enough clean laps yet to fit degradation.</div>;
    }

    const perLapMs = model.degSPerLap * 1000;
    const over10 = model.degSPerLap * 10;

    return (
        <>
            <div className="panel">
                <h3>Degradation</h3>
                <div className="deg-head">
                    <div>
                        <div className="big num">{perLapMs >= 0 ? '+' : ''}{perLapMs.toFixed(0)}<small>ms / lap</small></div>
                        <div className="where num">
                            {over10 >= 0 ? '+' : ''}{over10.toFixed(2)}s over ten laps ·
                            fit r² {model.r2.toFixed(2)} · {model.lapsUsed} laps
                            {model.dropped.length > 0 && ` · ${model.dropped.length} dropped as traffic`}
                        </div>
                    </div>
                    {opt && (
                        <div className="deg-opt num">
                            <div className="where">optimal stint</div>
                            <b>{opt.laps} laps</b>
                            <div className="where">limited by {opt.limitedBy}</div>
                        </div>
                    )}
                </div>

                {model.warning && <div className="deg-warn">{model.warning}</div>}
                {model.fuelCorrected && (
                    <div className="where" style={{ marginTop: 6 }}>
                        Fuel-corrected. Raw lap times hide degradation because the car is
                        shedding weight at the same time as the tyres give up.
                    </div>
                )}
                {model.cliff && (
                    <div className="deg-cliff">
                        Falling away from lap {model.cliff.fromLap}:{' '}
                        {(model.cliff.earlySPerLap * 1000).toFixed(0)}ms → {(model.cliff.lateSPerLap * 1000).toFixed(0)}ms per lap
                        ({model.cliff.ratio.toFixed(1)}×). Shorten the stint.
                    </div>
                )}
            </div>

            <div className="panel">
                <h3>Wear</h3>
                <div className="wear-grid">
                    {WHEELS.map(([id, label]) => {
                        const w = wear.wheels[id];
                        const limiting = wear.limitingWheel === id;
                        return (
                            <div key={id} className={`wear-cell ${limiting ? 'limiting' : ''}`}>
                                <div className="tyre-label">{label}{limiting && ' ·'}</div>
                                <div className="wear-bar">
                                    <i style={{
                                        width: `${(w?.current ?? 0) * 100}%`,
                                        background: (w?.current ?? 1) < 0.25 ? 'var(--loss)'
                                            : (w?.current ?? 1) < 0.5 ? 'var(--suggest)' : 'var(--gain)',
                                    }} />
                                </div>
                                <div className="num wear-nums">
                                    {w ? `${Math.round(w.current * 100)}%` : '—'}
                                    <span className="where">
                                        {w ? ` · ${(w.perLap * 100).toFixed(2)}%/lap` : ''}
                                    </span>
                                </div>
                                <div className="num where">{w?.lapsLeft != null ? `${w.lapsLeft} laps left` : ''}</div>
                            </div>
                        );
                    })}
                </div>
                {wear.limitingWheel && (
                    <div className="where" style={{ marginTop: 8 }}>
                        <b>{wear.limitingWheel.toUpperCase()}</b> wears fastest and sets the stint —
                        {' '}{wear.lapsLeft} laps before it reaches the limit.
                    </div>
                )}
            </div>

            <div className="panel">
                <h3>Lap times — raw against fuel-corrected</h3>
                <table>
                    <thead>
                        <tr><th>Stint lap</th><th className="r">Raw</th><th className="r">Corrected</th>
                            <th className="r">Fuel</th><th className="r">Correction</th></tr>
                    </thead>
                    <tbody>
                        {laps.slice(0, 14).map((l) => (
                            <tr key={l.stintLap}>
                                <td className="num">{l.stintLap}</td>
                                <td className="r num">{lapTime(l.lapTimeS)}</td>
                                <td className="r num">{lapTime(l.correctedS)}</td>
                                <td className="r num">{l.fuelL?.toFixed(1) ?? '—'}</td>
                                <td className="r num where">+{(l.correctedS - l.lapTimeS).toFixed(3)}s</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
