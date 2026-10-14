'use strict';

// Competitor tracking, and what can honestly be said about another car's stop.
//
// WHAT THE SIM ACTUALLY TELLS YOU
//   Shared memory scoring carries every vehicle: place, class, lap, lap
//   distance, gaps, best/last lap, and pit state.
//   LMU's REST endpoint /rest/watch/standings adds the one thing shared
//   memory has not got -- fuelFraction and veFraction PER CAR. That is how
//   you can see a rival's remaining energy at all.
//
// WHAT HAS TO BE INFERRED
//   Nothing reports "they fitted tyres". Two things are derivable, and both
//   are labelled as inferences rather than readings:
//
//   Fuel/energy taken  -- reliable. Their energy fraction jumps across the
//     stop; the size of the jump is how much went in.
//   Tyres changed      -- a judgement. Work out how long their stop should
//     have taken for the energy they took on, and compare with how long they
//     actually stood still. A tyre change adds roughly 25 seconds that fuel
//     alone cannot explain.

const DEFAULTS = {
    // Seconds of unexplained stationary time before tyres are the likely cause.
    tyreTimeThresholdS: 8,
    // Energy fraction gained before a stop counts as a refuel at all.
    refuelThreshold: 0.05,
    // Seconds per full tank/allowance; used to predict a fuel-only stop.
    secondsPerFullLoad: 33,
    // Pit lane transit, excluded from the stationary estimate.
    pitLaneDeltaS: 30,
};

class StandingsTracker {
    constructor(opts = {}) {
        this.opts = { ...DEFAULTS, ...opts };
        this.cars = new Map();
    }

    /**
     * @param {Array} entries per-car state this tick:
     *   { id, name, carClass, position, lap, lapDistM, gapToLeaderS,
     *     energyFrac, inPits, bestLapS, lastLapS }
     * @param {number} nowS session clock
     */
    update(entries, nowS) {
        for (const e of entries) {
            let c = this.cars.get(e.id);
            if (!c) {
                c = {
                    id: e.id, name: e.name, carClass: e.carClass,
                    stops: [], stintLaps: 0, lastLapSeen: e.lap,
                    pitEnteredAt: null, energyAtPitEntry: null, inPits: false,
                    energyHistory: [],
                };
                this.cars.set(e.id, c);
            }

            // --- stint laps ---------------------------------------------------
            if (e.lap > c.lastLapSeen) {
                c.stintLaps += e.lap - c.lastLapSeen;
                c.lastLapSeen = e.lap;
                if (e.energyFrac != null) {
                    c.energyHistory.push({ lap: e.lap, energy: e.energyFrac });
                    if (c.energyHistory.length > 8) c.energyHistory.shift();
                }
            }

            // --- pit detection ------------------------------------------------
            // Deliberately AFTER the lap accounting. A car leaving the pits is
            // usually credited a lap on the same tick, and that lap belongs to
            // the stint that just ended -- so the stop's reset has to be last
            // or the new stint starts at 1 instead of 0.
            if (e.inPits && !c.inPits) {
                c.pitEnteredAt = nowS;
                c.energyAtPitEntry = e.energyFrac;
            } else if (!e.inPits && c.inPits && c.pitEnteredAt != null) {
                this._closeStop(c, e, nowS);
            }
            c.inPits = e.inPits;

            Object.assign(c, {
                position: e.position, lap: e.lap, lapDistM: e.lapDistM,
                gapToLeaderS: e.gapToLeaderS, energyFrac: e.energyFrac,
                bestLapS: e.bestLapS, lastLapS: e.lastLapS,
            });
        }
        return this.snapshot();
    }

    _closeStop(c, e, nowS) {
        const totalS = nowS - c.pitEnteredAt;
        const stationaryS = Math.max(0, totalS - this.opts.pitLaneDeltaS);
        const before = c.energyAtPitEntry;
        const after = e.energyFrac;
        const gained = before != null && after != null ? after - before : null;

        const refuelled = gained != null && gained > this.opts.refuelThreshold;
        // How long that much energy should have taken on its own.
        const expectedFuelS = refuelled ? gained * this.opts.secondsPerFullLoad : 0;
        const unexplainedS = stationaryS - expectedFuelS;
        const tyresLikely = unexplainedS > this.opts.tyreTimeThresholdS;

        c.stops.push({
            lap: e.lap,
            atS: nowS,
            stationaryS,
            energyBefore: before,
            energyAfter: after,
            energyGained: gained,
            refuelled,
            tyresLikely,
            unexplainedS,
        });
        c.stintLaps = 0;
        c.pitEnteredAt = null;
        c.energyAtPitEntry = null;
    }

    /** Energy burned per lap, from the car's own recent laps. */
    _perLap(c) {
        const h = c.energyHistory;
        if (h.length < 2) return null;
        const drops = [];
        for (let i = 1; i < h.length; i++) {
            const d = h[i - 1].energy - h[i].energy;
            if (d > 0) drops.push(d);       // ignore the jump across a refuel
        }
        if (drops.length === 0) return null;
        return drops.reduce((a, b) => a + b, 0) / drops.length;
    }

    snapshot() {
        return [...this.cars.values()]
            .map((c) => {
                const perLap = this._perLap(c);
                const lastStop = c.stops[c.stops.length - 1] ?? null;
                return {
                    id: c.id, name: c.name, carClass: c.carClass,
                    position: c.position, lap: c.lap, lapDistM: c.lapDistM,
                    gapToLeaderS: c.gapToLeaderS,
                    energyFrac: c.energyFrac,
                    bestLapS: c.bestLapS, lastLapS: c.lastLapS,
                    inPits: c.inPits,
                    stintLaps: c.stintLaps,
                    stops: c.stops.length,
                    perLap,
                    estLapsLeft: perLap && c.energyFrac != null
                        ? Math.floor(c.energyFrac / perLap) : null,
                    lastStop,
                };
            })
            .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    }
}

module.exports = { StandingsTracker, DEFAULTS };
