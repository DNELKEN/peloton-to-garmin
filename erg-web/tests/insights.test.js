import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResult, paulsLaw, predictDistance, predictTime, suggestTargets, applyTargets, typicalAt, wattsAtPace500, parseLogbookDate } from '../js/insights.js';
import { PRESETS, buildIntervals } from '../js/workout.js';

const NOW = new Date(2026, 10, 26, 20, 0, 0).getTime();
const daysAgo = (d) => {
  const t = new Date(NOW - d * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} 18:00:00`;
};
// A Logbook API result: time in tenths.
const piece = (d, distance, pace, extra = {}) => ({ id: Math.random(), date: daysAgo(d), type: 'rower', workout_type: 'FixedDistanceSplits', distance, time: Math.round((distance / 500) * pace * 10), stroke_rate: 24, heart_rate: { average: 150 }, ...extra });

test('normalizes Logbook results, including interval reps', () => {
  const n = normalizeResult(piece(3, 2000, 120));
  assert.equal(n.time, 480);
  assert.equal(n.pace, 120);
  assert.equal(n.interval, false);
  assert.equal(n.hr, 150);
  const iv = normalizeResult({
    id: 9, date: daysAgo(2), type: 'rower', workout_type: 'FixedDistanceInterval', distance: 2000, time: 4600, rest_time: 1800,
    workout: { intervals: [500, 500, 500, 500].map(() => ({ type: 'distance', distance: 500, time: 1150, stroke_rate: 30, heart_rate: { average: 170 } })) },
  });
  assert.equal(iv.interval, true);
  assert.equal(iv.reps.length, 4);
  assert.equal(iv.reps[0].time, 115);
  assert.equal(normalizeResult({ time: 0, distance: 0 }), null);
  assert.ok(Number.isFinite(parseLogbookDate('2026-11-26 20:24:58')));
});

test("Paul's Law: +5 s/500m per doubling of distance", () => {
  assert.equal(paulsLaw(120, 2000, 4000), 125);
  assert.equal(paulsLaw(120, 2000, 1000), 115);
  assert.ok(Math.abs(wattsAtPace500(120) - 202.5) < 0.1);
});

test('predicts from the best recent pieces, ignoring old ones', () => {
  const history = [piece(10, 2000, 120), piece(20, 5000, 128), piece(30, 2000, 124), piece(400, 2000, 100)].map(normalizeResult);
  const p = predictDistance(history, 2000, NOW);
  // 2k @2:00 -> 120; 5k @2:08 -> 128 + 5*log2(0.4) = 121.39; 2k @2:04 -> 124. Mean of best 3.
  assert.ok(Math.abs(p.pace - (120 + 121.39 + 124) / 3) < 0.05, `pace ${p.pace}`);
  assert.equal(p.count, 3);
  assert.equal(predictDistance([], 2000, NOW), null);
});

test('timed pieces solve for the distance you would cover', () => {
  const history = [piece(5, 2000, 120)].map(normalizeResult);
  const p = predictTime(history, 1800, NOW);
  assert.ok(Math.abs((p.distance / 500) * p.pace - 1800) < 1);
  assert.ok(p.pace > 120 && p.pace < 135);
});

test('suggests targets for a 2k test with typical stroke rate, HR and watts', () => {
  const history = [piece(5, 2000, 121, { stroke_rate: 30, heart_rate: { average: 175 } }), piece(8, 6000, 130, { stroke_rate: 22, heart_rate: { average: 150 } })].map(normalizeResult);
  const s = suggestTargets(PRESETS[1], history, { now: NOW });
  assert.equal(s.basis, 'model');
  assert.equal(s.targets.length, 1);
  assert.ok(s.pace >= 120 && s.pace <= 123, `pace ${s.pace}`);
  assert.equal(s.spm, 30); // only the 2k is within 3 s/500m
  assert.equal(s.hr, 175);
  assert.ok(s.watts > 180 && s.watts < 210);
  assert.equal(suggestTargets(PRESETS[0], history, { now: NOW }), null); // Just row
  assert.equal(suggestTargets(PRESETS[1], [], { now: NOW }), null);
});

test('intervals: last similar sessions win; otherwise between one-rep and all-work pace', () => {
  const w = buildIntervals({ reps: 4, workKind: 'distance', workValue: 500, restSec: 120 });
  const steady = [piece(5, 2000, 120)].map(normalizeResult);
  const m = suggestTargets(w, steady, { now: NOW });
  assert.equal(m.basis, 'model');
  // one rep (500m) = 110, all work (2000m) = 120; a rep takes 110 s, so 120 s rest -> f = 120/220.
  assert.equal(m.targets[0].pace, 114.5);
  const short = suggestTargets(buildIntervals({ reps: 4, workKind: 'distance', workValue: 500, restSec: 30 }), steady, { now: NOW });
  assert.ok(short.pace > 114.5 && short.pace < 120, `pace ${short.pace}`);

  const past = normalizeResult({
    id: 1, date: daysAgo(7), type: 'rower', workout_type: 'FixedDistanceInterval', distance: 2000, time: 4480, rest_time: 3600,
    workout: { intervals: Array.from({ length: 4 }, () => ({ distance: 500, time: 1120 })) },
  });
  const s = suggestTargets(w, [...steady, past], { now: NOW });
  assert.equal(s.basis, 'similar');
  assert.equal(s.pace, 112);
  assert.equal(s.targets.length, 4);
});

test('BikeErg targets are per 1000m; applying sets targetPace on work segments only', () => {
  const history = [piece(5, 4000, 60, { type: 'bike' })].map(normalizeResult);
  const w = buildIntervals({ reps: 2, workKind: 'time', workValue: 240, restSec: 60 });
  const s = suggestTargets(w, history, { now: NOW, paceUnit: 1000 });
  assert.ok(s.pace > 100 && s.pace < 130, `pace ${s.pace}`);
  const applied = applyTargets(w, s);
  assert.equal(applied.segments[0].targetPace, s.targets[0].pace);
  assert.equal(applied.segments[1].targetPace, undefined);
  assert.equal(w.segments[0].targetPace, undefined); // original untouched
});

test('typicalAt uses interval reps as their own data points', () => {
  const past = normalizeResult({
    id: 1, date: daysAgo(3), type: 'rower', workout_type: 'FixedDistanceInterval', distance: 1000, time: 2200, rest_time: 600,
    workout: { intervals: [{ distance: 500, time: 1100, stroke_rate: 32, heart_rate: { average: 172 } }, { distance: 500, time: 1100, stroke_rate: 34, heart_rate: { average: 178 } }] },
  });
  assert.deepEqual(typicalAt([past], 110, NOW), { spm: 33, hr: 175, samples: 2 });
});
