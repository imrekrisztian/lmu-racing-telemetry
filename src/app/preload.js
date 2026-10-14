'use strict';

// The only bridge between the renderer and Node.
//
// The surface is generated from API_NAMES rather than hand-listed, so a new
// endpoint cannot exist in main but be missing here. Every call returns
// { ok, value } or { ok:false, error } -- unwrapped below so the renderer sees
// a normal promise rejection.

const { contextBridge, ipcRenderer } = require('electron');
const { API_NAMES } = require('./api');

// Helpers first: these are const, so using one before its declaration throws a
// ReferenceError that kills the preload entirely -- and a dead preload looks
// exactly like "not running in Electron" from the renderer's side.
const invokeOk = (channel) => async (payload) => {
    const res = await ipcRenderer.invoke(channel, payload);
    if (!res?.ok) throw new Error(res?.error ?? `${channel} failed`);
    return res.value;
};

// File dialogs need the window, so they live outside the generated surface.
const invoke = (channel) => async () => {
    const res = await ipcRenderer.invoke(channel);
    if (!res?.ok) throw new Error(res?.error ?? `${channel} failed`);
    return res.value;
};

const bridge = {};
for (const name of API_NAMES) {
    bridge[name] = async (payload) => {
        const res = await ipcRenderer.invoke(`api:${name}`, payload);
        if (!res?.ok) throw new Error(res?.error ?? `${name} failed`);
        return res.value;
    };
}

// Live streaming is push, not request/response, so it gets its own handful of
// methods rather than being squeezed into the generated surface above.
bridge.liveStart = async (payload) => {
    const res = await ipcRenderer.invoke('live:start', payload);
    if (!res?.ok) throw new Error(res?.error ?? 'live:start failed');
    return res.value;
};
bridge.liveStop = () => ipcRenderer.invoke('live:stop');
bridge.liveAvailable = invokeOk('live:available');
bridge.liveConnect = async (payload) => {
    const res = await ipcRenderer.invoke('live:connect', payload);
    if (!res?.ok) throw new Error(res?.error ?? 'live:connect failed');
    return res.value;
};
bridge.trackMap = async (payload) => {
    const res = await ipcRenderer.invoke('live:trackMap', payload);
    if (!res?.ok) throw new Error(res?.error ?? 'trackMap failed');
    return res.value;
};

bridge.onLiveTick = (cb) => {
    const handler = (_e, snap) => cb(snap);
    ipcRenderer.on('live:tick', handler);
    return () => ipcRenderer.removeListener('live:tick', handler);
};
bridge.onLiveEnd = (cb) => {
    const handler = () => cb();
    ipcRenderer.on('live:end', handler);
    return () => ipcRenderer.removeListener('live:end', handler);
};

bridge.openDatabase = invoke('file:openDatabase');
bridge.pickReference = invoke('file:pickReference');
bridge.currentDatabase = invoke('file:current');

contextBridge.exposeInMainWorld('lmu', Object.freeze(bridge));
