import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, parseFrame, checksum } from '../js/csafe.js';
import { workoutToFrames, WORKOUT_TYPE, splitFor } from '../js/pm5-workouts.js';
import { buildIntervals, PRESETS } from '../js/workout.js';
import { PLANS, planWorkout, planDays } from '../js/plans.js';

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

test('CSAFE framing: checksum, start/stop flags and byte stuffing', () => {
  // Spec example: get status command 0x80 -> F1 80 80 F2
  assert.equal(hex(buildFrame([0x80])), 'f1 80 80 f2');
  // A content byte in F0..F3 is stuffed as F3 0x
  const f = buildFrame([0x76, 0x02, 0xf1]);
  assert.equal(hex(f.slice(0, 5)), 'f1 76 02 f3 01');
  assert.equal(checksum([0x76, 0x02, 0xf1]), 0x76 ^ 0x02 ^ 0xf1);
});

test('CSAFE reply parsing: status bits', () => {
  // status 0x01 = Ready, previous frame ok
  const ok = parseFrame(buildFrame([0x01, 0x76, 0x00]));
  assert.equal(ok.state, 1);
  assert.equal(ok.previousFrame, 'ok');
  const rejected = parseFrame(buildFrame([0x11]));
  assert.equal(rejected.previousFrame, 'rejected');
  const bad = [...buildFrame([0x01, 0x10])];
  bad[bad.length - 2] ^= 0xff;
  assert.throws(() => parseFrame(bad));
});

test('Just Row: workout type 1 then prepare-to-row, in one frame', () => {
  const { frames, workoutType } = workoutToFrames(PRESETS[0]);
  assert.equal(workoutType, WORKOUT_TYPE.justRowSplits);
  assert.equal(hex(frames[0]), '76 07 01 01 01 13 02 01 01');
});

test('2000m: fixed distance with 400m splits (matches the ErgometerJS sequence)', () => {
  const { frames, workoutType } = workoutToFrames(PRESETS[1]);
  assert.equal(workoutType, WORKOUT_TYPE.fixedDistanceSplits);
  assert.equal(hex(frames[0]), '76 0a 01 01 03 03 05 80 00 00 07 d0');
  assert.equal(hex(frames[1]), '76 0e 05 05 80 00 00 01 90 14 01 01 13 02 01 01');
});

test('30 minutes: fixed time in hundredths of a second with 6:00 splits', () => {
  const { frames } = workoutToFrames(PRESETS[3]);
  assert.equal(hex(frames[0]), '76 0a 01 01 05 03 05 00 00 02 bf 20'); // 180000
  assert.equal(hex(frames[1].slice(0, 9)), '76 0e 05 05 00 00 00 8c a0'); // 36000
  assert.deepEqual(splitFor({ kind: 'time', value: 1200 }), { kind: 'time', value: 240 });
});

test('intervals become a variable-interval workout with exact rests and target pace', () => {
  const w = buildIntervals({ reps: 2, workKind: 'distance', workValue: 500, restSec: 60, targetPace: 100 });
  const { frames, workoutType } = workoutToFrames(w);
  assert.equal(workoutType, WORKOUT_TYPE.variableInterval);
  assert.deepEqual(frames.map(hex), [
    '76 09 18 01 00 01 01 08 17 01 01', // interval #0, variable interval, distance
    '76 0b 03 05 80 00 00 01 f4 04 02 00 3c', // 500m, 60s rest
    '76 09 06 04 00 00 27 10 14 01 01', // target 1:40.0, configure
    '76 06 18 01 01 17 01 01', // interval #1
    '76 0b 03 05 80 00 00 01 f4 04 02 00 00', // 500m, no rest after the last
    '76 09 06 04 00 00 27 10 14 01 01',
    '76 04 13 02 01 01', // prepare to row
  ]);
});

test('timed intervals use time interval type and hundredths', () => {
  const w = buildIntervals({ reps: 2, workKind: 'time', workValue: 240, restSec: 90 });
  const { frames } = workoutToFrames(w);
  assert.equal(hex(frames[0]), '76 09 18 01 00 01 01 08 17 01 00');
  assert.equal(hex(frames[1]), '76 0b 03 05 00 00 00 5d c0 04 02 00 5a');
});

test('every frame fits in one 20-byte BLE packet for all Pete Plan sessions', () => {
  const plan = PLANS.pete;
  for (const day of planDays(plan)) {
    const w = planWorkout(plan, day.index, { targets: { [day.session.id]: 115.3 } });
    if (!w) continue;
    for (const f of workoutToFrames(w).frames) assert.ok(buildFrame(f).length <= 20, `${w.name}: ${buildFrame(f).length} bytes`);
  }
});

test('rejects workouts the PM5 cannot represent', () => {
  assert.throws(() => workoutToFrames({ segments: [{ type: 'rest', kind: 'time', value: 60 }, { type: 'work', kind: 'distance', value: 500 }] }));
  assert.throws(() => workoutToFrames(buildIntervals({ reps: 31, workKind: 'distance', workValue: 100 })));
});
