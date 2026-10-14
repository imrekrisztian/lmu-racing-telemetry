#!/usr/bin/env node
'use strict';

// Pre-race stint planner.
//
//   node src/strategy/cli.js --duration 6h --lap 3:32 --class Hyper \
//        --consumption 4.4 --pit-delta 30 --refuel 3.0 --drivers Krisztian,Co-driver

const { planRace } = require('./planner');
const { renderStintSheet, parseDuration, parseLapTime } = require('./format');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? dflt : args[i + 1];
};
const num = (name, dflt) => { const v = arg(name); return v == null ? dflt : Number(v); };

if (args.includes('--help') || args.length === 0) {
    console.log(`
Stint planner for Le Mans Ultimate

  --duration <6h|90m>     timed race length        (or --laps <n>)
  --laps <n>              lap-limited race
  --lap <3:32.5>          representative lap time
  --class <Hyper|GT3|LMP2>
  --consumption <n>       %VE per lap (Hyper/GT3) or litres per lap (LMP2)
  --capacity <n>          tank litres; defaults to 100%VE for energy classes
  --reserve <n>           held back, never planned into a stint   [0]
  --pit-delta <s>         time lost traversing pit lane           [30]
  --refuel <rate>         %VE/s or L/s                            [3.0]
  --tyre-change <s>       stationary tyre time                    [0]
  --tyre-laps <n>         max laps per set; may bind before energy
  --drivers <a,b,c>       rotation, comma separated
  --track / --car         labels for the sheet

Hypercar and LMGT3 run to a Virtual Energy allowance; LMP2 runs to the tank.
The planner picks the right limiter from --class.
`);
    process.exit(0);
}

try {
    const drivers = (arg('drivers') ?? '').split(',').filter(Boolean)
        .map((name) => ({ name: name.trim() }));

    const plan = planRace({
        durationS: arg('duration') ? parseDuration(arg('duration')) : undefined,
        totalLaps: arg('laps') ? Number(arg('laps')) : undefined,
        lapTimeS: parseLapTime(arg('lap')),
        carClass: arg('class', 'Hyper'),
        consumptionPerLap: num('consumption'),
        capacity: arg('capacity') ? Number(arg('capacity')) : undefined,
        reserve: num('reserve', 0),
        pitLaneDeltaS: num('pit-delta', 30),
        refuelRate: num('refuel', 3.0),
        tyreChangeS: num('tyre-change', 0),
        tyreStintLaps: arg('tyre-laps') ? Number(arg('tyre-laps')) : undefined,
        drivers: drivers.length ? drivers : undefined,
    });

    console.log(renderStintSheet(plan, {
        track: arg('track', 'Unknown circuit'),
        car: arg('car', ''),
        carClass: arg('class', 'Hyper'),
    }));
} catch (e) {
    console.error(`\n${e.message}\n`);
    process.exit(1);
}
