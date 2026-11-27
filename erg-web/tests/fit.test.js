import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodeFit, fitCrc, lapsToCsv } from '../js/fit.js';
import { buildIntervals } from '../js/workout.js';
import { simulate } from './helpers.js';

test('FIT file has valid header and CRCs', () => {
  const w = buildIntervals({ reps: 2, workKind: 'distance', workValue: 500, restSec: 60 });
  const s = simulate(w, { speed: 4.2 }).summary();
  const fit = encodeFit(s);
  assert.equal(fit[0], 14);
  assert.equal(String.fromCharCode(...fit.slice(8, 12)), '.FIT');
  const dv = new DataView(fit.buffer);
  assert.equal(dv.getUint32(4, true), fit.length - 16);
  assert.equal(dv.getUint16(12, true), fitCrc(fit, 0, 12));
  assert.equal(fitCrc(fit), 0, 'CRC over the whole file including its CRC is zero');

  // Leave a copy for external validation (e.g. python fitdecode).
  if (process.env.FIT_OUT) {
    mkdirSync(process.env.FIT_OUT, { recursive: true });
    writeFileSync(`${process.env.FIT_OUT}/intervals.fit`, fit);
    writeFileSync(`${process.env.FIT_OUT}/intervals-fr945.fit`, encodeFit(s, { device: 'forerunner945' }));
  }
});

test('CSV has one row per lap', () => {
  const w = buildIntervals({ reps: 2, workKind: 'time', workValue: 30, restSec: 15 });
  const csv = lapsToCsv(simulate(w).summary());
  assert.equal(csv.trim().split('\n').length, 4);
});
