'use strict';

/**
 * Integration tests for the Homebridge platform, driven through a minimal mock
 * of the HAP API. These check the part that actually matters: that a D+ state
 * frame turns into the right HomeKit characteristic values.
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const dplus = require('../lib/dplus');
const plugin = require('../index');
const { ProGradePlatform } = plugin;

// --- minimal HAP mock -------------------------------------------------------

class MockService {
  constructor(type, displayName, subtype) {
    this.type = type;
    this.displayName = displayName;
    this.subtype = subtype;
    this.chars = new Map();
  }

  // Real HAP characteristics are objects; the enum-bearing ones in this mock are
  // String wrappers, so every key is normalised to a primitive before use.
  static key(name) {
    return String(name);
  }

  setCharacteristic(name, value) {
    this.chars.set(MockService.key(name), value);
    return this;
  }

  updateCharacteristic(name, value) {
    this.chars.set(MockService.key(name), value);
    return this;
  }

  getCharacteristic(name) {
    const self = this;
    const key = MockService.key(name);
    return {
      setProps(props) {
        self.props = { ...(self.props || {}), [key]: props };
        return this;
      },
      updateValue(v) {
        self.chars.set(key, v);
        return this;
      },
    };
  }

  addOptionalCharacteristic(name) {
    return this.getCharacteristic(name);
  }

  get(name) {
    return this.chars.get(MockService.key(name));
  }
}

class MockAccessory {
  constructor(displayName, uuid) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.services = [new MockService('AccessoryInformation', 'info', undefined)];
  }

  getService(type) {
    return this.services.find((s) => s.type === type);
  }

  getServiceById(type, subtype) {
    return this.services.find((s) => s.type === type && s.subtype === subtype);
  }

  addService(type, displayName, subtype) {
    const s = new MockService(type, displayName, subtype);
    this.services.push(s);
    return s;
  }

  removeService(service) {
    this.services = this.services.filter((s) => s !== service);
  }
}

const CHARS = [
  'Manufacturer', 'Model', 'SerialNumber', 'Name', 'ConfiguredName',
  'CurrentTemperature', 'StatusActive', 'BatteryLevel',
];

function makeApi() {
  const api = new EventEmitter();
  const Characteristic = Object.fromEntries(CHARS.map((c) => [c, c]));
  Characteristic.StatusFault = Object.assign('StatusFault', {
    NO_FAULT: 0,
    GENERAL_FAULT: 1,
  });
  Characteristic.ContactSensorState = Object.assign('ContactSensorState', {
    CONTACT_DETECTED: 0,
    CONTACT_NOT_DETECTED: 1,
  });
  Characteristic.StatusLowBattery = Object.assign('StatusLowBattery', {
    BATTERY_LEVEL_NORMAL: 0,
    BATTERY_LEVEL_LOW: 1,
  });

  api.hap = {
    Service: {
      AccessoryInformation: 'AccessoryInformation',
      TemperatureSensor: 'TemperatureSensor',
      ContactSensor: 'ContactSensor',
      Battery: 'Battery',
    },
    Characteristic,
    uuid: { generate: (s) => `uuid:${s}` },
  };
  api.platformAccessory = MockAccessory;
  api.registered = [];
  api.registerPlatformAccessories = (_p, _n, accs) => api.registered.push(...accs);
  api.updatePlatformAccessories = () => {};
  api.registerPlatform = () => {};
  return api;
}

const log = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

/** Boot a platform, wire the mock HAP, and return it started. */
function bootPlatform(config) {
  const api = makeApi();
  plugin(api); // populates the module-level Service/Characteristic
  const platform = new ProGradePlatform(log, config, api);
  api.emit('didFinishLaunching');
  return { platform, api };
}

/**
 * A layout with every field mapped, for exercising target/alarm/battery.
 * The real EM2251 reports temperature only -- see plugin.DEFAULT_FIELDS.
 */
const FULL_FIELDS = {
  probe: 'be0:1',
  target: 'be2:3',
  alarm: 'b4',
  battery: 'b5',
  scale: 0.1,
  offset: 0,
  unit: 'C',
};

/** Build a STATUS_REPORT frame in the layout `fields` declares. */
function stateFrame(fields, { probe, target, alarm = 0, battery = 100 }) {
  const mapped = ['probe', 'target', 'alarm', 'battery'].filter((k) => fields[k]);
  const size = Math.max(...mapped.map((k) => dplus.fieldExtent(fields[k]))) + 1;
  const body = Buffer.alloc(size);
  dplus.writeField(body, fields.probe, probe);
  if (fields.target) dplus.writeField(body, fields.target, target);
  if (fields.alarm) dplus.writeField(body, fields.alarm, alarm);
  if (fields.battery) dplus.writeField(body, fields.battery, battery);
  return dplus.decode(dplus.encode(dplus.FUNC.STATUS_REPORT, body));
}

// A real frame captured from an EM2251 while its own display read 197 F.
const REAL_FRAME = Buffer.from('3c540169001122303000040092030000263e', 'hex');

// --- tests ------------------------------------------------------------------

test('the shipped defaults decode a real captured device frame', (t) => {
  const emax = require('../lib/emax');
  const { platform } = bootPlatform({ transport: 'sim' });
  t.after(() => platform.stop());

  platform.onFrame(emax.decode(REAL_FRAME), 'emax');

  // 914 tenths of a degree C -> 91.4 C, which is the 197 F the display showed
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 91.4);
  assert.ok(Math.abs((91.4 * 9) / 5 + 32 - 196.5) < 0.1);
  assert.strictEqual(platform.probeService.get('StatusActive'), true);
});

test('a configured target drives the reached sensor without device support', (t) => {
  const emax = require('../lib/emax');
  // 225 F, the setpoint on the unit, is 107.2 C. The device never sends it.
  const { platform } = bootPlatform({ transport: 'sim', staticTargetC: 107.2 });
  t.after(() => platform.stop());

  platform.onFrame(emax.decode(REAL_FRAME), 'emax');
  assert.strictEqual(platform.targetService.get('CurrentTemperature'), 107.2);
  assert.strictEqual(platform.alarmService.get('ContactSensorState'), 1,
    '91.4 C is below the 107.2 C target, so not reached');

  // now push the probe past the target
  const hot = Buffer.from(REAL_FRAME);
  const body = Buffer.alloc(9);
  REAL_FRAME.copy(body, 0, 7, 16);
  const raw = 1080; // 108.0 C, past target
  body[5] = raw & 0xff;
  body[6] = (raw >> 8) & 0xff;
  platform.onFrame(emax.decode(emax.encode(0x54,
    Buffer.from('69001122', 'hex'), body)), 'emax');

  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 108);
  assert.strictEqual(platform.alarmService.get('ContactSensorState'), 0,
    'reached, which is what fires the HomeKit notification');
  assert.ok(hot);
});

test('the quirk frame with a stray > start byte still updates HomeKit', (t) => {
  const emax = require('../lib/emax');
  const { platform } = bootPlatform({ transport: 'sim' });
  t.after(() => platform.stop());

  const quirk = Buffer.from(REAL_FRAME);
  quirk[0] = 0x3e;
  platform.onFrame(emax.decode(quirk), 'emax');
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 91.4);
});

test('warns when the mapping yields an implausible temperature', (t) => {
  const emax = require('../lib/emax');
  const warnings = [];
  const api = makeApi();
  plugin(api);
  const noisyLog = { ...log, warn: (m) => warnings.push(m) };
  const platform = new ProGradePlatform(noisyLog,
    // be0:1 on the real body reads 0x3030 = 12336 -> 1233.6 C, absurd
    { transport: 'sim', fields: { ...plugin.DEFAULT_FIELDS, probe: 'be0:1' } },
    api);
  api.emit('didFinishLaunching');
  t.after(() => platform.stop());

  for (let i = 0; i < 3; i += 1) platform.onFrame(emax.decode(REAL_FRAME), 'emax');
  assert.ok(warnings.some((w) => /not a plausible probe temperature/.test(w)),
    `expected a plausibility warning, got ${JSON.stringify(warnings)}`);
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), undefined,
    'an implausible value must not be published');
});

test('publishes only the probe when the device reports nothing else', (t) => {
  // the shipped EM2251 defaults: temperature only, no target/alarm/battery data
  const { platform, api } = bootPlatform({ name: 'Grill', transport: 'sim' });
  t.after(() => platform.stop());

  assert.strictEqual(api.registered.length, 1, 'one accessory registered');
  const acc = api.registered[0];
  assert.deepStrictEqual(acc.services.map((s) => s.type).sort(),
    ['AccessoryInformation', 'TemperatureSensor'],
    'no dead Target/Battery tiles when there is no data for them');

  const probe = acc.getServiceById('TemperatureSensor', 'probe');
  assert.ok(probe, 'probe service exists');
  assert.deepStrictEqual(probe.props.CurrentTemperature, {
    minValue: -50, maxValue: 200, minStep: 0.1,
  }, 'probe range widened past the 100 C HomeKit default');
});

test('a configured target adds the Target and Target Reached services', (t) => {
  const { platform, api } = bootPlatform({
    name: 'Grill', transport: 'sim', staticTargetC: 107.2,
  });
  t.after(() => platform.stop());

  const types = api.registered[0].services.map((s) => s.type).sort();
  assert.deepStrictEqual(types, [
    'AccessoryInformation', 'ContactSensor',
    'TemperatureSensor', 'TemperatureSensor',
  ].sort());
});

test('a fully-mapped device publishes all four services', (t) => {
  const { platform, api } = bootPlatform({
    name: 'Grill', transport: 'sim', fields: { ...FULL_FIELDS },
  });
  t.after(() => platform.stop());

  const types = api.registered[0].services.map((s) => s.type).sort();
  assert.deepStrictEqual(types, [
    'AccessoryInformation', 'Battery', 'ContactSensor',
    'TemperatureSensor', 'TemperatureSensor',
  ].sort());
});

test('a Celsius-tenths state frame lands on the right characteristics', (t) => {
  const fields = { ...FULL_FIELDS };
  const { platform } = bootPlatform({ transport: 'sim', fields });
  t.after(() => platform.stop());

  // 68.5 C probe, 93.0 C target, alarm clear, battery 76 %
  platform.onFrame(stateFrame(fields, { probe: 685, target: 930, battery: 76 }));

  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 68.5);
  assert.strictEqual(platform.targetService.get('CurrentTemperature'), 93);
  assert.strictEqual(platform.probeService.get('StatusActive'), true);
  assert.strictEqual(platform.probeService.get('StatusFault'), 0);
  assert.strictEqual(platform.alarmService.get('ContactSensorState'), 1, 'not reached');
  assert.strictEqual(platform.batteryService.get('BatteryLevel'), 76);
  assert.strictEqual(platform.batteryService.get('StatusLowBattery'), 0);
});

test('the alarm flag shows as contact detected', (t) => {
  const fields = { ...FULL_FIELDS };
  const { platform } = bootPlatform({ transport: 'sim', fields });
  t.after(() => platform.stop());

  platform.onFrame(stateFrame(fields, { probe: 930, target: 930, alarm: 1 }));
  assert.strictEqual(platform.alarmService.get('ContactSensorState'), 0, 'reached');
});

test('a device reporting Fahrenheit is converted to Celsius for HomeKit', (t) => {
  const fields = { ...FULL_FIELDS, scale: 1, unit: 'F' };
  const { platform } = bootPlatform({ transport: 'sim', fields });
  t.after(() => platform.stop());

  platform.onFrame(stateFrame(fields, { probe: 203, target: 225 }));
  // 203 F = 95.0 C, 225 F = 107.2 C
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 95);
  assert.strictEqual(platform.targetService.get('CurrentTemperature'), 107.2);
});

test('derives the alarm from probe vs target when no alarm field is mapped', (t) => {
  const fields = { ...FULL_FIELDS, alarm: '' };
  const { platform } = bootPlatform({ transport: 'sim', fields });
  t.after(() => platform.stop());

  const body = Buffer.alloc(6);
  dplus.writeField(body, fields.probe, 950);
  dplus.writeField(body, fields.target, 930);
  platform.onFrame(dplus.decode(dplus.encode(dplus.FUNC.STATUS_REPORT, body)));
  assert.strictEqual(platform.alarmService.get('ContactSensorState'), 0, 'reached');
});

test('readings go inactive once they are stale', (t) => {
  const fields = { ...FULL_FIELDS };
  const { platform } = bootPlatform({ transport: 'sim', fields, staleSeconds: 60 });
  t.after(() => platform.stop());

  platform.onFrame(stateFrame(fields, { probe: 685, target: 930 }));
  assert.strictEqual(platform.probeService.get('StatusActive'), true);

  platform.state.lastFrameAt = Date.now() - 61_000; // age it past the threshold
  platform.refreshCharacteristics();
  assert.strictEqual(platform.probeService.get('StatusActive'), false);
  assert.strictEqual(platform.probeService.get('StatusFault'), 1);
  // the last known temperature is retained rather than zeroed
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 68.5);
});

test('nothing is published before the first frame arrives', (t) => {
  const { platform } = bootPlatform({ transport: 'sim' });
  t.after(() => platform.stop());
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), undefined);
  assert.strictEqual(platform.probeService.get('StatusActive'), false);
});

test('out-of-range temperatures are clamped to the advertised range', (t) => {
  const fields = { ...FULL_FIELDS, scale: 1, unit: 'C' };
  const { platform } = bootPlatform({ transport: 'sim', fields });
  t.after(() => platform.stop());

  platform.onFrame(stateFrame(fields, { probe: 250, target: 100 }));
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 200);
});

test('a truncated body does not overwrite a good reading', (t) => {
  const fields = { ...FULL_FIELDS };
  const { platform } = bootPlatform({ transport: 'sim', fields });
  t.after(() => platform.stop());

  platform.onFrame(stateFrame(fields, { probe: 685, target: 930 }));
  // body too short to contain the mapped offsets
  platform.onFrame(dplus.decode(dplus.encode(dplus.FUNC.STATUS_REPORT, Buffer.alloc(1))));
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 68.5);
});

test('udp transport receives datagrams and drives the characteristics', async (t) => {
  const dgram = require('dgram');

  // pick a free port by binding and releasing
  const probe = dgram.createSocket('udp4');
  await new Promise((res) => probe.bind(0, '127.0.0.1', res));
  const port = probe.address().port;
  await new Promise((res) => probe.close(res));

  // boot with the real udp transport, so createTransport is exercised too
  const fields = { ...FULL_FIELDS };
  const { platform } = bootPlatform({
    transport: 'udp', listenPort: port, bindAddress: '127.0.0.1', fields,
  });
  t.after(() => platform.stop());

  // wait for the socket to be listening before sending
  for (let i = 0; i < 100 && !platform.transport?.socket; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(platform.transport, 'a transport should have been created');

  const frame = stateFrame(fields, { probe: 685, target: 930, battery: 76 });
  const client = dgram.createSocket('udp4');
  await new Promise((res) =>
    client.send(frame.raw, port, '127.0.0.1', () => client.close(res)));

  for (let i = 0; i < 100 && platform.state.probeC === null; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 68.5);
  assert.strictEqual(platform.targetService.get('CurrentTemperature'), 93);
  assert.strictEqual(platform.batteryService.get('BatteryLevel'), 76);
});

test('wifi state frames are logged but do not disturb the readings', (t) => {
  const fields = { ...FULL_FIELDS };
  const { platform } = bootPlatform({ transport: 'sim', fields });
  t.after(() => platform.stop());

  platform.onFrame(stateFrame(fields, { probe: 685, target: 930 }));
  platform.onFrame(
    dplus.decode(dplus.encode(dplus.FUNC.WIFI_STATE, Buffer.from([3, 0, 1]))),
  );
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), 68.5);
});

test('defaults to the real device, not the simulator', (t) => {
  // A simulator default silently reports fake temperatures on a fresh install.
  const { platform } = bootPlatform({ name: 'Grill' });
  t.after(() => platform.stop());
  assert.strictEqual(platform.transportKind, 'udp');
});

test('simulator mode warns loudly that the readings are fake', (t) => {
  const warnings = [];
  const api = makeApi();
  plugin(api);
  const platform = new ProGradePlatform(
    { ...log, warn: (m) => warnings.push(m) }, { transport: 'sim' }, api,
  );
  api.emit('didFinishLaunching');
  t.after(() => platform.stop());

  assert.ok(warnings.some((w) => /SIMULATOR MODE/.test(w)),
    `expected a simulator warning, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => /fake/i.test(w) && /transport/.test(w)),
    'the warning should say the values are fake and how to fix it');
});

test('a heartbeat frame is reported as idle, not as a mapping error', (t) => {
  const emax = require('../lib/emax');
  const msgs = { warn: [], info: [] };
  const api = makeApi();
  plugin(api);
  const platform = new ProGradePlatform(
    { ...log, warn: (m) => msgs.warn.push(m), info: (m) => msgs.info.push(m) },
    { transport: 'sim' }, api,
  );
  api.emit('didFinishLaunching');
  t.after(() => platform.stop());

  // the real 5-byte heartbeat, three times
  const beat = emax.encode(0x54, Buffer.from('69001122', 'hex'),
    Buffer.from('0101010000', 'hex'));
  for (let i = 0; i < 3; i += 1) platform.onFrame(emax.decode(beat), 'emax');

  assert.ok(msgs.info.some((m) => /heartbeat/.test(m)),
    `expected an idle notice, got ${JSON.stringify(msgs.info)}`);
  assert.ok(!msgs.warn.some((m) => /field mapping|could not read field/.test(m)),
    'a heartbeat must not be reported as a bad field mapping');
  assert.strictEqual(platform.state.probeC, null, 'no reading published');
});

test('an implausible reading from a long body warns', (t) => {
  const emax = require('../lib/emax');
  const warnings = [];
  const api = makeApi();
  plugin(api);
  const platform = new ProGradePlatform(
    { ...log, warn: (m) => warnings.push(m) },
    { transport: 'sim', fields: { ...plugin.DEFAULT_FIELDS, probe: 'be40:41' } },
    api,
  );
  api.emit('didFinishLaunching');
  t.after(() => platform.stop());

  // 0xffff at the mapped offsets -> 6553.5 C
  const body = Buffer.alloc(50);
  body[40] = 0xff; body[41] = 0xff;
  const long = emax.encode(0x54, Buffer.from('69001122', 'hex'), body);
  for (let i = 0; i < 3; i += 1) platform.onFrame(emax.decode(long), 'emax');
  assert.ok(warnings.some((w) => /not a plausible probe temperature/.test(w)),
    `expected a plausibility warning, got ${JSON.stringify(warnings)}`);
});

test('the udp transport echoes datagrams back so the device will report', async (t) => {
  const dgram = require('dgram');
  const emax = require('../lib/emax');
  const { UdpTransport } = require('../lib/transport');

  // stand in for the thermometer: send a heartbeat, expect it echoed back
  const device = dgram.createSocket('udp4');
  await new Promise((res) => device.bind(0, '127.0.0.1', res));
  t.after(() => { try { device.close(); } catch { /* closed */ } });

  const probe = dgram.createSocket('udp4');
  await new Promise((res) => probe.bind(0, '127.0.0.1', res));
  const serverPort = probe.address().port;
  await new Promise((res) => probe.close(res));

  const udp = new UdpTransport({
    port: serverPort, bindAddress: '127.0.0.1', log, ackMinIntervalMs: 0,
  });
  t.after(() => udp.stop());
  await new Promise((res) => { udp.on('up', res); udp.start(); });

  const beat = emax.encode(0x54, Buffer.from('69001122', 'hex'),
    Buffer.from('0101010000', 'hex'));

  const echoed = new Promise((res) => device.once('message', (m) => res(m)));
  device.send(beat, serverPort, '127.0.0.1');

  const back = await echoed;
  assert.deepStrictEqual(back, beat,
    'the device must receive its own frame back verbatim');
});

test('acknowledgement can be turned off, and is rate limited', async (t) => {
  const dgram = require('dgram');
  const emax = require('../lib/emax');
  const { UdpTransport } = require('../lib/transport');

  const device = dgram.createSocket('udp4');
  await new Promise((res) => device.bind(0, '127.0.0.1', res));
  t.after(() => { try { device.close(); } catch { /* closed */ } });
  let received = 0;
  device.on('message', () => { received += 1; });

  const probe = dgram.createSocket('udp4');
  await new Promise((res) => probe.bind(0, '127.0.0.1', res));
  const serverPort = probe.address().port;
  await new Promise((res) => probe.close(res));

  const udp = new UdpTransport({
    port: serverPort, bindAddress: '127.0.0.1', log, acknowledge: false,
  });
  t.after(() => udp.stop());
  await new Promise((res) => { udp.on('up', res); udp.start(); });

  const beat = emax.encode(0x54, Buffer.from('69001122', 'hex'),
    Buffer.from('0101010000', 'hex'));
  device.send(beat, serverPort, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(received, 0, 'nothing should be echoed when disabled');

  // and with a rate floor, a burst produces at most one echo
  const udp2 = new UdpTransport({
    port: serverPort + 1, bindAddress: '127.0.0.1', log,
    ackMinIntervalMs: 10_000,
  });
  t.after(() => udp2.stop());
  await new Promise((res) => { udp2.on('up', res); udp2.start(); });
  received = 0;
  for (let i = 0; i < 5; i += 1) device.send(beat, serverPort + 1, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(received, 1, `expected 1 echo, got ${received}`);
});
