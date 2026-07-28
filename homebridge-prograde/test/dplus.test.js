'use strict';

/**
 * Tests for the D+ codec, checked against the three worked examples printed in
 * the vendor spec (D+ 串口协议标准 v1.7) plus stream-resync and field-decode
 * behaviour.  Run with:  node --test   (or: npm test)
 */

const test = require('node:test');
const assert = require('node:assert');
const d = require('../lib/dplus');

// --- spec vectors -----------------------------------------------------------

test('spec example 1: get product type request', () => {
  const expected = Buffer.from('aa111000000000000000000030010000' + '04', 'hex');
  assert.deepStrictEqual(d.encode(d.FUNC.PRODUCT_TYPE), expected);
  const f = d.decode(expected);
  assert.strictEqual(f.func, d.FUNC.PRODUCT_TYPE);
  assert.strictEqual(f.body.length, 0);
  assert.strictEqual(f.name, 'product_type');
});

test('spec example 2: MCU replies with product type 0x0123', () => {
  const expected = Buffer.from('aa1310000000000000000000380100000123d6', 'hex');
  const body = Buffer.from([0x01, 0x23]);
  assert.deepStrictEqual(d.encode(d.FUNC.PRODUCT_TYPE_REPLY, body), expected);
  const f = d.decode(expected);
  assert.strictEqual(f.func, d.FUNC.PRODUCT_TYPE_REPLY);
  assert.deepStrictEqual(f.body, body);
});

test('spec example 3: wifi pair request, body "QQDM" + padding', () => {
  const body = Buffer.concat([Buffer.from('QQDM'), Buffer.alloc(11)]);
  const frame = d.encode(d.FUNC.WIFI_PAIR, body);
  assert.strictEqual(frame[1], 0x20, 'length byte should be 0x20');
  assert.strictEqual(frame[frame.length - 1], 0xd2, 'checksum should be 0xd2');
  assert.ok(d.decode(frame).body.subarray(0, 4).equals(Buffer.from('QQDM')));
});

test('checksum matches the two arithmetic walkthroughs in the spec', () => {
  assert.strictEqual(
    d.checksum(Buffer.from('aa111000000000000000000030010000', 'hex')),
    0x04,
  );
  assert.strictEqual(
    d.checksum(Buffer.from('aa1310000000000000000000380100000123', 'hex')),
    0xd6,
  );
});

// --- framing robustness -----------------------------------------------------

test('rejects a corrupted checksum', () => {
  const frame = d.encode(d.FUNC.STATUS_QUERY);
  frame[frame.length - 1] ^= 0xff;
  assert.throws(() => d.decode(frame), /checksum/);
});

test('rejects a length field that disagrees with the buffer', () => {
  // 3-byte body -> length 20, so dropping one byte still clears the 17-byte
  // minimum and exercises the length-mismatch branch rather than "short frame".
  const frame = d.encode(d.FUNC.STATUS_REPORT, Buffer.from([1, 2, 3]));
  assert.throws(() => d.decode(frame.subarray(0, frame.length - 1)), /length field/);
});

test('rejects a frame shorter than the fixed overhead', () => {
  assert.throws(() => d.decode(Buffer.alloc(8, 0xaa)), /short frame/);
});

test('FrameStream reassembles frames split across chunks', () => {
  const a = d.encode(d.FUNC.PRODUCT_TYPE);
  const b = d.encode(d.FUNC.STATUS_REPORT, Buffer.from([1, 2, 3]));
  const s = new d.FrameStream();

  assert.deepStrictEqual(s.push(a.subarray(0, 5)), []);
  const got = s.push(Buffer.concat([a.subarray(5), b]));
  assert.deepStrictEqual(
    got.map((f) => f.func),
    [d.FUNC.PRODUCT_TYPE, d.FUNC.STATUS_REPORT],
  );
});

test('FrameStream resyncs past leading garbage and a false 0xAA', () => {
  const good = d.encode(d.FUNC.STATUS_REPORT, Buffer.from([9, 9]));
  const s = new d.FrameStream();
  const got = s.push(Buffer.concat([Buffer.from([0xff, 0x00, 0xaa, 0x02]), good]));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].func, d.FUNC.STATUS_REPORT);
});

test('FrameStream keeps a partial trailing frame for the next read', () => {
  const frame = d.encode(d.FUNC.STATUS_REPORT, Buffer.from([7]));
  const s = new d.FrameStream();
  assert.deepStrictEqual(s.push(frame.subarray(0, 10)), []);
  assert.strictEqual(s.push(frame.subarray(10)).length, 1);
});

// --- decoding helpers -------------------------------------------------------

test('decodeWifiState reads bars and link state', () => {
  assert.deepStrictEqual(d.decodeWifiState(Buffer.from([0x03, 0x00, 0x01])), {
    signalBars: 3,
    routerConnected: true,
    cloudConnected: false,
  });
});

test('readField supports the notation analyze.py prints', () => {
  const body = Buffer.from([0, 1, 2, 3, 0x04, 0xd2, 6]);
  assert.strictEqual(d.readField(body, 'b4'), 0x04);
  assert.strictEqual(d.readField(body, 'be4:5'), 0x04d2); // 1234
  assert.strictEqual(d.readField(body, 'le4:5'), 0xd204);
  assert.strictEqual(d.readField(body, 'b99'), null, 'out of range -> null');
  assert.throws(() => d.readField(body, 'nonsense'), /bad field spec/);
});

test('writeField round-trips through readField for every spec form', () => {
  for (const [spec, value] of [
    ['b0', 200],
    ['b6', 42],
    ['be2:3', 1234],
    ['le2:3', 1234],
    ['be0:1', 65535],
  ]) {
    const body = Buffer.alloc(d.fieldExtent(spec) + 1);
    d.writeField(body, spec, value);
    assert.strictEqual(d.readField(body, spec), value, `${spec} round-trip`);
  }
});

test('fieldExtent sizes a body big enough for the spec', () => {
  assert.strictEqual(d.fieldExtent('b4'), 4);
  assert.strictEqual(d.fieldExtent('be9:10'), 10);
  assert.strictEqual(d.fieldExtent('le3:2'), 3);
});

test('toCelsius applies the model analyze.py fits', () => {
  // analyze.py output "temp = 0.1 * raw + 0", readings logged in Fahrenheit:
  // raw 1234 -> 123.4 F -> 50.78 C
  const c = d.toCelsius(1234, { scale: 0.1, offset: 0, unit: 'F' });
  assert.ok(Math.abs(c - 50.7778) < 0.01, `got ${c}`);
  // same field but the device reports Celsius tenths
  assert.ok(Math.abs(d.toCelsius(725, { scale: 0.1, unit: 'C' }) - 72.5) < 1e-9);
  assert.strictEqual(d.toCelsius(null, {}), null);
});
