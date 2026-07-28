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

test('warns when the field mapping does not fit the body', (t) => {
  const emax = require('../lib/emax');
  const warnings = [];
  const api = makeApi();
  plugin(api);
  const noisyLog = { ...log, warn: (m) => warnings.push(m) };
  const platform = new ProGradePlatform(noisyLog,
    { transport: 'sim', fields: { ...plugin.DEFAULT_FIELDS, probe: 'be40:41' } },
    api);
  api.emit('didFinishLaunching');
  t.after(() => platform.stop());

  for (let i = 0; i < 3; i += 1) platform.onFrame(emax.decode(REAL_FRAME), 'emax');
  assert.ok(warnings.some((w) => /could not read field/.test(w)),
    `expected a mapping warning, got ${JSON.stringify(warnings)}`);
  assert.strictEqual(platform.probeService.get('CurrentTemperature'), undefined);
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
