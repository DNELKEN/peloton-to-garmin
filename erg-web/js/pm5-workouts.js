// Turn an app workout into the CSAFE command frames that program it onto a Concept2 PM5.
//
// Command grouping follows the sequences that are known to work over Web Bluetooth (ErgometerJS):
// each frame stays small enough for a single 20-byte BLE packet where possible, and the app
// waits for the PM's reply before sending the next frame.

import { be16, be32 } from './csafe.js';

const SETPMCFG = 0x76; // Concept2 proprietary "set configuration" wrapper

const CMD = {
  workoutType: 0x01,
  workoutDuration: 0x03,
  restDuration: 0x04,
  splitDuration: 0x05,
  targetPaceTime: 0x06,
  screenState: 0x13,
  configureWorkout: 0x14,
  intervalType: 0x17,
  workoutIntervalCount: 0x18,
};

export const WORKOUT_TYPE = { justRowSplits: 1, fixedDistanceSplits: 3, fixedTimeSplits: 5, variableInterval: 8 };
const INTERVAL_TYPE = { time: 0, distance: 1 };
const DURATION = { time: 0x00, distance: 0x80 };
const SCREEN_WORKOUT = 1;
const SCREEN_PREPARE_TO_ROW = 1;
export const SCREEN_TERMINATE = 2;

const cmd = (id, data) => [id, data.length, ...data];
// One SETPMCFG wrapper holding several PM commands.
export const pmConfig = (...cmds) => {
  const body = cmds.flat();
  return [SETPMCFG, body.length, ...body];
};

const duration = (seg) =>
  seg.kind === 'distance' ? [DURATION.distance, ...be32(Math.round(seg.value))] : [DURATION.time, ...be32(Math.round(seg.value * 100))];

// Default splits: about five per piece, e.g. 2000m -> 400m, 30:00 -> 6:00.
export function splitFor(seg) {
  if (seg.kind === 'distance') return { kind: 'distance', value: Math.max(100, Math.round(seg.value / 5 / 100) * 100) };
  return { kind: 'time', value: Math.max(20, Math.round(seg.value / 5)) };
}

export const prepareToRowFrame = () => pmConfig(cmd(CMD.screenState, [SCREEN_WORKOUT, SCREEN_PREPARE_TO_ROW]));
export const terminateFrame = () => pmConfig(cmd(CMD.screenState, [SCREEN_WORKOUT, SCREEN_TERMINATE]));

// Returns { frames: number[][], workoutType } or throws if the PM can't represent the workout.
export function workoutToFrames(workout, { sendTargets = true } = {}) {
  const segs = workout.segments;
  const works = segs.filter((s) => s.type === 'work');

  if (works.length === 1 && segs.length === 1) {
    const seg = works[0];
    if (seg.kind === 'open') {
      return {
        workoutType: WORKOUT_TYPE.justRowSplits,
        frames: [pmConfig(cmd(CMD.workoutType, [WORKOUT_TYPE.justRowSplits]), cmd(CMD.screenState, [SCREEN_WORKOUT, SCREEN_PREPARE_TO_ROW]))],
      };
    }
    const type = seg.kind === 'distance' ? WORKOUT_TYPE.fixedDistanceSplits : WORKOUT_TYPE.fixedTimeSplits;
    return {
      workoutType: type,
      frames: [
        pmConfig(cmd(CMD.workoutType, [type]), cmd(CMD.workoutDuration, duration(seg))),
        pmConfig(
          cmd(CMD.splitDuration, duration(workout.split?.kind === seg.kind ? workout.split : splitFor(seg))),
          cmd(CMD.configureWorkout, [1]),
          cmd(CMD.screenState, [SCREEN_WORKOUT, SCREEN_PREPARE_TO_ROW]),
        ),
      ],
    };
  }

  // Anything with more than one piece becomes a variable-interval workout, which has an exact
  // number of intervals (the PM's fixed-interval types repeat until you stop).
  const frames = [];
  let index = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.type === 'rest') {
      if (i === 0 || segs[i - 1].type === 'rest') throw new Error('Rest must follow a piece.');
      continue;
    }
    if (seg.kind === 'open') throw new Error('An open piece cannot be part of an interval workout on the PM5.');
    const next = segs[i + 1];
    const restSec = next?.type === 'rest' ? Math.round(next.value) : 0;
    if (restSec > 0xffff) throw new Error('Rest is too long for the PM5.');

    frames.push(pmConfig(
      cmd(CMD.workoutIntervalCount, [index]),
      ...(index === 0 ? [cmd(CMD.workoutType, [WORKOUT_TYPE.variableInterval])] : []),
      cmd(CMD.intervalType, [seg.kind === 'distance' ? INTERVAL_TYPE.distance : INTERVAL_TYPE.time]),
    ));
    frames.push(pmConfig(cmd(CMD.workoutDuration, duration(seg)), cmd(CMD.restDuration, be16(restSec))));
    frames.push(pmConfig(
      ...(sendTargets && seg.targetPace ? [cmd(CMD.targetPaceTime, be32(Math.round(seg.targetPace * 100)))] : []),
      cmd(CMD.configureWorkout, [1]),
    ));
    index++;
  }
  if (index > 30) throw new Error('Too many intervals to load onto the PM5 (30 max).');
  frames.push(prepareToRowFrame());
  return { workoutType: WORKOUT_TYPE.variableInterval, frames };
}
