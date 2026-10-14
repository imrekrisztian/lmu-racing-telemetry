'use strict';

/** 12345.6 -> "3h25m45s" */
function duration(s) {
    if (s == null) return '-';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
    return `${m}m${String(sec).padStart(2, '0')}s`;
}

/** 212.456 -> "3:32.456" */
function lapTime(s) {
    if (s == null) return '-';
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return `${m}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** Parse "6h", "90m", "21600", "1h30m" into seconds. */
function parseDuration(str) {
    const s = String(str).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (!m || (!m[1] && !m[2] && !m[3])) throw new Error(`Cannot parse duration "${str}"`);
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

/** Parse "3:32.456", "3:32", or "212.456" into seconds. */
function parseLapTime(str) {
    const s = String(str).trim();
    if (s.includes(':')) {
        const [m, rest] = s.split(':');
        return Number(m) * 60 + Number(rest);
    }
    return Number(s);
}

const pad = (v, n) => String(v).padEnd(n);
const padL = (v, n) => String(v).padStart(n);

function renderStintSheet(plan, meta = {}) {
    const L = [];
    const title = [meta.track, meta.car, `(${meta.carClass ?? ''})`].filter(Boolean).join(' · ');
    L.push(`STINT PLAN  ${title}`);
    L.push('='.repeat(Math.max(60, title.length + 12)));
    L.push(
        `${duration(plan.totalRaceTimeS)} · ${plan.totalLaps} laps · ` +
        `${plan.stops} stop${plan.stops === 1 ? '' : 's'} · ` +
        `max ${plan.maxLapsPerStint} laps/stint (limited by ${plan.boundBy})`
    );
    L.push(
        `${plan.limiter === 'virtual-energy' ? 'Virtual Energy' : 'Fuel'}: ` +
        `${plan.capacity}${plan.unit} capacity, ${plan.reserve}${plan.unit} reserve · ` +
        `pit total ${duration(plan.totalPitTimeS)}`
    );
    L.push('');
    L.push(`  # ${pad('Laps', 6)} ${pad('Range', 10)} ${padL('Load', 9)}  ${pad('Driver', 12)} ${padL('On track', 9)}  Pit after`);
    L.push('  ' + '-'.repeat(74));

    for (const s of plan.stints) {
        const pit = s.pitAfter
            ? `lap ${s.pitAfter.afterLap}  +${s.pitAfter.totalS.toFixed(1)}s ` +
              `(${s.pitAfter.added}${s.pitAfter.addedUnit} in ${s.pitAfter.refuelS.toFixed(1)}s)`
            : 'FINISH';
        L.push(
            `  ${padL(s.index, 1)} ${pad(s.laps, 6)} ${pad(`${s.fromLap}-${s.toLap}`, 10)} ` +
            `${padL(s.load + s.loadUnit, 9)}  ${pad(s.driver ?? '-', 12)} ` +
            `${padL(duration(s.onTrackS), 9)}  ${pit}`
        );
    }

    if (plan.warnings.length) {
        L.push('');
        L.push('WARNINGS');
        for (const w of plan.warnings) L.push(`  ! ${w}`);
    }
    return L.join('\n');
}

function renderLiveAssessment(a, plan) {
    const L = [];
    L.push(`LIVE  stint ${a.stintIndex} · ${a.lapsLeftOnLoad} laps left on this load ` +
           `(through lap ${a.lastLapOnLoad}, plan says ${a.plannedPitLap})`);
    L.push('-'.repeat(60));
    for (const line of a.advice) L.push(`  ${line}`);
    if (a.projectedStopsRemaining != null) {
        L.push(`  Projected ${a.projectedStopsRemaining} further stop(s) at the measured rate.`);
    }
    return L.join('\n');
}

module.exports = { duration, lapTime, parseDuration, parseLapTime, renderStintSheet, renderLiveAssessment };
