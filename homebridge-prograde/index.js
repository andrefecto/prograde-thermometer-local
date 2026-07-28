'use strict';

/**
 * homebridge-prograde — exposes a DTston "D+" grill thermometer
 * (ProGrade WiFi / Bluetooth thermometer and relatives) to HomeKit.
 *
 * HomeKit has no food-probe accessory type, so the mapping is:
 *
 *   probe temperature  -> TemperatureSensor  "Probe"
 *   target temperature -> TemperatureSensor  "Target"        (read-only)
 *   target reached     -> ContactSensor      "Target Reached"
 *   battery            -> Battery service    (level + low-battery warning)
 *
 * Read-only is deliberate: the target is set on the device itself, and the write
 * path is the one part of the protocol not documented for this product.
 * See ../README.md for setup and ../FINDINGS.md for the protocol.
 */

const dplus = require('./lib/dplus');
const { createTransport } = require('./lib/transport');

const PLUGIN_NAME = 'homebridge-prograde';
const PLATFORM_NAME = 'ProGradeThermometer';

// Body layout for the ProGrade EM2251, recovered from a live device and
// confirmed against its own display: the little-endian 16-bit value at body
// offsets 5..6 is the probe temperature in tenths of a degree Celsius
// (raw 914 -> 91.4 C -> 196.5 F, display read 197 F).
//
// The device does NOT transmit its alarm setpoint or a battery level, so those
// are blank. Set `staticTargetC` if you want a target and a "reached" trigger.
// A different unit on the same platform may well use a different layout --
// recover it with ../dplus/udp_listen.py and ../dplus/analyze.py.
const DEFAULT_FIELDS = {
  probe: 'le5:6',
  target: '',
  alarm: '',
  battery: '',
  scale: 0.1,
  offset: 0,
  unit: 'C',
};

let Service;
let Characteristic;

class ProGradePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.cached = new Map();

    this.name = this.config.name || 'Grill Thermometer';
    this.fields = { ...DEFAULT_FIELDS, ...(this.config.fields || {}) };
    this.staleSeconds = this.config.staleSeconds ?? 120;
    this.pollSeconds = this.config.pollSeconds ?? 0;
    this.transportKind = this.config.transport || 'sim';
    // The device does not report its alarm setpoint, so allow one to be set here
    // purely so HomeKit gets a target and a "reached" trigger.
    this.staticTargetC = this.config.staticTargetC ?? null;

    // Latest known state. null means "never seen", which HomeKit shows as
    // not-responding rather than as a wrong reading.
    this.state = {
      probeC: null,
      targetC: null,
      alarm: false,
      batteryPercent: null,
      lastFrameAt: 0,
    };

    if (!api) {
      this.log.error('no Homebridge API handle; plugin cannot start');
      return;
    }
    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  /** Homebridge hands back accessories it restored from its cache. */
  configureAccessory(accessory) {
    this.log.debug(`restoring cached accessory ${accessory.displayName}`);
    this.cached.set(accessory.UUID, accessory);
  }

  start() {
    try {
      this.buildAccessory();
    } catch (err) {
      this.log.error(`could not set up the accessory: ${err.message}`);
      return;
    }

    try {
      this.transport = createTransport(
        { ...this.config, transport: this.transportKind, fields: this.fields },
        this.log,
      );
    } catch (err) {
      this.log.error(`transport setup failed: ${err.message}`);
      return;
    }

    this.transport.on('frame', (frame, format) => this.onFrame(frame, format));
    this.transport.on('up', () => this.log.debug('transport up'));
    this.transport.on('down', (why) => {
      this.log.warn(`transport down: ${why}`);
      this.refreshCharacteristics();
    });
    this.transport.start();

    if (this.pollSeconds > 0) {
      this.pollTimer = setInterval(() => {
        this.transport.send(dplus.encode(dplus.FUNC.STATUS_QUERY));
      }, this.pollSeconds * 1000);
    }

    // Re-evaluate staleness even when nothing arrives, so HomeKit stops showing
    // an hours-old temperature as if it were current.
    this.staleTimer = setInterval(() => this.refreshCharacteristics(), 30000);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.transport) this.transport.stop();
  }

  buildAccessory() {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.name}`);
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;

    if (isNew) {
      accessory = new this.api.platformAccessory(this.name, uuid);
    }

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'ProGrade / DTston')
      .setCharacteristic(Characteristic.Model, 'D+ WiFi Grilling Thermometer')
      .setCharacteristic(
        Characteristic.SerialNumber,
        this.config.host || this.transportKind,
      );

    this.probeService = this.ensureService(
      accessory,
      Service.TemperatureSensor,
      'Probe',
      'probe',
    );
    // The default CurrentTemperature range stops at 100 C, which a probe can
    // exceed. Widen it or HomeKit clamps the reading.
    this.probeService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 200, minStep: 0.1 });

    // Only publish what this device can actually feed. The EM2251 sends
    // temperature alone, so a target needs `staticTargetC`, and without one
    // there is nothing to show -- a permanently blank tile is worse than none.
    const haveTarget = Boolean(this.fields.target) || this.staticTargetC !== null;
    const haveAlarm = Boolean(this.fields.alarm) || haveTarget;
    const haveBattery = Boolean(this.fields.battery);

    if (this.config.exposeTarget !== false && haveTarget) {
      this.targetService = this.ensureService(
        accessory,
        Service.TemperatureSensor,
        'Target',
        'target',
      );
      this.targetService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 200, minStep: 0.1 });
    } else {
      this.removeService(accessory, Service.TemperatureSensor, 'target');
    }

    if (this.config.exposeAlarm !== false && haveAlarm) {
      this.alarmService = this.ensureService(
        accessory,
        Service.ContactSensor,
        'Target Reached',
        'alarm',
      );
    } else {
      this.removeService(accessory, Service.ContactSensor, 'alarm');
    }

    if (this.config.exposeBattery !== false && haveBattery) {
      this.batteryService =
        accessory.getService(Service.Battery) ||
        accessory.addService(Service.Battery, 'Battery');
    } else {
      this.removeService(accessory, Service.Battery);
    }

    this.accessory = accessory;
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`published "${this.name}" to HomeKit`);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    this.refreshCharacteristics();
  }

  ensureService(accessory, type, displayName, subtype) {
    const service =
      accessory.getServiceById(type, subtype) ||
      accessory.addService(type, displayName, subtype);
    service.setCharacteristic(Characteristic.Name, displayName);
    // ConfiguredName is what recent iOS versions actually show for sub-services.
    if (Characteristic.ConfiguredName) {
      const c =
        service.getCharacteristic(Characteristic.ConfiguredName) ||
        service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      if (c && c.updateValue) c.updateValue(displayName);
    }
    return service;
  }

  removeService(accessory, type, subtype) {
    const existing = subtype
      ? accessory.getServiceById(type, subtype)
      : accessory.getService(type);
    if (existing) accessory.removeService(existing);
  }

  onFrame(frame, format = 'dplus') {
    const code = format === 'emax' ? frame.type : frame.func;
    this.log.debug(
      `${format} frame ${frame.name} (0x${code.toString(16)}) ` +
        `body=${frame.body.toString('hex')}`,
    );

    if (format === 'dplus') {
      if (frame.func === dplus.FUNC.WIFI_STATE) {
        try {
          const st = dplus.decodeWifiState(frame.body);
          this.log.debug(
            `wifi: ${st.signalBars}/3 bars, router ${st.routerConnected ? 'up' : 'down'}, ` +
              `cloud ${st.cloudConnected ? 'up' : 'down'}`,
          );
        } catch {
          /* malformed, ignore */
        }
        return;
      }
      if (frame.func !== dplus.FUNC.STATUS_REPORT
          && frame.func !== dplus.FUNC.STATUS_REPLY) {
        return; // not a state frame
      }
    }
    // every emax frame we recognise is a temperature report

    const f = this.fields;
    const conv = { scale: f.scale, offset: f.offset, unit: f.unit };

    const probeRaw = dplus.readField(frame.body, f.probe);
    const probeC = dplus.toCelsius(probeRaw, conv);
    if (probeC !== null && Number.isFinite(probeC)) {
      this.state.probeC = probeC;
      this.state.lastFrameAt = Date.now();
    } else {
      // The mapped offset isn't in this body, so the field config doesn't match
      // this device. Say so once rather than silently publishing nothing.
      this.badFieldFrames = (this.badFieldFrames || 0) + 1;
      if (this.badFieldFrames === 3) {
        this.log.warn(
          `could not read field "${f.probe}" from a ${frame.body.length}-byte ` +
            'body. The field mapping does not match this device -- recover it ' +
            'with dplus/udp_listen.py and dplus/analyze.py.',
        );
      }
    }

    if (f.target) {
      const targetC = dplus.toCelsius(dplus.readField(frame.body, f.target), conv);
      if (targetC !== null && Number.isFinite(targetC)) this.state.targetC = targetC;
    } else if (this.staticTargetC !== null) {
      // The EM2251 keeps its alarm setpoint to itself, so allow a configured one
      this.state.targetC = this.staticTargetC;
    }

    if (f.alarm) {
      const raw = dplus.readField(frame.body, f.alarm);
      if (raw !== null) this.state.alarm = raw !== 0;
    } else if (this.state.targetC !== null && this.state.probeC !== null) {
      this.state.alarm = this.state.probeC >= this.state.targetC;
    }

    if (f.battery) {
      const raw = dplus.readField(frame.body, f.battery);
      if (raw !== null) this.state.batteryPercent = Math.min(100, Math.max(0, raw));
    }

    this.refreshCharacteristics();
  }

  get stale() {
    if (!this.state.lastFrameAt) return true;
    return Date.now() - this.state.lastFrameAt > this.staleSeconds * 1000;
  }

  refreshCharacteristics() {
    if (!this.probeService) return;
    const stale = this.stale;
    const fault = stale
      ? Characteristic.StatusFault.GENERAL_FAULT
      : Characteristic.StatusFault.NO_FAULT;

    const publish = (service, celsius) => {
      if (!service) return;
      service.updateCharacteristic(Characteristic.StatusActive, !stale);
      service.updateCharacteristic(Characteristic.StatusFault, fault);
      if (celsius === null) return;
      // clamp into the range we advertised so HAP never rejects the value
      const clamped = Math.min(200, Math.max(-50, celsius));
      service.updateCharacteristic(
        Characteristic.CurrentTemperature,
        Math.round(clamped * 10) / 10,
      );
    };

    publish(this.probeService, this.state.probeC);
    publish(this.targetService, this.state.targetC);

    if (this.alarmService) {
      this.alarmService.updateCharacteristic(
        Characteristic.ContactSensorState,
        this.state.alarm
          ? Characteristic.ContactSensorState.CONTACT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      );
      this.alarmService.updateCharacteristic(Characteristic.StatusActive, !stale);
    }

    if (this.batteryService && this.state.batteryPercent !== null) {
      const pct = this.state.batteryPercent;
      this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, pct);
      this.batteryService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        pct <= 20
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ProGradePlatform);
};

// exported for testing without a running Homebridge
module.exports.ProGradePlatform = ProGradePlatform;
module.exports.DEFAULT_FIELDS = DEFAULT_FIELDS;
module.exports.PLATFORM_NAME = PLATFORM_NAME;
