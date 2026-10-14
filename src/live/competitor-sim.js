'use strict';

// A synthetic field, standing in for real competitor data until the REST
// client exists.
//
// On Windows the same shape comes from two real sources:
//   $rFactor2SMMP_Scoring$   place, class, lap, lap distance, gaps, pit state
//   GET /rest/watch/standings  adds fuelFraction and veFraction PER CAR, which
//                              shared memory does not carry
//
// Nothing here is guesswork about the data model -- only about the values. The
// field below drives the same StandingsTracker the real feed will.

const NAMES = [
    ['#2 Porsche Penske', 'Hyper', 209.2],
    ['#51 Ferrari AF Corse', 'Hyper', 209.6],
    ['#7 Toyota Gazoo', 'Hyper', 210.1],
    ['#15 BMW WRT', 'Hyper', 211.4],
    ['#36 Alpine', 'Hyper', 212.0],
    ['#34 Inter Europol', 'LMP2', 216.8],
    ['#92 Manthey GT3', 'GT3', 228.5],
];

const TRACK_M = 13626;

class CompetitorSim {
    constructor({ trackLengthM = TRACK_M, seed = 1 } = {}) {
        this.trackLengthM = trackLengthM;
        this.cars = NAMES.map(([name, carClass, lapTimeS], i) => ({
            id: i + 1,
            name,
            carClass,
            lapTimeS,
            // A little pace scatter so gaps evolve rather than sitting still.
            jitter: ((seed * (i + 3) * 37) % 13) / 100 - 0.06,
            perLap: carClass === 'GT3' ? 0.052 : 0.044,
            // Start mid-race with staggered energy, so stops happen while
            // someone is watching rather than twenty laps later.
            // One car deliberately on fumes, so a stop (and the inference
            // drawn from it) is visible early rather than twenty laps in.
            energy: i === NAMES.length - 1 ? 0.07 : 0.92 - i * 0.115,
            lapOffset: 0,
            dist: -i * 140,
            lap: 1,
            inPits: false,
            pitUntilS: null,
            stops: 0,
            best: null,
            last: null,
        }));
        this.lastClock = 0;
    }

    /** Advance to `clockS` and return per-car entries for StandingsTracker. */
    step(clockS) {
        const dt = Math.max(0, clockS - this.lastClock);
        this.lastClock = clockS;

        for (const c of this.cars) {
            if (c.pitUntilS != null) {
                if (clockS < c.pitUntilS) { c.inPits = true; continue; }
                // Leaving the box.
                c.inPits = false;
                c.pitUntilS = null;
                c.energy = 1.0;
                c.stops++;
            }

            const speed = this.trackLengthM / (c.lapTimeS + c.jitter);
            c.dist += speed * dt;

            while (c.dist >= this.trackLengthM) {
                c.dist -= this.trackLengthM;
                c.lap++;
                c.energy = Math.max(0, c.energy - c.perLap);
                c.last = c.lapTimeS + c.jitter;
                if (c.best == null || c.last < c.best) c.best = c.last;

                // Box when the next lap would not be covered.
                if (c.energy < c.perLap * 1.5) {
                    const fuelS = (1 - c.energy) * 33;
                    // Tyres on alternate stops, as most teams actually run them.
                    const tyreS = c.stops % 2 === 0 ? 26 : 0;
                    c.pitUntilS = clockS + 30 + Math.max(fuelS, tyreS) + (tyreS ? 6 : 0);
                    c.inPits = true;
                }
            }
        }

        // Running order by distance covered.
        const ordered = [...this.cars].sort(
            (a, b) => (b.lap * this.trackLengthM + b.dist) - (a.lap * this.trackLengthM + a.dist));
        const leaderProgress = ordered[0].lap * this.trackLengthM + ordered[0].dist;

        return ordered.map((c, i) => {
            const progress = c.lap * this.trackLengthM + c.dist;
            const speed = this.trackLengthM / c.lapTimeS;
            return {
                id: c.id,
                name: c.name,
                carClass: c.carClass,
                position: i + 1,
                lap: c.lap,
                lapDistM: Math.max(0, c.dist),
                gapToLeaderS: (leaderProgress - progress) / speed,
                energyFrac: c.energy,
                inPits: c.inPits,
                bestLapS: c.best,
                lastLapS: c.last,
            };
        });
    }
}

module.exports = { CompetitorSim, TRACK_M };
