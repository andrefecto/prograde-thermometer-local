'use strict';

/**
 * DTston "D+" frame codec (JS port of ../../dplus/protocol.py).
 *
 * Frame layout (spec: D+ 串口协议标准 v1.7):
 *
 *   offset  size  field
 *   0       1     header      always 0xAA
 *   1       1     length      total frame length, header..checksum
 *   2       2     packetId    session id; replies echo the request's id
 *   4       8     deviceInfo  8 x 0x00 from the MCU side
 *   12      2     func        function code, big-endian
 *   14      2     reserved    always 0x0000
 *   16      N     body        function-specific
 *   16+N    1     checksum    two's complement of sum(header..body)
 *
 * length === 17 + N. All multi-byte integers big-endian.
 */

const HEADER = 0xaa;
const OVERHEAD = 17;

// System-fixed function codes, identical on every D+ product.
const FUNC = {
  STATUS_QUERY: 0x1001,
  STATUS_REPLY: 0x1801,
  STATUS_REPORT: 0x2000,
  WIFI_PAIR: 0x2001,
  WIFI_PAIR_REPLY: 0x2801,
  WIFI_STATE: 0x2002,
  PRODUCT_TYPE: 0x3001,
  PRODUCT_TYPE_REPLY: 0x3801,
};

const FUNC_NAMES = Object.fromEntries(
  Object.entries(FUNC).map(([k, v]) => [v, k.toLowerCase()]),
);

/** Two's complement of the running sum, per spec 2.1 (取反再加1). */
function checksum(buf) {
  let sum = 0;
  for (const b of buf) sum += b;
  return (-sum) & 0xff;
}

/**
 * Build a frame.
 * @param {number} func function code
 * @param {Buffer} [body]
 * @param {number} [packetId]
 */
function encode(func, body = Buffer.alloc(0), packetId = 0x1000) {
  if (OVERHEAD + body.length > 0xff) {
    throw new Error('body too long: the length field is a single byte');
  }
  const head = Buffer.alloc(16 + body.length);
  head.writeUInt8(HEADER, 0);
  head.writeUInt8(OVERHEAD + body.length, 1);
  head.writeUInt16BE(packetId, 2);
  // bytes 4..11 stay zero: deviceInfo
  head.writeUInt16BE(func, 12);
  head.writeUInt16BE(0x0000, 14);
  body.copy(head, 16);
  return Buffer.concat([head, Buffer.from([checksum(head)])]);
}

/**
 * Parse exactly one frame. Throws on malformed input.
 * @returns {{func:number, name:string, body:Buffer, packetId:number, raw:Buffer}}
 */
function decode(raw, { verify = true } = {}) {
  if (raw.length < OVERHEAD) {
    throw new Error(`short frame: ${raw.length} < ${OVERHEAD} bytes`);
  }
  if (raw[0] !== HEADER) {
    throw new Error(`bad header 0x${raw[0].toString(16)}, want 0xaa`);
  }
  const length = raw[1];
  if (length < OVERHEAD) throw new Error(`length field ${length} below minimum`);
  if (raw.length !== length) {
    throw new Error(`length field says ${length}, got ${raw.length} bytes`);
  }
  if (verify) {
    const want = checksum(raw.subarray(0, raw.length - 1));
    if (raw[raw.length - 1] !== want) {
      throw new Error(
        `checksum 0x${raw[raw.length - 1].toString(16)}, computed 0x${want.toString(16)}`,
      );
    }
  }
  const func = raw.readUInt16BE(12);
  return {
    func,
    name: FUNC_NAMES[func] || `unknown_${func.toString(16).padStart(4, '0')}`,
    body: Buffer.from(raw.subarray(16, raw.length - 1)),
    packetId: raw.readUInt16BE(2),
    raw: Buffer.from(raw),
  };
}

/**
 * Incremental stream parser. Feed it whatever arrives; it returns the complete
 * frames and keeps any partial trailing frame for next time. Resynchronises by
 * discarding bytes until a frame validates, so a corrupt byte costs one frame
 * rather than the whole session.
 */
class FrameStream {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** @returns {Array<object>} complete frames found in the stream so far */
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      const start = this.buf.indexOf(HEADER);
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        return out;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 2) return out;
      const length = this.buf[1];
      if (length < OVERHEAD) {
        this.buf = this.buf.subarray(1); // not a real header
        continue;
      }
      if (this.buf.length < length) return out; // wait for the rest
      const candidate = this.buf.subarray(0, length);
      try {
        out.push(decode(candidate));
        this.buf = this.buf.subarray(length);
      } catch {
        this.buf = this.buf.subarray(1); // false 0xAA, resync
      }
    }
  }
}

/** Body of WIFI_STATE (0x2002): 3 bytes, per spec section "Wifi网络状态". */
function decodeWifiState(body) {
  if (body.length < 3) throw new Error('wifi_state body must be >= 3 bytes');
  return {
    signalBars: body[0], // 1=weak, 2=medium, 3=strong
    routerConnected: body[1] === 0x00,
    cloudConnected: body[2] === 0x00,
  };
}

/**
 * Read a field out of a state-report body using the notation analyze.py prints:
 *   "b4"      -> single byte at offset 4
 *   "be4:5"   -> big-endian 16-bit from offsets 4,5
 *   "le4:5"   -> little-endian 16-bit from offsets 4,5
 * Returns null when the body is too short, so a truncated frame degrades to
 * "no reading" instead of a bogus one.
 */
function readField(body, spec) {
  const single = /^b(\d+)$/.exec(spec);
  if (single) {
    const i = Number(single[1]);
    return i < body.length ? body[i] : null;
  }
  const pair = /^(be|le)(\d+):(\d+)$/.exec(spec);
  if (pair) {
    const [, endian, aStr, bStr] = pair;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a >= body.length || b >= body.length) return null;
    return endian === 'be' ? (body[a] << 8) | body[b] : (body[b] << 8) | body[a];
  }
  throw new Error(
    `bad field spec "${spec}"; expected forms are b4, be4:5 or le4:5`,
  );
}

/**
 * Inverse of readField: write `raw` into `body` at the position `spec` names.
 * Used by the simulator so it can synthesise bodies in whatever layout the
 * config declares, which keeps the simulated path identical to the real one.
 */
function writeField(body, spec, raw) {
  const value = Math.max(0, Math.round(raw));
  const single = /^b(\d+)$/.exec(spec);
  if (single) {
    body[Number(single[1])] = value & 0xff;
    return body;
  }
  const pair = /^(be|le)(\d+):(\d+)$/.exec(spec);
  if (pair) {
    const [, endian, aStr, bStr] = pair;
    const a = Number(aStr);
    const b = Number(bStr);
    const hi = (value >> 8) & 0xff;
    const lo = value & 0xff;
    if (endian === 'be') {
      body[a] = hi;
      body[b] = lo;
    } else {
      body[a] = lo;
      body[b] = hi;
    }
    return body;
  }
  throw new Error(`bad field spec "${spec}"`);
}

/** Highest byte offset a field spec touches, for sizing a synthetic body. */
function fieldExtent(spec) {
  const single = /^b(\d+)$/.exec(spec);
  if (single) return Number(single[1]);
  const pair = /^(be|le)(\d+):(\d+)$/.exec(spec);
  if (pair) return Math.max(Number(pair[2]), Number(pair[3]));
  throw new Error(`bad field spec "${spec}"`);
}

/**
 * Turn a raw field into a temperature in Celsius, which is the only unit
 * HomeKit accepts on CurrentTemperature.
 *
 * `scale` and `offset` come straight from analyze.py's "temp = a*raw + b" line;
 * `unit` says which unit that model produces.
 */
function toCelsius(raw, { scale = 1, offset = 0, unit = 'C' } = {}) {
  if (raw === null || raw === undefined) return null;
  const value = raw * scale + offset;
  return unit.toUpperCase() === 'F' ? ((value - 32) * 5) / 9 : value;
}

module.exports = {
  HEADER,
  OVERHEAD,
  FUNC,
  FUNC_NAMES,
  checksum,
  encode,
  decode,
  FrameStream,
  decodeWifiState,
  readField,
  writeField,
  fieldExtent,
  toCelsius,
};
