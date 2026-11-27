import { u8, u16, u24 } from './bytes.js';
import { buildFrame, parseFrame, FRAME_STOP } from './csafe.js';
import { workoutToFrames, terminateFrame } from './pm5-workouts.js';

// Concept2 PM5 Bluetooth Smart interface. All UUIDs share one base:
// CE06xxxx-43E5-11E4-916C-0800200C9A66
const pmUuid = (short) => `ce06${short}-43e5-11e4-916c-0800200c9a66`;

export const PM5_UUIDS = {
  discoveryService: pmUuid('0000'),
  infoService: pmUuid('0010'),
  controlService: pmUuid('0020'),
  controlTransmit: pmUuid('0021'), // app -> PM
  controlReceive: pmUuid('0022'), // PM -> app
  rowingService: pmUuid('0030'),
  generalStatus: pmUuid('0031'),
  additionalStatus: pmUuid('0032'),
  additionalStatus2: pmUuid('0033'),
  sampleRate: pmUuid('0034'),
  strokeData: pmUuid('0035'),
  additionalStrokeData: pmUuid('0036'),
  forceCurve: pmUuid('003d'),
};

// 0x0031 General Status
export function parseGeneralStatus(dv) {
  return {
    elapsed: u24(dv, 0) / 100,
    distance: u24(dv, 3) / 10,
    workoutType: u8(dv, 6),
    intervalType: u8(dv, 7),
    workoutState: u8(dv, 8),
    rowingState: u8(dv, 9),
    strokeState: u8(dv, 10),
    dragFactor: dv.byteLength > 18 ? u8(dv, 18) : undefined,
  };
}

// 0x0032 Additional Status
export function parseAdditionalStatus(dv) {
  const hr = u8(dv, 6);
  return {
    elapsed: u24(dv, 0) / 100,
    speed: u16(dv, 3) / 1000, // m/s
    strokeRate: u8(dv, 5),
    heartRate: hr === 0 || hr === 255 ? undefined : hr,
    pace: u16(dv, 7) / 100, // s per 500 m
    avgPace: u16(dv, 9) / 100,
  };
}

// 0x0033 Additional Status 2
export function parseAdditionalStatus2(dv) {
  return {
    elapsed: u24(dv, 0) / 100,
    intervalCount: u8(dv, 3),
    avgPower: u16(dv, 4),
    calories: u16(dv, 6),
  };
}

// 0x0035 Stroke Data
export function parseStrokeData(dv) {
  return {
    elapsed: u24(dv, 0) / 100,
    distance: u24(dv, 3) / 10,
    driveLength: u8(dv, 6) / 100, // m
    driveTime: u8(dv, 7) / 100, // s
    recoveryTime: u16(dv, 8) / 100, // s
    strokeDistance: u16(dv, 10) / 100, // m
    peakForce: u16(dv, 12) / 10, // lbs
    avgForce: u16(dv, 14) / 10, // lbs
    workPerStroke: u16(dv, 16) / 10, // J
    strokeCount: u16(dv, 18),
  };
}

// 0x0036 Additional Stroke Data
export function parseAdditionalStrokeData(dv) {
  return {
    elapsed: u24(dv, 0) / 100,
    power: u16(dv, 3), // W
    strokeCalories: u16(dv, 5), // cal/hr
    strokeCount: u16(dv, 7),
  };
}

// 0x003D Force Curve. One stroke's curve arrives over several notifications. Byte 0: high nibble
// = notifications for this stroke, low nibble = 16-bit force words in this one. Byte 1 = sequence
// number. Then the words, little-endian, in lbs. Feed every notification to push(); it returns the
// whole curve once the last piece is in, and null otherwise.
export class ForceCurveAssembler {
  constructor() {
    this.reset();
  }

  reset() {
    this.points = [];
    this.received = 0;
    this.expected = 0;
    this.lastSeq = null;
  }

  push(dv) {
    const head = u8(dv, 0);
    const packets = head >> 4;
    const words = head & 0x0f;
    const seq = u8(dv, 1);
    if (!packets || 2 + words * 2 > dv.byteLength) { this.reset(); return null; }
    // A dropped or out-of-order packet spoils this stroke; start over from the next one.
    const gap = this.lastSeq != null && seq !== ((this.lastSeq + 1) & 0xff);
    if (this.received && (gap || packets !== this.expected)) this.reset();
    this.lastSeq = seq;
    this.expected = packets;
    for (let i = 0; i < words; i++) this.points.push(u16(dv, 2 + i * 2));
    this.received += 1;
    if (this.received < this.expected) return null;
    const curve = this.points;
    this.reset();
    this.lastSeq = seq;
    return curve.length >= 3 ? curve : null;
  }
}

// PM5 workout states (General Status byte 8). 1-9 are the "in a workout" states: rowing, and
// the countdown, rest and work phases of intervals. 10 = workout end, 11 = terminated (Menu
// pressed mid-workout), 12 = logged, 13 = rearm, 0 = waiting to begin.
export const isActiveWorkoutState = (s) => s != null && s >= 1 && s <= 9;

// True when the monitor has just left a workout, whether it finished or the rower pressed Menu.
export const pmWorkoutEnded = (prev, next) => isActiveWorkoutState(prev) && !isActiveWorkoutState(next);

// Concept2 pace-to-watts formula, used when the PM has not sent stroke power yet.
export const wattsFromSpeed = (speed) => (speed > 0 ? 2.8 * speed ** 3 : 0);

// Guess Row / Ski / Bike from the advertised name, e.g. "PM5 430012345 Row".
export function machineFromName(name = '') {
  const n = name.toLowerCase();
  if (n.includes('ski')) return 'ski';
  if (n.includes('bike')) return 'bikeerg';
  return 'rower';
}

export const PM5_HANDLERS = {
  [PM5_UUIDS.generalStatus]: (dv) => {
    const s = parseGeneralStatus(dv);
    return { distance: s.distance, pmWorkoutType: s.workoutType, pmWorkoutState: s.workoutState };
  },
  [PM5_UUIDS.additionalStatus]: (dv) => {
    const s = parseAdditionalStatus(dv);
    return { speed: s.speed, cadence: s.strokeRate, heartRate: s.heartRate };
  },
  [PM5_UUIDS.additionalStrokeData]: (dv) => ({ power: parseAdditionalStrokeData(dv).power }),
  // Once per stroke, at the end of the drive.
  [PM5_UUIDS.strokeData]: (dv) => {
    const s = parseStrokeData(dv);
    return {
      driveLength: s.driveLength,
      driveTime: s.driveTime,
      recoveryTime: s.recoveryTime,
      peakForce: s.peakForce,
      avgForce: s.avgForce,
      strokeCount: s.strokeCount,
    };
  },
};

// Older monitor firmware may not offer these; the workout still runs without them.
const OPTIONAL = new Set([PM5_UUIDS.strokeData, PM5_UUIDS.forceCurve]);

export class PM5Device {
  constructor({ onData, onDisconnect, onWorkoutEnd }) {
    this.onData = onData;
    this.onDisconnect = onDisconnect;
    this.onWorkoutEnd = onWorkoutEnd;
    this.gotStrokePower = false;
    this.curve = new ForceCurveAssembler();
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [PM5_UUIDS.discoveryService] }, { namePrefix: 'PM5' }],
      optionalServices: [PM5_UUIDS.infoService, PM5_UUIDS.controlService, PM5_UUIDS.rowingService],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
    const server = await this.device.gatt.connect();
    const rowing = await server.getPrimaryService(PM5_UUIDS.rowingService);

    // Ask for updates every 500 ms (0=1s, 1=500ms, 2=250ms, 3=100ms). Not fatal if refused.
    try {
      const rate = await rowing.getCharacteristic(PM5_UUIDS.sampleRate);
      await rate.writeValue(Uint8Array.of(1));
    } catch { /* keep default rate */ }

    try {
      const control = await server.getPrimaryService(PM5_UUIDS.controlService);
      this.tx = await control.getCharacteristic(PM5_UUIDS.controlTransmit);
      const rx = await control.getCharacteristic(PM5_UUIDS.controlReceive);
      rx.addEventListener('characteristicvaluechanged', (e) => this.onControlData(e.target.value));
      await rx.startNotifications();
    } catch {
      this.tx = null; // monitor still streams data; workouts just can't be loaded
    }

    const subscriptions = [...Object.entries(PM5_HANDLERS), [PM5_UUIDS.forceCurve, (dv) => this.parseForceCurve(dv)]];
    for (const [uuid, parse] of subscriptions) {
      try {
        const ch = await rowing.getCharacteristic(uuid);
        ch.addEventListener('characteristicvaluechanged', (e) => this.handle(uuid, parse, e.target.value));
        await ch.startNotifications();
      } catch (err) {
        if (!OPTIONAL.has(uuid)) throw err;
      }
    }
    return this.device.name || 'Concept2 PM5';
  }

  parseForceCurve(dv) {
    const curve = this.curve.push(dv);
    return curve ? { forceCurve: curve } : null;
  }

  handle(uuid, parse, dv) {
    let update;
    try {
      update = parse(dv);
    } catch {
      return; // short or malformed packet
    }
    if (!update) return; // partial force curve
    let ended = false;
    if (uuid === PM5_UUIDS.generalStatus) {
      ended = pmWorkoutEnded(this.status?.workoutState, update.pmWorkoutState);
      this.status = { workoutType: update.pmWorkoutType, workoutState: update.pmWorkoutState, at: Date.now() };
      delete update.pmWorkoutType;
      delete update.pmWorkoutState;
    }
    if (uuid === PM5_UUIDS.additionalStrokeData) this.gotStrokePower = true;
    if (uuid === PM5_UUIDS.additionalStatus && !this.gotStrokePower) update.power = Math.round(wattsFromSpeed(update.speed));
    this.onData(update);
    if (ended) this.onWorkoutEnd?.(this.status.workoutState);
  }

  get canProgram() {
    return !!this.tx;
  }

  // ---- CSAFE control channel ----

  onControlData(dv) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    this.rxBuffer = [...(this.rxBuffer ?? []), ...bytes];
    const end = this.rxBuffer.indexOf(FRAME_STOP);
    if (end < 0) return;
    const frame = this.rxBuffer.slice(0, end + 1);
    this.rxBuffer = this.rxBuffer.slice(end + 1);
    const waiter = this.waiter;
    this.waiter = null;
    try {
      waiter?.resolve(parseFrame(frame));
    } catch (err) {
      waiter?.resolve({ previousFrame: 'unreadable', error: err.message });
    }
  }

  // Send one CSAFE frame (in 20-byte BLE packets) and wait for the PM's reply.
  async sendFrame(contents, timeoutMs = 2000) {
    if (!this.tx) throw new Error('This monitor does not accept commands over Bluetooth.');
    const frame = buildFrame(contents);
    this.rxBuffer = [];
    const reply = new Promise((resolve) => {
      this.waiter = { resolve };
      setTimeout(() => {
        if (this.waiter?.resolve === resolve) { this.waiter = null; resolve(null); }
      }, timeoutMs);
    });
    for (let i = 0; i < frame.length; i += 20) {
      const chunk = frame.slice(i, i + 20);
      await (this.tx.writeValueWithResponse ? this.tx.writeValueWithResponse(chunk) : this.tx.writeValue(chunk));
    }
    const res = await reply;
    if (res && (res.previousFrame === 'rejected' || res.previousFrame === 'not ready')) {
      throw new Error(`The PM5 ${res.previousFrame === 'rejected' ? 'rejected' : 'was not ready for'} the workout. Go back to the PM5 main menu and try again.`);
    }
    return res;
  }

  // Whether the monitor is in the middle of a workout (anything between first stroke and the end).
  get workoutInProgress() {
    return isActiveWorkoutState(this.status?.workoutState);
  }

  // Load a workout onto the monitor. Resolves { verified } once the PM reports the new workout type.
  async programWorkout(workout, { terminateFirst = false, sendTargets = true } = {}) {
    const { frames, workoutType } = workoutToFrames(workout, { sendTargets });
    if (terminateFirst) {
      await this.sendFrame(terminateFrame());
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const f of frames) await this.sendFrame(f);
    // The rowing service reports the active workout type about twice a second.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (this.status?.workoutType === workoutType && this.status.workoutState === 0) return { verified: true };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { verified: false };
  }

  get machineGuess() {
    return machineFromName(this.device?.name);
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
