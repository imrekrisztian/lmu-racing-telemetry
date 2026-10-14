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
const VEHICLE = {
    mID: 0,            // int32
    mDeltaTime: 4,     // double  <- physics sample interval, the number we want
    mElapsedTime: 12,  // double
    mLapNumber: 20,    // int32
    mLapStartET: 24,   // double
    mVehicleName: 32,  // char[64]
    mTrackName: 96,    // char[64]
    mPos: 160,         // 3 x double
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
