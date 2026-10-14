# lmu-racing-telemetry

Telemetry, strategy and engineering tool for Le Mans Ultimate.

## Phase 0 — the reader spike

One question: **how fast does Le Mans Ultimate actually publish telemetry?**

Everything in the telemetry-analysis plan hangs off the answer. At 90 Hz you get a
sample roughly every 0.6 m at racing speed and corner-level coaching works. At
10 Hz you get one every 5.5 m, and brake-point analysis is not recoverable by
interpolation. Measure before building.

## Setup (on the Windows box with LMU)

1. Put `rFactor2SharedMemoryMapPlugin64.dll` in `...\Le Mans Ultimate\Plugins\`
   (create the folder if absent).
2. Enable it in `...\Le Mans Ultimate\UserData\player\CustomPluginVariables.JSON`:

   ```json
   "rFactor2SharedMemoryMapPlugin64.dll": { " Enabled": 1, "EnableDirectMemoryAccess": 1 }
   ```

   The leading space in `" Enabled"` is required — it is an engine quirk, not a typo.
3. `npm install`

   If npm reports `1 package has install scripts not yet covered by allowScripts`,
   run `npm install-scripts approve koffi`. koffi ships prebuilt binaries, so the
   probe usually works without it — but approve it if `require('koffi')` throws.

## Run

Start LMU, get into a **practice session with the car on track** (not the main
menu — the plugin publishes nothing there), then:

```
npm run probe                      # Telemetry, 20 seconds
node src/reader/probe.js --seconds 60     # longer sample
node src/reader/probe.js --buffer Scoring # any of the six buffers
```

It busy-polls one core for the duration, deliberately — timer granularity would
otherwise alias a 90 Hz signal.

## Reading the output

**The offset sanity check runs first and matters more than the rate.** It reads
`mTrackName`, `mVehicleName`, `mNumVehicles` and `mDeltaTime` and asserts they
look like real values. If any line says `FAIL`, the offsets in `src/reader/layout.js`
do not match your plugin build — fix those before believing any other number.
This is the `#pragma pack(4)` failure mode, and it is silent: wrong offsets
return plausible-looking garbage rather than an error.

Then three independent rate figures are reported:

| Figure | Source |
|---|---|
| Observed update rate | how often `mVersionUpdateEnd` actually changes |
| Sim `mDeltaTime` rate | the physics interval the sim reports for itself |
| Median `mElapsedTime` step | the real spacing between published samples |

They should agree. If they don't, something is wrong — investigate before moving on.

## Files

- `src/reader/win-shm.js` — `OpenFileMappingW` + `MapViewOfFile` via koffi; returns a
  zero-copy Buffer aliasing the live mapping
- `src/reader/layout.js` — **the offsets. Verify against your plugin's `rF2Data.h`.**
- `src/reader/probe.js` — torn-read protocol + rate measurement

## Torn reads

Shared memory is written while you read it. The writer bumps
`mVersionUpdateBegin` before writing and `mVersionUpdateEnd` after, so a snapshot
is only coherent when the two match:

```
read mVersionUpdateBegin -> copy the whole window -> read mVersionUpdateEnd
accept only if begin == end
```

`readFrame()` in `probe.js` implements this and retries up to 8 times. Reuse that
function in the real reader; don't read fields in place off the live mapping.


---

# Storage

DuckDB is the native store, not an import format. That makes comparing against
someone else's reference laps a one-line `ATTACH` rather than a feature.

```
npm test        # verifies the delta math and cross-file comparison
```

- `db/schema.sql` — sessions, laps, samples, setups, advice, feedback
- `db/open.js` — applies the schema; `attachReference()` mounts a foreign
  `.duckdb` read-only and refuses on schema mismatch

## Unit contract

Normalised once, at the reader boundary, never downstream:

| Quantity | Unit |
|---|---|
| distance / speed / time | m · m/s · s |
| temperature | **Celsius** (the sim sends tyre + brake temps in Kelvin) |
| pressure | kPa |
| throttle / brake / clutch | 0..1 |
| steering | -1..1 |
| tyre wear | 0..1, where **1.0 = new** |

The sim's `-1.0` ("no time") and `0.0` ("no lap") sentinels become `NULL`.
Never store a sentinel.

## Comparing two laps

`lap_binned` resamples every lap onto a 1 m distance grid, so comparison is a
join on `dist_bin`:

```sql
SELECT * FROM lap_delta('<lap-a-uuid>', '<lap-b-uuid>');
```

Returns per-metre speed/throttle/brake deltas plus `delta_t_s`, the running
time delta — positive means lap A is losing time. Verified against the
analytic answer in `test/smoke.js`.

Against someone else's file:

```js
await attachReference(con, 'alien_lemans_hyper.duckdb', 'ref');
```

Then join `lap_binned` to `ref.lap_binned` on `dist_bin`.

## Setups are indices, not values

`setups.raw` keeps LMU's garage payload verbatim because the REST API returns
**ordinal indices**, not physical units. Resolving "index 14" to "3.2 bar"
needs a per-car calibration table that does not exist yet. Build it by stepping
each setting in-game and recording the response; add resolved columns later
without losing the raw data.

Setups are keyed by content hash, so identical setups dedupe across sessions
and lap times join straight onto setup changes.

## License

MIT — see [LICENSE](LICENSE).

Shared-memory struct offsets in `src/reader/layout.js` are derived from
[TheIronWolf's rF2SharedMemoryMapPlugin](https://github.com/TheIronWolfModding/rF2SharedMemoryMapPlugin),
also MIT.

## Ingest pipeline

```
frames -> LapTracker -> normalize -> Writer -> DuckDB
```

- `src/ingest/units.js` — the unit contract in one place (K->C, sentinels->NULL)
- `src/ingest/normalize.js` — sim-native frame to a schema-contract sample row
- `src/ingest/lap-tracker.js` — lap segmentation and distance reconstruction
- `src/ingest/writer.js` — DuckDB appender; column order read from the live
  schema, so reordering a column cannot silently shift values
- `src/reader/synthetic-source.js` — fake sim, so everything above is testable
  without Windows

### Distance reconstruction

Telemetry is fast but carries no lap distance; only the ~5 Hz scoring buffer
knows it. Sampling at scoring rate would discard most of the resolution, so
`LapTracker` integrates speed between scoring updates and re-anchors whenever a
fresh value lands — high-rate distance with no accumulating drift. It refuses
to integrate across gaps over 0.5s, so a pause or alt-tab cannot invent metres.

Measured end to end on a synthetic Le Mans lap: reconstructed distance lands
within 2% of track length, and `lap_delta()` accumulates 1.207s against a
1.200s true lap-time gap — 7ms of error over a 3.5-minute lap.

Ingest runs at ~138k rows/s, against the ~90 rows/s a 90 Hz session produces.
Throughput is not going to be the constraint.
