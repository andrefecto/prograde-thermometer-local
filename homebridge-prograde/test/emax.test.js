'use strict';

/**
 * Tests for the Emax codec, checked against frames captured from a live
 * ProGrade EM2251. Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const e = require('../lib/emax');

// Two real frames, captured minutes apart during a cook. The display read
// 195 F for the first and 197 F for the second.
const FRAME_904 = Buffer.from('3c5401690011223030000400880300001c3e', 'hex');
const FRAME_914 = Buffer.from('3c540169001122303000040092030000263e', 'hex');
// The same frame as received with the firmware's stray '>' start byte.
const FRAME_QUIRK = Buffer.from('3e540169001122303000040092030000263e', 'hex');

function probeTenthsC(body) {
  return (body[6] << 8) | body[5]; // le5:6
}

test('decodes a captured frame', () => {
  const f = e.decode(FRAME_914);
  assert.strictEqual(f.type, e.TYPE_TEMPERATURE);
  assert.strictEqual(f.name, 'temperature');
  assert.strictEqual(f.deviceId.toString('hex'), '69001122');
  assert.strictEqual(f.body.toString('hex'), '303000040092030000');
  assert.strictEqual(f.probeLabel, '00');
});

test('re-encoding a parsed frame reproduces the captured bytes', () => {
  const f = e.decode(FRAME_914);
  assert.deepStrictEqual(e.encode(f.type, f.deviceId, f.body, f.unknown),
    FRAME_914);
});

test('checksum matches both captured frames', () => {
  assert.strictEqual(e.checksum(FRAME_904.subarray(0, FRAME_904.length - 2)), 0x1c);
  assert.strictEqual(e.checksum(FRAME_914.subarray(0, FRAME_914.length - 2)), 0x26);
});

test('le5:6 is tenths of a degree Celsius, matching the display', () => {
  // 904 -> 90.4 C -> 194.7 F, display read 195 F
  const cool = probeTenthsC(e.decode(FRAME_904).body);
  assert.strictEqual(cool, 904);
  assert.ok(Math.abs((cool * 0.1 * 9) / 5 + 32 - 194.7) < 0.1);

  // 914 -> 91.4 C -> 196.5 F, display read 197 F
  const hot = probeTenthsC(e.decode(FRAME_914).body);
  assert.strictEqual(hot, 914);
  assert.ok(Math.abs((hot * 0.1 * 9) / 5 + 32 - 196.5) < 0.1);
});

test("tolerates the firmware's stray '>' start byte", () => {
  const good = e.decode(FRAME_914);
  const quirk = e.decode(FRAME_QUIRK);
  assert.deepStrictEqual(quirk.body, good.body);
  assert.deepStrictEqual(quirk.deviceId, good.deviceId);
});

test('rejects a corrupted checksum', () => {
  const bad = Buffer.from(FRAME_914);
  bad[bad.length - 2] ^= 0xff;
  assert.throws(() => e.decode(bad), /checksum/);
});

test('rejects a missing terminator', () => {
  assert.throws(() => e.decode(FRAME_914.subarray(0, FRAME_914.length - 1)),
    /bad end|checksum/);
});

test('rejects a frame shorter than the fixed overhead', () => {
  assert.throws(() => e.decode(Buffer.from('3c3e', 'hex')), /short frame/);
});

test('FrameStream reassembles a frame split across chunks', () => {
  const s = new e.FrameStream();
  assert.deepStrictEqual(s.push(FRAME_914.subarray(0, 10)), []);
  const got = s.push(FRAME_914.subarray(10));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(probeTenthsC(got[0].body), 914);
});

test('FrameStream handles back-to-back frames and leading garbage', () => {
  const s = new e.FrameStream();
  const got = s.push(Buffer.concat([
    Buffer.from([0xff, 0x00]), FRAME_904, FRAME_914,
  ]));
  assert.deepStrictEqual(got.map((f) => probeTenthsC(f.body)), [904, 914]);
});

test('FrameStream recovers a quirk frame mixed in with good ones', () => {
  const s = new e.FrameStream();
  const got = s.push(Buffer.concat([FRAME_904, FRAME_QUIRK, FRAME_914]));
  assert.deepStrictEqual(got.map((f) => probeTenthsC(f.body)), [904, 914, 914]);
});
