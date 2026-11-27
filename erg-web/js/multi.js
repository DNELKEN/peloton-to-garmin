// Multi-erg workouts: circuits that cycle between machines, and ergathlons (one long leg per
// machine). Every segment names its machine. Between legs on different machines there is a
// transition: the clock keeps running, and the next leg starts when its machine starts moving.

import { formatTime, machineInfo } from './workout.js';

export const MULTI_MACHINES = ['rower', 'bikeerg', 'ski'];
export const SHORT_NAMES = { rower: 'Row', bikeerg: 'Bike', ski: 'Ski', bike: 'Bike' };

const isBike = (machine) => machineInfo(machine).paceUnit === 1000;

// BikeErg metres come about twice as fast as RowErg or SkiErg metres at the same effort.
export const matchedValue = (machine, kind, value, matchBike) => (matchBike && kind === 'distance' && isBike(machine) ? value * 2 : value);

const legText = ({ machine, kind, value }) => `${SHORT_NAMES[machine] ?? machine} ${kind === 'distance' ? `${value.toLocaleString('en-US')}m` : formatTime(value)}`;

// legs: [{ machine, kind: 'distance' | 'time', value, targetPace? }] in order.
export function buildMultiWorkout(legs, name) {
  const segments = [];
  legs.forEach((leg, i) => {
    if (i > 0 && legs[i - 1].machine !== leg.machine) segments.push({ type: 'transition', kind: 'open', value: 0, machine: leg.machine });
    segments.push({ type: 'work', kind: leg.kind, value: leg.value, machine: leg.machine, ...(leg.targetPace ? { targetPace: leg.targetPace } : {}) });
  });
  return { multi: true, name: name || legs.map(legText).join(' · '), segments };
}

// Circuit: the same leg on each machine in turn, for a number of rounds.
export function buildCircuit({ machines, rounds, kind, value, matchBike = true }) {
  if (!machines.length) throw new Error('Pick at least one machine.');
  if (!(rounds >= 1)) throw new Error('Rounds must be 1 or more.');
  if (!(value > 0)) throw new Error('Enter a distance or time for each leg.');
  const legs = [];
  for (let r = 0; r < rounds; r++) {
    for (const machine of machines) legs.push({ machine, kind, value: matchedValue(machine, kind, value, matchBike) });
  }
  const round = machines.map((machine) => legText({ machine, kind, value: matchedValue(machine, kind, value, matchBike) })).join(' / ');
  return buildMultiWorkout(legs, `Circuit ${rounds} × ${round}`);
}

// Ergathlon: one leg per machine, each with its own distance or time.
export function buildErgathlon(legs) {
  const used = legs.filter((l) => l.value > 0);
  if (!used.length) throw new Error('Enter a distance or time for at least one machine.');
  return buildMultiWorkout(used, `Ergathlon ${used.map(legText).join(' · ')}`);
}

// The machines a workout needs, in the order they are first used.
export function machinesIn(workout) {
  return [...new Set(workout.segments.map((s) => s.machine).filter(Boolean))];
}

// The next work leg on a given machine after segment index `from` (for loading the PM5 ahead).
export function nextLegOn(workout, machine, from = -1) {
  for (let i = from + 1; i < workout.segments.length; i++) {
    const s = workout.segments[i];
    if (s.type === 'work' && s.machine === machine) return { index: i, segment: s };
  }
  return null;
}

// The samples recorded during these legs, with distance counted on this machine only.
function legSamples(summary, legs) {
  const startDistance = new Map();
  let total = 0;
  for (const l of summary.laps) { startDistance.set(l, total); total += l.distance; }
  const out = [];
  let before = 0; // metres on this machine before the current leg
  for (const l of legs) {
    const base = startDistance.get(l) ?? 0;
    for (const s of summary.samples ?? []) {
      if (s.t >= l.startTime && s.t <= l.endTime) out.push({ ...s, distance: before + Math.max(0, s.distance - base) });
    }
    before += l.distance;
  }
  return out;
}

// Split a finished multi-erg summary into one summary per machine, for the Logbook. Legs on the
// same machine become intervals, with the time spent elsewhere counted as rest between them.
export function splitByMachine(summary) {
  const out = [];
  for (const machine of machinesIn({ segments: summary.laps })) {
    const legs = summary.laps.filter((l) => l.machine === machine && l.type === 'work' && l.duration > 0);
    if (!legs.length) continue;
    const laps = [];
    const segments = [];
    legs.forEach((l, i) => {
      laps.push({ ...l, index: laps.length });
      segments.push({ type: 'work', kind: l.kind, value: l.value });
      const next = legs[i + 1];
      if (next) {
        const gap = Math.max(0, (next.startTime - l.endTime) / 1000);
        laps.push({ index: laps.length, type: 'rest', kind: 'time', value: gap, machine, duration: gap, distance: 0, startTime: l.endTime, endTime: next.startTime });
        segments.push({ type: 'rest', kind: 'time', value: gap });
      }
    });
    const startTime = legs[0].startTime;
    const endTime = legs.at(-1).endTime;
    const time = legs.reduce((a, l) => a + l.duration, 0);
    const weighted = (key, base = time) => (base > 0 ? legs.reduce((a, l) => a + (l[key] ?? 0) * l.duration, 0) / base : null);
    const hrTime = legs.reduce((a, l) => a + (l.avgHr ? l.duration : 0), 0);
    out.push({
      machine,
      summary: {
        name: `${summary.name} (${SHORT_NAMES[machine] ?? machine})`,
        machine,
        startTime,
        endTime,
        elapsed: (endTime - startTime) / 1000,
        totalDistance: legs.reduce((a, l) => a + l.distance, 0),
        avgCadence: weighted('avgCadence'),
        avgPower: weighted('avgPower'),
        avgHr: hrTime ? Math.round(weighted('avgHr', hrTime)) : null,
        maxHr: Math.max(0, ...legs.map((l) => l.maxHr ?? 0)) || null,
        calories: legs.reduce((a, l) => a + (l.calories ?? 0), 0),
        cycles: legs.reduce((a, l) => a + (l.cycles ?? 0), 0),
        laps,
        samples: legSamples(summary, legs),
      },
      workout: { name: summary.name, segments },
    });
  }
  return out;
}
