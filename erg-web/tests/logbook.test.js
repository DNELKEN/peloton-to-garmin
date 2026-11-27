import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLogbookResult, logbookDate } from '../js/logbook.js';
import { buildIntervals, PRESETS } from '../js/workout.js';
import { simulate } from './helpers.js';
import worker, { makeState, checkState } from '../logbook-worker/worker.js';

const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);

test('date is local end time in Logbook format', () => {
  assert.match(logbookDate(Date.UTC(2026, 10, 26, 12, 5, 9)), /^2026-11-2\d \d\d:05:09$/);
});

test('2000m becomes FixedDistanceSplits whose splits add up exactly', () => {
  const s = simulate(PRESETS[1], { speed: 4.1 }).summary();
  const r = buildLogbookResult(s, PRESETS[1], { timeZone: 'Europe/London' });
  assert.equal(r.type, 'rower');
  assert.equal(r.weight_class, 'H');
  assert.equal(r.workout_type, 'FixedDistanceSplits');
  assert.equal(r.distance, 2000);
  assert.equal(r.workout.splits.length, 5);
  assert.equal(sum(r.workout.splits, 'distance'), 2000);
  assert.equal(sum(r.workout.splits, 'time'), r.time);
  assert.ok(Number.isInteger(r.time) && Number.isInteger(r.stroke_rate));
  assert.equal(r.workout.splits[0].distance, 400);
});

test('timed piece splits by time', () => {
  const w = buildIntervals({ reps: 1, workKind: 'time', workValue: 300 });
  const s = simulate(w, { speed: 4 }).summary();
  const r = buildLogbookResult(s, w);
  assert.equal(r.workout_type, 'FixedTimeSplits');
  assert.equal(r.time, 3000);
  assert.deepEqual(r.workout.splits.map((x) => x.time), [600, 600, 600, 600, 600]);
  assert.equal(sum(r.workout.splits, 'distance'), r.distance);
});

test('intervals become VariableInterval with work totals and rest separately', () => {
  const w = buildIntervals({ reps: 3, workKind: 'distance', workValue: 500, restSec: 60, targetPace: 120 });
  const s = simulate(w, { speed: 4.5, restSpeed: 0.5 }).summary();
  const r = buildLogbookResult(s, w);
  assert.equal(r.workout_type, 'VariableInterval');
  assert.equal(r.distance, 1500);
  assert.equal(r.workout.intervals.length, 3);
  assert.deepEqual(r.workout.intervals.map((i) => i.rest_time), [600, 600, 0]);
  assert.equal(r.rest_time, 1200);
  assert.ok(r.rest_distance > 0);
  assert.equal(r.time, sum(r.workout.intervals, 'time'));
  assert.deepEqual(r.workout.intervals[0].targets, { pace: 1200 });
});

test('a workout ended early goes up as Just Row', () => {
  const e = simulate(PRESETS[1], { speed: 4, seconds: 60 });
  const s = e.end(Date.UTC(2026, 10, 26, 12) + 60000);
  const r = buildLogbookResult(s, PRESETS[1]);
  assert.equal(r.workout_type, 'JustRow');
  assert.equal(sum(r.workout.splits, 'distance'), r.distance);
});

test('SkiErg has no weight class; smart bikes are refused', () => {
  const s = simulate(PRESETS[1], { speed: 4, machine: 'ski' }).summary();
  const r = buildLogbookResult(s, PRESETS[1]);
  assert.equal(r.type, 'skierg');
  assert.equal(r.weight_class, undefined);
  const bike = simulate(PRESETS[1], { speed: 8, machine: 'bike' }).summary();
  assert.throws(() => buildLogbookResult(bike, PRESETS[1]));
});

// ---------- sync server ----------

const env = {
  C2_CLIENT_ID: 'cid', C2_CLIENT_SECRET: 'csecret', STATE_SECRET: 'state-secret',
  C2_BASE_URL: 'https://log-dev.concept2.com', APP_URL: 'https://me.github.io/app/',
};

test('state is signed and expires', async () => {
  const st = await makeState('k', 1000);
  assert.ok(await checkState('k', st, 2000));
  assert.ok(!(await checkState('other', st, 2000)));
  assert.ok(!(await checkState('k', st, 1000 + 11 * 60 * 1000)));
  assert.ok(!(await checkState('k', 'junk')));
});

test('server: login redirects to Concept2 with scope, callback and state', async () => {
  const res = await worker.fetch(new Request('https://sync.example.workers.dev/login'), env);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, 'https://log-dev.concept2.com/oauth/authorize');
  assert.equal(loc.searchParams.get('scope'), 'user:read,results:read,results:write');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://sync.example.workers.dev/callback');
  assert.ok(await checkState(env.STATE_SECRET, loc.searchParams.get('state')));
});

test('server: callback exchanges the code with the secret and returns tokens in the fragment', async () => {
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: new URLSearchParams(init.body) };
    return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 604800 }), { status: 200 });
  };
  try {
    const state = await makeState(env.STATE_SECRET);
    const res = await worker.fetch(new Request(`https://sync.example.workers.dev/callback?code=abc&state=${state}`), env);
    assert.equal(sent.url, 'https://log-dev.concept2.com/oauth/access_token');
    assert.equal(sent.body.get('client_secret'), 'csecret');
    assert.equal(sent.body.get('grant_type'), 'authorization_code');
    assert.equal(sent.body.get('redirect_uri'), 'https://sync.example.workers.dev/callback');
    const loc = res.headers.get('Location');
    assert.ok(loc.startsWith('https://me.github.io/app/#c2='));
    const tokens = JSON.parse(Buffer.from(loc.split('#c2=')[1], 'base64url').toString());
    assert.deepEqual(tokens, { access_token: 'AT', refresh_token: 'RT', expires_in: 604800 });

    const bad = await worker.fetch(new Request('https://sync.example.workers.dev/callback?code=abc&state=forged.1.x'), env);
    assert.match(bad.headers.get('Location'), /#c2error=/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('server: relays only the allowed API calls, with CORS for the app', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, method: init.method }); return new Response('{"data":{"id":1}}', { status: 201 }); };
  try {
    const ok = await worker.fetch(new Request('https://s.dev/api/users/me/results', { method: 'POST', headers: { Authorization: 'Bearer AT' }, body: '{}' }), env);
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://me.github.io');
    assert.deepEqual(calls, [{ url: 'https://log-dev.concept2.com/api/users/me/results', method: 'POST' }]);
    const blocked = await worker.fetch(new Request('https://s.dev/api/users/me/results/5', { method: 'DELETE', headers: { Authorization: 'Bearer AT' } }), env);
    assert.equal(blocked.status, 404);
    assert.equal(calls.length, 1);
    // History: filters and paging pass through, anything else is dropped.
    await worker.fetch(new Request('https://s.dev/api/users/me/results?type=rower&from=2026-01-01&number=250&page=2&evil=1', { headers: { Authorization: 'Bearer AT' } }), env);
    assert.deepEqual(calls[1], { url: 'https://log-dev.concept2.com/api/users/me/results?from=2026-01-01&type=rower&number=250&page=2', method: 'GET' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
