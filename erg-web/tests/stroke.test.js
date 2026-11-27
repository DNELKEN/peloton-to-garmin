import test from 'node:test';
import assert from 'node:assert/strict';
import { toDataView } from '../js/bytes.js';
import { ForceCurveAssembler, PM5Device, PM5_HANDLERS, PM5_UUIDS } from '../js/pm5.js';
import { StrokeTracker, analyzeCurve, HINTS } from '../js/stroke.js';
import { simulatedCurve } from '../js/simulator.js';

const le = (v, n) => Array.from({ length: n }, (_, i) => (v >> (8 * i)) & 0xff);
const packet = (packets, seq, words) => toDataView([(packets << 4) | words.length, seq, ...words.flatMap((w) => le(w, 2))]);

test('force curve is put back together from its notifications', () => {
  const fc = new ForceCurveAssembler();
  assert.equal(fc.push(packet(3, 10, [0, 40, 90, 140, 180, 210, 230, 240, 238])), null);
  assert.equal(fc.push(packet(3, 11, [225, 200, 170, 135, 100, 70, 40, 20, 8])), null);
  const curve = fc.push(packet(3, 12, [2, 0]));
  assert.equal(curve.length, 20);
  assert.equal(curve[7], 240);
  assert.equal(curve.at(-1), 0);
  // Next stroke starts clean.
  assert.deepEqual(fc.push(packet(1, 13, [5, 50, 20, 0])), [5, 50, 20, 0]);
});

test('force curve with a dropped notification is thrown away', () => {
  const fc = new ForceCurveAssembler();
  fc.push(packet(3, 1, [0, 40, 90]));
  assert.equal(fc.push(packet(3, 3, [100, 50, 0])), null); // seq 2 missing: starts over at 3
  assert.equal(fc.push(packet(3, 4, [80, 40, 0])), null);
  assert.deepEqual(fc.push(packet(3, 5, [10, 5, 0])), [100, 50, 0, 80, 40, 0, 10, 5, 0]);
});

test('PM5 reports stroke data and whole force curves', () => {
  const updates = [];
  const pm = new PM5Device({ onData: (u) => updates.push(u) });
  const stroke = toDataView([...le(0, 3), ...le(0, 3), 142, 82, ...le(168, 2), ...le(1000, 2), ...le(2450, 2), ...le(1300, 2), ...le(5000, 2), ...le(37, 2)]);
  pm.handle(PM5_UUIDS.strokeData, PM5_HANDLERS[PM5_UUIDS.strokeData], stroke);
  assert.deepEqual(updates.at(-1), { driveLength: 1.42, driveTime: 0.82, recoveryTime: 1.68, peakForce: 245, avgForce: 130, strokeCount: 37 });

  const n = updates.length;
  const parse = (dv) => pm.parseForceCurve(dv);
  pm.handle(PM5_UUIDS.forceCurve, parse, packet(2, 0, [0, 100, 200]));
  assert.equal(updates.length, n); // nothing until the stroke is complete
  pm.handle(PM5_UUIDS.forceCurve, parse, packet(2, 1, [150, 50, 0]));
  assert.deepEqual(updates.at(-1), { forceCurve: [0, 100, 200, 150, 50, 0] });
});

test('stroke tracker keeps the latest stroke and its ratio', () => {
  const t = new StrokeTracker();
  assert.equal(t.ratio, null);
  t.ingest({ driveTime: 0.8, recoveryTime: 1.7, driveLength: 1.4, peakForce: 230, avgForce: 120 });
  assert.equal(t.stroke.driveLength, 1.4);
  assert.ok(Math.abs(t.ratio - 1.7 / 0.8) < 1e-9);
  assert.equal(t.version, 1);
  t.ingest({ distance: 100 }); // other updates change nothing
  assert.equal(t.version, 1);
});

test('stroke tracker keeps the last five curves', () => {
  const t = new StrokeTracker();
  for (let i = 0; i < 7; i++) t.ingest({ forceCurve: [0, i + 10, 0] });
  assert.equal(t.curves.length, 5);
  assert.deepEqual(t.latestCurve, [0, 16, 0]);
  assert.equal(t.version, 7);
});

test('curve shape notes', () => {
  assert.equal(analyzeCurve(simulatedCurve(4, 1)).hint, null);
  assert.equal(analyzeCurve(simulatedCurve(4, 0.6)).hint, HINTS.dip);
  assert.equal(analyzeCurve([0, 20, 40, 60, 80, 110, 150, 190, 230, 200, 60]).hint, HINTS.late);
  assert.equal(analyzeCurve([0, 240, 200, 170, 150, 130, 110, 90, 70, 40, 10, 0]).hint, HINTS.early);
  // Only shown when three strokes in a row agree.
  const t = new StrokeTracker();
  t.ingest({ forceCurve: simulatedCurve(4, 0.6) });
  t.ingest({ forceCurve: simulatedCurve(4, 0.6) });
  assert.equal(t.hint, null);
  t.ingest({ forceCurve: simulatedCurve(4, 0.6) });
  assert.equal(t.hint, HINTS.dip);
  t.ingest({ forceCurve: simulatedCurve(4, 1) });
  assert.equal(t.hint, null);
});
