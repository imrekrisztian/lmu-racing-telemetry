export const lapTime = (s) => {
    if (s == null) return '—';
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};

export const delta = (s) => (s == null ? '—' : `${s >= 0 ? '+' : ''}${s.toFixed(3)}`);

export const duration = (s) => {
    if (s == null) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec).padStart(2, '0')}s`;
};

export const metres = (m) => (m == null ? '—' : `${Math.round(m)}m`);
