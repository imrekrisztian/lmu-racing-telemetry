import React, { useEffect, useState, useCallback } from 'react';
import api, { hasBridge } from './api.js';
import { lapTime } from './format.js';
import Compare from './components/Compare.jsx';
import Engineer from './components/Engineer.jsx';
import Strategy from './components/Strategy.jsx';
import Live from './components/Live.jsx';

const TABS = [['live', 'Live'], ['compare', 'Compare'], ['engineer', 'Engineer'], ['strategy', 'Strategy']];

export default function App() {
    const [sessions, setSessions] = useState([]);
    const [laps, setLaps] = useState([]);
    const [lapA, setLapA] = useState(null);   // the lap under examination
    const [lapB, setLapB] = useState(null);   // the reference
    const [tab, setTab] = useState(
        () => (typeof window !== 'undefined' && window.location.hash.slice(1)) || 'compare');
    const [dbFile, setDbFile] = useState(null);
    const [refFile, setRefFile] = useState(null);
    const [refLaps, setRefLaps] = useState([]);
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!hasBridge) {
            setError('Running outside Electron — start with "npm run app:dev".');
            return;
        }
        (async () => {
            try {
                api.currentDatabase().then(setDbFile).catch(() => {});
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

    /** Reload everything after the active database changes. */
    const reload = useCallback(async () => {
        const [s, l] = await Promise.all([api.listSessions(), api.listLaps()]);
        setSessions(s); setLaps(l); setLapA(null); setLapB(null);
        setRefFile(null); setRefLaps([]);
    }, []);

    const openDatabase = useCallback(async () => {
        setBusy('open');
        try {
            const picked = await api.openDatabase();
            if (picked) { setDbFile(picked.file); await reload(); }
            setError(null);
        } catch (e) { setError(e.message); }
        finally { setBusy(null); }
    }, [reload]);

    const attachReference = useCallback(async () => {
        setBusy('ref');
        try {
            const file = await api.pickReference();
            if (!file) return;
            const res = await api.attachReferenceFile({ file });
            setRefFile(res.file);
            setRefLaps(res.laps);
            setError(res.laps.length === 0 ? 'That file has no completed laps.' : null);
        } catch (e) { setError(e.message); setRefFile(null); setRefLaps([]); }
        finally { setBusy(null); }
    }, []);

    const detachReference = useCallback(async () => {
        try { await api.detachReferenceFile(); } catch { /* nothing attached */ }
        setRefFile(null); setRefLaps([]);
        setLapB((b) => (refLaps.some((l) => l.lap_id === b) ? null : b));
    }, [refLaps]);

    const pick = useCallback((lap, ev) => {
        if (ev.altKey || ev.shiftKey) setLapB(lap.lap_id);
        else setLapA(lap.lap_id);
    }, []);

    const track = sessions[0]?.track ?? null;
    const allLaps = [...laps, ...refLaps];
    const a = laps.find((l) => l.lap_id === lapA) ?? null;
    const b = allLaps.find((l) => l.lap_id === lapB) ?? null;
    const shortFile = (f) => (f ? f.split(/[\\/]/).pop() : null);

    const bySession = sessions.map((s) => ({
        session: s,
        laps: laps.filter((l) => l.session_id === s.session_id),
    }));

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="brand">
                    LMU Racing Telemetry
                    <small title={dbFile ?? ''}>{shortFile(dbFile) ?? 'no database'}</small>
                </div>

                <div className="db-actions">
                    <button className="act" onClick={openDatabase} disabled={busy === 'open'}>
                        {busy === 'open' ? 'Opening…' : 'Open recording…'}
                    </button>
                    <button className="act" onClick={refFile ? detachReference : attachReference}
                            disabled={busy === 'ref'}>
                        {busy === 'ref' ? 'Attaching…' : refFile ? 'Detach reference' : 'Compare with file…'}
                    </button>
                </div>

                <div className="pick-hint">
                    Click a lap to inspect it · <b>Alt-click</b> to set it as the reference
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

                {refLaps.length > 0 && (
                    <div className="ref-group">
                        <div className="group-title">
                            ◆ {shortFile(refFile)}
                            <span className="where"> — alt-click to compare</span>
                        </div>
                        {refLaps.map((l) => (
                            <div
                                key={l.lap_id}
                                className={`lap-row external ${l.lap_id === lapB ? 'pick-b' : ''}`}
                                onClick={() => setLapB(l.lap_id)}
                                title={`${l.driver ?? 'unknown'} · ${l.track}`}
                            >
                                <span className="n num">{l.lap_num}</span>
                                <span className="t num">{lapTime(l.lap_time_s)}</span>
                                <span className="tag">{l.driver ?? ''}</span>
                            </div>
                        ))}
                    </div>
                )}

                {laps.length === 0 && !error && (
                    <div className="empty">
                        No laps in this database.<br />
                        <span className="where">Open a recording above, or run the reader.</span>
                    </div>
                )}
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
                    {tab === 'live' && <Live laps={laps} lapA={a} lapB={b?.external ? null : b} track={track}
                                            carClass={sessions[0]?.car_class ?? 'Hyper'} />}
                    {tab === 'compare' && <Compare track={track} lapA={a} lapB={b} />}
                    {tab === 'engineer' && <Engineer track={track} lapA={a} lapB={b} laps={laps} />}
                    {tab === 'strategy' && <Strategy sessionId={a?.session_id ?? sessions[0]?.session_id}
                                                     track={track} lapId={a?.lap_id} />}
                </div>
            </main>
        </div>
    );
}
