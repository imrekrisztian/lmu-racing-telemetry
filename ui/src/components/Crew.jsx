import React, { useMemo } from 'react';
import { handoverSchedule } from '../../../src/strategy/drivers.js';
import { duration } from '../format.js';

/**
 * Driver swaps and the handover schedule.
 *
 * The plan minimises handovers rather than sharing laps evenly: a driver change
 * costs around half a minute, so whoever is in the car stays in it for as long
 * as the limits and the other drivers' minimum seat time allow.
 *
 * The schedule is the team-facing half. "Lap 41" means nothing to someone
 * setting an alarm in another timezone, so each handover resolves to a wall
 * clock and a be-ready-by time.
 */
export default function Crew({ plan, startsAt, timeZone }) {
    const schedule = useMemo(
        () => (plan?.crew ? handoverSchedule(plan.crew, { startsAt, timeZone }) : []),
        [plan, startsAt, timeZone],
    );

    if (!plan?.crew) {
        return <div className="where">Add drivers above to plan swaps.</div>;
    }
    const { crew } = plan;

    return (
        <>
            <div className="panel">
                <h3>Crew</h3>
                <div className="legend">
                    <span><b className="num">{crew.handoverCount}</b> handover{crew.handoverCount === 1 ? '' : 's'}</span>
                    <span>costing <b className="num">{duration(crew.handoverTimeS)}</b></span>
                    <span className="where">
                        {crew.driverChangeS}s each · {plan.stops} stop{plan.stops === 1 ? '' : 's'} total,
                        so {plan.stops - crew.handoverCount} are fuel only
                    </span>
                </div>

                <table style={{ marginTop: 8 }}>
                    <thead>
                        <tr><th>Driver</th><th className="r">Stints</th><th className="r">Share</th>
                            <th className="r">At the wheel</th><th className="r">Longest run</th></tr>
                    </thead>
                    <tbody>
                        {crew.perDriver.map((d) => (
                            <tr key={d.name}>
                                <td>{d.name}</td>
                                <td className="r num">{d.stints}</td>
                                <td className="r num">{Math.round(d.share * 100)}%</td>
                                <td className="r num">{duration(d.totalS)}</td>
                                <td className="r num">{duration(d.longestRunS)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {crew.violations.length > 0 && (
                    <div className="deg-cliff" style={{ marginTop: 10 }}>
                        {crew.violations.map((v, i) => <div key={i}>{v.detail}</div>)}
                    </div>
                )}
            </div>

            <div className="panel">
                <h3>Stint sheet</h3>
                <table>
                    <thead>
                        <tr><th>#</th><th>Driver</th><th className="r">Laps</th><th>Range</th>
                            <th className="r">At the wheel</th><th>Stop</th></tr>
                    </thead>
                    <tbody>
                        {plan.stints.map((s) => (
                            <tr key={s.index} className={s.isHandover ? 'handover-row' : ''}>
                                <td className="num">{s.index}</td>
                                <td>{s.driver}{s.isHandover && <span className="pit-badge">IN</span>}</td>
                                <td className="r num">{s.laps}</td>
                                <td className="num">{s.fromLap}–{s.toLap}</td>
                                <td className="r num">{duration(s.onTrackS)}</td>
                                <td className="num where">
                                    {s.pitAfter ? `lap ${s.pitAfter.afterLap} · +${s.pitAfter.totalS.toFixed(0)}s` : 'finish'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {schedule.length > 0 && (
                <div className="panel">
                    <h3>Handover schedule</h3>
                    <table>
                        <thead>
                            <tr><th>Lap</th><th>Race time</th><th>Out</th><th>In</th>
                                <th>Ready by</th><th>Wall clock</th></tr>
                        </thead>
                        <tbody>
                            {schedule.map((h, i) => (
                                <tr key={i}>
                                    <td className="num">{h.atLap}</td>
                                    <td className="num">{h.raceClock}</td>
                                    <td>{h.from}</td>
                                    <td><b>{h.to}</b></td>
                                    <td className="num where">{h.readyBy ?? '—'}</td>
                                    <td className="num">{h.wallClock ?? '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="where" style={{ marginTop: 7 }}>
                        Ready-by allows fifteen minutes to get belted in and on the wall.
                    </div>
                </div>
            )}
        </>
    );
}
