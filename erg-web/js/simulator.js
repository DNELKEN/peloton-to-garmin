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

  disconnect() {
    clearInterval(this.timer);
  }
}
