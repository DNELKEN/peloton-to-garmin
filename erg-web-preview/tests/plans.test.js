import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, planDays, planWorkout, nextDay, recordPlanResult, planLength } from '../js/plans.js';

const pete = PLANS.pete;

test('Pete Plan: 3 weeks x 7 days with the published sessions', () => {
  assert.equal(planLength(pete), 21);
  const names = planDays(pete).map((d) => planWorkout(pete, d.index)?.shortName ?? 'Rest');
  assert.deepEqual(names, [
    '8 × 500m / 3:30r', 'Steady 10k', '5 × 1,500m / 5:00r', 'Steady 10k', 'Hard 5k', 'Steady 10k', 'Rest',
    'Pyramid 250m–1k–250m', 'Steady 10k', '4 × 2,000m / 5:00r', 'Steady 10k', 'Hard 5k', 'Steady 10k', 'Rest',
    '4 × 1,000m / 5:00r', 'Steady 10k', '3k, 2.5k, 2k', 'Steady 10k', 'Hard 5k', 'Steady 10k', 'Rest',
  ]);
});

test('pyramid rests are 1:30 per preceding 250m', () => {
  const w = planWorkout(pete, 7);
  const rests = w.segments.filter((s) => s.type === 'rest').map((s) => s.value);
  assert.deepEqual(rests, [90, 180, 270, 360, 270, 180]);
  const pieces = w.segments.filter((s) => s.type === 'work').map((s) => s.value);
  assert.equal(pieces.reduce((a, b) => a + b), 4000);
});

test('target applies to every rep except the last', () => {
  const w = planWorkout(pete, 0, { targets: { 'pete-8x500': 112.4 } });
  const targets = w.segments.filter((s) => s.type === 'work').map((s) => s.targetPace ?? null);
  assert.deepEqual(targets, [112.4, 112.4, 112.4, 112.4, 112.4, 112.4, 112.4, null]);
  assert.equal(planWorkout(pete, 1, { targets: { 'pete-steady': 130 } }).segments[0].targetPace, undefined);
});

test('steady and hard distances are configurable', () => {
  const w = planWorkout(pete, 1, { options: { steadyDistance: 12000 } });
  assert.equal(w.segments[0].value, 12000);
});

test('progress: next day skips rest, results set targets, cycle wraps', () => {
  assert.equal(nextDay(pete, {}), 0);
  const finished = (dayIndex, workPace, partial = false) => ({
    plan: planWorkout(pete, dayIndex).plan, workPace, startTime: 0, laps: [{ partial }],
  });
  let p = recordPlanResult(pete, {}, finished(0, 113.26));
  assert.equal(p.targets['pete-8x500'], 113.3);
  assert.equal(nextDay(pete, p), 1);
  p = recordPlanResult(pete, p, finished(19, 130));
  assert.equal(nextDay(pete, p), 0, 'skips the rest day at the end of week 3');
  p = recordPlanResult(pete, p, finished(0, 112));
  assert.equal(p.cycle, 2);
  assert.equal(p.targets['pete-8x500'], 112);
  const unchanged = recordPlanResult(pete, p, finished(2, 100, true));
  assert.equal(unchanged.lastDone, 0, 'an unfinished session does not count');
});
