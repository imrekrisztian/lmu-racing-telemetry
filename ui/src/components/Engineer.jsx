import React, { useEffect, useState, useCallback } from 'react';
import api from '../api.js';

/**
 * The advice panel — and the half of the feedback loop that faces the driver.
 *
 * Marking advice as applied is what eventually lets ruleScores() say which
 * rules actually made laps quicker, so the buttons are the point of the
 * screen, not decoration.
 */
export default function Engineer({ track, lapA, lapB, laps }) {
    const [findings, setFindings] = useState([]);
    const [scores, setScores] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        if (!lapA) return;
        try {
            const [adv, sc] = await Promise.all([
                api.pastAdvice({ lapId: lapA.lap_id }),
                api.ruleScores(),
            ]);
            setFindings(adv);
            setScores(sc.filter((s) => s.given > 0));
            setError(null);
        } catch (e) { setError(e.message); }
    }, [lapA?.lap_id]);

    useEffect(() => { load(); }, [load]);

    const run = async () => {
        if (!lapA || !track) return;
        setBusy(true);
        try {
            const sameDriver = laps
                .filter((l) => l.driver === lapA.driver && l.lap_time_s)
                .map((l) => l.lap_id);
            await api.runEngineer({
                track, lapId: lapA.lap_id,
                referenceLapId: lapB?.lap_id ?? null,
                lapIds: sameDriver, limit: 6,
            });
            await load();
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
    };

    const feedback = async (f, patch) => {
        try {
            await api.recordFeedback({ adviceId: f.advice_id, ...patch });
            await load();
        } catch (e) { setError(e.message); }
    };

    if (!lapA) return <div className="empty">Pick a lap from the left.</div>;

    return (
        <>
            {error && <div className="err">{error}</div>}

            <div className="panel">
                <div className="legend" style={{ justifyContent: 'space-between' }}>
                    <span>
                        Lap {lapA.lap_num}
                        {lapB ? ` against reference lap ${lapB.lap_num}` : ' — no reference selected'}
                    </span>
                    <button className="act" onClick={run} disabled={busy}>
                        {busy ? 'Analysing…' : 'Analyse this lap'}
                    </button>
                </div>
            </div>

            {findings.length === 0 && (
                <div className="empty">
                    No advice for this lap yet. Run the analysis above.
                </div>
            )}

            {findings.map((f) => (
                <div key={f.advice_id} className={`finding ${f.severity}`}>
                    <div className="head">
                        <span className="title">{f.title}</span>
                        <span className="where">
                            {f.evidence?.seg_num != null ? `segment ${f.evidence.seg_num}` : 'car'}
                            {' · '}{f.rule_id}
                        </span>
                    </div>
                    <div className="detail">{f.detail}</div>

                    {f.evidence && (
                        <div className="ev num">
                            {Object.entries(f.evidence)
                                .filter(([k]) => k !== 'seg_num')
                                .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${
                                    typeof v === 'number' ? v : JSON.stringify(v)}`)
                                .join('   ')}
                        </div>
                    )}

                    <div className="actions">
                        <button
                            className={`act ${f.applied ? 'done' : ''}`}
                            disabled={f.applied === true}
                            onClick={() => feedback(f, { applied: true, rating: 1 })}
                        >{f.applied ? 'Applied ✓' : 'I tried this'}</button>
                        <button
                            className="act"
                            disabled={f.rating === -1}
                            onClick={() => feedback(f, { applied: false, rating: -1 })}
                        >Not useful</button>
                        {f.driver_note && <span className="where">“{f.driver_note}”</span>}
                    </div>
                </div>
            ))}

            {scores.length > 0 && (
                <div className="panel">
                    <h3>Rule scorecard — negative delta means laps got quicker</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>Rule</th><th className="r">Given</th><th className="r">Applied</th>
                                <th className="r">Improved</th><th className="r">Mean delta</th>
                            </tr>
                        </thead>
                        <tbody>
                            {scores.map((s) => (
                                <tr key={s.rule_id}>
                                    <td>{s.rule_id}</td>
                                    <td className="r num">{s.given}</td>
                                    <td className="r num">{s.applied}</td>
                                    <td className="r num">{s.improved}</td>
                                    <td className={`r num ${s.meanDeltaS == null ? '' : s.meanDeltaS < 0 ? 'gain' : 'loss'}`}>
                                        {s.meanDeltaS == null ? '—' : `${s.meanDeltaS.toFixed(3)}s`}
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
