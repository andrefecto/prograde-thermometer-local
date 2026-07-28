'use strict';

/**
 * Codec for the telemetry the ProGrade EM2251 actually sends (JS port of
 * ../../dplus/emax.py).
 *
 * This is not the DTston "D+" framing in dplus.js -- that is the platform's
 * generic MCU protocol, but this product's MCU uses its own simpler format. The
 * WiFi module is a transparent passthrough, so what the MCU emits is what
 * arrives over UDP.
 *
 * Frame, as captured from a live device (18 bytes):
 *
 *   3c 54 01 69 00 11 22 30 30 00 04 00 92 03 00 00 26 3e
 *   <  T  ?  <--dev id--> "0 0" <---- body ----> ck >
 *
 *   offset  size  field
 *   0       1     start        0x3C, '<'
 *   1       1     type         0x54 ('T') on temperature reports
 *   2       1     unknown      0x01 observed
 *   3       4     deviceId     last four bytes of the module MAC
 *   7       N     body         product-specific payload
 *   -2      1     checksum     sum(frame[:-2]) & 0xFF -- includes the '<'
 *   -1      1     end          0x3E, '>'
 *
 * On this product the probe temperature is the little-endian 16-bit value at
 * body offsets 5..6, in tenths of a degree Celsius. Confirmed against the
 * device's own display: raw 914 -> 91.4 C -> 196.5 F, display read 197 F.
 */

const START = 0x3c; // '<'
const END = 0x3e;   // '>'
const OVERHEAD = 9; // start + type + unknown + 4-byte id + checksum + end

const TYPE_TEMPERATURE = 0x54; // 'T'
const TYPE_NAMES = { [TYPE_TEMPERATURE]: 'temperature' };

/** Low byte of the running sum, from the '<' up to (not incl.) the checksum. */
function checksum(buf) {
  let sum = 0;
  for (const b of buf) sum += b;
  return sum & 0xff;
}

function encode(type, deviceId, body = Buffer.alloc(0), unknown = 0x01) {
  if (deviceId.length !== 4) throw new Error('deviceId must be exactly 4 bytes');
  const head = Buffer.concat([
    Buffer.from([START, type, unknown]), deviceId, body,
  ]);
  return Buffer.concat([head, Buffer.from([checksum(head), END])]);
}

/**
 * Parse exactly one frame. Throws on malformed input.
 *
 * Tolerates a quirk seen on real hardware: roughly one frame in eight arrives
 * with 0x3E ('>') as its first byte instead of 0x3C. The rest is intact and its
 * checksum is the one computed for a leading '<', so those frames are accepted
 * rather than dropped.
 */
function decode(raw, { verify = true } = {}) {
  if (raw.length < OVERHEAD) {
    throw new Error(`short frame: ${raw.length} < ${OVERHEAD} bytes`);
  }
  if (raw[0] !== START && raw[0] !== END) {
    throw new Error(`bad start 0x${raw[0].toString(16)}, want 0x3c`);
  }
  if (raw[raw.length - 1] !== END) {
    throw new Error(`bad end 0x${raw[raw.length - 1].toString(16)}, want 0x3e`);
  }
  if (verify) {
    const payload = raw.subarray(0, raw.length - 2);
    const asReceived = checksum(payload);
    const corrected = checksum(
      Buffer.concat([Buffer.from([START]), payload.subarray(1)]),
    );
    const got = raw[raw.length - 2];
    if (got !== asReceived && got !== corrected) {
      throw new Error(
        `checksum 0x${got.toString(16)}, computed 0x${asReceived.toString(16)}`,
      );
    }
  }

  const type = raw[1];
  const body = Buffer.from(raw.subarray(7, raw.length - 2));
  const head = body.subarray(0, 2).toString('ascii');
  return {
    type,
    name: TYPE_NAMES[type] || `type_${type.toString(16).padStart(2, '0')}`,
    unknown: raw[2],
    deviceId: Buffer.from(raw.subarray(3, 7)),
    body,
    probeLabel: /^\d{2}$/.test(head) ? head : '',
    raw: Buffer.from(raw),
  };
}

/**
 * Incremental stream parser. Frames are delimited rather than length-prefixed,
 * so scan for a start byte then the next '>' and validate. Keeps any trailing
 * partial frame for the next call.
 */
class FrameStream {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      let start = this.buf.indexOf(START);
      const alt = this.buf.indexOf(END);
      // a frame may begin with either byte; take whichever comes first
      if (start < 0 || (alt >= 0 && alt < start)) start = alt;
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        return out;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      const end = this.buf.indexOf(END, OVERHEAD - 1);
      if (end < 0) return out; // terminator not here yet
      try {
        out.push(decode(this.buf.subarray(0, end + 1)));
        this.buf = this.buf.subarray(end + 1);
      } catch {
        this.buf = this.buf.subarray(1); // false start, resync
      }
    }
  }
}

module.exports = {
  START,
  END,
  OVERHEAD,
  TYPE_TEMPERATURE,
  TYPE_NAMES,
  checksum,
  encode,
  decode,
  FrameStream,
};
