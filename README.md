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

## Strategy planner

```
npm run strategy -- --duration 6h --lap 3:32 --class Hyper --consumption 4.4 \
  --pit-delta 30 --refuel 3.0 --tyre-change 26 --drivers "A,B"
```

Prints a stint sheet: stint ranges, loads, driver rotation, per-stop time and
total race time.

### The rule that drives everything

**Hypercar and LMGT3 run to a Virtual Energy allowance; LMP2/LMP3/GTE run to
the fuel tank.** `limiterFor(carClass)` is a single lookup the planner applies
itself, rather than a flag callers can get wrong. Virtual Energy exists only on
the REST API (`:6397`) — it is not in shared memory, which is why the strategy
module takes measured consumption as an input instead of reading telemetry.

### Two things most planners get wrong

**Timed races are circular.** Laps completed depend on time spent in the pits,
which depends on the number of stops, which depends on laps completed. It is
solved by iterating to a fixed point — typically 2–3 passes.

**Refuel time is not a constant.** It scales with the load taken on, so a stop
after a short stint is genuinely cheaper. Using a flat per-stop figure
overstates short-stint strategies.

Stints are also split *evenly* rather than max-then-remainder: that avoids
finishing the race on a two-lap splash, and carries less weight throughout.

### Live mode

`assessLive()` recomputes against what the car is actually consuming:

```
LIVE  stint 1 · 22 laps left on this load (through lap 22, plan says 25)
  Consuming 4.50%VE/lap, over plan by 12.5%.
  Short by 3 laps: the load runs out on lap 22, plan says pit on 25.
  Save 0.50%VE/lap (target 4.00) to make the window, or pit 3 early.
```

That last line is the one a static calculator cannot produce, and it feeds
straight into lift-and-coast coaching.

## Telemetry analysis

```js
const segs = await deriveTrackSegments(con, { track, lapId: referenceLap });
const worst = await worstSegments(con, { track, lapA: mine, lapB: reference }, 5);
```

```
TIME LOSS vs reference — worst 5
  seg 12 corner   10060-10864m  +0.210s
  seg  2 corner     377-1389 m  +0.184s
  seg 16 corner   12637-13538m  +0.172s
  sum of segments: 1.207s        <- equals the total lap delta
```

### Corner detection uses speed, not steering

Steering angle varies with setup, driver style and controller calibration.
Speed minima are a property of the circuit. A corner is a local speed minimum
bounded by the fastest points either side; straights fall out for free as the
gaps between them.

Segments are derived once per track from a reference lap and then **frozen**.
If corner boundaries moved between sessions, per-corner comparison across
sessions would be comparing different pieces of tarmac.

The subtlety worth knowing: a corner's extent runs out only as far as speed
stays below 95% of the surrounding peaks. Walking out to the local maximum
instead makes adjacent corners run across the flat top of a straight and
overlap — the tests assert segments partition the lap exactly.

### What it computes

| Output | Use |
|---|---|
| `segmentDeltas` / `worstSegments` | where the time actually goes — ranked |
| `cornerMetrics` | brake point, apex speed and location, throttle application |
| `consistency` | lap-time spread, plus per-corner apex and brake-point σ |

Attribution **conserves the total**: per-segment losses sum to the full lap
delta, asserted in the tests. If they didn't, the ranking would be pointing at
the wrong corners.

Braking-point σ is the most actionable consistency number — it localises
inconsistency to a specific corner, and endurance races are won on spread
rather than on a single best lap.

## The engineer

```js
const { findings } = await analyse(con, { track, lapId, referenceLapId, lapIds });
```

```
ENGINEER
!! [seg 2] 3.9 km/h less apex speed
     Minimum 119.7 km/h against the reference's 123.6 km/h. This corner feeds a
     932m straight, so exit speed here is carried the whole way down it — worth
     more than the raw time delta suggests.
```

A rule-based expert system, not a model. On day one there is no training data,
and an advisor that cannot say *why* it said something cannot be scored or
corrected. Every finding carries the numbers that produced it in `evidence`.
**Rules compute; nothing invents a measurement.** A language layer, if one is
added later, narrates from that evidence rather than replacing it.

### What it reads off a trace

Beyond the obvious reference comparisons (brake point, apex speed, throttle
application), it computes what an engineer actually looks for:

| Metric | What it means |
|---|---|
| `coast_m` | Neither pedal applied. The cheapest time on the lap to recover |
| `brake_release_m` | Brakes fully off this far before the apex — the signature of no trail braking |
| `plateau_m` | Distance at minimum speed. A quick corner is a V, not a U |
| `brake_build_m` | First touch to peak pressure. Slow builds waste the start of the zone, where downforce is highest |
| `throttle_drops` | Backing off after committing — traction-limited, or power before the car is pointed |
| `steer_reversals` | Fighting the car. Over a stint this costs tyres more than it costs lap time |
| front/rear tyre Δ | The balance read: hotter fronts are understeer, hotter rears are oversteer |

Plus `entry.overdriving` — braking *later* than the reference yet *slower* at
the apex, the classic case of buying entry speed back with interest on exit.
It requires both conditions, because a later brake point with a faster apex is
simply a better corner.

### Exit priority

A corner feeding a long straight is worth more than one feeding another corner,
because exit speed is carried the whole way down it. Findings on high-priority
corners are promoted in severity and say so. Engineers weight their attention
that way; so does this.

Output is **ranked and capped** — an engineer who says sixteen things has said
nothing.

### The feedback loop

```
RULE SCORECARD  (mean delta: negative = laps got quicker)
  rule                            given  applied  improved  mean delta  rating
  apex.slow                          4        3         3     -1.811s    1.00
```

`recordFeedback()` logs what the driver did with each piece of advice;
`ruleScores()` ranks every rule by what actually happened to lap time
afterwards. A rule that never moves the clock is one to retire, however
sensible it sounds. **This accumulating record is the one asset a competitor
cannot copy** — which is why `advice` and `feedback` were in the schema before
the advisor existed.

Energy advice is LMU-specific: the cheapest place to save is immediately before
a heavy braking zone, where lifting costs little because that speed was about
to be thrown away anyway.

## The app

```
npm run seed -- demo.duckdb     # synthetic data, so the UI works with no sim
npm run app:dev -- demo.duckdb  # vite + electron, hot reload
npm run app -- demo.duckdb      # build the renderer and run it
```

Three views: **Compare** (delta, speed, pedals, and where the time goes),
**Engineer** (findings with feedback buttons), **Strategy** (live stint plan).

### Architecture

The main process owns the DuckDB connection and, on Windows, the reader. The
renderer owns nothing but pixels. Everything crosses one narrow bridge, and
both sides of it are generated from `API_NAMES` — an endpoint cannot exist in
main but be missing from the preload.

`src/app/api.js` is a plain module over a connection rather than a pile of
`ipcMain` handlers, so the entire data layer is unit-testable without launching
a window. IPC errors are *returned* as `{ ok:false, error }` rather than
thrown, because an exception crossing that boundary arrives as an opaque string
with no useful stack.

Charts use **uPlot**: a lap is ~13,600 points per channel and these redraw on
every cursor move. The crosshair is synced across all three charts, so hovering
the delta trace also reads out speed and pedal positions at the same point on
track. Corners are shaded behind every trace from `track_segments`, so a
reading always has track context.

### Verifying the UI without looking at it

```
LMU_SMOKE=/tmp/ui.png LMU_SMOKE_TAB=engineer electron src/app/main.js demo.duckdb
```

Renders, captures a PNG, exits. It caught two real bugs that tests had not:
the reference trace was being aligned by array index instead of distance (which
drifts whenever two laps have different bin counts), and advice was replaying
in insertion order, putting `suggest` findings above `strong` ones and quietly
undoing the engine's ranking in the one place the driver sees it.

## Live view

A pit-wall display: live delta against a reference lap, speed and pedals,
measured consumption, laps remaining on the current load, tyre corners and
recent-lap history.

```
npm run app:dev -- demo.duckdb     # Live tab → pick a lap → Start replay
```

### Why it works without a sim

The data source is swappable. `ReplaySource` plays recorded laps back at
wall-clock pace (1× to 10×); the shared-memory reader on Windows will expose
the same start/stop shape, and the view cannot tell them apart. That makes the
live view buildable on a machine with no sim attached — and gives you stint
replay for review afterwards, which is worth having regardless.

Emission is driven by a clock rather than by the samples: each tick picks the
sample nearest the current playback time, so the UI runs at a steady 30 Hz
whether the source recorded at 10 Hz or 90 Hz.

### Live delta

A reference lap is reduced to one thing: how long it had taken by each point on
track. Live delta is then a subtraction — your time so far minus the
reference's time at the same distance — which is exactly what an in-car delta
bar shows. Verified two ways: a lap replayed against itself holds delta under
0.05s for a full lap, and against a different lap it converges on the real
lap-time gap by the line.

### What makes it more than a planner

`SimEndurance` and friends are calculators: you type a consumption figure in.
Here the figure is **measured**. `Laps left` comes from fuel actually burned
over recent laps, so it tracks traffic, weather and how the driver is lifting,
and it turns red with a BOX THIS LAP banner when the load will not see two more
laps. Consistency (σ of recent lap times) sits alongside it, because endurance
is won on spread rather than on one quick lap.

### Track map

The circuit is drawn from the recording's own world positions — no track files,
no per-venue artwork, and any circuit draws itself after one lap has been run
on it. The three worst corners are painted onto it, centred on the apex, so the
map answers *where* rather than just showing where the car is. Rivals appear as
dots, dimmed when they are in the pits.

### The field, and what can honestly be said about a rival's stop

Shared-memory scoring carries every vehicle: place, class, lap, lap distance,
gaps and pit state. LMU's `/rest/watch/standings` adds the one thing shared
memory has not got — **`fuelFraction` and `veFraction` per car**. That is why a
rival's remaining energy is visible at all.

Nothing in the sim reports "they fitted tyres". Two things are derived, and the
UI labels them as derived:

| Shown | How |
|---|---|
| **Fuelled, and how much** | Reliable. Their energy fraction jumps across the stop; the size of the jump is what went in |
| **Tyres?** | A judgement. Work out how long the stop *should* have taken for the energy they took on, and compare with how long they actually stood still. Roughly 25s that fuel cannot explain means tyres |

Per-car consumption and laps-remaining come from each rival's own energy trace,
with the refuel jump excluded so it cannot pollute the estimate.

### Weather and track conditions

Fields mirror `rF2ScoringInfo` one for one, so the mapping stays checkable:

| Field | Meaning |
|---|---|
| `mAmbientTemp` / `mTrackTemp` | **Celsius already** — unlike the Kelvin tyre temps in Telemetry |
| `mRaining` | rain severity 0..1 |
| `mDarkCloud` | cloud darkness 0..1 |
| `mWind` | vec3 speed, reduced to speed + bearing |
| `mMin/Avg/MaxPathWetness` | wetness on the racing line 0..1 |

**These are read from SCORING, not from the Weather buffer.** `$rFactor2SMMP_Weather$`
holds `rF2WeatherControlInfo` (`mRaining[3][3]`, `mCloudiness`, `mAmbientTempK`,
`mWindMaxSpeed`) — an input for *setting* weather through the plugin, not a
source for reading it. Note that one takes Kelvin while Scoring reports Celsius.

Two temperature fields a few hundred bytes apart use different scales, which is
why the unit contract lives in one file.

Conditions are stored as a session time series rather than per sample: weather
moves over minutes, so one row every two seconds captures everything without
adding ten columns to the hot table.

**Why min and max wetness, not just average:** the racing line dries first. A
circuit can be dry on the line and standing water off it, and that spread is
the decision.

The panel's headline is the **crossover** call. Rain stopping does not dry a
track — wetness lags it going up and lags far longer coming down — so rain and
wetness are plotted together and the gap between them is the thing to read. The
synthetic model uses a 70s wet-up and 300s dry-out time constant; an earlier
version applied the lag per frame, which at 90Hz saturated instantly and made
the lag silently vanish.
