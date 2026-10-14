import React from 'react';
import { lapTime } from '../format.js';

/**
 * The competitor board.
 *
 * Energy per car comes from LMU's /rest/watch/standings (veFraction /
 * fuelFraction) — shared memory does not carry it.
 *
 * What a rival did in the pits is INFERRED, and marked as such: the energy
 * jump across the stop says whether they fuelled, and stationary time the
 * fuel cannot account for says they probably took tyres. Nothing in the sim
 * reports a tyre change directly, so these are reasoned, not read.
 */
export default function Standings({ cars = [], myClass = null }) {
    if (cars.length === 0) return <div className="where">Waiting for the field…</div>;

    return (
        <table className="standings">
            <thead>
                <tr>
                    <th>P</th><th>Car</th><th>Cl</th>
                    <th className="r">Gap</th><th className="r">Last</th>
                    <th>Energy</th><th className="r">Left</th><th>Last stop</th>
                </tr>
            </thead>
            <tbody>
                {cars.map((c) => {
                    const pct = c.energyFrac == null ? null : Math.round(c.energyFrac * 100);
                    const low = pct != null && pct < 12;
                    const s = c.lastStop;
                    return (
                        <tr key={c.id} className={[
                            c.inPits ? 'in-pits' : '',
                            myClass && c.carClass === myClass ? 'my-class' : '',
                        ].join(' ')}>
                            <td className="num">{c.position}</td>
                            <td>{c.name}{c.inPits && <span className="pit-badge">PIT</span>}</td>
                            <td className="where">{c.carClass}</td>
                            <td className="r num">{c.gapToLeaderS == null ? '—'
                                : c.gapToLeaderS === 0 ? 'LEAD' : `+${c.gapToLeaderS.toFixed(1)}`}</td>
                            <td className="r num">{lapTime(c.lastLapS)}</td>
                            <td>
                                <div className="energy">
                                    <i style={{
                                        width: `${pct ?? 0}%`,
                                        background: low ? 'var(--loss)' : pct < 30 ? 'var(--suggest)' : 'var(--gain)',
                                    }} />
                                    <span className="num">{pct == null ? '—' : `${pct}%`}</span>
                                </div>
                            </td>
                            <td className={`r num ${c.estLapsLeft != null && c.estLapsLeft <= 2 ? 'loss' : ''}`}>
                                {c.estLapsLeft ?? '—'}
                            </td>
                            <td className="where">
                                {!s ? '—' : (
                                    <>
                                        L{s.lap} · {s.stationaryS.toFixed(0)}s
                                        {s.refuelled && <span className="chip fuel">
                                            +{Math.round(s.energyGained * 100)}% fuel</span>}
                                        {s.tyresLikely && <span className="chip tyre">tyres?</span>}
                                    </>
                                )}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}
