import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutEngine } from '../js/workout.js';
import { buildCircuit, buildErgathlon, machinesIn, nextLegOn, splitByMachine } from '../js/multi.js';
import { buildLogbookResult } from '../js/logbook.js';
import { encodeFit, lapsToCsv } from '../js/fit.js';

const START = Date.UTC(2026, 10, 27, 15);

test('circuit cycles through the machines with a changeover between them', () => {
  const w = buildCircuit({ machines: ['rower', 'bikeerg', 'ski'], rounds: 2, kind: 'distance', value: 500 });
  assert.equal(w.multi, true);
  assert.equal(w.name, 'Circuit 2 × Row 500m / Bike 1,000m / Ski 500m');
  const types = w.segments.map((s) => (s.type === 'work' ? `${s.machine}:${s.value}` : 'T'));
  assert.deepEqual(types, ['rower:500', 'T', 'bikeerg:1000', 'T', 'ski:500', 'T', 'rower:500', 'T', 'bikeerg:1000', 'T', 'ski:500']);
  assert.deepEqual(machinesIn(w), ['rower', 'bikeerg', 'ski']);
  assert.equal(nextLegOn(w, 'rower', 0).index, 6);
  assert.equal(nextLegOn(w, 'ski', 10), null);
  // Without matching, the bike does the same distance; time legs are never doubled.
  assert.equal(buildCircuit({ machines: ['bikeerg'], rounds: 1, kind: 'distance', value: 500, matchBike: false }).segments[0].value, 500);
  assert.equal(buildCircuit({ machines: ['bikeerg'], rounds: 1, kind: 'time', value: 240 }).segments[0].value, 240);
});

test('ergathlon: one leg per machine, empty legs skipped', () => {
  const w = buildErgathlon([{ machine: 'rower', kind: 'distance', value: 2000 }, { machine: 'bikeerg', kind: 'distance', value: 0 }, { machine: 'ski', kind: 'distance', value: 2000 }]);
  assert.equal(w.name, 'Ergathlon Row 2,000m · Ski 2,000m');
  assert.deepEqual(w.segments.map((s) => s.type), ['work', 'transition', 'work']);
  assert.throws(() => buildErgathlon([]));
});

// Two machines streaming at once; only the active one moves the workout on.
function runMulti(workout, { speeds = { rower: 4, bikeerg: 8, ski: 3.8 }, changeover = 10, seconds = 3600 } = {}) {
  const engine = new WorkoutEngine(workout);
  const dist = { rower: 0, bikeerg: 0, ski: 0 };
  let changeStarted = null;
  for (let ms = 0; ms <= seconds * 1000 && engine.state !== 'finished'; ms += 100) {
    const now = START + ms;
    if (ms % 500 === 0) {
      const seg = engine.segment;
      for (const m of Object.keys(dist)) {
        let v = 0;
        if (engine.state !== 'finished' && m === seg.machine) {
          if (seg.type === 'work') { v = speeds[m]; changeStarted = null; }
          else { changeStarted ??= ms; if (ms - changeStarted >= changeover * 1000) v = speeds[m]; }
        }
        dist[m] += v * 0.5;
        engine.ingest({ source: m, distance: dist[m], speed: v, cadence: v ? 24 : 0, power: Math.round(2.8 * v ** 3), heartRate: 150 }, now);
      }
    }
    engine.tick(now);
  }
  return engine;
}

test('engine runs each leg on its own machine and times the changeovers', () => {
  const w = buildCircuit({ machines: ['rower', 'bikeerg'], rounds: 2, kind: 'distance', value: 500 });
  const e = runMulti(w);
  assert.equal(e.state, 'finished');
  const s = e.summary();
  assert.equal(s.multi, true);
  assert.equal(s.machine, 'multi');
  assert.deepEqual(s.laps.map((l) => `${l.type}:${l.machine}`), ['work:rower', 'transition:bikeerg', 'work:bikeerg', 'transition:rower', 'work:rower', 'transition:bikeerg', 'work:bikeerg']);
  const [row, change, bike] = s.laps;
  assert.ok(Math.abs(row.distance - 500) < 0.01);
  assert.ok(Math.abs(row.duration - 125) < 1, `row ${row.duration}`);
  assert.ok(Math.abs(bike.distance - 1000) < 0.01);
  assert.ok(Math.abs(bike.duration - 125) < 1, `bike ${bike.duration}`);
  assert.ok(Math.abs(row.pace - 125) < 1); // per 500 m
  assert.ok(Math.abs(bike.pace - 125) < 1); // per 1,000 m
  assert.ok(change.duration >= 9.5 && change.duration <= 11, `changeover ${change.duration}`);
  assert.equal(change.distance, 0);
  // The clock never stopped: legs and changeovers add up to the whole time.
  const sum = s.laps.reduce((a, l) => a + l.duration, 0);
  assert.ok(Math.abs(sum - s.elapsed) < 0.01);
  assert.equal(s.workPace, null);
});

test('a multi-erg workout goes to the Logbook as one result per machine', () => {
  const w = buildCircuit({ machines: ['rower', 'bikeerg'], rounds: 2, kind: 'distance', value: 500 });
  const s = runMulti(w).summary();
  const parts = splitByMachine(s);
  assert.deepEqual(parts.map((p) => p.machine), ['rower', 'bikeerg']);
  const row = buildLogbookResult(parts[0].summary, parts[0].workout);
  assert.equal(row.type, 'rower');
  assert.equal(row.workout_type, 'VariableInterval');
  assert.equal(row.distance, 1000);
  assert.equal(row.workout.intervals.length, 2);
  // Rest between the two row legs is the time spent on the bike and changing over.
  const expectedRest = (s.laps[4].startTime - s.laps[0].endTime) / 1000;
  assert.equal(row.rest_time, Math.round(expectedRest * 10));
  const bike = buildLogbookResult(parts[1].summary, parts[1].workout);
  assert.equal(bike.type, 'bike');
  assert.equal(bike.distance, 2000);
});

test('an ergathlon leg goes up as a single piece with splits on that machine', () => {
  const w = buildErgathlon([{ machine: 'rower', kind: 'distance', value: 1000 }, { machine: 'ski', kind: 'distance', value: 1000 }]);
  const s = runMulti(w);
  const parts = splitByMachine(s.summary());
  const ski = buildLogbookResult(parts[1].summary, parts[1].workout);
  assert.equal(ski.type, 'skierg');
  assert.equal(ski.workout_type, 'FixedDistanceSplits');
  assert.equal(ski.distance, 1000);
  const splitDistance = ski.workout.splits.reduce((a, x) => a + x.distance, 0);
  assert.equal(splitDistance, 1000);
  assert.ok(ski.workout.splits.length >= 2);
});

test('multi-erg FIT file is a multisport activity', () => {
  const w = buildErgathlon([{ machine: 'rower', kind: 'distance', value: 500 }, { machine: 'bikeerg', kind: 'distance', value: 1000 }]);
  const s = runMulti(w).summary();
  const bytes = encodeFit(s);
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), '.FIT');
  assert.ok(bytes.length > 100);
  const csv = lapsToCsv(s).trim().split('\n');
  assert.equal(csv.length, 1 + 3);
  assert.match(csv[2], /^2,transition,bikeerg,/);
  assert.match(csv[3], /,bikeerg,.*,1000,/);
});
