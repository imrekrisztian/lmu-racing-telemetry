import React, { useMemo, useRef, useEffect } from 'react';

/**
 * Conditions, mirroring rF2ScoringInfo's fields one for one.
 *
 *   mAmbientTemp / mTrackTemp      Celsius (already — unlike tyre temps)
 *   mRaining                       rain severity   0..1
 *   mDarkCloud                     cloud darkness  0..1
 *   mWind                          vec3 speed
 *   mMin/Avg/MaxPathWetness        wetness on the racing line 0..1
 *
 * These are read from the SCORING buffer. The Weather buffer holds
 * rF2WeatherControlInfo, which is an input for setting weather, not a source.
 *
 * The call that matters is the crossover: rain stopping does not dry a
 * circuit, and a track that is still wet after the shower has passed is where
 * tyre decisions are won and lost. Rain and wetness are therefore plotted
 * together, so the gap between them is visible rather than inferred.
 */

function trackState(c) {
    if (!c) return { label: '—', cls: '' };
    const wet = c.wetness_avg ?? 0;
    const rain = c.raining ?? 0;
    if (wet < 0.08 && rain < 0.05) return { label: 'DRY', cls: 'dry' };
    if (wet < 0.30) return { label: rain > 0.05 ? 'DAMP' : 'CROSSOVER', cls: 'damp' };
    return { label: rain > 0.3 ? 'WET' : 'WET — DRYING', cls: 'wet' };
}

function Sparkline({ history, height = 54 }) {
    const ref = useRef(null);
    useEffect(() => {
        const cv = ref.current;
        if (!cv || history.length < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = height;
        cv.width = w * dpr; cv.height = h * dpr;
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const x = (i) => (i / (history.length - 1)) * w;
        const y = (v) => h - 4 - v * (h - 10);

        const line = (key, stroke, fill) => {
            ctx.beginPath();
            history.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[key])) : ctx.moveTo(x(i), y(p[key]))));
            if (fill) {
                ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
                ctx.fillStyle = fill; ctx.fill();
            } else {
                ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
            }
        };
        line('rain', null, 'rgba(56,189,248,.18)');
        line('wet', '#f59e0b');
        line('rain', '#38bdf8');
    }, [history, height]);

    return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}

export default function Weather({ conditions, history = [] }) {
    const state = useMemo(() => trackState(conditions), [conditions]);
    if (!conditions) return <div className="where">Waiting for conditions…</div>;

    const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
    const windKmh = conditions.wind_ms == null ? null : conditions.wind_ms * 3.6;
    const windDeg = conditions.wind_dir_rad == null ? 0 : (conditions.wind_dir_rad * 180) / Math.PI;

    return (
        <>
            <div className={`track-state ${state.cls}`}>{state.label}</div>

            <div className="kv num" style={{ marginTop: 10 }}>
                <span>Air</span><b>{conditions.air_temp_c?.toFixed(1) ?? '—'}°C</b>
                <span>Track</span><b>{conditions.track_temp_c?.toFixed(1) ?? '—'}°C</b>
                <span>Rain</span><b>{pct(conditions.raining)}</b>
                <span>Cloud</span><b>{pct(conditions.cloud)}</b>
                <span>Wind</span>
                <b>
                    {windKmh == null ? '—' : `${windKmh.toFixed(0)} km/h`}
                    {windKmh != null && (
                        <span className="wind-arrow" style={{ transform: `rotate(${windDeg}deg)` }}>↑</span>
                    )}
                </b>
            </div>

            <div className="wetness">
                <div className="wetness-label">
                    Wetness <span className="where">min / avg / max on the line</span>
                </div>
                <div className="wetness-bar">
                    <i className="avg" style={{ width: `${(conditions.wetness_avg ?? 0) * 100}%` }} />
                    <i className="span" style={{
                        left: `${(conditions.wetness_min ?? 0) * 100}%`,
                        width: `${((conditions.wetness_max ?? 0) - (conditions.wetness_min ?? 0)) * 100}%`,
                    }} />
                </div>
                <div className="wetness-nums num">
                    {pct(conditions.wetness_min)} · {pct(conditions.wetness_avg)} · {pct(conditions.wetness_max)}
                </div>
            </div>

            {history.length > 1 && (
                <div style={{ marginTop: 10 }}>
                    <div className="wetness-label">
                        <span style={{ color: '#38bdf8' }}>rain</span>
                        {' vs '}
                        <span style={{ color: '#f59e0b' }}>wetness</span>
                        <span className="where"> — the gap is the crossover</span>
                    </div>
                    <Sparkline history={history} />
                </div>
            )}
        </>
    );
}
