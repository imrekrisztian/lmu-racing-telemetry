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

### Tyre compounds and the wet call

Operating windows are Michelin's published WEC figures, which is what LMU models:

| Compound | Track temp | Conditions | Sidewall |
|---|---|---|---|
| Soft | 0–15°C | dry or slightly damp | white |
| Medium | 15–25°C | dry | yellow |
| Hard | >25°C | dry, abrasive | red |
| Wet | — | wet or drying | blue |

**There is no intermediate.** WEC runs slicks or full wets and nothing between,
which is exactly why the crossover is the hardest call on the pit wall — get it
wrong in either direction and it costs far more than a tenth. Wets also sit
outside the dry allocation, so fitting them never costs a set of slicks later.

`recommendCompound()` returns the call *with its reasoning*, because a pit wall
that says "wets" without saying the track is at 38% and still rising is not
something a strategist can argue with — and arguing with it is the point. It
handles four cases: heavy rain commits regardless of current track state; past
the crossover means wets (with lower conviction if the track is drying, and an
estimate of how long the wet stint needs to be); a dry track picks the slick
suited to the surface temperature; and inside the crossover band the **trend**
decides, since there is no tyre that splits the difference.

A dry line with standing water off it lowers confidence and says so — the
min/max wetness spread is why those are stored separately.

**The trend uses Theil–Sen, not least squares.** Least squares was the first
implementation and is the wrong tool: a single corrupt sample at the end of the
window sits at maximum leverage and flattens a real trend to "steady", which in
the crossover band flips the tyre call. Theil–Sen's ~29% breakdown point means
a handful of bad reads cannot move it, and the window is small enough that the
O(n²) cost is irrelevant.

### Tyre wear and degradation

Two different quantities, and conflating them is the usual error:

| | What it is | What it answers |
|---|---|---|
| **Wear** | rubber gone, from `tyre_wear` (0..1, 1.0 = new) | when the tyre is finished |
| **Degradation** | lap time lost as the tyre gives up | when *stopping* is worth the pit loss |

A tyre can be 60% worn and still quick, or barely worn and three tenths off
because it is overheating. Both are modelled.

**The correction that makes it work.** Raw lap times over a stint mix two
opposing effects: tyres degrade (slower) while fuel burns off (faster). On a
Hypercar shedding 4 L a lap at ~0.035 s/L, the fuel effect is worth 0.14 s/lap
— which very nearly cancels typical degradation. Fit raw times and the tyres
appear to be *improving*. The test asserts exactly that: the uncorrected fit
comes out **negative** on a stint with 0.05 s/lap of real degradation.

Visible in the demo data: raw lap times drift 209.82 → 209.92 and look flat,
while fuel-corrected reveal 0.12 s/lap.

Where fuel data is missing the figure is **flagged**, not quietly returned —
an uncorrected number is not degradation and should not be presented as it.

Other details that earn their place:

- **Slow outliers only.** Traffic and mistakes cost time; nobody is accidentally
  fast. The fit drops laps more than 2σ slow and refits, keeping quick ones.
- **Out and in laps never enter the fit.**
- **A cliff is degradation *accelerating*, not merely being high.** The last
  third of the stint is fitted against the first two thirds, because a linear
  fit averages a sudden fall-away into something reassuring and wrong.
- **Per-wheel wear** names the limiting corner — the fastest-wearing tyre sets
  the stint, and which corner it is tells you about setup.
- **Optimal stint length** minimises `pitLoss/n + base + deg*(n-1)/2`, giving
  `n = sqrt(2·pitLoss/deg)`, capped by what fuel and tyres physically allow.

### Fuel saving and lift-and-coast coaching

The cheapest energy on a lap sits immediately before a heavy braking zone:
that kinetic energy was about to become brake heat anyway. So the question is
never "should I lift" but **where, and how much is each corner worth**.

Everything is measured from the car's own telemetry. Coast deceleration is
fitted as `a = k·v² + c` from samples where the driver is already off both
pedals; fuel flow comes from what the lap actually burned divided by time on
throttle. A guessed drag coefficient would make the advice decorative, so when
a lap contains no coasting the fallback model is used **and declared**.

**The physics.** The driver lifts `liftM` before their normal braking point and
stays off both pedals until the car genuinely needs to brake — there is no
getting back on the throttle in between. Arriving slower means less braking
distance, so the brake point moves later too; coasting continues until distance
remaining equals braking distance, giving `coast = liftM · b/(b−a)`.

**What actually makes heavy zones dominant.** Not efficiency per metre — that
is only ~9% better, because coast deceleration is small next to braking
deceleration either way. It is **capacity**: a zone shedding 260 km/h can
absorb ~770 m of lift before the car falls below corner speed, while one
shedding 30 km/h saturates at ~190 m. A flat-out section offers none at all and
is refused.

**The planner is greedy on marginal return, not absolute.** Within a zone the
returns diminish, so the smallest lift always has the best absolute ratio — a
greedy comparing absolute ratios takes the minimum lift everywhere, spreads
crumbs across the lap and never reaches the target. That is exactly what the
first version did. Comparing *extra* energy per *extra* second equalises
marginal return across corners, which is both optimal on concave frontiers and
how an engineer actually works: lean on the best corner until it stops paying.

Output is what a driver can act on: *lift 63 m early at turns 8, 10 and 12 —
saves 0.151 %VE per lap, costs 0.076 s*.

### Driver swaps and handover planning

The optimisation is **not** sharing laps out evenly. It is minimising handovers
while satisfying every drive-time rule, because a driver change adds roughly
half a minute to a stop that would otherwise be fuel only. Double and triple
stinting is how endurance teams buy that time back, so whoever is in the car
stays in it for as long as the limits — and the other drivers' minimum seat
time — allow.

```
CREW   2 handovers costing 1m04s
       32s each · 4 stops total, so 2 are fuel only

STINT SHEET
 1  Krisztian          21 laps   1–21     1h14m
 2  Krisztian          20 laps   22–41    1h10m
 3  Co-driver  [IN]    20 laps   42–61    1h10m
```

Constraints, all optional: `maxContinuousStints`, `maxContinuousS`,
`maxTotalS`, `minTotalS` (Bronze seat time), and a `rollingWindow` for rules
shaped like "no more than 4h at the wheel in any 6h period". An impossible set
is **reported**, never silently broken.

The minimum-seat-time check looks ahead: without it the planner triple-stints
the quickest driver and only discovers the shortfall at the last stop, when it
can no longer be fixed.

**Handovers sit inside the race planner's fixed point**, not added afterwards —
they lengthen the stops they land on, which shortens the race, which changes
the lap count.

The schedule is the team-facing half: "lap 41" means nothing to someone setting
an alarm in another timezone, so each handover resolves to a wall clock and a
be-ready-by time fifteen minutes earlier.

### Weather forecast and strategy adaptation

A forecast tells you about **rain**. What decides a race is **wetness**, and
they are not the same thing — so the forecast is run through the same
first-order lag the track itself obeys, and crossovers are read off the
projected wetness curve rather than off the rain.

Measured on a 20-minute squall: **0 s to reach wet-tyre territory, 19 minutes
to come back out of it.** That asymmetry is the entire reason crossover timing
is a decision rather than an observation. The time constants (70 s wet-up,
600 s dry-out) are the most load-bearing numbers in the module and they are
**estimates** — they want calibrating per circuit against recorded sessions.

**The adaptation question is never "when does it rain".** It is whether a stop
already falls near enough to the crossover, because a tyre change at a stop you
were making anyway is free, while one at a stop you would not have made costs
the whole pit loss. Four outcomes:

| | Meaning |
|---|---|
| `aligned` | A planned stop is already within ~7 min — fit the right tyre there, free |
| `bring-forward` | Pull a stop earlier; free *only if* the following stint stays legal |
| `extend` | Run longer to reach the crossover, within the stint limit |
| `extra-stop` | Nothing reachable — costs the full pit loss, and says so |

Three bugs found while building it, all of which made the advice look better
than it was: the same stop was recommended for every crossover in turn
(producing a plan that pits the same lap three times); a stop could be "brought
forward" 49 laps and still reported as costing nothing, when moving it that far
hands its laps to the next stint and breaks the limit; and the synthetic
forecast was so volatile it produced four crossovers inside half an hour —
weather no strategist would ever see.

## Running on Windows

The reader needs Windows because LMU does. Everything else is cross-platform,
so the usual split is: develop the UI and analysis on any machine against
recorded data, run the real thing next to the sim.

### Prerequisites

- **Node.js 22 or newer** (`node -v`) — [nodejs.org](https://nodejs.org)
- **Git**, if you are cloning rather than copying the folder
- Le Mans Ultimate, with `rFactor2SharedMemoryMapPlugin64.dll` installed and
  enabled (see *Setup* above — mind the leading space in `" Enabled"`)

### Install

```
git clone https://github.com/imrekrisztian/lmu-racing-telemetry.git
cd lmu-racing-telemetry
npm install
```

If npm reports `1 package has install scripts not yet covered by allowScripts`,
run `npm install-scripts approve koffi`. koffi ships prebuilt binaries so it
usually works regardless — approve it only if `require('koffi')` throws.

`npm install` also downloads the Electron binary (~100 MB) the first time.

### Run it

```
npm run probe                     :: measure the telemetry rate — do this first
npm run seed -- demo.duckdb       :: synthetic data, so the UI has something to show
npm run app -- demo.duckdb        :: build the renderer and launch
npm run app:dev -- demo.duckdb    :: same, with hot reload for UI work
```

With no database argument the app uses `%APPDATA%\lmu-racing-telemetry\telemetry.duckdb`.

### Order of operations on the Windows machine

1. **`npm run probe`** with LMU in a practice session and the car *on track*.
   The offset sanity check runs first — if any line reads FAIL, the offsets in
   `src/reader/layout.js` do not match your plugin build and nothing downstream
   should be trusted until they do.
2. The rate it reports decides how much of the telemetry analysis is viable.
3. `npm test` should pass (197 tests, none of which need the sim).
4. `npm run app -- demo.duckdb` to confirm the UI runs before any live data
   exists.

### A click-and-run installer

```
npm run dist:win     :: on Windows — produces an installer and a portable exe
npm run dist         :: for the host platform
```

Output lands in `release/`:

- **`LMU Racing Telemetry <version> x64.exe`** — NSIS installer. Choose the
  install location, gets a Start Menu and desktop shortcut.
- **`LMU Racing Telemetry <version> x64.exe`** (portable) — a single
  executable that installs nothing. Handy for dropping straight onto a sim rig.

**Build it on Windows, or let CI do it.** Cross-building from macOS or Linux
produces an app that launches and then fails, because DuckDB ships one binding
package per platform and npm installs only the one matching the host — so the
database engine would simply be absent. koffi bundles every platform, DuckDB
does not.

`.github/workflows/build.yml` builds on a `windows-latest` runner: push a tag
(`git tag v0.1.0 && git push --tags`) and the installer is attached to a GitHub
release. `workflow_dispatch` builds one on demand without tagging.

The packaged app has been verified end to end — native modules load, the schema
and renderer are read from inside the asar, and the UI renders — though so far
only in the macOS build, since that is what this machine can run.

### Releasing

```
npm run release                   :: patch bump, push, tag, build on CI
npm run release -- --version minor
npm run release -- --dry-run      :: show the plan, change nothing
npm run release -- --no-bump      :: tag the current version
```

It refuses to release from a dirty tree, runs the tests first, checks the tag
is free, then pushes and tags — the tag is what triggers the Windows build.

With the GitHub CLI installed it follows the run and downloads the installer
into `release/` when it finishes. Without it, it still pushes and tags, and
prints where to watch. `gh` is worth installing (`brew install gh && gh auth
login`); it also removes the push-authentication problem entirely.

## Opening recordings and comparing files

The sidebar has two controls:

- **Open recording…** — switch the active database. The packaged app has no
  command line to pass a path on, so without this a fresh install opens an
  empty database in `%APPDATA%` with no way to reach a recording.
- **Compare with file…** — ATTACH someone else's `.duckdb` read-only. Its laps
  appear in their own group; alt-click one to use it as the reference.

Cross-file comparison is a real join, not an import — nothing is copied. The
`lap_delta` macro only knows about local laps, so there are cross-file variants
of the delta, trace and segment-loss queries using the same mathematics.

Verified against two separate databases: a −2.633s cross-file delta against a
−2.622s actual lap-time gap.

## Live from the sim

**Connect to sim** reads the running session and does two things at once: drives
the pit wall, and **records**. A practice session you watched but did not
capture cannot be analysed afterwards, which defeats most of the point — so
laps are written to the database as they complete.

The source is swappable and the view cannot tell which it has: `ShmSource`
reads shared memory, `ReplaySource` plays back a recording.

Two honest limits in this first version:

- **Distance is integrated** from speed using the sim's own `mDeltaTime` rather
  than wall clock, and reset at each lap. Lap distance lives in the Scoring
  buffer, which this reader does not decode yet; anchoring to `mLapDist` would
  remove the drift entirely.
- **No tyre data.** The wheel offsets are not derivable from the struct layout
  this module has, and inventing them would fill the dashboard with
  plausible-looking wrong numbers. The offset table stops at `mRearBrakeBias`
  on purpose.

The probe now validates **every** field the live reader depends on — speed,
gear, RPM, throttle, brake, steering, fuel, brake bias, water temperature — so
a layout mismatch is caught there rather than showing up as a believable but
wrong dashboard.

## Automatic logging

The app arms itself at startup and watches for the sim. When LMU begins
publishing it connects, records, and goes back to watching when the sim goes
away — so going on track is the only action required. A telemetry tool you have
to remember to arm is one that misses the lap you actually wanted.

The indicator in the sidebar shows which state it is in, and clicking it
toggles logging off and on:

| | |
|---|---|
| ● Watching for the sim | armed, LMU not publishing yet |
| ● Logging **Le Mans** · 4 laps | connected and recording |
| ● Auto-logging off | disabled |

A **track or car change opens a new session** rather than extending the current
one — lumping a Le Mans run and a Monza run together makes every per-track
query wrong.

**Track setup happens by itself.** Corner detection, time-loss attribution and
the track map all need segments, and those used to be produced only by the seed
script — so a new circuit gave you a dashboard with no corners in it and no
explanation. The first clean lap now derives them automatically, choosing the
*fastest* clean lap, because segments taken from a lap with an off would bake
that line into the circuit permanently.
