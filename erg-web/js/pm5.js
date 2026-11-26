import { u8, u16, u24 } from './bytes.js';

// Concept2 PM5 Bluetooth Smart interface. All UUIDs share one base:
// CE06xxxx-43E5-11E4-916C-0800200C9A66
const pmUuid = (short) => `ce06${short}-43e5-11e4-916c-0800200c9a66`;

export const PM5_UUIDS = {
  discoveryService: pmUuid('0000'),
  infoService: pmUuid('0010'),
  controlService: pmUuid('0020'),
  rowingService: pmUuid('0030'),
  generalStatus: pmUuid('0031'),
  additionalStatus: pmUuid('0032'),
  additionalStatus2: pmUuid('0033'),
  sampleRate: pmUuid('0034'),
  strokeData: pmUuid('0035'),
  additionalStrokeData: pmUuid('0036'),
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

// Concept2 pace-to-watts formula, used when the PM has not sent stroke power yet.
export const wattsFromSpeed = (speed) => (speed > 0 ? 2.8 * speed ** 3 : 0);

// Guess Row / Ski / Bike from the advertised name, e.g. "PM5 430012345 Row".
export function machineFromName(name = '') {
  const n = name.toLowerCase();
  if (n.includes('ski')) return 'ski';
  if (n.includes('bike')) return 'bikeerg';
  return 'rower';
}

const handlers = {
  [PM5_UUIDS.generalStatus]: (dv) => ({ distance: parseGeneralStatus(dv).distance }),
  [PM5_UUIDS.additionalStatus]: (dv) => {
    const s = parseAdditionalStatus(dv);
    return { speed: s.speed, cadence: s.strokeRate, heartRate: s.heartRate };
  },
  [PM5_UUIDS.additionalStrokeData]: (dv) => ({ power: parseAdditionalStrokeData(dv).power }),
};

export class PM5Device {
  constructor({ onData, onDisconnect }) {
    this.onData = onData;
    this.onDisconnect = onDisconnect;
    this.gotStrokePower = false;
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

    for (const [uuid, parse] of Object.entries(handlers)) {
      const ch = await rowing.getCharacteristic(uuid);
      ch.addEventListener('characteristicvaluechanged', (e) => this.handle(uuid, parse, e.target.value));
      await ch.startNotifications();
    }
    return this.device.name || 'Concept2 PM5';
  }

  handle(uuid, parse, dv) {
    let update;
    try {
      update = parse(dv);
    } catch {
      return; // short or malformed packet
    }
    if (uuid === PM5_UUIDS.additionalStrokeData) this.gotStrokePower = true;
    if (uuid === PM5_UUIDS.additionalStatus && !this.gotStrokePower) update.power = Math.round(wattsFromSpeed(update.speed));
    this.onData(update);
  }

  get machineGuess() {
    return machineFromName(this.device?.name);
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
