// Thin wrapper over the preload bridge.
//
// When the page is opened in a plain browser (vite dev without Electron) the
// bridge is absent; rather than crashing, every call rejects with a message
// that says exactly what is wrong.

const bridge = typeof window !== 'undefined' ? window.lmu : undefined;

export const hasBridge = Boolean(bridge);

function missing(name) {
    return () => Promise.reject(new Error(
        `window.lmu.${name} is unavailable — this page is running outside Electron. ` +
        `Start it with "npm run app:dev" rather than vite alone.`
    ));
}

const NAMES = [
    'listSessions', 'listLaps', 'lapTrace', 'lapDelta', 'trackSegments',
    'segmentLosses', 'deriveSegments', 'runEngineer', 'pastAdvice',
    'recordFeedback', 'ruleScores', 'strategy', 'strategyLive',
];

const api = {};
for (const n of NAMES) api[n] = bridge?.[n] ?? missing(n);

export default api;
