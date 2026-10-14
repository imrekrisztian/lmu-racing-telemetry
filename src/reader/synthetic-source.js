'use strict';

// A fake telemetry source so the ingest path, the schema and every analysis
// query can be built and tested without Windows or a running sim.
//
// It emits lapDist at 5 Hz while emitting everything else at the full sample
// rate, mirroring the real buffer-rate mismatch -- so anything that consumes
// these frames exercises the integrate-and-re-anchor path for real.

const DEFAULT_TRACK = {
    name: 'Circuit de la Sarthe',
    lengthM: 13626,
    // dist along lap -> target apex speed (m/s)
    corners: [
        { dist: 600, speed: 33 },   // Dunlop
        { dist: 2600, speed: 22 },  // Forest esses exit
        { dist: 4800, speed: 17 },  // Mulsanne chicane 1
        { dist: 6700, speed: 17 },  // Mulsanne chicane 2
        { dist: 8700, speed: 20 },  // Mulsanne corner
        { dist: 10300, speed: 38 }, // Indianapolis
        { dist: 11200, speed: 25 }, // Arnage
        { dist: 12900, speed: 30 }, // Porsche curves exit
    ],
    vMax: 93,          // ~335 km/h
    accel: 4.2,        // m/s^2
    decel: 13.0,       // m/s^2
};

const SCORING_HZ = 5;

/**
 * A weather model, so the conditions panel has something to show before real
 * Scoring data exists. Shaped to match rF2ScoringInfo's fields exactly.
 *
 * The part worth getting right is that WETNESS LAGS RAIN. A circuit does not
 * become wet the instant it starts raining, and it stays wet long after the
 * rain stops -- which is the whole reason crossover timing is a strategy
 * decision. Modelled as a first-order lag with a slower dry-out than wet-up.
 */
function weatherAt(tS, state) {
    // A shower arrives around ten minutes in and passes over a few minutes.
    const showerPeak = 600;
    const showerWidth = 260;
    const rain = Math.max(0, Math.exp(-((tS - showerPeak) ** 2) / (2 * showerWidth ** 2)) * 0.85);

    // Wetness chases rain as a first-order lag, in SECONDS rather than per
    // frame -- a per-frame rate saturates instantly at 90Hz and the lag
    // silently disappears, which is exactly what the first version did.
    const dt = Math.max(0, tS - (state.lastT ?? tS));
    state.lastT = tS;
    const WET_TAU_S = 70;      // soaks in about a minute
    const DRY_TAU_S = 300;     // takes far longer to dry out
    const tau = rain > state.wetness ? WET_TAU_S : DRY_TAU_S;
    state.wetness += (rain - state.wetness) * (1 - Math.exp(-dt / tau));

    const cloud = Math.min(1, 0.15 + rain * 1.1);
    // Track temp falls under cloud and rain; ambient moves far less.
    const ambient = 21.5 - cloud * 2.4;
    const trackTemp = 34.0 - cloud * 7.0 - state.wetness * 9.0;

    return {
        ambientTemp: ambient,
        trackTemp,
        raining: rain,
        darkCloud: cloud,
        wind: { x: Math.cos(tS / 180) * (3 + rain * 6), y: 0, z: Math.sin(tS / 180) * (3 + rain * 6) },
        // The racing line dries first, so min trails avg trails max.
        minPathWetness: state.wetness * 0.75,
        avgPathWetness: state.wetness,
        maxPathWetness: Math.min(1, state.wetness * 1.25),
    };
}

/**
 * A plausible circuit outline, integrated from the corner list.
 *
 * The earlier version emitted cos/sin positions, which drew a perfect circle
 * on the track map -- correct code, meaningless shape. Walking a heading down
 * straights and turning through each corner produces something that at least
 * looks like a racing circuit, so the map is worth looking at before real
 * position data exists.
 */
function buildPath(track) {
    const STEP = 5;                       // metres per integration step
    const turnArc = 140;                  // metres spent turning in each corner
    const turnEach = (Math.PI * 2) / track.corners.length;   // closes the loop

    const pts = [];
    let x = 0, z = 0, heading = 0;
    for (let d = 0; d <= track.lengthM; d += STEP) {
        const corner = track.corners.find((c) => Math.abs(d - c.dist) < turnArc / 2);
        if (corner) heading += (turnEach / turnArc) * STEP;
        x += Math.cos(heading) * STEP;
        z += Math.sin(heading) * STEP;
        pts.push({ d, x, z });
    }
    return (dist) => {
        const i = Math.max(0, Math.min(pts.length - 1, Math.round(dist / STEP)));
        return { x: pts[i].x, y: 0, z: pts[i].z };
    };
}

const PATH_CACHE = new WeakMap();
function pathFor(track) {
    if (!PATH_CACHE.has(track)) PATH_CACHE.set(track, buildPath(track));
    return PATH_CACHE.get(track);
}

/**
 * Generate frames for one or more laps.
 * `skill` scales corner speed: 1.02 is a driver carrying 2% more apex speed,
 * which produces a cleanly comparable faster lap.
 */
function* syntheticFrames({
    track = DEFAULT_TRACK,
    sampleRateHz = 90,
    laps = 1,
    skill = 1.0,
    startET = 0,
} = {}) {
    const dt = 1 / sampleRateHz;
    const scoringEvery = Math.max(1, Math.round(sampleRateHz / SCORING_HZ));

    let elapsed = startET;
    let frameNo = 0;
    let lastLapTime = -1;
    const weatherState = { wetness: 0 };

    for (let lap = 1; lap <= laps; lap++) {
        const lapStartET = elapsed;
        let dist = 0;
        let v = lap === 1 ? 25 : 70;          // rolling start, then flying
        let lastScoringDist = null;

        while (dist < track.lengthM) {
            // Next corner ahead, and whether we must be braking for it yet.
            const next = track.corners.find((c) => c.dist > dist);
            const target = next ? next.speed * skill : track.vMax;
            const gap = next ? next.dist - dist : Infinity;
            const brakingDist = Math.max(0, (v * v - target * target) / (2 * track.decel));

            let throttle = 0, brake = 0;
            if (next && gap <= brakingDist && v > target) {
                v = Math.max(target, v - track.decel * dt);
                brake = Math.min(1, (v - target) / 20 + 0.35);
            } else if (v < track.vMax) {
                v = Math.min(track.vMax, v + track.accel * dt);
                throttle = 1;
            } else {
                throttle = 0.85;
            }

            dist += v * dt;
            elapsed += dt;
            frameNo++;

            const gear = Math.max(1, Math.min(8, Math.ceil(v / 12)));
            const emitScoring = frameNo % scoringEvery === 0;
            if (emitScoring) lastScoringDist = Math.min(dist, track.lengthM);

            // Steering rises through corners; crude but gives a plausible trace.
            const steer = next && gap < 150 ? Math.sin((150 - gap) / 150 * Math.PI) * 0.6 : 0.02;

            yield {
                elapsedTime: elapsed,
                lapStartET,
                lapNumber: lap,
                lastLapTime,
                lapDist: emitScoring ? lastScoringDist : undefined,
                inPits: false,

                speed: v,
                unfilteredThrottle: throttle,
                unfilteredBrake: brake,
                unfilteredClutch: 0,
                unfilteredSteering: steer,
                gear,
                engineRPM: 2000 + (v / track.vMax) * 7000,
                fuel: 60 - (lap - 1) * 4 - (dist / track.lengthM) * 4,
                rearBrakeBias: 0.43,

                pos: pathFor(track)(dist),
                localAccel: { x: steer * 18, y: 0, z: throttle * track.accel - brake * track.decel },

                conditions: weatherAt(elapsed, weatherState),

                wheels: [0, 1, 2, 3].map((i) => ({
                    tempInner: 273.15 + 88 + i, tempCenter: 273.15 + 92 + i, tempOuter: 273.15 + 85 + i,
                    pressure: 165 + i, brakeTemp: 273.15 + 420 + i * 10,
                    wear: 1 - (lap - 1) * 0.015 - (dist / track.lengthM) * 0.015,
                    suspensionDeflection: 0.02, rideHeight: 0.055,
                })),
            };
        }
        lastLapTime = elapsed - lapStartET;
    }

    // One trailing frame to close the final lap (the tracker needs the
    // boundary to know the previous lap ended).
    yield {
        elapsedTime: elapsed, lapStartET: elapsed, lapNumber: laps + 1,
        lastLapTime, speed: 70, lapDist: 0, inPits: false, wheels: [{}, {}, {}, {}],
    };
}

module.exports = { syntheticFrames, DEFAULT_TRACK, SCORING_HZ };
