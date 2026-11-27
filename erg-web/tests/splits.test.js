import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutEngine, PRESETS, buildIntervals, parseSplitText, splitKindOf, splitForSegment } from '../js/workout.js';
import { workoutToFrames } from '../js/pm5-workouts.js';
import { buildLogbookResult } from '../js/logbook.js';
import { encodeFit, lapsToCsv } from '../js/fit.js';
import { simulate } from './helpers.js';

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
const twoK = PRESETS.find((p) => p.name === '2,000m test');
const tenMin = buildIntervals({ reps: 1, workKind: 'time', workValue: 600 });
const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);

test('split box: meters, m:ss, either, and errors', () => {
  assert.deepEqual(parseSplitText('250', twoK), { split: { kind: 'distance', value: 250 } });
  assert.deepEqual(parseSplitText(' 250m ', twoK), { split: { kind: 'distance', value: 250 } });
  assert.deepEqual(parseSplitText('2:00', tenMin), { split: { kind: 'time', value: 120 } });
  assert.deepEqual(parseSplitText('90', tenMin), { split: { kind: 'time', value: 90 } });
  assert.deepEqual(parseSplitText('', twoK), { split: null });
  const justRow = PRESETS.find((p) => p.name === 'Just row');
  assert.equal(splitKindOf(justRow), 'either');
  assert.deepEqual(parseSplitText('5:00', justRow), { split: { kind: 'time', value: 300 } });
  assert.deepEqual(parseSplitText('1000', justRow), { split: { kind: 'distance', value: 1000 } });
  assert.match(parseSplitText('abc', twoK).error, /meters/);
  assert.match(parseSplitText('50', twoK).error, /at least 100/);
  assert.match(parseSplitText('0:10', tenMin).error, /at least 0:20/);
  assert.match(parseSplitText('2000', twoK).error, /shorter than the piece/);
});

test('mixed or multi-erg workouts take no split', () => {
  const mixed = { segments: [{ type: 'work', kind: 'distance', value: 500 }, { type: 'rest', kind: 'time', value: 60 }, { type: 'work', kind: 'time', value: 120 }] };
  assert.equal(splitKindOf(mixed), null);
  assert.equal(splitKindOf({ ...twoK, multi: true }), null);
});

test('2k with 250m splits records eight splits that add up to the piece', () => {
  const s = simulate({ ...twoK, split: { kind: 'distance', value: 250 } }, { speed: 4.1 }).summary();
  const [lap] = s.laps;
  assert.equal(lap.splits.length, 8);
  assert.deepEqual(lap.splits.map((x) => Math.round(x.distance)), [250, 250, 250, 250, 250, 250, 250, 250]);
  assert.ok(Math.abs(sum(lap.splits, 'duration') - lap.duration) < 0.01);
  for (const sp of lap.splits) assert.ok(Math.abs(sp.pace - 500 / 4.1) < 1, `pace ${sp.pace}`);
});

test('10 minute piece with 2:00 splits records five timed splits', () => {
  const s = simulate({ ...tenMin, split: { kind: 'time', value: 120 } }, { speed: 4 }).summary();
  const [lap] = s.laps;
  assert.deepEqual(lap.splits.map((x) => x.duration), [120, 120, 120, 120, 120]);
  assert.ok(Math.abs(sum(lap.splits, 'distance') - lap.distance) < 0.01);
});

test('without a chosen split a single piece gets the PM5 default; intervals get none', () => {
  const s = simulate(twoK, { speed: 4 }).summary();
  assert.equal(s.laps[0].splits.length, 5); // 400 m
  const iv = buildIntervals({ reps: 2, workKind: 'distance', workValue: 500, restSec: 30 });
  assert.equal(splitForSegment(iv, iv.segments[0]), null);
  assert.equal(simulate(iv, { speed: 5 }).summary().laps[0].splits, null);
});

test('intervals: every piece gets its own splits, and the live view shows the current ones', () => {
  const w = { ...buildIntervals({ reps: 3, workKind: 'distance', workValue: 1000, restSec: 60 }), split: { kind: 'distance', value: 250 } };
  const start = Date.UTC(2026, 10, 26, 12);
  const engine = new WorkoutEngine(w);
  let d = 0;
  let seen = 0;
  for (let ms = 0; ms <= 900000 && engine.state !== 'finished'; ms += 100) {
    if (ms % 500 === 0) { engine.ingest({ distance: d, speed: 5 }, start + ms); d += 2.5; }
    engine.tick(start + ms);
    const v = engine.view(start + ms);
    if (v.seg.type === 'work') seen = Math.max(seen, v.splits.length);
  }
  assert.equal(seen, 3, 'live view lists the finished splits of the current piece');
  const work = engine.summary().laps.filter((l) => l.type === 'work');
  assert.equal(work.length, 3);
  for (const l of work) assert.deepEqual(l.splits.map((x) => Math.round(x.distance)), [250, 250, 250, 250]);
  assert.equal(engine.summary().laps.find((l) => l.type === 'rest').splits, null);
});

test('ending early closes the current split as partial', () => {
  const e = simulate({ ...twoK, split: { kind: 'distance', value: 250 } }, { speed: 4, seconds: 100 });
  const s = e.end(Date.UTC(2026, 10, 26, 12) + 100000);
  const splits = s.laps[0].splits;
  assert.equal(splits.length, 2);
  assert.equal(Math.round(splits[0].distance), 250);
  assert.ok(splits[1].partial);
});

test('PM5 gets the chosen split for a single piece', () => {
  const { frames } = workoutToFrames({ ...twoK, split: { kind: 'distance', value: 250 } });
  assert.equal(hex(frames[1].slice(0, 9)), '76 0e 05 05 80 00 00 00 fa'); // 250 m
  const t = workoutToFrames({ ...tenMin, split: { kind: 'time', value: 120 } });
  assert.equal(hex(t.frames[1].slice(0, 9)), '76 0e 05 05 00 00 00 2e e0'); // 12000 hundredths
});

test('Logbook splits follow the chosen split and add up exactly', () => {
  const w = { ...twoK, split: { kind: 'distance', value: 250 } };
  const r = buildLogbookResult(simulate(w, { speed: 4.2 }).summary(), w);
  assert.equal(r.workout_type, 'FixedDistanceSplits');
  assert.equal(r.workout.splits.length, 8);
  assert.equal(sum(r.workout.splits, 'distance'), 2000);
  assert.equal(sum(r.workout.splits, 'time'), r.time);
});

test('FIT has a lap per split; CSV lists them under the piece', () => {
  const w = { ...twoK, split: { kind: 'distance', value: 500 } };
  const s = simulate(w, { speed: 4 }).summary();
  const fit = encodeFit(s);
  assert.ok(fit.length > 100);
  const csv = lapsToCsv(s).trim().split('\n');
  assert.deepEqual(csv.slice(1).map((r) => r.split(',')[0]), ['1', '1.1', '1.2', '1.3', '1.4']);
});
