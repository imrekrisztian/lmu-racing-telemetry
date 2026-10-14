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
        await new Promise((r) => setTimeout(r, 2500));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(process.env.LMU_SMOKE, image.toPNG());
        process.stdout.write(`captured ${process.env.LMU_SMOKE}\n`);
        app.exit(0);
    }
}

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
    await createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    try { con?.closeSync(); } catch { /* already gone */ }
    if (process.platform !== 'darwin') app.quit();
});
