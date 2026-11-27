// Suggested targets from Concept2 Logbook history.
//
// Paces here are seconds per 500 m (the Logbook's native split) unless a name says otherwise.
// Predictions use Paul's Law: pace slows by about 5 s/500m each time the distance doubles.

const DAY = 86400000;
const PAUL_SEC_PER_DOUBLING = 5;
const RECENT_DAYS = 120;
const FALLBACK_DAYS = 365;
const MIN_PIECE_M = 500;
const SIMILAR_PACE_SEC = 3;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const close = (a, b, tol) => Math.abs(a - b) <= tol;

export const wattsAtPace500 = (pace) => (pace > 0 ? 2.8 / (pace / 500) ** 3 : 0);

// "2026-11-26 20:24:58" (local wall-clock) -> ms
export function parseLogbookDate(text) {
  const m = String(text ?? '').match(/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d):(\d\d))?/);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
}

// One Logbook result -> the compact shape used below (and kept in the browser).
export function normalizeResult(r) {
  const time = r.time / 10;
  const distance = r.distance;
  if (!(time > 0 && distance > 0)) return null;
  const reps = (r.workout?.intervals ?? [])
    .filter((i) => i.time > 0 && i.distance > 0)
    .map((i) => ({ distance: i.distance, time: i.time / 10, spm: i.stroke_rate || undefined, hr: i.heart_rate?.average || undefined }));
  const interval = /interval/i.test(r.workout_type ?? '') || r.rest_time > 0 || reps.length > 1;
  return {
    id: r.id,
    date: parseLogbookDate(r.date),
    type: r.type,
    workoutType: r.workout_type,
    distance,
    time,
    pace: (time / distance) * 500,
    spm: r.stroke_rate || undefined,
    hr: r.heart_rate?.average || undefined,
    interval,
    restTime: r.rest_time ? r.rest_time / 10 : 0,
    reps: interval ? reps : [],
  };
}

export const paulsLaw = (pace, fromDistance, toDistance) => pace + PAUL_SEC_PER_DOUBLING * Math.log2(toDistance / fromDistance);

function within(history, now, days) {
  return history.filter((h) => Number.isFinite(h.date) && now - h.date <= days * DAY && now >= h.date - DAY);
}

// Predicted steady pace for one continuous piece of `distance` metres.
export function predictDistance(history, distance, now = Date.now()) {
  const pieces = (h) => h.filter((x) => !x.interval && x.distance >= MIN_PIECE_M);
  let pool = pieces(within(history, now, RECENT_DAYS));
  if (!pool.length) pool = pieces(within(history, now, FALLBACK_DAYS));
  if (!pool.length) return null;
  const preds = pool.map((x) => paulsLaw(x.pace, x.distance, distance)).sort((a, b) => a - b);
  const best = preds.slice(0, 3);
  return { pace: mean(best), count: pool.length };
}

// Predicted pace for a piece of `seconds`, and the distance that pace covers.
export function predictTime(history, seconds, now = Date.now()) {
  let distance = (seconds * 500) / 120;
  let p = null;
  for (let i = 0; i < 8; i++) {
    p = predictDistance(history, distance, now);
    if (!p) return null;
    distance = (seconds * 500) / p.pace;
  }
  return { ...p, distance };
}

const predictSegment = (history, seg, now) => (seg.kind === 'distance' ? predictDistance(history, seg.value, now) : predictTime(history, seg.value, now));

// Past interval sessions with the same rep (same distance, or same time), most recent first.
function similarIntervals(history, seg, now) {
  return within(history, now, FALLBACK_DAYS)
    .filter((h) => h.interval && h.reps.length > 1 && h.reps.every((r) => (seg.kind === 'distance' ? close(r.distance, seg.value, seg.value * 0.01) : close(r.time, seg.value, 1))))
    .sort((a, b) => b.date - a.date);
}

// Typical stroke rate and heart rate when you rowed near this pace.
export function typicalAt(history, pace, now = Date.now()) {
  const points = within(history, now, FALLBACK_DAYS).flatMap((h) => (h.reps.length ? h.reps.map((r) => ({ ...r, pace: (r.time / r.distance) * 500 })) : [h]));
  const near = points.filter((p) => close(p.pace, pace, SIMILAR_PACE_SEC));
  const spm = mean(near.map((p) => p.spm).filter(Boolean));
  const hr = mean(near.map((p) => p.hr).filter(Boolean));
  return { spm: spm && Math.round(spm), hr: hr && Math.round(hr), samples: near.length };
}

// Suggested target pace for each work segment of a workout, plus what to expect at that pace.
// Returns null when there is nothing to base it on (no history, or an open "Just row").
export function suggestTargets(workout, history, { now = Date.now(), paceUnit = 500 } = {}) {
  const works = workout.segments.map((s, index) => ({ s, index })).filter(({ s }) => s.type === 'work');
  if (!history?.length || !works.length || works.some(({ s }) => s.kind === 'open')) return null;
  const rests = workout.segments.filter((s) => s.type === 'rest');
  const restSec = mean(rests.map((r) => r.value)) ?? 0;
  const n = works.length;

  let basis = 'model';
  let count = 0;
  const targets = [];
  for (const { s, index } of works) {
    let pace;
    if (n === 1) {
      const p = predictSegment(history, s, now);
      if (!p) return null;
      ({ pace, count } = p);
    } else {
      const similar = similarIntervals(history, s, now).slice(0, 3);
      if (similar.length) {
        basis = 'similar';
        count = similar.length;
        pace = mean(similar.map((h) => h.pace));
      } else {
        // Between the pace you could hold for one rep and for all the work in one go; the more
        // rest relative to the rep, the closer to the one-rep pace.
        const rep = predictSegment(history, s, now);
        if (!rep) return null;
        const repDistance = s.kind === 'distance' ? s.value : rep.distance;
        const all = predictDistance(history, repDistance * n, now);
        const repTime = (repDistance * rep.pace) / 500;
        const f = Math.min(1, restSec / (2 * repTime));
        pace = all.pace - f * (all.pace - rep.pace);
        count = rep.count;
      }
    }
    targets.push({ index, pace500: pace, pace: Math.round(pace * (paceUnit / 500) * 10) / 10 });
  }

  const avg500 = mean(targets.map((t) => t.pace500));
  const typical = typicalAt(history, avg500, now);
  return {
    targets,
    pace: Math.round(avg500 * (paceUnit / 500) * 10) / 10,
    watts: Math.round(wattsAtPace500(avg500)),
    spm: typical.spm,
    hr: typical.hr,
    basis,
    count,
  };
}

// Copy of the workout with the suggested target pace on each work segment.
export function applyTargets(workout, suggestion) {
  const segments = workout.segments.map((s, i) => {
    const t = suggestion.targets.find((x) => x.index === i);
    return t ? { ...s, targetPace: t.pace } : s;
  });
  return { ...workout, segments };
}
