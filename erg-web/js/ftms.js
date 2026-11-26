import { u8, u16, s16, u24 } from './bytes.js';

// Bluetooth Fitness Machine Service (FTMS, 0x1826): used by WaterRower S4 (with ComModule),
// RP3, many Rogue/generic rowers and most smart bikes.

const ROWER_DATA = 0x2ad1;
const INDOOR_BIKE_DATA = 0x2ad2;

// Wraps a parser so a truncated packet returns whatever fields were read before the end.
const tolerant = (fn) => (dv) => {
  const out = {};
  try {
    fn(dv, out);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return out;
};

export const parseRowerData = tolerant((dv, r) => {
  const f = u16(dv, 0);
  let o = 2;
  if (!(f & 0x0001)) { r.cadence = u8(dv, o) / 2; r.strokeCount = u16(dv, o + 1); o += 3; }
  if (f & 0x0002) o += 1; // average stroke rate
  if (f & 0x0004) { r.distance = u24(dv, o); o += 3; }
  if (f & 0x0008) { const p = u16(dv, o); if (p > 0 && p < 0xffff) { r.pace = p; r.speed = 500 / p; } o += 2; }
  if (f & 0x0010) o += 2; // average pace
  if (f & 0x0020) { r.power = Math.max(0, s16(dv, o)); o += 2; }
  if (f & 0x0040) o += 2; // average power
  if (f & 0x0080) o += 2; // resistance level
  if (f & 0x0100) { const c = u16(dv, o); if (c !== 0xffff) r.calories = c; o += 5; }
  if (f & 0x0200) { const h = u8(dv, o); if (h > 0) r.heartRate = h; o += 1; }
  if (f & 0x0400) o += 1; // metabolic equivalent
  if (f & 0x0800) { r.elapsed = u16(dv, o); o += 2; }
  if (f & 0x1000) o += 2; // remaining time
});

export const parseIndoorBikeData = tolerant((dv, r) => {
  const f = u16(dv, 0);
  let o = 2;
  if (!(f & 0x0001)) { r.speed = u16(dv, o) / 100 / 3.6; o += 2; }
  if (f & 0x0002) o += 2; // average speed
  if (f & 0x0004) { r.cadence = u16(dv, o) / 2; o += 2; }
  if (f & 0x0008) o += 2; // average cadence
  if (f & 0x0010) { r.distance = u24(dv, o); o += 3; }
  if (f & 0x0020) o += 2; // resistance level
  if (f & 0x0040) { r.power = Math.max(0, s16(dv, o)); o += 2; }
  if (f & 0x0080) o += 2; // average power
  if (f & 0x0100) { const c = u16(dv, o); if (c !== 0xffff) r.calories = c; o += 5; }
  if (f & 0x0200) { const h = u8(dv, o); if (h > 0) r.heartRate = h; o += 1; }
  if (f & 0x0400) o += 1;
  if (f & 0x0800) { r.elapsed = u16(dv, o); o += 2; }
  if (f & 0x1000) o += 2;
});

export class FtmsDevice {
  constructor({ onData, onDisconnect }) {
    this.onData = onData;
    this.onDisconnect = onDisconnect;
    this.machineGuess = 'rower';
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['fitness_machine'] }] });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService('fitness_machine');

    const candidates = [
      [ROWER_DATA, parseRowerData, 'rower'],
      [INDOOR_BIKE_DATA, parseIndoorBikeData, 'bike'],
    ];
    for (const [uuid, parse, machine] of candidates) {
      let ch;
      try {
        ch = await service.getCharacteristic(uuid);
      } catch {
        continue;
      }
      ch.addEventListener('characteristicvaluechanged', (e) => this.onData(parse(e.target.value)));
      await ch.startNotifications();
      this.machineGuess = machine;
      return this.device.name || 'Fitness machine';
    }
    throw new Error('This machine does not report rower or bike data over FTMS.');
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
