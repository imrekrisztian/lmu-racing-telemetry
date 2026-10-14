#!/usr/bin/env node
'use strict';

// Starts Vite, waits for it to report a URL, then launches Electron pointed at
// it. Keeps the dev loop to a single command without pulling in a process
// runner as a dependency.

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vite = spawn('npx', ['vite', '--config', 'ui/vite.config.mjs'],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });

let launched = false;
vite.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    const m = text.match(/https?:\/\/localhost:\d+/);
    if (m && !launched) {
        launched = true;
        const electron = spawn(require('electron'), [path.join(root, 'src', 'app', 'main.js'), ...process.argv.slice(2)],
            { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: m[0] } });
        electron.on('exit', () => { vite.kill(); process.exit(0); });
    }
});

process.on('SIGINT', () => { vite.kill(); process.exit(0); });
