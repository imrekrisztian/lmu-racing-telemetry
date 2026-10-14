import React, { useMemo } from 'react';
import { compoundsFor, recommendCompound } from '../../../src/strategy/tyres.js';

/**
 * Compound selection and the wet-tyre call.
 *
 * The recommendation shows its reasoning rather than just an answer: a pit
 * wall that says "wets" without saying the track is at 38% and still rising
 * is not something a strategist can argue with — and arguing with it is the
 * point.
 */
export default function TyreChoice({ carClass = 'Hyper', conditions, history = [], fitted, onFit }) {
    const compounds = useMemo(() => compoundsFor(carClass), [carClass]);
    const rec = useMemo(
        () => recommendCompound({ carClass, conditions, history, current: fitted }),
        [carClass, conditions, history, fitted],
    );

    const mins = (s) => (s == null ? null : Math.max(1, Math.round(s / 60)));
    const toWet = mins(rec.secondsToWetCrossover);
    const toDry = mins(rec.secondsToDry);

    return (
        <>
            <div className="compound-row">
                {compounds.map((c) => (
                    <button
                        key={c.id}
                        className={`compound ${fitted === c.id ? 'fitted' : ''} ${rec.compound === c.id ? 'advised' : ''}`}
                        onClick={() => onFit?.(c.id)}
                        title={c.trackTempC ? `${c.trackTempC[0]}–${c.trackTempC[1]}°C` : 'wet or drying'}
                    >
                        <i style={{ background: c.colour }} />
                        {c.name}
                    </button>
                ))}
            </div>

            {rec.compound && (
                <div className={`tyre-advice ${rec.change ? 'change' : 'hold'}`}>
                    <div className="tyre-advice-head">
                        <span>
                            {/* "Stay on" is only true if something is actually on. */}
                            {fitted == null ? 'FIT' : rec.change ? 'BOX FOR' : 'STAY ON'} <b>{rec.name}</b>
                        </span>
                        <span className="where">{Math.round(rec.confidence * 100)}% confidence</span>
                    </div>
                    <ul className="tyre-reasons">
                        {rec.reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                    {(toWet || toDry) && (
                        <div className="crossover num">
                            {toWet && <span>wet crossover in ~{toWet} min</span>}
                            {toDry && <span>dry crossover in ~{toDry} min</span>}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
