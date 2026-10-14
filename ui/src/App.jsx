import React, { useEffect, useState, useCallback } from 'react';
import api, { hasBridge } from './api.js';
import { lapTime } from './format.js';
import Compare from './components/Compare.jsx';
import Engineer from './components/Engineer.jsx';
import Strategy from './components/Strategy.jsx';

const TABS = [['compare', 'Compare'], ['engineer', 'Engineer'], ['strategy', 'Strategy']];

export default function App() {
    const [sessions, setSessions] = useState([]);
    const [laps, setLaps] = useState([]);
    const [lapA, setLapA] = useState(null);   // the lap under examination
    const [lapB, setLapB] = useState(null);   // the reference
    const [tab, setTab] = useState(
        () => (typeof window !== 'undefined' && window.location.hash.slice(1)) || 'compare');
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!hasBridge) {
            setError('Running outside Electron — start with "npm run app:dev".');
            return;
        }
        (async () => {
            try {
                const [s, l] = await Promise.all([api.listSessions(), api.listLaps()]);
                setSessions(s);
                setLaps(l);

                // Open on something useful: the driver's best lap against the
                // quickest lap recorded by anyone else.
                const timed = l.filter((x) => x.lap_time_s && x.valid);
                if (timed.length) {
                    const best = timed.reduce((a, b) => (b.lap_time_s < a.lap_time_s ? b : a));
                    const mine = timed.filter((x) => x.driver !== best.driver);
                    const myBest = mine.length
                        ? mine.reduce((a, b) => (b.lap_time_s < a.lap_time_s ? b : a))
                        : timed[0];
                    setLapA(myBest.lap_id);
                    setLapB(best.lap_id);
                }
            } catch (e) {
                setError(e.message);
            }
        })();
    }, []);

    const pick = useCallback((lap, ev) => {
        if (ev.altKey || ev.shiftKey) setLapB(lap.lap_id);
        else setLapA(lap.lap_id);
    }, []);

    const track = sessions[0]?.track ?? null;
    const a = laps.find((l) => l.lap_id === lapA) ?? null;
    const b = laps.find((l) => l.lap_id === lapB) ?? null;

    const bySession = sessions.map((s) => ({
        session: s,
        laps: laps.filter((l) => l.session_id === s.session_id),
    }));

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="brand">
                    LMU Racing Telemetry
                    <small>{track ?? 'no data'}</small>
                </div>

                {bySession.map(({ session, laps: ls }) => (
                    <div key={session.session_id}>
                        <div className="group-title">
                            {session.driver ?? 'unknown'} · {session.car}
                            {session.sample_rate_hz ? ` · ${Math.round(session.sample_rate_hz)}Hz` : ''}
                        </div>
                        {ls.map((l) => (
                            <div
                                key={l.lap_id}
                                className={[
                                    'lap-row',
                                    l.lap_id === lapA ? 'pick-a' : '',
                                    l.lap_id === lapB ? 'pick-b' : '',
                                    l.valid ? '' : 'invalid',
                                ].join(' ')}
                                onClick={(e) => pick(l, e)}
                                title="Click to inspect · Alt-click to set as reference"
                            >
                                <span className="n num">{l.lap_num}</span>
                                <span className="t num">{lapTime(l.lap_time_s)}</span>
                                <span className="tag">
                                    {l.is_out_lap ? 'OUT' : l.is_in_lap ? 'IN' : ''}
                                </span>
                            </div>
                        ))}
                    </div>
                ))}

                {laps.length === 0 && !error && <div className="empty">No laps recorded</div>}
                <div className="group-title" style={{ marginTop: 24 }}>
                    Click = inspect · Alt-click = reference
                </div>
            </aside>

            <main className="main">
                <nav className="tabs">
                    {TABS.map(([id, label]) => (
                        <button
                            key={id}
                            className={`tab ${tab === id ? 'active' : ''}`}
                            onClick={() => { setTab(id); window.location.hash = id; }}
                        >{label}</button>
                    ))}
                </nav>

                <div className="content">
                    {error && <div className="err">{error}</div>}
                    {tab === 'compare' && <Compare track={track} lapA={a} lapB={b} />}
                    {tab === 'engineer' && <Engineer track={track} lapA={a} lapB={b} laps={laps} />}
                    {tab === 'strategy' && <Strategy />}
                </div>
            </main>
        </div>
    );
}
