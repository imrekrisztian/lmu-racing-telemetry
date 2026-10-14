'use strict';

// Mid-race assessment against what the car is ACTUALLY consuming.
//
// This is the part a web form cannot do. A pre-race plan assumes a figure for
// %VE or litres per lap; the real number moves with traffic, weather, fuel
// load and how the driver is lifting. Feeding measured consumption back in
// turns the plan from a prediction into a live instrument.
//
// Measured consumption comes from the REST API (:6397) -- /rest/strategy/usage
// and the fuelInfo block on /rest/garage/UIScreen/RepairAndRefuel. Virtual
// Energy is not in shared memory.

const { planRace } = require('./planner');

/**
 * @param {object} o
 * @param {object} o.plan             the pre-race plan from planRace()
 * @param {number} o.currentLap       lap being run now
 * @param {number} o.levelNow         %VE or litres in the car at the start of it
 * @param {number} o.measuredPerLap   actual consumption, measured
 * @param {number} [o.lapTimeS]       current pace, if it differs from the plan
 * @param {number} [o.remainingS]     race time left (timed races)
 */
function assessLive(o) {
    const { plan, currentLap, levelNow, measuredPerLap } = o;
    const reserve = plan.reserve ?? 0;
    const usable = levelNow - reserve;
    const advice = [];

    if (!(measuredPerLap > 0)) throw new Error('measuredPerLap must be > 0');

    const stint = plan.stints.find((s) => currentLap >= s.fromLap && currentLap <= s.toLap)
        ?? plan.stints.at(-1);

    // How far the current load actually goes.
    const lapsLeftOnLoad = Math.floor(usable / measuredPerLap);
    const lastLapOnLoad = currentLap + lapsLeftOnLoad - 1;

    const plannedPitLap = stint.pitAfter ? stint.pitAfter.afterLap : plan.totalLaps;
    const pitLapDelta = lastLapOnLoad - plannedPitLap;

    // What consumption would be needed to reach the planned stop.
    const lapsToPlannedPit = plannedPitLap - currentLap + 1;
    const targetPerLap = lapsToPlannedPit > 0 ? usable / lapsToPlannedPit : null;
    const savingNeeded = targetPerLap != null ? measuredPerLap - targetPerLap : null;

    const driftPct = plan.stints.length
        ? ((measuredPerLap - plannedPerLap(plan)) / plannedPerLap(plan)) * 100
        : 0;

    // Can the current load see the chequered flag?
    const lapsToFinish = plan.totalLaps - currentLap + 1;
    const canFinishOnThisLoad = lapsLeftOnLoad >= lapsToFinish;

    // --- actionable lines -------------------------------------------------
    if (Math.abs(driftPct) >= 1) {
        advice.push(
            `Consuming ${measuredPerLap.toFixed(2)}${plan.unit}/lap, ` +
            `${driftPct > 0 ? 'over' : 'under'} plan by ${Math.abs(driftPct).toFixed(1)}%.`
        );
    }

    if (pitLapDelta < 0) {
        advice.push(
            `Short by ${-pitLapDelta} lap${pitLapDelta === -1 ? '' : 's'}: ` +
            `the load runs out on lap ${lastLapOnLoad}, plan says pit on ${plannedPitLap}.`
        );
        if (savingNeeded > 0) {
            advice.push(
                `Save ${savingNeeded.toFixed(2)}${plan.unit}/lap ` +
                `(target ${targetPerLap.toFixed(2)}) to make the window, or pit ${-pitLapDelta} early.`
            );
        }
    } else if (pitLapDelta > 0) {
        advice.push(
            `${pitLapDelta} lap${pitLapDelta === 1 ? '' : 's'} in hand — ` +
            `could extend to lap ${lastLapOnLoad} and shorten a later stint.`
        );
    } else {
        advice.push(`On target for the planned stop on lap ${plannedPitLap}.`);
    }

    if (canFinishOnThisLoad && stint.pitAfter) {
        advice.push(`Current load would reach the flag — a remaining stop may be optional.`);
    }

    // --- revised plan for the rest of the race ---------------------------
    let revised = null;
    if (o.remainingS != null && o.lapTimeS != null) {
        try {
            revised = planRace({
                durationS: o.remainingS,
                lapTimeS: o.lapTimeS,
                carClass: plan.carClassEcho ?? inferClass(plan),
                consumptionPerLap: measuredPerLap,
                capacity: plan.capacity,
                reserve,
                pitLaneDeltaS: plan.pitLaneDeltaSEcho ?? 30,
                refuelRate: plan.refuelRateEcho ?? 3.0,
            });
        } catch { /* a revision is a bonus, never a hard failure */ }
    }

    return {
        stintIndex: stint.index,
        lapsLeftOnLoad,
        lastLapOnLoad,
        plannedPitLap,
        pitLapDelta,
        targetPerLap: targetPerLap == null ? null : round(targetPerLap, 3),
        savingNeeded: savingNeeded == null ? null : round(savingNeeded, 3),
        consumptionDriftPct: round(driftPct, 2),
        canFinishOnThisLoad,
        projectedStopsRemaining: revised ? revised.stops : null,
        revised,
        advice,
    };
}

/** Consumption the plan was built on, recovered from any stint. */
function plannedPerLap(plan) {
    const s = plan.stints[0];
    return s.used / s.laps;
}

function inferClass(plan) {
    return plan.limiter === 'virtual-energy' ? 'Hyper' : 'LMP2';
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

module.exports = { assessLive };
