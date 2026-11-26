// Training plans. The Pete Plan follows Pete Marston's published plan (thepeteplan.wordpress.com):
// a three-week cycle of one speed-interval session, one endurance-interval session, one hard
// distance piece, steady distance on the other days and one rest day.

import { buildIntervals, describeWorkout } from './workout.js';

const piece = (m) => ({ type: 'work', kind: 'distance', value: m });
const rest = (s) => ({ type: 'rest', kind: 'time', value: s });

function ladder(distances, rests, name) {
  const segments = [];
  distances.forEach((d, i) => {
    segments.push(piece(d));
    if (i < distances.length - 1) segments.push(rest(rests[i]));
  });
  return { name, segments };
}

const intervals = (id, kind, build) => ({ id, kind, build });

const PETE_SESSIONS = {
  speed1: intervals('pete-8x500', 'speed', () => buildIntervals({ reps: 8, workKind: 'distance', workValue: 500, restSec: 210 })),
  speed2: intervals('pete-pyramid', 'speed', () =>
    // 1:30 rest per preceding 250m of work.
    ladder([250, 500, 750, 1000, 750, 500, 250], [90, 180, 270, 360, 270, 180], 'Pyramid 250m–1k–250m')),
  speed3: intervals('pete-4x1000', 'speed', () => buildIntervals({ reps: 4, workKind: 'distance', workValue: 1000, restSec: 300 })),
  endurance1: intervals('pete-5x1500', 'endurance', () => buildIntervals({ reps: 5, workKind: 'distance', workValue: 1500, restSec: 300 })),
  endurance2: intervals('pete-4x2000', 'endurance', () => buildIntervals({ reps: 4, workKind: 'distance', workValue: 2000, restSec: 300 })),
  endurance3: intervals('pete-3k-2.5k-2k', 'endurance', () => ladder([3000, 2500, 2000], [300, 300], '3k, 2.5k, 2k')),
  steady: { id: 'pete-steady', kind: 'steady', build: (o) => ({ name: `Steady ${(o.steadyDistance / 1000).toLocaleString('en-US')}k`, segments: [piece(o.steadyDistance)] }) },
  hard: { id: 'pete-hard', kind: 'hard', build: (o) => ({ name: `Hard ${(o.hardDistance / 1000).toLocaleString('en-US')}k`, segments: [piece(o.hardDistance)] }) },
  rest: { id: 'rest', kind: 'rest', build: null },
};

const week = (speed, endurance) => [speed, PETE_SESSIONS.steady, endurance, PETE_SESSIONS.steady, PETE_SESSIONS.hard, PETE_SESSIONS.steady, PETE_SESSIONS.rest];

export const PLANS = {
  pete: {
    id: 'pete',
    name: 'The Pete Plan',
    defaults: { steadyDistance: 10000, hardDistance: 5000 },
    weeks: [
      week(PETE_SESSIONS.speed1, PETE_SESSIONS.endurance1),
      week(PETE_SESSIONS.speed2, PETE_SESSIONS.endurance2),
      week(PETE_SESSIONS.speed3, PETE_SESSIONS.endurance3),
    ],
    notes: [
      'Steady days: 8–15k at 22–25 spm, at least 10 seconds per 500m slower than your endurance intervals.',
      'Intervals: hold your target on every rep but the last, then go as fast as you can. Your average becomes next time\'s target.',
      'First time through a session, set your target from what you could row the whole distance in as one piece.',
      'Take a full rest day every week.',
    ],
  },
};

export const planLength = (plan) => plan.weeks.reduce((n, w) => n + w.length, 0);

export function planDays(plan) {
  const days = [];
  plan.weeks.forEach((w, wi) => w.forEach((session, di) => days.push({ index: days.length, week: wi + 1, day: di + 1, session })));
  return days;
}

// Build the workout for one day of a plan. Interval sessions get the stored target pace on every
// rep but the last ("go as fast as you can on the final rep").
export function planWorkout(plan, dayIndex, progress = {}) {
  const day = planDays(plan)[dayIndex];
  const { session } = day;
  if (!session.build) return null;
  const options = { ...plan.defaults, ...progress.options };
  const w = session.build(options);
  const target = progress.targets?.[session.id] ?? null;
  const segments = w.segments.map((s) => ({ ...s }));
  if (target && (session.kind === 'speed' || session.kind === 'endurance')) {
    const workIdx = segments.map((s, i) => (s.type === 'work' ? i : -1)).filter((i) => i >= 0);
    workIdx.slice(0, -1).forEach((i) => { segments[i].targetPace = target; });
  }
  const name = w.name || describeWorkout(w);
  return {
    name: `${plan.name} W${day.week}D${day.day} · ${name}`,
    shortName: name,
    segments,
    plan: { planId: plan.id, dayIndex, sessionId: session.id, kind: session.kind },
  };
}

// Index of the next non-rest day after the last completed one.
export function nextDay(plan, progress = {}) {
  const days = planDays(plan);
  let i = progress.lastDone == null ? 0 : (progress.lastDone + 1) % days.length;
  for (let n = 0; n < days.length && !days[i].session.build; n++) i = (i + 1) % days.length;
  return i;
}

// Record a finished plan workout. Returns the new progress object.
export function recordPlanResult(plan, progress = {}, summary) {
  const p = { ...progress, targets: { ...progress.targets }, history: [...(progress.history ?? [])] };
  const info = summary.plan;
  const completedAll = summary.laps.every((l) => !l.partial);
  if (!completedAll) return p; // ended early: don't move the plan on or change targets
  if (p.lastDone != null && info.dayIndex < p.lastDone) p.cycle = (p.cycle ?? 1) + 1;
  p.cycle ??= 1;
  p.lastDone = info.dayIndex;
  if ((info.kind === 'speed' || info.kind === 'endurance') && summary.workPace) p.targets[info.sessionId] = Math.round(summary.workPace * 10) / 10;
  p.history.unshift({ dayIndex: info.dayIndex, cycle: p.cycle, date: summary.startTime, pace: summary.workPace });
  p.history = p.history.slice(0, 60);
  return p;
}
