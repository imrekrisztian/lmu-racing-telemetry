import React, { useEffect, useRef } from 'react';
import uPlot from 'uplot';

/**
 * uPlot wrapper.
 *
 * uPlot rather than a generic charting library because a lap is ~13,600 points
 * per channel and these redraw on every cursor move. It is the only option in
 * this class that stays smooth at that size.
 *
 * `syncKey` ties the crosshair across every chart on the page, so hovering the
 * delta trace also shows the speed and pedal values at the same point on track
 * — which is how you actually read telemetry.
 */
export default function Chart({ data, series, height = 180, syncKey, bands = [], yRange }) {
    const hostRef = useRef(null);
    const plotRef = useRef(null);

    useEffect(() => {
        if (!hostRef.current || !data || data[0].length === 0) return;

        // Shade corners behind the traces so every reading has track context.
        const cornerBands = {
            hooks: {
                drawClear: [(u) => {
                    const { ctx } = u;
                    ctx.save();
                    ctx.fillStyle = 'rgba(120,145,180,0.09)';
                    for (const b of bands) {
                        const x0 = u.valToPos(b.start, 'x', true);
                        const x1 = u.valToPos(b.end, 'x', true);
                        ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
                    }
                    ctx.restore();
                }],
            },
        };

        const opts = {
            width: hostRef.current.clientWidth,
            height,
            cursor: {
                sync: syncKey ? { key: syncKey, setSeries: false } : undefined,
                points: { size: 5 },
            },
            scales: { x: { time: false }, y: yRange ? { range: yRange } : {} },
            axes: [
                { stroke: '#6b7a8f', grid: { stroke: 'rgba(38,47,61,.65)' }, ticks: { stroke: '#262f3d' },
                  values: (u, vals) => vals.map((v) => `${(v / 1000).toFixed(1)}km`) },
                { stroke: '#6b7a8f', grid: { stroke: 'rgba(38,47,61,.65)' }, ticks: { stroke: '#262f3d' }, size: 54 },
            ],
            series,
            plugins: [cornerBands],
        };

        plotRef.current = new uPlot(opts, data, hostRef.current);

        const onResize = () => plotRef.current?.setSize({
            width: hostRef.current.clientWidth, height,
        });
        window.addEventListener('resize', onResize);

        return () => {
            window.removeEventListener('resize', onResize);
            plotRef.current?.destroy();
            plotRef.current = null;
        };
    }, [data, series, height, syncKey, bands, yRange]);

    return <div className="chart-wrap" ref={hostRef} />;
}
