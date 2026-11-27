import { STROKE_STATE } from './pm5.js';

// Keeps track of the stroke cycle for the live force panel and the rower figure.
//
// The monitor tells us two things: its stroke state (driving or recovering, about twice a second)
// and, once per stroke at the end of the drive, the stroke's drive and recovery times and its
// force curve. Status updates are too slow to animate from directly, so we anchor on the moment
// a phase starts and then run the cycle forward on the measured times until the next anchor.

const HISTORY = 5; // curves kept for the faint trail behind the latest one
const IDLE_AFTER_CYCLES = 2; // stop animating after this many strokes with no news

export class StrokeTracker {
  constructor() {
    this.curves = [];
    this.version = 0; // bumps whenever a new curve or stroke arrives
    this.stroke = null; // latest { driveLength, driveTime, recoveryTime, peakForce, avgForce }
    this.anchor = null; // { phase: 'drive' | 'recovery', at }
    this.strokeState = null;
  }

  ingest(update, now) {
    if (update.strokeState != null) {
      const prev = this.strokeState;
      const next = update.strokeState;
      this.strokeState = next;
      if (next === STROKE_STATE.driving && prev !== STROKE_STATE.driving) this.anchor = { phase: 'drive', at: now };
      else if (isRecovery(next) && !isRecovery(prev) && prev != null) this.anchor = { phase: 'recovery', at: now };
    }
    if (update.driveTime != null && update.driveTime > 0) {
      this.stroke = {
        driveLength: update.driveLength,
        driveTime: update.driveTime,
        recoveryTime: update.recoveryTime > 0 ? update.recoveryTime : this.stroke?.recoveryTime ?? update.driveTime * 2,
        peakForce: update.peakForce,
        avgForce: update.avgForce,
      };
      // Stroke data is sent as the drive finishes, so the recovery is starting now.
      this.anchor = { phase: 'recovery', at: now };
      this.version += 1;
    }
    if (Array.isArray(update.forceCurve) && update.forceCurve.length >= 3) {
      this.curves = [...this.curves, update.forceCurve].slice(-HISTORY);
      this.version += 1;
    }
  }

  // Where in the stroke the athlete is at `now`: { phase: 'drive' | 'recovery' | 'idle', t: 0..1 }.
  phaseAt(now) {
    if (!this.anchor || !this.stroke) return { phase: 'idle', t: 0 };
    const drive = this.stroke.driveTime * 1000;
    const recovery = this.stroke.recoveryTime * 1000;
    const cycle = drive + recovery;
    let since = now - this.anchor.at;
    if (since < 0 || since > cycle * IDLE_AFTER_CYCLES) return { phase: 'idle', t: 0 };
    // Measure from the start of the drive, then fold into one cycle.
    if (this.anchor.phase === 'recovery') since += drive;
    const into = since % cycle;
    return into < drive ? { phase: 'drive', t: into / drive } : { phase: 'recovery', t: (into - drive) / recovery };
  }

  get latestCurve() {
    return this.curves.at(-1) ?? null;
  }

  // Drive to recovery ratio, e.g. 2.1 for "1 : 2.1". Coaches aim for about 1 : 2 at steady rates.
  get ratio() {
    const s = this.stroke;
    return s && s.driveTime > 0 ? s.recoveryTime / s.driveTime : null;
  }

  // The technique note to show, if the last few curves agree on one.
  get hint() {
    const recent = this.curves.slice(-3).map((c) => analyzeCurve(c).hint);
    if (recent.length < 3) return null;
    return recent.every((h) => h && h.id === recent[0].id) ? recent[0] : null;
  }
}

const isRecovery = (s) => s === STROKE_STATE.dwelling || s === STROKE_STATE.recovery;

// Read the shape of one force curve. A good rowing curve rises quickly, peaks around the first
// third to half of the drive and comes down smoothly, with no dip in the middle.
export function analyzeCurve(forces) {
  if (!forces || forces.length < 3) return { peakAt: null, hint: null };
  const n = forces.length;
  const max = Math.max(...forces);
  const peakIndex = forces.indexOf(max);
  const peakAt = peakIndex / (n - 1);
  if (max <= 0) return { peakAt, hint: null };

  // A dip: somewhere in the middle of the drive the force falls well below what came before
  // and recovers again after, which usually means the legs, back and arms are not connected.
  for (let i = Math.floor(n * 0.2); i <= Math.ceil(n * 0.8) && i < n - 1; i++) {
    const before = Math.max(...forces.slice(0, i));
    const after = Math.max(...forces.slice(i + 1));
    if (forces[i] < 0.85 * Math.min(before, after) && Math.min(before, after) > 0.5 * max) {
      return { peakAt, hint: HINTS.dip };
    }
  }
  if (peakAt > 0.6) return { peakAt, hint: HINTS.late };
  if (peakAt < 0.2) return { peakAt, hint: HINTS.early };
  return { peakAt, hint: null };
}

export const HINTS = {
  dip: { id: 'dip', text: 'Dip in the middle of the drive. Keep the legs pushing as the back opens, then add the arms.' },
  late: { id: 'late', text: 'Peak force comes late. Push hard with the legs right from the catch.' },
  early: { id: 'early', text: 'Peak force comes very early. Keep the push going through the whole drive.' },
};
