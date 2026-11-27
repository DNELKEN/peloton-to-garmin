// CSAFE framing for the Concept2 PM5 control channel.
// Frame: F1 <contents> <xor checksum> F2, with F0..F3 inside the frame byte-stuffed as F3 0x.

export const FRAME_START = 0xf1;
export const FRAME_STOP = 0xf2;
const EXT_START = 0xf0;
const STUFF = 0xf3;

export function checksum(bytes) {
  return bytes.reduce((x, b) => x ^ b, 0);
}

function stuff(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b >= EXT_START && b <= STUFF) out.push(STUFF, b & 0x03);
    else out.push(b);
  }
  return out;
}

function unstuff(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === STUFF && i + 1 < bytes.length) out.push(EXT_START + bytes[++i]);
    else out.push(bytes[i]);
  }
  return out;
}

export function buildFrame(contents) {
  return Uint8Array.from([FRAME_START, ...stuff([...contents, checksum(contents)]), FRAME_STOP]);
}

// Parse a complete response frame. Returns { status, previousFrame, state, contents } or throws.
export function parseFrame(frame) {
  const bytes = Array.from(frame);
  if (bytes[0] !== FRAME_START || bytes[bytes.length - 1] !== FRAME_STOP) throw new Error('not a CSAFE frame');
  const body = unstuff(bytes.slice(1, -1));
  const sum = body.pop();
  if (checksum(body) !== sum) throw new Error('CSAFE checksum mismatch');
  const status = body[0];
  return {
    status,
    state: status & 0x0f,
    previousFrame: ['ok', 'rejected', 'bad', 'not ready'][(status >> 4) & 0x03],
    contents: body.slice(1),
  };
}

// Big-endian helpers for PM command payloads.
export const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
export const be32 = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
