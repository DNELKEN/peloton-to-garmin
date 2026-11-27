// Concept2 Logbook sync.
//
// Sign-in uses OAuth2 through a small server you deploy (logbook-worker/), because Concept2's
// token exchange needs a client secret that can't live in a public web page. The server hands
// the tokens back to this page in the URL fragment; they are kept in this browser only.

import { splitFor } from './pm5-workouts.js';
import { normalizeResult } from './insights.js';

const TOKEN_KEY = 'erg-trainer.logbook.tokens';
const CONFIG_KEY = 'erg-trainer.logbook.config';

export const LOGBOOK_TYPES = { rower: 'rower', ski: 'skierg', bikeerg: 'bike' };

const tenths = (sec) => Math.round(sec * 10);
const int = (v) => (v == null || !Number.isFinite(v) ? undefined : Math.round(v));
const pad = (n) => String(n).padStart(2, '0');

// The Logbook wants local wall-clock time of the END of the workout, "yyyy-mm-dd hh:mm:ss".
export function logbookDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function heartRate(avg, max, ending) {
  const hr = { average: int(avg), max: int(max), ending: int(ending) };
  for (const k of Object.keys(hr)) if (!hr[k]) delete hr[k];
  return Object.keys(hr).length ? hr : undefined;
}

const clean = (obj) => {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
};

// Cumulative (time, distance) at a given cumulative distance or time, interpolated from samples.
function makeInterpolator(samples, startTime) {
  const pts = [{ t: 0, d: 0 }, ...samples.map((s) => ({ t: (s.t - startTime) / 1000, d: s.distance }))];
  return {
    timeAtDistance(d) {
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].d >= d) {
          const a = pts[i - 1], b = pts[i];
          return b.d === a.d ? b.t : a.t + ((d - a.d) / (b.d - a.d)) * (b.t - a.t);
        }
      }
      return pts.at(-1).t;
    },
    distanceAtTime(t) {
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].t >= t) {
          const a = pts[i - 1], b = pts[i];
          return b.t === a.t ? b.d : a.d + ((t - a.t) / (b.t - a.t)) * (b.d - a.d);
        }
      }
      return pts.at(-1).d;
    },
    stats(t0, t1) {
      const inRange = samples.filter((s) => (s.t - startTime) / 1000 > t0 && (s.t - startTime) / 1000 <= t1);
      const moving = inRange.filter((s) => s.cadence > 0);
      const hrs = inRange.map((s) => s.heartRate).filter(Boolean);
      return {
        strokeRate: moving.length ? moving.reduce((a, s) => a + s.cadence, 0) / moving.length : undefined,
        hrAvg: hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : undefined,
        hrEnd: hrs.at(-1),
      };
    },
  };
}

// Split a single piece into Logbook splits. Integer time (tenths) and distance (m) per split are
// taken as differences of rounded cumulative values, so they always add up to the totals exactly.
function buildSplits(summary, lap, totalTime, totalDistance, by) {
  const interp = makeInterpolator(summary.samples, summary.startTime);
  const marks = [];
  if (by.kind === 'distance') {
    for (let d = by.value; d < totalDistance; d += by.value) marks.push({ t: interp.timeAtDistance(d), d });
  } else {
    for (let t = by.value; t < lap.duration; t += by.value) marks.push({ t, d: interp.distanceAtTime(t) });
  }
  marks.push({ t: lap.duration, d: lap.distance });
  const splits = [];
  let prevT = 0, prevD = 0, prevSec = 0;
  for (const m of marks) {
    const cumT = m === marks.at(-1) ? totalTime : tenths(m.t);
    const cumD = m === marks.at(-1) ? totalDistance : Math.round(m.d);
    const s = interp.stats(prevSec, m.t);
    splits.push(clean({ distance: cumD - prevD, time: cumT - prevT, stroke_rate: int(s.strokeRate), heart_rate: heartRate(s.hrAvg, null, s.hrEnd) }));
    prevT = cumT; prevD = cumD; prevSec = m.t;
  }
  return splits.filter((s) => s.time > 0);
}

// Convert a finished workout summary into a Logbook result.
export function buildLogbookResult(summary, workout, { weightClass = 'H', timeZone } = {}) {
  const type = LOGBOOK_TYPES[summary.machine];
  if (!type) throw new Error('Only Concept2 RowErg, SkiErg and BikeErg workouts can go to the Logbook.');
  const laps = summary.laps;
  const work = laps.filter((l) => l.type === 'work');
  const partial = laps.some((l) => l.partial);
  const segs = workout.segments;
  const single = segs.length === 1;
  const base = clean({
    type,
    date: logbookDate(summary.endTime),
    timezone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    weight_class: type === 'rower' ? weightClass : undefined,
    stroke_rate: int(summary.avgCadence),
    stroke_count: int(summary.cycles),
    calories_total: int(summary.calories),
    heart_rate: heartRate(summary.avgHr, summary.maxHr),
    comments: summary.name,
  });

  if (single || partial) {
    // One continuous piece (or anything ended early, sent as Just Row with all rowing time).
    const time = tenths(single ? laps[0].duration : summary.elapsed);
    const distance = Math.round(single ? laps[0].distance : summary.totalDistance);
    const kind = partial || segs[0].kind === 'open' ? 'JustRow' : segs[0].kind === 'distance' ? 'FixedDistanceSplits' : 'FixedTimeSplits';
    const lap = single ? laps[0] : { duration: summary.elapsed, distance: summary.totalDistance };
    const by = kind === 'JustRow' ? { kind: 'time', value: 300 } : splitFor(segs[0]);
    return {
      ...base,
      workout_type: kind,
      time,
      distance,
      workout: { splits: buildSplits(summary, lap, time, distance, by) },
    };
  }

  // Intervals: work totals at the top, rest totals separately, one entry per work interval.
  const intervals = [];
  for (let i = 0; i < laps.length; i++) {
    const l = laps[i];
    if (l.type !== 'work') continue;
    const rest = laps[i + 1]?.type === 'rest' ? laps[i + 1] : null;
    intervals.push(clean({
      type: l.kind === 'distance' ? 'distance' : 'time',
      time: tenths(l.duration),
      distance: Math.round(l.distance),
      rest_time: rest ? tenths(rest.duration) : 0,
      rest_distance: rest ? Math.round(rest.distance) : 0,
      stroke_rate: int(l.avgCadence),
      calories_total: int(l.calories),
      heart_rate: heartRate(l.avgHr, l.maxHr),
      targets: l.targetPace && type !== 'bike' ? { pace: tenths(l.targetPace) } : undefined,
    }));
  }
  return {
    ...base,
    workout_type: 'VariableInterval',
    time: intervals.reduce((a, x) => a + x.time, 0),
    distance: intervals.reduce((a, x) => a + x.distance, 0),
    rest_time: intervals.reduce((a, x) => a + x.rest_time, 0),
    rest_distance: intervals.reduce((a, x) => a + x.rest_distance, 0),
    workout: { intervals },
  };
}

// ---------- client ----------

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* unavailable */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* unavailable */ } },
};

export class LogbookClient {
  constructor() {
    this.config = { serverUrl: '', weightClass: 'H', autoSync: true, ...storage.get(CONFIG_KEY) };
    this.tokens = storage.get(TOKEN_KEY);
  }

  get connected() {
    return !!this.tokens?.refresh_token;
  }

  saveConfig(patch) {
    this.config = { ...this.config, ...patch };
    storage.set(CONFIG_KEY, this.config);
  }

  get server() {
    return this.config.serverUrl.replace(/\/+$/, '');
  }

  login() {
    if (!this.server) throw new Error('Enter your Logbook sync server address first.');
    location.href = `${this.server}/login`;
  }

  // Pick up tokens the sync server put in the URL fragment after sign-in.
  handleRedirect() {
    const m = location.hash.match(/[#&]c2=([^&]+)/);
    const err = location.hash.match(/[#&]c2error=([^&]+)/);
    if (!m && !err) return null;
    history.replaceState(null, '', location.pathname + location.search);
    if (err) return { error: decodeURIComponent(err[1]) };
    try {
      const t = JSON.parse(atob(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/')));
      this.setTokens(t);
      return { ok: true };
    } catch {
      return { error: 'Could not read the sign-in response.' };
    }
  }

  setTokens(t) {
    this.tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 };
    storage.set(TOKEN_KEY, this.tokens);
  }

  disconnect() {
    this.tokens = null;
    this.user = null;
    storage.remove(TOKEN_KEY);
  }

  async refresh() {
    const res = await fetch(`${this.server}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.tokens.refresh_token }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) this.disconnect();
      throw new Error('Your Logbook sign-in expired. Connect again.');
    }
    this.setTokens(await res.json());
  }

  async api(method, path, body) {
    if (!this.connected) throw new Error('Not connected to the Logbook.');
    if (Date.now() > this.tokens.expires_at - 60_000) await this.refresh();
    const call = () => fetch(`${this.server}/api/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.tokens.access_token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let res = await call();
    if (res.status === 401) { await this.refresh(); res = await call(); }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async me() {
    const { status, data } = await this.api('GET', 'users/me');
    if (status !== 200) throw new Error(data.message || `Logbook error ${status}`);
    this.user = data.data;
    return this.user;
  }

  // Past results of one machine type, newest first, normalized for suggested targets.
  async history({ type, days = 365, perPage = 250, maxPages = 8 } = {}) {
    const from = logbookDate(Date.now() - days * 86400000).slice(0, 10);
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({ from, number: String(perPage), page: String(page) });
      if (type) q.set('type', type);
      const { status, data } = await this.api('GET', `users/me/results?${q}`);
      if (status === 401 || status === 403) throw new Error('Reconnect the Logbook to allow reading your workout history.');
      if (status !== 200) throw new Error(data.message || `Logbook error ${status}`);
      for (const r of data.data ?? []) {
        const n = normalizeResult(r);
        if (n) out.push(n);
      }
      const p = data.meta?.pagination;
      if (!p || p.current_page >= p.total_pages) break;
    }
    return out.sort((a, b) => b.date - a.date);
  }

  // Returns { ok, duplicate, id } or throws with the Logbook's message.
  async upload(result) {
    const { status, data } = await this.api('POST', 'users/me/results', result);
    if (status === 200 || status === 201) return { ok: true, id: data.data?.id };
    if (status === 409) return { ok: true, duplicate: true };
    const details = data.errors ? Object.values(data.errors).flat().join(' ') : '';
    throw new Error(`${data.message || `Logbook error ${status}`}${details ? `: ${details}` : ''}`);
  }
}
