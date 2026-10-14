'use strict';

// ---------------------------------------------------------------------------
// rF2 / LMU shared-memory offsets.
//
// VERIFY THESE against the rF2Data.h shipped with the plugin version you
// installed. They are derived from TheIronWolf's rF2SharedMemoryMapPlugin
// layout and are the single most likely thing in this repo to be wrong.
// The probe prints a PASS/FAIL block precisely so a bad offset is obvious
// within one second rather than three weeks.
//
// Everything is #pragma pack(4): each member aligns to min(natural, 4).
// That is why mDeltaTime (a double) sits at +4 and not +8 -- under natural
// 8-byte alignment every field after it would shift and all reads would be
// silently wrong.
// ---------------------------------------------------------------------------

// LMU inherits rF2's full buffer set, but not every buffer is driven. LMU has
// no full course yellow and no safety car, so the Rules buffer and scoring's
// YellowFlagState / SectorFlag fields are almost certainly inert here --
// present in the layout because the engine defines them, never populated.
// Confirm with the probe (--buffer Rules) before building anything on them.
//
// The Weather buffer is NOT where conditions are read from. It holds
// rF2WeatherControlInfo, which is an INPUT for setting weather via the plugin
// (mRaining[3][3], mCloudiness, mAmbientTempK, mWindMaxSpeed). The readable
// conditions -- temps, rain, cloud, wind, path wetness -- live in SCORING.
const BUFFERS = {
    Telemetry: '$rFactor2SMMP_Telemetry$',
    Scoring: '$rFactor2SMMP_Scoring$',
    Rules: '$rFactor2SMMP_Rules$',
    PitInfo: '$rFactor2SMMP_PitInfo$',
    Weather: '$rFactor2SMMP_Weather$',
    Extended: '$rFactor2SMMP_Extended$',
};

// rF2MappedBufferHeaderWithSize, shared by every buffer above.
const HEADER = {
    mVersionUpdateBegin: 0,   // uint32
    mVersionUpdateEnd: 4,     // uint32
    mBytesUpdatedHint: 8,     // int32
};

// rF2Telemetry adds mNumVehicles, then the vehicle array.
const TELEMETRY = {
    mNumVehicles: 12,         // int32
    mVehiclesBase: 16,
};

// rF2VehicleTelemetry, offsets relative to the start of one vehicle entry.
//
// Derived from the struct's declaration order under pack(4): long is 4 bytes,
// double is 8 but aligns to 4, rF2Vec3 is three doubles (24 bytes).
//
// THE TABLE STOPS AT mRearBrakeBias ON PURPOSE. The real header carries many
// more fields between it and mWheels -- downforce, dent severity, impact data,
// compound indices and so on -- and this module does not have their exact
// declaration order. Computing wheel offsets without that would produce
// numbers that look plausible and are wrong, which is worse than not having
// them. Tyre data is therefore absent from the live reader until the probe
// confirms the layout against the installed plugin's own rF2Data.h.
const VEHICLE = {
    mID: 0,                   // long
    mDeltaTime: 4,            // double  <- physics sample interval
    mElapsedTime: 12,         // double
    mLapNumber: 20,           // long
    mLapStartET: 24,          // double
    mVehicleName: 32,         // char[64]
    mTrackName: 96,           // char[64]
    mPos: 160,                // rF2Vec3
    mLocalVel: 184,           // rF2Vec3  <- speed is this vector's magnitude
    mLocalAccel: 208,         // rF2Vec3
    mOri: 232,                // rF2Vec3[3]
    mLocalRot: 304,           // rF2Vec3
    mLocalRotAccel: 328,      // rF2Vec3
    mGear: 352,               // long
    mEngineRPM: 356,          // double
    mEngineWaterTemp: 364,    // double, already Celsius
    mEngineOilTemp: 372,      // double, already Celsius
    mClutchRPM: 380,          // double
    mUnfilteredThrottle: 388, // double 0..1
    mUnfilteredBrake: 396,    // double 0..1
    mUnfilteredSteering: 404, // double -1..1
    mUnfilteredClutch: 412,   // double 0..1
    mFilteredThrottle: 420,   // double
    mFilteredBrake: 428,      // double
    mFilteredSteering: 436,   // double
    mFilteredClutch: 444,     // double
    mFuel: 452,               // double, litres
    mRearBrakeBias: 460,      // double, rear fraction
};

// Absolute offsets for vehicle 0, which is all the probe needs.
const V0 = TELEMETRY.mVehiclesBase;
const VEHICLE0 = Object.fromEntries(
    Object.entries(VEHICLE).map(([k, v]) => [k, V0 + v])
);

// Enough to cover the header plus the front of vehicle 0.
const PROBE_WINDOW_BYTES = 4096;

function readFixedString(buf, offset, maxLen) {
    const end = buf.indexOf(0, offset);
    const stop = end === -1 || end > offset + maxLen ? offset + maxLen : end;
    return buf.toString('latin1', offset, stop).trim();
}

module.exports = { BUFFERS, HEADER, TELEMETRY, VEHICLE, VEHICLE0, PROBE_WINDOW_BYTES, readFixedString };
