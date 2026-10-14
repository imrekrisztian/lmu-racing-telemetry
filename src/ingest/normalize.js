'use strict';

// Raw decoded frame -> a sample row obeying the unit contract.
//
// The reader produces frames with sim-native names and units; everything past
// this function speaks the contract in db/schema.sql and nothing else.

const U = require('./units');

const WHEELS = ['fl', 'fr', 'rl', 'rr'];

/**
 * @param {object} f  decoded telemetry frame (sim-native units)
 * @returns {object}  sample row ready for the writer
 */
function normalizeSample(f) {
    const row = {
        dist_m: f.lapDist,
        t_s: f.elapsedTime - f.lapStartET,

        speed_ms: f.speed ?? U.speedOf(f.localVel),
        throttle: U.unit(f.unfilteredThrottle),
        brake: U.unit(f.unfilteredBrake),
        clutch: U.unit(f.unfilteredClutch),
        steer: U.signedUnit(f.unfilteredSteering),
        gear: f.gear ?? null,
        rpm: f.engineRPM ?? null,

        fuel_l: U.positiveOrNull(f.fuel),
        // rF2 reports REAR bias as a fraction; the UI and every setup guide
        // talk about FRONT bias, so flip it once here.
        brake_bias_frac: f.rearBrakeBias == null ? null : 1 - f.rearBrakeBias,

        pos_x: f.pos?.x ?? null,
        pos_y: f.pos?.y ?? null,
        pos_z: f.pos?.z ?? null,
        accel_lat: f.localAccel?.x ?? null,
        accel_long: f.localAccel?.z ?? null,
    };

    // Per-wheel channels. Tyre and brake temps arrive in Kelvin.
    for (let i = 0; i < WHEELS.length; i++) {
        const w = WHEELS[i];
        const wheel = f.wheels?.[i] ?? {};
        row[`tyre_temp_${w}_in_c`] = U.kToC(wheel.tempInner);
        row[`tyre_temp_${w}_mid_c`] = U.kToC(wheel.tempCenter);
        row[`tyre_temp_${w}_out_c`] = U.kToC(wheel.tempOuter);
        row[`tyre_press_${w}_kpa`] = wheel.pressure ?? null;
        row[`brake_temp_${w}_c`] = U.kToC(wheel.brakeTemp);
        row[`tyre_wear_${w}`] = wheel.wear ?? null;   // already 0..1, 1 = new
        row[`susp_defl_${w}`] = wheel.suspensionDeflection ?? null;
        row[`ride_height_${w}`] = wheel.rideHeight ?? null;
    }

    return row;
}

/** Scoring-derived lap metadata -> a laps row. */
function normalizeLap(s) {
    return {
        lap_num: s.lapNumber,
        lap_time_s: U.lapTime(s.lastLapTime),
        sector1_s: U.lapTime(s.lastSector1),
        sector2_s: U.lapTime(s.lastSector2 == null || s.lastSector1 == null
            ? null
            : s.lastSector2 - s.lastSector1),   // sim reports cumulative splits
        sector3_s: U.lapTime(s.lastLapTime == null || s.lastSector2 == null
            ? null
            : s.lastLapTime - s.lastSector2),
        valid: s.valid !== false,
        track_temp_c: s.trackTemp ?? null,
        air_temp_c: s.ambientTemp ?? null,
    };
}

module.exports = { normalizeSample, normalizeLap, WHEELS };
