import { WorkoutEngine } from '../js/workout.js';

// Drive an engine with a steady erg: device distance updates every 500 ms, ticks every 100 ms.
export function simulate(workout, { speed = 4, seconds = 600, restSpeed = 0, machine = 'rower', hr = 150, start = Date.UTC(2026, 10, 26, 12) } = {}) {
  let resting = false;
  const engine = new WorkoutEngine(workout, { machine, onSegmentChange: (seg) => { resting = seg.type === 'rest'; } });
  let distance = 0;
  for (let ms = 0; ms <= seconds * 1000 && engine.state !== 'finished'; ms += 100) {
    const now = start + ms;
    if (ms % 500 === 0) {
      const v = resting ? restSpeed : speed;
      engine.ingest({ distance, speed: v, cadence: v ? 24 : 0, power: Math.round(2.8 * v ** 3), heartRate: hr }, now);
      distance += v * 0.5;
    }
    engine.tick(now);
  }
  return engine;
}

