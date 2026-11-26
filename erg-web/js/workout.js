// Workout definitions, formatting helpers and the engine that tracks a workout in progress.

const cubicWatts = (speed) => (speed > 0 ? 2.8 * speed ** 3 : 0);

// FIT sport / sub-sport codes: rowing=15/indoor_rowing=14, cycling=2/indoor_cycling=6,
// cross_country_skiing=12/generic=0.
export const MACHINES = {
  rower: { label: 'RowErg / rower', paceUnit: 500, cadenceUnit: 'spm', sport: 15, subSport: 14, simSpeed: 500 / 125, simCadence: 24, watts: cubicWatts },
  ski: { label: 'SkiErg', paceUnit: 500, cadenceUnit: 'spm', sport: 12, subSport: 0, simSpeed: 500 / 130, simCadence: 40, watts: cubicWatts },
  bikeerg: { label: 'BikeErg', paceUnit: 1000, cadenceUnit: 'rpm', sport: 2, subSport: 6, simSpeed: 1000 / 125, simCadence: 85, watts: (v) => cubicWatts(v / 2) },
  bike: { label: 'Smart bike (FTMS)', paceUnit: 1000, cadenceUnit: 'rpm', sport: 2, subSport: 6, simSpeed: 9, simCadence: 88, watts: (v) => cubicWatts(v / 2) },
};

export const machineInfo = (machine) => MACHINES[machine] ?? MACHINES.rower;

// ---------- formatting ----------

export function formatTime(sec, tenths = false) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const neg = sec < 0;
  let s = Math.abs(sec);
  if (!tenths) s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const secStr = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
  return (neg ? '-' : '') + body;
}

export const formatPace = (secPerUnit) => (secPerUnit == null ? '--:--' : formatTime(secPerUnit, true));

export const formatDistance = (m) => `${Math.floor(m).toLocaleString('en-US')} m`;

// "4:00" -> 240, "1:30.5" -> 90.5, "1:02:03" -> 3723, "90" -> 90
export function parseDuration(text) {
  const parts = String(text).trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

// ---------- workout definitions ----------

const work = (kind, value, extra = {}) => ({ type: 'work', kind, value, ...extra });
const rest = (value) => ({ type: 'rest', kind: 'time', value });

export function buildIntervals({ reps, workKind, workValue, restSec = 0, targetPace = null, name }) {
  const segments = [];
  for (let i = 0; i < reps; i++) {
    segments.push(work(workKind, workValue, targetPace ? { targetPace } : {}));
    if (restSec > 0 && i < reps - 1) segments.push(rest(restSec));
  }
  const w = { segments };
  w.name = name || describeWorkout(w);
  return w;
}

const segText = (s) => (s.kind === 'distance' ? `${s.value.toLocaleString('en-US')}m` : s.kind === 'time' ? formatTime(s.value) : 'Open');

export function describeWorkout(w) {
  const works = w.segments.filter((s) => s.type === 'work');
  const rests = w.segments.filter((s) => s.type === 'rest');
  if (works.length === 1 && !rests.length) return works[0].kind === 'open' ? 'Just row' : segText(works[0]);
  const same = works.every((s) => s.kind === works[0].kind && s.value === works[0].value);
  if (same) return `${works.length} × ${segText(works[0])}${rests.length ? ` / ${formatTime(rests[0].value)}r` : ''}`;
  return `${works.length} pieces`;
}

export const PRESETS = [
  { name: 'Just row', segments: [work('open', 0)] },
  { name: '2,000m test', segments: [work('distance', 2000)] },
  { name: '5,000m', segments: [work('distance', 5000)] },
  { name: '30 minutes', segments: [work('time', 1800)] },
  buildIntervals({ reps: 8, workKind: 'distance', workValue: 500, restSec: 60 }),
  buildIntervals({ reps: 4, workKind: 'distance', workValue: 1000, restSec: 180 }),
  buildIntervals({ reps: 6, workKind: 'time', workValue: 240, restSec: 90 }),
  buildIntervals({ reps: 10, workKind: 'time', workValue: 60, restSec: 60 }),
];

// ---------- engine ----------

const STALE_DATA_MS = 3000;
const STALE_HR_MS = 5000;
const MAX_DISTANCE_JUMP = 200; // metres; bigger jumps mean the monitor was reset

const newAcc = () => ({ time: 0, movingTime: 0, power: 0, cadence: 0, hr: 0, hrTime: 0, maxHr: 0, maxPower: 0, maxSpeed: 0, calories: 0, cycles: 0 });

export class WorkoutEngine {
  constructor(workout, { machine = 'rower', onSegmentChange = () => {}, onFinish = () => {} } = {}) {
    this.workout = workout;
    this.machine = machine;
    this.unit = machineInfo(machine).paceUnit;
    this.onSegmentChange = onSegmentChange;
    this.onFinish = onFinish;

    this.state = 'armed'; // armed -> running -> finished
    this.segIndex = 0;
    this.totalDistance = 0;
    this.calories = 0;
    this.live = { speed: 0, cadence: 0, power: 0, heartRate: null };
    this.lastDataAt = 0;
    this.lastHrAt = 0;
    this.lastDeviceDistance = null;
    this.useDeviceDistance = false;
    this.laps = [];
    this.samples = [];
    this.acc = newAcc();
    this.total = newAcc();
  }

  get segment() {
    return this.workout.segments[this.segIndex];
  }

  // Feed one normalized update from a device: any of distance, speed, cadence, power, heartRate.
  ingest(u, now) {
    if (this.state === 'finished') return;
    if (u.heartRate != null) { this.live.heartRate = u.heartRate; this.lastHrAt = now; }
    if (u.speed != null) this.live.speed = u.speed;
    if (u.cadence != null) this.live.cadence = u.cadence;
    if (u.power != null) this.live.power = u.power;
    if (u.speed != null || u.cadence != null || u.power != null || u.distance != null) this.lastDataAt = now;

    if (u.distance != null) {
      this.useDeviceDistance = true;
      const prev = this.lastDeviceDistance;
      const prevAt = this.lastDeviceAt ?? now;
      this.lastDeviceDistance = u.distance;
      this.lastDeviceAt = now;
      const d = prev == null ? 0 : u.distance - prev;
      if (d > 0 && d < MAX_DISTANCE_JUMP) {
        // Movement began somewhere after the previous reading; start the clock there.
        if (this.state === 'armed') this.begin(prevAt);
        this.addDistance(d, now);
      }
    } else if (this.state === 'armed' && u.speed > 0.5) {
      this.begin(now);
    }
  }

  // Call frequently (e.g. every 200 ms) to advance timed segments and record samples.
  tick(now) {
    if (this.state !== 'running') return;
    const dt = Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (now - this.lastDataAt > STALE_DATA_MS) Object.assign(this.live, { speed: 0, cadence: 0, power: 0 });
    if (this.lastHrAt && now - this.lastHrAt > STALE_HR_MS) this.live.heartRate = null;

    this.accumulate(dt);
    if (!this.useDeviceDistance && this.live.speed > 0) this.addDistance(this.live.speed * dt, now);
    if (this.state !== 'running') return;

    if (now - (this.lastSampleAt ?? 0) >= 1000) {
      this.lastSampleAt = now;
      this.samples.push({ t: now, distance: this.totalDistance, speed: this.live.speed, power: this.live.power, cadence: this.live.cadence, heartRate: this.live.heartRate });
    }

    const seg = this.segment;
    if (seg.kind === 'time' && now - this.segStartTime >= seg.value * 1000) this.completeSegment(this.segStartTime + seg.value * 1000);
  }

  startNow(now) {
    if (this.state === 'armed') this.begin(now);
  }

  // End early (or end an open "Just row"). The current segment becomes a partial lap.
  end(now) {
    if (this.state === 'armed') { this.state = 'finished'; return null; }
    if (this.state !== 'running') return null;
    this.tick(now);
    if (this.state === 'running') {
      this.completeSegment(now, this.totalDistance, true);
      if (this.state === 'running') this.finish(now);
    }
    return this.summary();
  }

  begin(now) {
    this.state = 'running';
    this.startTime = now;
    this.lastTick = now;
    this.lastDistanceAt = now;
    this.segStartTime = now;
    this.segStartDistance = this.totalDistance;
    this.onSegmentChange(this.segment, 0);
  }

  accumulate(dt) {
    const { speed, cadence, power, heartRate } = this.live;
    const kcal = power > 0 ? ((4 * power + 300) / 3600) * dt : 0; // Concept2 calorie formula
    for (const a of [this.acc, this.total]) {
      a.time += dt;
      a.power += power * dt;
      if (speed > 0) { a.movingTime += dt; a.cadence += cadence * dt; }
      if (heartRate) { a.hr += heartRate * dt; a.hrTime += dt; a.maxHr = Math.max(a.maxHr, heartRate); }
      a.maxPower = Math.max(a.maxPower, power);
      a.maxSpeed = Math.max(a.maxSpeed, speed);
      a.calories += kcal;
      a.cycles += (cadence / 60) * dt;
    }
    this.calories = this.total.calories;
  }

  addDistance(d, now) {
    const before = this.totalDistance;
    this.totalDistance += d;
    const seg = this.segment;
    if (seg.kind === 'distance') {
      const target = this.segStartDistance + seg.value;
      if (this.totalDistance >= target) {
        // Interpolate the moment the target was crossed between the last two readings.
        const frac = (target - before) / d;
        const finishAt = this.lastDistanceAt + frac * (now - this.lastDistanceAt);
        this.completeSegment(finishAt, target);
      }
    }
    this.lastDistanceAt = now;
  }

  completeSegment(endTime, endDistance = this.totalDistance, partial = false) {
    const seg = this.segment;
    const a = this.acc;
    const duration = Math.max(0, (endTime - this.segStartTime) / 1000);
    const distance = Math.max(0, endDistance - this.segStartDistance);
    this.laps.push({
      index: this.laps.length,
      type: seg.type,
      kind: seg.kind,
      value: seg.value,
      targetPace: seg.targetPace ?? null,
      partial,
      startTime: this.segStartTime,
      endTime,
      duration,
      distance,
      pace: distance > 0 ? (duration / distance) * this.unit : null,
      avgSpeed: duration > 0 ? distance / duration : 0,
      maxSpeed: a.maxSpeed,
      avgPower: a.time ? Math.round(a.power / a.time) : 0,
      maxPower: Math.round(a.maxPower),
      avgCadence: a.movingTime ? Math.round(a.cadence / a.movingTime) : 0,
      avgHr: a.hrTime ? Math.round(a.hr / a.hrTime) : null,
      maxHr: a.maxHr || null,
      calories: Math.round(a.calories),
      cycles: Math.round(a.cycles),
    });
    this.acc = newAcc();
    this.segIndex++;
    if (this.segIndex >= this.workout.segments.length) {
      this.finish(endTime);
    } else {
      this.segStartTime = endTime;
      this.segStartDistance = endDistance;
      this.onSegmentChange(this.segment, this.segIndex);
    }
  }

  finish(endTime) {
    this.state = 'finished';
    this.endTime = endTime;
    this.segIndex = Math.min(this.segIndex, this.workout.segments.length - 1);
    this.onFinish(this.summary());
  }

  summary() {
    const t = this.total;
    const workLaps = this.laps.filter((l) => l.type === 'work');
    const workTime = workLaps.reduce((s, l) => s + l.duration, 0);
    const workDistance = workLaps.reduce((s, l) => s + l.distance, 0);
    return {
      name: this.workout.name,
      machine: this.machine,
      startTime: this.startTime,
      endTime: this.endTime,
      elapsed: (this.endTime - this.startTime) / 1000,
      totalDistance: this.totalDistance,
      workTime,
      workDistance,
      workPace: workDistance > 0 ? (workTime / workDistance) * this.unit : null,
      avgPower: t.time ? Math.round(t.power / t.time) : 0,
      maxPower: Math.round(t.maxPower),
      avgCadence: t.movingTime ? Math.round(t.cadence / t.movingTime) : 0,
      avgHr: t.hrTime ? Math.round(t.hr / t.hrTime) : null,
      maxHr: t.maxHr || null,
      maxSpeed: t.maxSpeed,
      calories: Math.round(t.calories),
      cycles: Math.round(t.cycles),
      laps: this.laps,
      samples: this.samples,
    };
  }

  // Everything the workout screen needs, already computed.
  view(now) {
    const seg = this.segment;
    const running = this.state === 'running';
    const segElapsed = running ? (now - this.segStartTime) / 1000 : 0;
    const segDistance = running ? this.totalDistance - this.segStartDistance : 0;
    const { speed } = this.live;

    let remaining = null;
    let progress = null;
    let projected = null;
    if (seg.kind === 'distance') {
      remaining = Math.max(0, seg.value - segDistance);
      progress = segDistance / seg.value;
      if (speed > 0.3) projected = segElapsed + remaining / speed; // finish time
    } else if (seg.kind === 'time') {
      remaining = Math.max(0, seg.value - segElapsed);
      progress = segElapsed / seg.value;
      projected = segDistance + speed * remaining; // finish distance
    }

    const segPace = segDistance > 5 ? (segElapsed / segDistance) * this.unit : null;
    const works = this.workout.segments.filter((s) => s.type === 'work').length;
    const workNumber = this.workout.segments.slice(0, this.segIndex + 1).filter((s) => s.type === 'work').length;

    return {
      state: this.state,
      seg,
      segIndex: this.segIndex,
      workNumber,
      works,
      next: this.workout.segments[this.segIndex + 1] ?? null,
      segElapsed,
      segDistance,
      remaining,
      progress: progress == null ? null : Math.min(1, progress),
      projected,
      pace: speed > 0.3 ? this.unit / speed : null,
      segPace,
      targetDelta: seg.targetPace && segPace ? segPace - seg.targetPace : null,
      cadence: this.live.cadence,
      power: this.live.power,
      heartRate: this.live.heartRate,
      totalDistance: this.totalDistance,
      totalElapsed: running ? (now - this.startTime) / 1000 : 0,
      calories: this.calories,
    };
  }
}
