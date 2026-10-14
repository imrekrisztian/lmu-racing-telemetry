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

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

let con = null;
let win = null;

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
    ipcMain.handle('live:start', async (_e, { lapIds, referenceLapId, speed = 1 }) => {
        try {
            stopLive();
            const reference = referenceLapId
                ? await loadReference(con, { lapId: referenceLapId }) : null;
            const session = new LiveSession({ reference });
            const source = await new ReplaySource(con, { lapIds, speed }).load();

            source.start(
                (sample, progress) => {
                    const snap = session.update(sample);
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
    registerHandlers();
    registerLiveHandlers();
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
