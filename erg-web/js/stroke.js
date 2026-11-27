// Keeps the last few strokes for the live force panel: the force curves, and the latest stroke's
// length, drive and recovery times and forces (sent by the monitor once per stroke).

const HISTORY = 5; // curves kept for the faint trail behind the latest one

export class StrokeTracker {
  constructor() {
    this.curves = [];
    this.version = 0; // bumps whenever a new curve or stroke arrives
    this.stroke = null; // latest { driveLength, driveTime, recoveryTime, peakForce, avgForce }
  }

  ingest(update) {
    if (update.driveTime != null && update.driveTime > 0) {
      this.stroke = {
        driveLength: update.driveLength,
        driveTime: update.driveTime,
        recoveryTime: update.recoveryTime > 0 ? update.recoveryTime : this.stroke?.recoveryTime ?? update.driveTime * 2,
        peakForce: update.peakForce,
        avgForce: update.avgForce,
      };
      this.version += 1;
    }
    if (Array.isArray(update.forceCurve) && update.forceCurve.length >= 3) {
      this.curves = [...this.curves, update.forceCurve].slice(-HISTORY);
      this.version += 1;
    }
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
