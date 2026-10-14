import React, { useEffect, useRef, useState } from 'react';
import api from '../api.js';

/**
 * Forecast and the strategy it implies.
 *
 * The chart plots RAIN against PROJECTED WETNESS, because they are not the
 * same thing and the gap between them is where the decisions live: a circuit
 * soaks in about a minute and takes the best part of twenty to dry, so the
 * crossover out of wets trails the rain stopping by a long way.
 */
function Timeline({ timeline, events, nowS, height = 120 }) {
    const ref = useRef(null);

    useEffect(() => {
        const cv = ref.current;
        if (!cv || timeline.length < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = height;
        cv.width = w * dpr; cv.height = h * dpr;
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const t0 = timeline[0].atS, t1 = timeline[timeline.length - 1].atS;
        const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
        const y = (v) => h - 12 - v * (h - 24);

        // Wet-tyre territory.
        ctx.fillStyle = 'rgba(96,165,250,.10)';
        ctx.fillRect(0, y(1), w, y(0.30) - y(1));

        const line = (key, stroke, fill) => {
            ctx.beginPath();
            timeline.forEach((p, i) => (i ? ctx.lineTo(x(p.atS), y(p[key])) : ctx.moveTo(x(p.atS), y(p[key]))));
            if (fill) {
                ctx.lineTo(w, h - 12); ctx.lineTo(0, h - 12); ctx.closePath();
                ctx.fillStyle = fill; ctx.fill();
            } else { ctx.strokeStyle = stroke; ctx.lineWidth = 1.6; ctx.stroke(); }
        };
        line('raining', null, 'rgba(56,189,248,.16)');
        line('raining', '#38bdf8');
        line('wetness', '#f59e0b');

        for (const ev of events) {
            ctx.strokeStyle = ev.type === 'to-wet' ? '#60a5fa' : '#22c55e';
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(x(ev.atS), 4); ctx.lineTo(x(ev.atS), h - 12); ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.fillStyle = 'rgba(107,122,143,.85)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText('0', 2, h - 14);
        ctx.fillText(`+${Math.round((t1 - t0) / 60)} min`, w - 48, h - 2);
    }, [timeline, events, nowS, height]);

    return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}

const ACTION_LABEL = {
    aligned: 'FREE', 'bring-forward': 'SHIFT EARLIER', extend: 'EXTEND', 'extra-stop': 'EXTRA STOP',
};

export default function Forecast({ sessionId, plan, lapTimeS, pitLossS, tyreChangeS }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!sessionId || !plan) return;
        let cancelled = false;
        (async () => {
            try {
                const d = await api.forecast({
                    sessionId, horizonS: 14400, plan, currentLap: 1, lapTimeS,
                    pitLossS, tyreChangeS, maxLapsPerStint: plan.maxLapsPerStint,
                });
                if (!cancelled) { setData(d); setError(null); }
            } catch (e) { if (!cancelled) setError(e.message); }
        })();
        return () => { cancelled = true; };
    }, [sessionId, plan, lapTimeS, pitLossS, tyreChangeS]);

    if (error) return <div className="err">{error}</div>;
    if (!data) return <div className="where">Loading forecast…</div>;

    const { timeline, events, adaptation } = data;

    return (
        <>
            <div className="panel">
                <h3>Forecast — <span style={{ color: '#38bdf8' }}>rain</span> against <span style={{ color: '#f59e0b' }}>projected wetness</span></h3>
                <Timeline timeline={timeline} events={events} nowS={data.nowS} />
                <div className="where" style={{ marginTop: 7 }}>
                    Shaded band is wet-tyre territory. A track soaks in about a minute and takes
                    the best part of twenty to dry, so the crossover back to slicks trails the
                    rain stopping by a long way — that gap is the decision.
                    {data.synthetic && ' Forecast is synthetic until the REST client is wired up.'}
                </div>
            </div>

            {events.length > 0 && (
                <div className="panel">
                    <h3>Crossovers</h3>
                    <table>
                        <thead>
                            <tr><th>In</th><th>Change</th><th className="r">Wetness</th><th>Fit</th></tr>
                        </thead>
                        <tbody>
                            {events.map((e, i) => (
                                <tr key={i}>
                                    <td className="num">+{Math.round((e.atS - data.nowS) / 60)} min</td>
                                    <td>{e.type === 'to-wet' ? 'Track goes wet' : 'Track dries out'}</td>
                                    <td className="r num">{Math.round(e.wetness * 100)}%</td>
                                    <td><b>{e.type === 'to-wet' ? 'Wets' : 'Slicks'}</b></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {adaptation?.actions.length > 0 && (
                <div className="panel">
                    <h3>Strategy adaptation</h3>
                    <div className="legend">
                        <span><b className="num">{adaptation.freeChanges}</b> free change{adaptation.freeChanges === 1 ? '' : 's'}</span>
                        <span>added time <b className="num">{adaptation.addedTimeS}s</b></span>
                        <span className="where">
                            a tyre change at a stop you were making anyway is free; one at a stop you
                            would not have made costs the whole pit loss
                        </span>
                    </div>
                    {adaptation.actions.map((a, i) => (
                        <div key={i} className={`finding ${a.costS === 0 ? 'suggest' : 'strong'}`}>
                            <div className="head">
                                <span className="title">
                                    {ACTION_LABEL[a.action]} — lap {a.atLap}, fit {a.compound === 'wet' ? 'wets' : 'slicks'}
                                </span>
                                <span className="where num">{a.costS === 0 ? 'no cost' : `+${a.costS}s`}</span>
                            </div>
                            <div className="detail">{a.detail}</div>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}
