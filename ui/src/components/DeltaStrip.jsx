import React, { useEffect, useRef } from 'react';

/**
 * The delta trace for the lap in progress.
 *
 * Hand-drawn on a canvas rather than through uPlot: this redraws 30 times a
 * second and uPlot's setData/rescale cycle is far more machinery than a
 * single polyline needs.
 */
export default function DeltaStrip({ points, lapLength, height = 110 }) {
    const ref = useRef(null);

    useEffect(() => {
        const cv = ref.current;
        if (!cv) return;
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = height;
        cv.width = w * dpr; cv.height = h * dpr;
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // Symmetric scale so the zero line sits in the middle and the eye can
        // read gained/lost without re-reading the axis.
        const maxAbs = Math.max(0.25, ...points.map((p) => Math.abs(p.d)));
        const x = (dist) => (dist / Math.max(1, lapLength)) * w;
        const y = (d) => h / 2 - (d / maxAbs) * (h / 2 - 8);

        ctx.strokeStyle = 'rgba(100,116,139,.45)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

        ctx.fillStyle = 'rgba(107,122,143,.75)';
        ctx.font = '10px -apple-system, system-ui, sans-serif';
        ctx.fillText(`+${maxAbs.toFixed(2)}s`, 4, 12);
        ctx.fillText(`-${maxAbs.toFixed(2)}s`, 4, h - 4);

        if (points.length > 1) {
            // Fill between the trace and zero, coloured by which side it is on.
            ctx.beginPath();
            ctx.moveTo(x(points[0].x), y(0));
            for (const p of points) ctx.lineTo(x(p.x), y(p.d));
            ctx.lineTo(x(points[points.length - 1].x), y(0));
            ctx.closePath();
            const lastD = points[points.length - 1].d;
            ctx.fillStyle = lastD > 0 ? 'rgba(239,68,68,.16)' : 'rgba(34,197,94,.16)';
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(x(points[0].x), y(points[0].d));
            for (const p of points) ctx.lineTo(x(p.x), y(p.d));
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
    }, [points, lapLength, height]);

    return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}
