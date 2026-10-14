'use strict';

// Electron main process.
//
// It owns the DuckDB connection and the (Windows-only) reader; the renderer
// owns nothing but pixels. Every call crosses one narrow, named bridge, which
// is why src/app/api.js is a plain module -- the IPC layer here is a forwarder
// with no logic of its own to get wrong.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { open } = require('../../db/open');
const { API, API_NAMES } = require('./api');
const { ReplaySource } = require('../live/replay');
const { LiveSession } = require('../live/session');
const { loadReference } = require('../live/reference');
const { ShmSource, available: liveAvailable } = require('../live/shm-source');
const { LapTracker } = require('../ingest/lap-tracker');
const { Writer } = require('../ingest/writer');
const { StandingsTracker } = require('../live/standings');
const { CompetitorSim } = require('../live/competitor-sim');
const { buildTrackMap } = require('../analysis/track-map');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

let con = null;
let win = null;
let currentDatabase = null;

function databasePath() {
    const fromArg = process.argv.find((a) => a.endsWith('.duckdb'));
    if (fromArg) return fromArg;
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'telemetry.duckdb');
}

// Live streaming sits outside the request/response API: it pushes, and at
// 30 Hz an invoke round trip per frame would be wasteful. The source is
// swappable -- replay here, the shared-memory reader on Windows -- and the
// renderer cannot tell the difference.
let liveSource = null;

function stopLive() {
    liveSource?.stop();
    liveSource = null;
}

/**
 * Send to the renderer, if there is still a renderer.
 *
 * `win?.webContents` is NOT sufficient: after the window closes, `win` is a
 * non-null reference to a destroyed object and touching webContents throws
 * "Object has been destroyed". The replay timer fires every 33ms, so the race
 * between closing the window and the next tick is routinely lost.
 */
function sendToRenderer(channel, payload) {
    try {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
            stopLive();
            return;
        }
        win.webContents.send(channel, payload);
    } catch {
        // The window went away mid-send. Stop streaming into the void.
        stopLive();
    }
}

function registerLiveHandlers() {
    ipcMain.handle('live:available', async () => ({ ok: true, value: liveAvailable() }));

    /**
     * Connect to the running sim.
     *
     * Does two things at once: drives the dashboard, and RECORDS. A practice
     * session you watched but did not capture cannot be analysed afterwards,
     * which defeats most of the point.
     */
    ipcMain.handle('live:connect', async (_e, { referenceLapId } = {}) => {
        try {
            const check = liveAvailable();
            if (!check.ok) return { ok: false, error: check.reason };

            stopLive();
            const reference = referenceLapId
                ? await loadReference(con, { lapId: referenceLapId }) : null;
            const session = new LiveSession({ reference });
            const source = new ShmSource().open();

            // Capture the session as it happens.
            const writer = await new Writer(con).init();
            const first = source.readOnce();
            const sessionId = await writer.createSession({
                track: first?.trackName || 'Unknown', car: first?.vehicleName || 'Unknown',
                session_type: 'live', driver: null, sim_version: 'lmu',
            });
            const tracker = new LapTracker();
            let recorded = 0;

            source.start(
                (sample) => {
                    const snap = session.update(sample);
                    const done = tracker.push(sample);
                    if (done) {
                        writer.writeLap(sessionId, done)
                            .then(() => { recorded++; sendToRenderer('live:lap', { recorded }); })
                            .catch((e) => process.stderr.write(`[record] ${e.message}\n`));
                    }
                    sendToRenderer('live:tick', { ...snap, live: true, recorded });
                },
                (err) => {
                    if (err) sendToRenderer('live:error', err.message);
                    sendToRenderer('live:end');
                },
            );

            liveSource = source;
            return { ok: true, value: { connected: true, track: first?.trackName, car: first?.vehicleName, sessionId } };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('live:start', async (_e, { lapIds, referenceLapId, speed = 1 }) => {
        try {
            stopLive();
            const reference = referenceLapId
                ? await loadReference(con, { lapId: referenceLapId }) : null;
            const session = new LiveSession({ reference });
            const source = await new ReplaySource(con, { lapIds, speed }).load();

            // Competitors: synthetic for now. On Windows this is scoring plus
            // /rest/watch/standings, feeding the same tracker.
            const field = new CompetitorSim({ trackLengthM: reference?.maxDist ?? undefined });
            const standings = new StandingsTracker();

            source.start(
                (sample, progress) => {
                    const snap = session.update(sample);
                    const clockS = (sample.elapsedTime ?? 0);
                    snap.standings = standings.update(field.step(clockS), clockS);
                    sendToRenderer('live:tick', { ...snap, progress });
                },
                () => sendToRenderer('live:end'),
            );
            liveSource = source;
            return { ok: true, value: { samples: source.loaded, durationS: source.duration } };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('live:stop', async () => { stopLive(); return { ok: true, value: true }; });

    ipcMain.handle('live:trackMap', async (_e, { lapId }) => {
        try { return { ok: true, value: await buildTrackMap(con, { lapId }) }; }
        catch (err) { return { ok: false, error: err.message }; }
    });
}

/**
 * Native file dialogs and switching the active database.
 *
 * The packaged app has no command line to pass a path on, so without these a
 * fresh install opens an empty database in userData with no way to reach a
 * recording -- which is exactly how it shipped.
 */
function registerFileHandlers() {
    const pick = async (title, buttonLabel) => {
        const r = await dialog.showOpenDialog(win, {
            title, buttonLabel, properties: ['openFile'],
            filters: [{ name: 'Telemetry database', extensions: ['duckdb'] }, { name: 'All files', extensions: ['*'] }],
        });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    };

    ipcMain.handle('file:openDatabase', async () => {
        try {
            const file = await pick('Open telemetry database', 'Open');
            if (!file) return { ok: true, value: null };

            // Reopen on the new file. The old connection is closed first so the
            // previous database is not left locked.
            const previous = con;
            const opened = await open(file);
            try { previous?.con?.closeSync?.(); previous?.closeSync?.(); } catch { /* already gone */ }
            con = opened.con;
            currentDatabase = file;
            return { ok: true, value: { file } };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('file:pickReference', async () => {
        try {
            const file = await pick('Choose a reference recording', 'Attach');
            return { ok: true, value: file };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('file:current', async () => ({ ok: true, value: currentDatabase }));
}

function registerHandlers() {
    for (const name of API_NAMES) {
        ipcMain.handle(`api:${name}`, async (_event, payload) => {
            try {
                return { ok: true, value: await API[name](con, payload ?? {}) };
            } catch (err) {
                // Errors are returned, not thrown: an exception across the IPC
                // boundary arrives as an opaque string with no stack worth
                // reading. The renderer can show this one.
                return { ok: false, error: err.message };
            }
        });
    }
}

async function createWindow() {
    win = new BrowserWindow({
        width: 1500,
        height: 950,
        backgroundColor: '#0d0f13',
        title: 'LMU Racing Telemetry',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // Stop streaming as soon as the window goes. Waiting for
    // 'window-all-closed' leaves a 33ms window in which the timer fires at a
    // destroyed object, which crashes the main process.
    win.on('closed', () => { stopLive(); win = null; });

    // Surface renderer errors in the terminal; otherwise a blank window is
    // the only symptom of a broken bundle.
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
        process.stderr.write(`[preload] FAILED ${preloadPath}: ${error}\n`);
        dialog.showErrorBox('Preload failed',
            `${preloadPath}\n\n${error}\n\nThe app cannot talk to its backend.`);
    });

    win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) process.stderr.write(`[renderer] ${message}\n`);
    });

    if (DEV_URL) {
        await win.loadURL(DEV_URL);
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        await win.loadFile(path.join(__dirname, '..', '..', 'ui', 'dist', 'index.html'), {
            hash: process.env.LMU_SMOKE_TAB ?? '',
        });
    }

    // Smoke mode: render, capture, exit. Lets the UI be verified in CI (and
    // from a terminal) rather than only by looking at it.
    if (process.env.LMU_SMOKE) {
        // Let the view settle; for the live tab, drive it first so the capture
        // shows a running session rather than an empty shell.
        if (process.env.LMU_SMOKE_CLICK) {
            await new Promise((r) => setTimeout(r, 1200));
            // Comma-separated and clicked in order, so a capture can select a
            // playback speed and then start, not just press one button.
            for (const label of process.env.LMU_SMOKE_CLICK.split(',')) {
                const want = JSON.stringify(label.trim());
                const hit = await win.webContents.executeJavaScript(
                    '(() => { const b = [...document.querySelectorAll("button")]'
                    + '.find(x => x.textContent.trim() === ' + want + ');'
                    + ' if (b) b.click(); return Boolean(b); })()'
                );
                process.stdout.write('click ' + label.trim() + ': ' + (hit ? 'ok' : 'NOT FOUND') + '\n');
                await new Promise((r) => setTimeout(r, 300));
            }
            await new Promise((r) => setTimeout(r, Number(process.env.LMU_SMOKE_WAIT ?? 4000)));
        }
        // Regression check for the destroyed-window crash: close the window
        // while the live stream is still ticking and confirm nothing throws.
        if (process.env.LMU_SMOKE_CLOSE) {
            win.close();
            await new Promise((r) => setTimeout(r, 2000));
            process.stdout.write('survived closing the window mid-stream\n');
            app.exit(0);
            return;
        }

        await new Promise((r) => setTimeout(r, 2500));

        // Scroll AFTER settling. Panels that load asynchronously are not in the
        // document yet at first paint, so an early scrollTop is clamped to the
        // short page and silently lands at the top.
        if (process.env.LMU_SMOKE_SCROLL) {
            const at = await win.webContents.executeJavaScript(`
                (() => {
                    const el = document.querySelector('.content');
                    el.scrollTop = ${Number(process.env.LMU_SMOKE_SCROLL)};
                    return { asked: ${Number(process.env.LMU_SMOKE_SCROLL)},
                             got: el.scrollTop, height: el.scrollHeight };
                })()
            `);
            process.stdout.write(`scroll ${JSON.stringify(at)}\n`);
            await new Promise((r) => setTimeout(r, 500));
        }

        const image = await win.webContents.capturePage();
        fs.writeFileSync(process.env.LMU_SMOKE, image.toPNG());
        process.stdout.write(`captured ${process.env.LMU_SMOKE}\n`);
        app.exit(0);
    }
}

// A stray async failure in the main process takes the entire app down with a
// modal dialog. Log it and keep running; the renderer stays usable.
process.on('uncaughtException', (err) => {
    process.stderr.write(`[main] uncaught: ${err?.stack ?? err}\n`);
    stopLive();
});

app.whenReady().then(async () => {
    const file = databasePath();
    try {
        ({ con } = await open(file));
    } catch (err) {
        dialog.showErrorBox('Cannot open database', `${file}\n\n${err.message}`);
        app.quit();
        return;
    }
    currentDatabase = file;
    registerHandlers();
    registerLiveHandlers();
    registerFileHandlers();
    await createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    stopLive();
    try { con?.closeSync(); } catch { /* already gone */ }
    if (process.platform !== 'darwin') app.quit();
});
