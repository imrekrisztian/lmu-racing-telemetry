'use strict';

// Driver swaps and stint handovers.
//
// The optimisation is not "share the laps out". It is MINIMISE HANDOVERS while
// still satisfying every drive-time rule, because a driver change adds roughly
// half a minute to a stop that would otherwise be fuel only. Double and triple
// stinting a driver is how endurance teams buy that time back, so the planner
// keeps whoever is in the car in it for as long as the rules and the other
// drivers' minimum times allow.
//
// WEC-shaped constraints, all optional and all configurable:
//   maxContinuousStints   consecutive stints before a change is forced
//   maxContinuousS        consecutive time at the wheel
//   maxTotalS             total time across the race
//   minTotalS             a driver who must be given seat time (Bronze rules)
//   rollingWindow         e.g. no more than 4h at the wheel in any 6h period

const DEFAULTS = {
    driverChangeS: 32,          // belts, seat insert, radio -- on top of the stop
    rollingWindow: null,        // { windowS, maxS }
};

/** Time a driver has at the wheel inside the last `windowS` of the timeline. */
function timeInWindow(timeline, driver, atS, windowS) {
    const from = atS - windowS;
    let total = 0;
    for (const seg of timeline) {
        if (seg.driver !== driver) continue;
        const start = Math.max(seg.startS, from);
        const end = Math.min(seg.endS, atS);
        if (end > start) total += end - start;
    }
    return total;
}

function eligible(driver, state, stint, atS, rules) {
    const s = state.get(driver.name);

    if (driver.maxTotalS != null && s.totalS + stint.onTrackS > driver.maxTotalS) {
        return { ok: false, why: 'total drive time' };
    }
    if (driver.maxContinuousStints != null) {
        const stintsIfTaken = (s.current ? s.runStints : 0) + 1;
        if (stintsIfTaken > driver.maxContinuousStints) {
            return { ok: false, why: 'consecutive stints' };
        }
    }
    if (driver.maxContinuousS != null) {
        // Checked even when the driver is NOT currently in the car: a single
        // stint longer than their continuous limit is just as much a breach as
        // two short ones, and the earlier version skipped that case entirely.
        const runIfTaken = (s.current ? s.runS : 0) + stint.onTrackS;
        if (runIfTaken > driver.maxContinuousS) return { ok: false, why: 'continuous time' };
    }
    const w = driver.rollingWindow ?? rules.rollingWindow;
    if (w) {
        const used = timeInWindow(state.timeline, driver.name, atS + stint.onTrackS, w.windowS);
        if (used + stint.onTrackS > w.maxS) return { ok: false, why: 'rolling window' };
    }
    return { ok: true };
}

/**
 * Could everyone still reach their minimum if this stint goes to `candidate`?
 *
 * Without this check the planner happily triple-stints the quickest driver and
 * only discovers at the last stop that a Bronze has nowhere left to run. The
 * shortfall has to be caught while there are still stints to give away.
 */
function minimumsStillReachable(stints, i, candidate, state, drivers) {
    const remaining = stints.slice(i + 1).reduce((n, s) => n + s.onTrackS, 0);
    let needed = 0;
    for (const d of drivers) {
        if (d.minTotalS == null) continue;
        const have = state.get(d.name).totalS + (d.name === candidate ? stints[i].onTrackS : 0);
        needed += Math.max(0, d.minTotalS - have);
    }
    return needed <= remaining;
}

/**
 * Assign drivers to an existing stint plan.
 *
 * @param {Array} stints from planRace(): [{ index, laps, onTrackS, fromLap, toLap }]
 * @param {Array} drivers [{ name, paceDeltaS?, maxContinuousStints?, maxContinuousS?,
 *                           maxTotalS?, minTotalS?, rollingWindow? }]
 */
function planDriverStints({ stints, drivers: rawDrivers, rules = {} } = {}) {
    const r = { ...DEFAULTS, ...rules };
    if (!rawDrivers || rawDrivers.length === 0) throw new Error('at least one driver is required');

    // `maxStintS` was the field name before this planner existed. Accept it as
    // an alias rather than silently ignoring it, which would quietly drop a
    // limit a caller believed was being enforced.
    const drivers = rawDrivers.map((d) => (
        d.maxStintS != null && d.maxContinuousS == null
            ? { ...d, maxContinuousS: d.maxStintS } : d));

    const state = new Map(drivers.map((d) => [d.name, {
        totalS: 0, stints: 0, runS: 0, runStints: 0, current: false, longestRunS: 0,
    }]));
    state.timeline = [];
    state.get = state.get.bind(state);

    const violations = [];
    const assigned = [];
    const handovers = [];
    let clockS = 0;
    let currentDriver = null;

    for (let i = 0; i < stints.length; i++) {
        const stint = stints[i];

        // Prefer to keep whoever is in the car -- that is the whole point.
        let pick = null;
        if (currentDriver) {
            const d = drivers.find((x) => x.name === currentDriver);
            const e = eligible(d, state, stint, clockS, r);
            if (e.ok && minimumsStillReachable(stints, i, currentDriver, state, drivers)) {
                pick = currentDriver;
            }
        }

        if (!pick) {
            // Whoever is furthest from their obligations goes in; pace breaks
            // ties, so free choices go to the quicker driver.
            const options = drivers
                .filter((d) => d.name !== currentDriver)
                .map((d) => ({ d, e: eligible(d, state, stint, clockS, r) }))
                .filter((x) => x.e.ok);

            const scored = options.map(({ d }) => {
                const s = state.get(d.name);
                const owed = Math.max(0, (d.minTotalS ?? 0) - s.totalS);
                return { name: d.name, owed, pace: d.paceDeltaS ?? 0, totalS: s.totalS };
            }).sort((a, b) => (b.owed - a.owed) || (a.pace - b.pace) || (a.totalS - b.totalS));

            if (scored.length > 0) {
                pick = scored[0].name;
            } else {
                // Nobody is legal. Say so rather than silently breaking a rule.
                const d = drivers.find((x) => x.name === currentDriver) ?? drivers[0];
                pick = d.name;
                violations.push({
                    stint: stint.index,
                    issue: 'no eligible driver',
                    detail: `Stint ${stint.index} breaches every driver's limits; assigned ${pick}.`,
                });
            }
        }

        const isHandover = currentDriver != null && pick !== currentDriver;
        if (isHandover) {
            handovers.push({
                afterStint: stints[i - 1].index,
                atLap: stints[i - 1].toLap,
                atRaceS: clockS,
                from: currentDriver,
                to: pick,
                addedS: r.driverChangeS,
            });
        }

        const s = state.get(pick);
        if (pick === currentDriver) { s.runS += stint.onTrackS; s.runStints += 1; }
        else {
            if (currentDriver) { const p = state.get(currentDriver); p.current = false; }
            s.runS = stint.onTrackS; s.runStints = 1; s.current = true;
        }
        s.totalS += stint.onTrackS;
        s.stints += 1;
        s.longestRunS = Math.max(s.longestRunS, s.runS);

        state.timeline.push({ driver: pick, startS: clockS, endS: clockS + stint.onTrackS });
        assigned.push({ ...stint, driver: pick, isHandover });

        clockS += stint.onTrackS + (stint.pitAfter?.totalS ?? 0) + (isHandover ? 0 : 0);
        currentDriver = pick;
    }

    // Minimums that were never met, reported against the finished plan.
    for (const d of drivers) {
        const s = state.get(d.name);
        if (d.minTotalS != null && s.totalS < d.minTotalS - 1) {
            violations.push({
                driver: d.name, issue: 'minimum drive time',
                detail: `${d.name} is short of the minimum: ${fmt(s.totalS)} of ${fmt(d.minTotalS)}.`,
            });
        }
        if (d.maxTotalS != null && s.totalS > d.maxTotalS + 1) {
            violations.push({
                driver: d.name, issue: 'maximum drive time',
                detail: `${d.name} exceeds the maximum: ${fmt(s.totalS)} of ${fmt(d.maxTotalS)}.`,
            });
        }
    }

    const perDriver = drivers.map((d) => {
        const s = state.get(d.name);
        return {
            name: d.name, stints: s.stints, totalS: s.totalS, longestRunS: s.longestRunS,
            share: stints.length ? s.stints / stints.length : 0,
        };
    });

    return {
        stints: assigned,
        handovers,
        perDriver,
        violations,
        handoverCount: handovers.length,
        handoverTimeS: handovers.length * r.driverChangeS,
        driverChangeS: r.driverChangeS,
    };
}

/**
 * The team-facing schedule: every handover as a wall-clock time.
 *
 * Endurance teams are rarely in one timezone, and "lap 41" means nothing to
 * someone setting an alarm. `startsAt` anchors race time to real time.
 */
function handoverSchedule(plan, { startsAt, timeZone = 'UTC' } = {}) {
    const base = startsAt ? new Date(startsAt) : null;
    const fmtClock = (raceS) => {
        if (!base) return null;
        const at = new Date(base.getTime() + raceS * 1000);
        return new Intl.DateTimeFormat('en-GB', {
            timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short',
        }).format(at);
    };

    return plan.handovers.map((h) => ({
        ...h,
        raceClock: fmt(h.atRaceS),
        wallClock: fmtClock(h.atRaceS),
        // Enough warning to get belted in and on the wall.
        readyBy: fmtClock(Math.max(0, h.atRaceS - 900)),
    }));
}

function fmt(s) {
    if (s == null) return '—';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

module.exports = { DEFAULTS, planDriverStints, handoverSchedule, timeInWindow, fmt };
