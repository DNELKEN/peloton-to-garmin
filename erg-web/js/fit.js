// Minimal FIT activity-file encoder (records, laps, session, activity) for Garmin Connect,
// Strava, TrainingPeaks, intervals.icu and friends.
import { machineInfo } from './workout.js';

const FIT_EPOCH_OFFSET = 631065600; // seconds between 1970-01-01 and 1989-12-31
export const toFitTime = (ms) => Math.round(ms / 1000) - FIT_EPOCH_OFFSET;

const TYPES = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff },
  uint32z: { id: 0x8c, size: 4, invalid: 0 },
};

// [field number, base type, scale]
const MESSAGES = {
  file_id: { num: 0, fields: { type: [0, 'enum'], manufacturer: [1, 'uint16'], product: [2, 'uint16'], serial_number: [3, 'uint32z'], time_created: [4, 'uint32'] } },
  device_info: { num: 23, fields: { timestamp: [253, 'uint32'], device_index: [0, 'uint8'], manufacturer: [2, 'uint16'], serial_number: [3, 'uint32z'], product: [4, 'uint16'], software_version: [5, 'uint16', 100] } },
  event: { num: 21, fields: { timestamp: [253, 'uint32'], event: [0, 'enum'], event_type: [1, 'enum'] } },
  record: { num: 20, fields: { timestamp: [253, 'uint32'], heart_rate: [3, 'uint8'], cadence: [4, 'uint8'], distance: [5, 'uint32', 100], speed: [6, 'uint16', 1000], power: [7, 'uint16'] } },
  lap: {
    num: 19,
    fields: {
      message_index: [254, 'uint16'], timestamp: [253, 'uint32'], event: [0, 'enum'], event_type: [1, 'enum'], start_time: [2, 'uint32'],
      total_elapsed_time: [7, 'uint32', 1000], total_timer_time: [8, 'uint32', 1000], total_distance: [9, 'uint32', 100], total_cycles: [10, 'uint32'],
      total_calories: [11, 'uint16'], avg_speed: [13, 'uint16', 1000], max_speed: [14, 'uint16', 1000], avg_heart_rate: [15, 'uint8'], max_heart_rate: [16, 'uint8'],
      avg_cadence: [17, 'uint8'], avg_power: [19, 'uint16'], max_power: [20, 'uint16'], intensity: [23, 'enum'], lap_trigger: [24, 'enum'], sport: [25, 'enum'], sub_sport: [39, 'enum'],
    },
  },
  session: {
    num: 18,
    fields: {
      message_index: [254, 'uint16'], timestamp: [253, 'uint32'], event: [0, 'enum'], event_type: [1, 'enum'], start_time: [2, 'uint32'], sport: [5, 'enum'], sub_sport: [6, 'enum'],
      total_elapsed_time: [7, 'uint32', 1000], total_timer_time: [8, 'uint32', 1000], total_distance: [9, 'uint32', 100], total_cycles: [10, 'uint32'], total_calories: [11, 'uint16'],
      avg_speed: [14, 'uint16', 1000], max_speed: [15, 'uint16', 1000], avg_heart_rate: [16, 'uint8'], max_heart_rate: [17, 'uint8'], avg_cadence: [18, 'uint8'],
      avg_power: [20, 'uint16'], max_power: [21, 'uint16'], first_lap_index: [25, 'uint16'], num_laps: [26, 'uint16'], trigger: [28, 'enum'],
    },
  },
  activity: { num: 34, fields: { timestamp: [253, 'uint32'], total_timer_time: [0, 'uint32', 1000], num_sessions: [1, 'uint16'], type: [2, 'enum'], event: [3, 'enum'], event_type: [4, 'enum'], local_timestamp: [5, 'uint32'] } },
};

// Which device the file claims to come from. Garmin Connect only computes Training Effect
// for files from Garmin devices, the same reason peloton-to-garmin offers device spoofing.
export const FIT_DEVICES = {
  generic: { label: 'This app (generic)', manufacturer: 255, product: 0, serial: 1, version: 1 },
  forerunner945: { label: 'Garmin Forerunner 945', manufacturer: 1, product: 3113, serial: 1, version: 19.2 },
};

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function fitCrc(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

class FitWriter {
  constructor() {
    this.out = [];
    this.locals = new Map(); // message name -> local message type
  }

  push(value, size) {
    for (let i = 0; i < size; i++) this.out.push((value >>> (8 * i)) & 0xff);
  }

  write(name, values) {
    const msg = MESSAGES[name];
    const entries = Object.entries(msg.fields);
    if (!this.locals.has(name)) {
      const local = this.locals.size;
      if (local > 15) throw new Error('too many FIT message types');
      this.locals.set(name, local);
      this.out.push(0x40 | local, 0, 0); // definition header, reserved, little-endian
      this.push(msg.num, 2);
      this.out.push(entries.length);
      for (const [, [num, type]] of entries) this.out.push(num, TYPES[type].size, TYPES[type].id);
    }
    this.out.push(this.locals.get(name));
    for (const [field, [, type, scale = 1]] of entries) {
      const t = TYPES[type];
      const v = values[field];
      let raw = t.invalid;
      if (v != null && Number.isFinite(v)) {
        const max = t.invalid === 0 ? 2 ** (8 * t.size) - 1 : t.invalid - 1;
        raw = Math.min(max, Math.max(0, Math.round(v * scale)));
      }
      this.push(raw, t.size);
    }
  }

  bytes() {
    const header = new Uint8Array(14);
    const dv = new DataView(header.buffer);
    header[0] = 14;
    header[1] = 0x20; // protocol 2.0
    dv.setUint16(2, 2132, true); // profile version 21.32
    dv.setUint32(4, this.out.length, true);
    header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    dv.setUint16(12, fitCrc(header, 0, 12), true);

    const file = new Uint8Array(14 + this.out.length + 2);
    file.set(header, 0);
    file.set(this.out, 14);
    const crc = fitCrc(file, 0, file.length - 2);
    file[file.length - 2] = crc & 0xff;
    file[file.length - 1] = crc >> 8;
    return file;
  }
}

const n = (v) => (v == null || v === 0 ? null : v);

export function encodeFit(summary, { device = 'generic' } = {}) {
  const dev = FIT_DEVICES[device] ?? FIT_DEVICES.generic;
  const { sport, subSport } = machineInfo(summary.machine);
  const start = toFitTime(summary.startTime);
  const end = toFitTime(summary.endTime);
  const w = new FitWriter();

  w.write('file_id', { type: 4, manufacturer: dev.manufacturer, product: dev.product, serial_number: dev.serial, time_created: start });
  w.write('device_info', { timestamp: start, device_index: 0, manufacturer: dev.manufacturer, serial_number: dev.serial, product: dev.product, software_version: dev.version });
  w.write('event', { timestamp: start, event: 0, event_type: 0 }); // timer start

  for (const s of summary.samples) {
    w.write('record', { timestamp: toFitTime(s.t), heart_rate: s.heartRate, cadence: s.cadence, distance: s.distance, speed: s.speed, power: s.power });
  }

  w.write('event', { timestamp: end, event: 0, event_type: 4 }); // timer stop_all

  // A multi-erg workout becomes a multisport activity: one session per leg, with the time spent
  // changing machines as transition sessions in between.
  const sportOf = (l) => (l.type === 'transition' ? { sport: 3, subSport: 0 } : summary.multi ? machineInfo(l.machine) : { sport, subSport });

  summary.laps.forEach((l, i) => {
    const ls = sportOf(l);
    w.write('lap', {
      message_index: i, timestamp: toFitTime(l.endTime), event: 9, event_type: 1, start_time: toFitTime(l.startTime),
      total_elapsed_time: l.duration, total_timer_time: l.duration, total_distance: l.distance, total_cycles: l.cycles, total_calories: l.calories,
      avg_speed: l.avgSpeed, max_speed: l.maxSpeed, avg_heart_rate: l.avgHr, max_heart_rate: l.maxHr, avg_cadence: n(l.avgCadence),
      avg_power: n(l.avgPower), max_power: n(l.maxPower), intensity: l.type === 'rest' ? 1 : 0,
      lap_trigger: l.partial ? 0 : l.kind === 'distance' ? 2 : l.kind === 'time' ? 1 : 7, sport: ls.sport, sub_sport: ls.subSport,
    });
  });

  let numSessions = 1;
  if (summary.multi) {
    numSessions = summary.laps.length;
    summary.laps.forEach((l, i) => {
      const ls = sportOf(l);
      w.write('session', {
        message_index: i, timestamp: toFitTime(l.endTime), event: 8, event_type: 1, start_time: toFitTime(l.startTime), sport: ls.sport, sub_sport: ls.subSport,
        total_elapsed_time: l.duration, total_timer_time: l.duration, total_distance: l.distance, total_cycles: l.cycles,
        total_calories: l.calories, avg_speed: l.avgSpeed, max_speed: l.maxSpeed,
        avg_heart_rate: l.avgHr, max_heart_rate: l.maxHr, avg_cadence: n(l.avgCadence), avg_power: n(l.avgPower), max_power: n(l.maxPower),
        first_lap_index: i, num_laps: 1, trigger: 0,
      });
    });
  } else {
    w.write('session', {
      message_index: 0, timestamp: end, event: 8, event_type: 1, start_time: start, sport, sub_sport: subSport,
      total_elapsed_time: summary.elapsed, total_timer_time: summary.elapsed, total_distance: summary.totalDistance, total_cycles: summary.cycles,
      total_calories: summary.calories, avg_speed: summary.elapsed > 0 ? summary.totalDistance / summary.elapsed : 0, max_speed: summary.maxSpeed,
      avg_heart_rate: summary.avgHr, max_heart_rate: summary.maxHr, avg_cadence: n(summary.avgCadence), avg_power: n(summary.avgPower), max_power: n(summary.maxPower),
      first_lap_index: 0, num_laps: summary.laps.length, trigger: 0,
    });
  }

  const tzOffsetSec = new Date(summary.endTime).getTimezoneOffset() * 60;
  w.write('activity', { timestamp: end, total_timer_time: summary.elapsed, num_sessions: numSessions, type: 0, event: 26, event_type: 1, local_timestamp: end - tzOffsetSec });

  return w.bytes();
}

export function lapsToCsv(summary) {
  if (summary.multi) {
    // Legs are on different machines: pace is per 500 m on RowErg/SkiErg and per 1,000 m on bikes.
    const rows = [['lap', 'type', 'machine', 'duration_s', 'distance_m', 'pace_s', 'pace_per_m', 'avg_watts', 'avg_cadence', 'avg_hr', 'max_hr', 'calories']];
    for (const l of summary.laps) {
      const unit = machineInfo(l.machine).paceUnit;
      rows.push([l.index + 1, l.type, l.machine, l.duration.toFixed(1), l.distance.toFixed(1), l.pace?.toFixed(1) ?? '', l.pace ? unit : '', l.avgPower, l.avgCadence, l.avgHr ?? '', l.maxHr ?? '', l.calories]);
    }
    return rows.map((r) => r.join(',')).join('\n') + '\n';
  }
  const unit = machineInfo(summary.machine).paceUnit;
  const rows = [['lap', 'type', 'duration_s', 'distance_m', `pace_s_per_${unit}m`, 'avg_watts', 'avg_cadence', 'avg_hr', 'max_hr', 'calories']];
  for (const l of summary.laps) {
    rows.push([l.index + 1, l.type, l.duration.toFixed(1), l.distance.toFixed(1), l.pace?.toFixed(1) ?? '', l.avgPower, l.avgCadence, l.avgHr ?? '', l.maxHr ?? '', l.calories]);
  }
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
