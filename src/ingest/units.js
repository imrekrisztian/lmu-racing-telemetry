'use strict';

// The unit contract, enforced in exactly one place.
//
// LMU/rF2 is inconsistent on purpose-built grounds:
//
//   Telemetry  tyre and brake temps     KELVIN      -> convert
//   Telemetry  water and oil temps      Celsius     -> already right
//   Scoring    ambient and track temp   CELSIUS     -> already right
//
// Two temperature fields a few hundred bytes apart in the same sim use
// different scales, so converting here means no query, chart or rule
// downstream ever has to remember which is which. Pressures are kPa, wetness
// and rain are 0..1, and lap times use -1.0 / 0.0 as "no value" sentinels.

const KELVIN_OFFSET = 273.15;

/** Kelvin -> Celsius. Passes null/undefined through untouched. */
const kToC = (k) => (k == null ? null : k - KELVIN_OFFSET);

/**
 * The sim reports -1.0 for "no time recorded" and 0.0 for "no lap yet".
 * Both are absences, not measurements -- never store them as numbers.
 */
const lapTime = (t) => (t == null || t <= 0 ? null : t);

/** Guard against the transient zero-fuel reads seen on distant cars. */
const positiveOrNull = (v) => (v == null || v <= 0 ? null : v);

/** Clamp a 0..1 control input; the sim occasionally overshoots slightly. */
const unit = (v) => (v == null ? null : Math.min(1, Math.max(0, v)));

/** Clamp a -1..1 axis. */
const signedUnit = (v) => (v == null ? null : Math.min(1, Math.max(-1, v)));

/** Magnitude of a {x,y,z} velocity vector, in m/s. */
const speedOf = (vel) =>
    vel == null ? null : Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);

/** Scoring already reports these in Celsius -- do NOT run kToC over them. */
const celsius = (v) => (v == null ? null : v);

/** Wetness, rain severity and cloud darkness are all 0..1 in rF2/LMU. */
const fraction = (v) => (v == null ? null : Math.min(1, Math.max(0, v)));

module.exports = {
    KELVIN_OFFSET, kToC, lapTime, positiveOrNull, unit, signedUnit, speedOf,
    celsius, fraction,
};
