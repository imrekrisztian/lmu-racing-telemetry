import React, { useState, useEffect } from 'react';
import api from '../api.js';
import { duration, lapTime } from '../format.js';
import Degradation from './Degradation.jsx';

// Hypercar and LMGT3 burn a Virtual Energy allowance; LMP2 burns fuel. The
// form follows the class so the units on screen are never the wrong ones.
const CLASSES = ['Hyper', 'GT3', 'LMP2'];

const FIELDS = [
    ['durationH', 'Race length (h)', 6],
    ['lapTimeS', 'Lap time (s)', 212],
    ['consumptionPerLap', 'Per lap', 4.4],
    ['capacity', 'Capacity', 100],
    ['reserve', 'Reserve', 0],
    ['pitLaneDeltaS', 'Pit lane loss (s)', 30],
    ['refuelRate', 'Refuel rate (/s)', 3.0],
    ['tyreChangeS', 'Tyre change (s)', 26],
    ['tyreStintLaps', 'Tyre life (laps)', ''],
];

export default function Strategy({ sessionId }) {
    const [carClass, setCarClass] = useState('Hyper');
    const [form, setForm] = useState(Object.fromEntries(FIELDS.map(([k, , d]) => [k, d])));
    const [plan, setPlan] = useState(null);
    const [error, setError] = useState(null);

    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const p = await api.strategy({
                    durationS: Number(form.durationH) * 3600,
                    lapTimeS: Number(form.lapTimeS),
                    carClass,
                    consumptionPerLap: Number(form.consumptionPerLap),
                    capacity: form.capacity === '' ? undefined : Number(form.capacity),
                    reserve: Number(form.reserve) || 0,
                    pitLaneDeltaS: Number(form.pitLaneDeltaS),
                    refuelRate: Number(form.refuelRate),
                    tyreChangeS: Number(form.tyreChangeS) || 0,
                    tyreStintLaps: form.tyreStintLaps === '' ? undefined : Number(form.tyreStintLaps),
                });
                if (!cancelled) { setPlan(p); setError(null); }
            } catch (e) {
                if (!cancelled) { setError(e.message); setPlan(null); }
            }
        })();
        return () => { cancelled = true; };
    }, [carClass, form]);

    return (
        <>
            <div className="panel">
                <h3>Inputs</h3>
                <div className="form">
                    <div>
                        <label>Class</label>
                        <select value={carClass} onChange={(e) => setCarClass(e.target.value)}>
                            {CLASSES.map((c) => <option key={c}>{c}</option>)}
                        </select>
                    </div>
                    {FIELDS.map(([k, label]) => (
                        <div key={k}>
                            <label>
                                {label}
                                {k === 'consumptionPerLap' || k === 'capacity' || k === 'reserve'
                                    ? ` (${carClass === 'LMP2' ? 'L' : '%VE'})` : ''}
                            </label>
                            <input value={form[k]} onChange={set(k)} inputMode="decimal" />
                        </div>
                    ))}
                </div>
            </div>

            {error && <div className="err">{error}</div>}

            {sessionId && (
                <Degradation
                    sessionId={sessionId}
                    pitLossS={Number(form.pitLaneDeltaS) + Number(form.tyreChangeS || 0)}
                    maxLaps={plan?.maxLapsPerStint ?? 22}
                />
            )}

            {plan && (
                <>
                    <div className="panel">
                        <div className="legend">
                            <span><b className="num">{plan.totalLaps}</b> laps</span>
                            <span><b className="num">{plan.stops}</b> stops</span>
                            <span>max <b className="num">{plan.maxLapsPerStint}</b> laps/stint
                                <span className="where"> (limited by {plan.boundBy})</span></span>
                            <span>pit total <b className="num">{duration(plan.totalPitTimeS)}</b></span>
                            <span>race <b className="num">{duration(plan.totalRaceTimeS)}</b></span>
                        </div>
                    </div>

                    <div className="panel">
                        <h3>Stint plan</h3>
                        <table>
                            <thead>
                                <tr>
                                    <th>#</th><th className="r">Laps</th><th>Range</th>
                                    <th className="r">Load</th><th className="r">On track</th><th>Pit after</th>
                                </tr>
                            </thead>
                            <tbody>
                                {plan.stints.map((s) => (
                                    <tr key={s.index}>
                                        <td className="num">{s.index}</td>
                                        <td className="r num">{s.laps}</td>
                                        <td className="num">{s.fromLap}–{s.toLap}</td>
                                        <td className="r num">{s.load}{s.loadUnit}</td>
                                        <td className="r num">{duration(s.onTrackS)}</td>
                                        <td className="num">
                                            {s.pitAfter
                                                ? `lap ${s.pitAfter.afterLap} · +${s.pitAfter.totalS.toFixed(1)}s`
                                                : 'finish'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {plan.warnings.length > 0 && (
                        <div className="panel">
                            <h3>Warnings</h3>
                            {plan.warnings.map((w, i) => <div key={i} className="detail">{w}</div>)}
                        </div>
                    )}
                </>
            )}
        </>
    );
}
