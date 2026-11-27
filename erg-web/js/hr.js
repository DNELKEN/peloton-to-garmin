import { u8, u16 } from './bytes.js';

// Standard Bluetooth Heart Rate Measurement (0x2A37).
export function parseHeartRate(dv) {
  const flags = u8(dv, 0);
  const hr = flags & 0x01 ? u16(dv, 1) : u8(dv, 1);
  return hr > 0 ? { heartRate: hr } : {};
}

export class HeartRateDevice {
  constructor({ onData, onDisconnect }) {
    this.onData = onData;
    this.onDisconnect = onDisconnect;
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const ch = await service.getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', (e) => this.onData(parseHeartRate(e.target.value)));
    await ch.startNotifications();
    return this.device.name || 'Heart rate monitor';
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
