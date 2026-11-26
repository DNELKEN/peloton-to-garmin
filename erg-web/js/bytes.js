// Little-endian readers for Bluetooth characteristic payloads.
export const u8 = (dv, o) => dv.getUint8(o);
export const u16 = (dv, o) => dv.getUint16(o, true);
export const s16 = (dv, o) => dv.getInt16(o, true);
export const u24 = (dv, o) => dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);

export const toDataView = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
