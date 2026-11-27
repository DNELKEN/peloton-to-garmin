import test from 'node:test';
import assert from 'node:assert/strict';
import { toDataView } from '../js/bytes.js';
import { parseGeneralStatus, parseAdditionalStatus, parseStrokeData, parseAdditionalStrokeData, machineFromName, wattsFromSpeed, pmWorkoutEnded, PM5Device, PM5_UUIDS, PM5_HANDLERS } from '../js/pm5.js';
import { parseRowerData, parseIndoorBikeData } from '../js/ftms.js';
import { parseHeartRate } from '../js/hr.js';

const le = (v, n) => Array.from({ length: n }, (_, i) => (v >> (8 * i)) & 0xff);

test('PM5 general status', () => {
  const bytes = [...le(12345, 3), ...le(15003, 3), 1, 0, 1, 1, 2, ...le(1500, 3), ...le(2000, 3), 0x80, 120];
  const s = parseGeneralStatus(toDataView(bytes));
  assert.equal(s.elapsed, 123.45);
  assert.equal(s.distance, 1500.3);
  assert.equal(s.dragFactor, 120);
});

test('PM5 workout end detection: finished or Menu pressed mid-workout', () => {
  assert.equal(pmWorkoutEnded(1, 11), true); // rowing -> terminated (Menu)
  assert.equal(pmWorkoutEnded(5, 0), true); // interval work -> waiting (reset)
  assert.equal(pmWorkoutEnded(1, 10), true); // rowing -> workout end
  assert.equal(pmWorkoutEnded(3, 5), false); // rest -> work is still the same workout
  assert.equal(pmWorkoutEnded(0, 1), false); // starting
  assert.equal(pmWorkoutEnded(undefined, 11), false); // first reading after connecting
  assert.equal(pmWorkoutEnded(12, 0), false); // already ended
});

test('PM5Device reports the end of a workout once, after the final data', () => {
  const events = [];
  const pm = new PM5Device({ onData: (u) => events.push(['data', u.distance]), onWorkoutEnd: (s) => events.push(['end', s]) });
  const status = (distance, workoutState) => toDataView([...le(0, 3), ...le(distance * 10, 3), 1, 0, workoutState, 1, 2, ...le(0, 3), ...le(0, 3), 0x80, 120]);
  const feed = (d, st) => pm.handle(PM5_UUIDS.generalStatus, PM5_HANDLERS[PM5_UUIDS.generalStatus], status(d, st));
  feed(0, 0);
  feed(100, 1);
  feed(812, 1);
  feed(812, 11); // Menu pressed
  feed(0, 0);
  assert.deepEqual(events, [['data', 0], ['data', 100], ['data', 812], ['data', 812], ['end', 11], ['data', 0]]);
});

test('PM5 additional status: speed, stroke rate, HR, pace', () => {
  const bytes = [...le(100, 3), ...le(4167, 2), 26, 150, ...le(12000, 2), ...le(12150, 2), 0, 0, 0, 0, 0, 0];
  const s = parseAdditionalStatus(toDataView(bytes));
  assert.equal(s.speed, 4.167);
  assert.equal(s.strokeRate, 26);
  assert.equal(s.heartRate, 150);
  assert.equal(s.pace, 120);
  const noHr = parseAdditionalStatus(toDataView([...bytes.slice(0, 6), 255, ...bytes.slice(7)]));
  assert.equal(noHr.heartRate, undefined);
});

test('PM5 stroke data and stroke power', () => {
  const stroke = parseStrokeData(toDataView([...le(0, 3), ...le(500, 3), 145, 80, ...le(160, 2), ...le(1020, 2), ...le(2100, 2), ...le(1300, 2), ...le(5000, 2), ...le(42, 2)]));
  assert.equal(stroke.driveLength, 1.45);
  assert.equal(stroke.strokeCount, 42);
  assert.equal(stroke.peakForce, 210);
  const extra = parseAdditionalStrokeData(toDataView([...le(0, 3), ...le(205, 2), ...le(1100, 2), ...le(42, 2), 0, 0, 0, 0, 0, 0]));
  assert.equal(extra.power, 205);
});

test('PM5 helpers', () => {
  assert.equal(machineFromName('PM5 430012345 Ski'), 'ski');
  assert.equal(machineFromName('PM5 430012345 Bike'), 'bikeerg');
  assert.equal(machineFromName('PM5 430012345 Row'), 'rower');
  // 2:00 /500m is about 203 W on a Concept2.
  assert.equal(Math.round(wattsFromSpeed(500 / 120)), 203);
});

test('FTMS rower data', () => {
  // flags: stroke data present (bit0=0), total distance, inst pace, inst power, heart rate, elapsed
  const flags = 0x0004 | 0x0008 | 0x0020 | 0x0200 | 0x0800;
  const r = parseRowerData(toDataView([...le(flags, 2), 48, ...le(77, 2), ...le(1234, 3), ...le(125, 2), ...le(180, 2), 142, ...le(600, 2)]));
  assert.deepEqual(r, { cadence: 24, strokeCount: 77, distance: 1234, pace: 125, speed: 4, power: 180, heartRate: 142, elapsed: 600 });
});

test('FTMS rower data tolerates truncated packets', () => {
  const r = parseRowerData(toDataView([...le(0x0004, 2), 48, ...le(10, 2), 1]));
  assert.equal(r.cadence, 24);
  assert.equal(r.distance, undefined);
});

test('FTMS indoor bike data', () => {
  const flags = 0x0004 | 0x0040;
  const r = parseIndoorBikeData(toDataView([...le(flags, 2), ...le(3600, 2), ...le(180, 2), ...le(250, 2)]));
  assert.equal(r.speed, 10);
  assert.equal(r.cadence, 90);
  assert.equal(r.power, 250);
});

test('heart rate measurement, 8 and 16 bit', () => {
  assert.deepEqual(parseHeartRate(toDataView([0x00, 72])), { heartRate: 72 });
  assert.deepEqual(parseHeartRate(toDataView([0x01, ...le(301, 2)])), { heartRate: 301 });
});
