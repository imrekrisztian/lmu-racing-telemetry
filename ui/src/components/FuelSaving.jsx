import React, { useEffect, useState } from 'react';
import api from '../api.js';

/**
 * Lift-and-coast coaching.
 *
 * The output a driver can act on is not "save fuel" but "lift 80 metres early
 * at turns 4, 6 and 8, and it will cost you two tenths". Corners are ranked by
 * how much lift they can absorb, because that — not efficiency per metre — is
 * what makes heavy braking zones the place to do it.
 */
export default function FuelSaving({ track, lapId, unit = 'L' }) {
    const [target, setTarget] = useState(0.15);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!track || !lapId) return;
        let cancelled = false;
        (async () => {
            try {
                const d = await api.liftAndCoast({ track, lapId, targetSaving: Number(target) || 0 });
                if (!cancelled) { setData(d); setError(null); }
            } catch (e) { if (!cancelled) setError(e.message); }
        })();
        return () => { cancelled = true; };
    }, [track, lapId, target]);

    if (error) return <div className="err">{error}</div>;
    if (!data) return <div className="where">Loading lift-and-coast…</div>;

    const { coast, fuel, zones, plan } = data;
    const perLapPct = fuel.usedPerLap > 0 ? (Number(target) / fuel.usedPerLap) * 100 : 0;

    return (
        <>
            <div className="panel">
                <h3>Fuel saving — lift and coast</h3>

                <div className="form" style={{ gridTemplateColumns: 'repeat(3, minmax(130px, 1fr))' }}>
                    <div>
                        <label>Save per lap ({unit})</label>
                        <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" />
                    </div>
                    <div>
                        <label>Currently using</label>
                        <div className="num" style={{ padding: '6px 0' }}>
                            {fuel.usedPerLap.toFixed(2)} {unit}/lap · {Math.round(fuel.onThrottleFraction * 100)}% on throttle
                        </div>
                    </div>
                    <div>
                        <label>That is</label>
                        <div className="num" style={{ padding: '6px 0' }}>{perLapPct.toFixed(1)}% of a lap's fuel</div>
                    </div>
                </div>

                {plan && (
                    <div className={`tyre-advice ${plan.met ? 'hold' : 'change'}`} style={{ marginTop: 12 }}>
                        <div className="tyre-advice-head">
                            <span>
                                {plan.met ? 'ACHIEVABLE' : 'NOT REACHABLE'} —{' '}
                                <b className="num">{plan.achieved.toFixed(3)} {unit}/lap</b>
                                {' across '}{plan.lifts.length} corner{plan.lifts.length === 1 ? '' : 's'}
                            </span>
                            <span className="where num">costs {plan.timeLostS.toFixed(3)}s per lap</span>
                        </div>
                        {!plan.met && (
                            <div className="where" style={{ marginTop: 6 }}>
                                Lifting cannot find that much without dropping below corner speed.
                                Short-shift, or plan an extra stop.
                            </div>
                        )}
                    </div>
                )}

                {!coast.measured && (
                    <div className="deg-warn">
                        No coasting found in this lap, so drag is modelled rather than measured.
                        Figures are indicative until a lap contains some off-throttle running.
                    </div>
                )}
                {coast.measured && (
                    <div className="where" style={{ marginTop: 8 }}>
                        Coast deceleration measured from {coast.samples} off-pedal samples:{' '}
                        {coast.atKmh.map((p) => `${p.decel.toFixed(2)} m/s² at ${p.kmh} km/h`).join(' · ')}
                    </div>
                )}
            </div>

            {plan?.lifts.length > 0 && (
                <div className="panel">
                    <h3>Where to lift</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>Corner</th><th className="r">Entry</th><th className="r">Lift</th>
                                <th className="r">Coast</th><th className="r">Saves</th><th className="r">Costs</th>
                            </tr>
                        </thead>
                        <tbody>
                            {plan.lifts.map((l) => (
                                <tr key={l.seg_num}>
                                    <td className="num">seg {l.seg_num}</td>
                                    <td className="r num">{(l.zone.entrySpeedMs * 3.6).toFixed(0)} km/h</td>
                                    <td className="r num"><b>{l.liftM.toFixed(0)}m early</b></td>
                                    <td className="r num">{l.coastM.toFixed(0)}m</td>
                                    <td className="r num gain">{l.energySaved.toFixed(3)}</td>
                                    <td className="r num loss">{l.timeLostS.toFixed(3)}s</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="panel">
                <h3>Lift capacity by corner</h3>
                <div className="where" style={{ marginBottom: 8 }}>
                    How much lift each braking zone can absorb before the car falls below
                    corner speed. Capacity, not efficiency per metre, is why heavy braking
                    zones are where the energy is.
                </div>
                <table>
                    <thead>
                        <tr><th>Corner</th><th className="r">Speed drop</th><th className="r">Approach</th><th className="r">Capacity</th></tr>
                    </thead>
                    <tbody>
                        {zones.slice(0, 8).map((z) => (
                            <tr key={z.seg_num}>
                                <td className="num">seg {z.seg_num}</td>
                                <td className="r num">{z.dropKmh.toFixed(0)} km/h</td>
                                <td className="r num">{z.approachM.toFixed(0)}m</td>
                                <td className="r num">{z.capacityM.toFixed(0)}m</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
