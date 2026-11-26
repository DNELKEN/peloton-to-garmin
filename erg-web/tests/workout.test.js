import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from './helpers.js';
import { WorkoutEngine, buildIntervals, describeWorkout, formatTime, parseDuration, PRESETS } from '../js/workout.js';

test('formatting and parsing', () => {
  assert.equal(formatTime(125), '2:05');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(119.94, true), '1:59.9');
  assert.equal(parseDuration('4:00'), 240);
  assert.equal(parseDuration('1:30.5'), 90.5);
  assert.equal(parseDuration('90'), 90);
  assert.ok(Number.isNaN(parseDuration('abc')));
});

test('interval builder and names', () => {
  const w = buildIntervals({ reps: 3, workKind: 'distance', workValue: 500, restSec: 60 });
  assert.equal(w.segments.length, 5); // no rest after the last piece
  assert.equal(w.name, '3 × 500m / 1:00r');
  assert.equal(describeWorkout(PRESETS[0]), 'Just row');
});

test('waits in armed state until the erg moves', () => {
  const e = new WorkoutEngine(PRESETS[1]);
  e.ingest({ distance: 0, speed: 0 }, 0);
  e.tick(1000);
  assert.equal(e.state, 'armed');
  e.ingest({ distance: 2, speed: 4 }, 1500);
  assert.equal(e.state, 'running');
});

test('2,000m at 4 m/s finishes in about 500 s with interpolated finish', () => {
  const e = simulate(PRESETS[1], { speed: 4 });
  assert.equal(e.state, 'finished');
  const s = e.summary();
  assert.equal(s.laps.length, 1);
  assert.equal(s.laps[0].distance, 2000);
  assert.ok(Math.abs(s.laps[0].duration - 500) < 0.6, `duration ${s.laps[0].duration}`);
  assert.ok(Math.abs(s.laps[0].pace - 125) < 0.2);
  assert.equal(s.avgHr, 150);
  assert.ok(s.samples.length >= 499);
});

test('intervals alternate work and rest, rest laps are time based', () => {
  const w = buildIntervals({ reps: 3, workKind: 'distance', workValue: 500, restSec: 60 });
  const e = simulate(w, { speed: 5 });
  assert.equal(e.state, 'finished');
  const laps = e.summary().laps;
  assert.deepEqual(laps.map((l) => l.type), ['work', 'rest', 'work', 'rest', 'work']);
  for (const l of laps.filter((l) => l.type === 'work')) assert.ok(Math.abs(l.duration - 100) < 1);
  for (const l of laps.filter((l) => l.type === 'rest')) assert.ok(Math.abs(l.duration - 60) < 0.2);
  const s = e.summary();
  assert.equal(Math.round(s.workDistance), 1500);
});

test('timed piece ends on the clock', () => {
  const w = buildIntervals({ reps: 1, workKind: 'time', workValue: 120 });
  const e = simulate(w, { speed: 4 });
  const [lap] = e.summary().laps;
  assert.equal(lap.duration, 120);
  assert.ok(Math.abs(lap.distance - 480) < 3);
});

test('target pace delta and projections', () => {
  const w = buildIntervals({ reps: 1, workKind: 'distance', workValue: 1000, targetPace: 120 });
  const e = new WorkoutEngine(w);
  const t0 = 1_000_000;
  let d = 0;
  for (let ms = 0; ms <= 60000; ms += 500) {
    e.ingest({ distance: d, speed: 4 }, t0 + ms);
    e.tick(t0 + ms);
    d += 2;
  }
  const v = e.view(t0 + 60000);
  assert.ok(v.segPace > 124 && v.segPace < 126.5, `pace ${v.segPace}`);
  assert.ok(v.targetDelta > 4, 'slower than target');
  assert.ok(v.projected > 240 && v.projected < 255, `projected finish ${v.projected}`);
});

test('ending a Just Row early produces a partial lap', () => {
  const e = simulate(PRESETS[0], { speed: 4, seconds: 30 });
  assert.equal(e.state, 'running');
  const s = e.end(Date.UTC(2026, 10, 26, 12) + 30000);
  assert.equal(e.state, 'finished');
  assert.equal(s.laps.length, 1);
  assert.ok(s.laps[0].partial);
  assert.ok(s.totalDistance > 110);
});

test('monitor reset does not add a huge jump in distance', () => {
  const e = new WorkoutEngine(PRESETS[0]);
  e.ingest({ distance: 0 }, 0);
  e.ingest({ distance: 10 }, 1000);
  e.ingest({ distance: 5000 }, 2000); // reset / bogus reading
  e.ingest({ distance: 5004 }, 3000);
  assert.equal(e.totalDistance, 14);
});

test('bike without distance integrates speed', () => {
  const e = new WorkoutEngine(PRESETS[0], { machine: 'bike' });
  e.ingest({ speed: 10, power: 200, cadence: 90 }, 0);
  for (let ms = 100; ms <= 10000; ms += 100) {
    if (ms % 1000 === 0) e.ingest({ speed: 10, power: 200, cadence: 90 }, ms);
    e.tick(ms);
  }
  assert.ok(Math.abs(e.totalDistance - 100) < 1.5, `distance ${e.totalDistance}`);
});

test('PM5 per-interval distance reset keeps counting', () => {
  const e = new WorkoutEngine(PRESETS[0]);
  e.ingest({ distance: 0 }, 0);
  for (let d = 4, t = 1000; d <= 500; d += 4, t += 1000) e.ingest({ distance: d }, t);
  e.ingest({ distance: 3 }, 200000); // new interval starts from zero
  e.ingest({ distance: 10 }, 201000);
  assert.equal(e.totalDistance, 510);
});
