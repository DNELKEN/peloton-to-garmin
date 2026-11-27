import { MACHINES } from './workout.js';

// A fake erg so the app can be tried and tested without hardware.
// Emits the same normalized updates as the Bluetooth devices, every 500 ms.
export class Simulator {
  constructor({ machine = 'rower', onData }) {
    this.machine = machine;
    this.onData = onData;
    this.effort = 1; // multiplier on base speed
    this.resting = false;
  }

  connect() {
    this.distance = 0;
    this.speed = 0;
    this.heartRate = 68;
    this.t = 0;
    this.timer = setInterval(() => this.step(0.5), 500);
    this.strokeCount = 0;
    this.strokeLoop();
    return 'Simulated erg';
  }

  setResting(resting) {
    this.resting = resting;
  }

  adjustEffort(delta) {
    this.effort = Math.min(1.6, Math.max(0.5, this.effort + delta));
  }

  step(dt) {
    const m = MACHINES[this.machine] ?? MACHINES.rower;
    this.t += dt;
    const target = this.resting
      ? 0
      : m.simSpeed * this.effort * (1 + 0.03 * Math.sin(this.t / 7) + (Math.random() - 0.5) * 0.03);
    // Speed eases toward the target rather than jumping.
    this.speed += (target - this.speed) * Math.min(1, dt * (this.resting ? 1.5 : 0.8));
    if (this.speed < 0.05) this.speed = 0;
    this.distance += this.speed * dt;

    const intensity = this.speed / m.simSpeed;
    const hrTarget = 68 + 105 * Math.min(1.3, intensity);
    this.heartRate += (hrTarget - this.heartRate) * (dt / 25);

    const power = Math.round(m.watts(this.speed));
    this.onData({
      distance: this.distance,
      speed: this.speed,
      cadence: this.speed > 0 ? Math.round(m.simCadence * (0.85 + 0.15 * this.effort)) : 0,
      power,
      heartRate: Math.round(this.heartRate),
    });
  }

  // Rowing machines also report each stroke: phase changes, drive and recovery times, and the
  // force curve at the end of the drive. Below 75% effort the curve gets a mid-drive dip, so the
  // technique note can be tried out.
  strokeLoop() {
    const m = MACHINES[this.machine] ?? MACHINES.rower;
    const spm = this.speed > 0.5 && !this.resting ? m.simCadence * (0.85 + 0.15 * this.effort) : 0;
    if (!spm || m.paceUnit !== 500) {
      this.onData({ strokeState: 0 });
      this.strokeTimer = setTimeout(() => this.strokeLoop(), 500);
      return;
    }
    const cycle = 60 / spm;
    const driveTime = Math.min(0.95, cycle * 0.34);
    const recoveryTime = cycle - driveTime;
    this.onData({ strokeState: 2 });
    this.strokeTimer = setTimeout(() => {
      const curve = simulatedCurve(this.speed, this.effort);
      this.strokeCount += 1;
      this.onData({
        strokeState: 4,
        driveLength: Math.round((1.38 + 0.06 * this.effort + (Math.random() - 0.5) * 0.04) * 100) / 100,
        driveTime: Math.round(driveTime * 100) / 100,
        recoveryTime: Math.round(recoveryTime * 100) / 100,
        peakForce: Math.max(...curve),
        avgForce: Math.round(curve.reduce((a, b) => a + b, 0) / curve.length),
        strokeCount: this.strokeCount,
        forceCurve: curve,
      });
      this.strokeTimer = setTimeout(() => this.strokeLoop(), recoveryTime * 1000);
    }, driveTime * 1000);
  }

  disconnect() {
    clearInterval(this.timer);
    clearTimeout(this.strokeTimer);
  }
}

// A plausible drive: quick rise, peak about 40% through, smooth fall. Force in lbs.
export function simulatedCurve(speed, effort, points = 32) {
  const peak = 60 + 45 * speed * effort;
  const dip = effort < 0.75;
  return Array.from({ length: points }, (_, i) => {
    const x = i / (points - 1);
    let f = Math.sin(Math.PI * x ** 0.85) ** 1.4;
    if (dip) f *= 1 - 0.35 * Math.exp(-(((x - 0.55) / 0.06) ** 2));
    return Math.max(0, Math.round(peak * f * (1 + (Math.random() - 0.5) * 0.04)));
  });
}
