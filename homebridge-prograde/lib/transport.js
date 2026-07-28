'use strict';

/**
 * Transports that deliver D+ frames to the plugin.
 *
 *   udp - what the real device uses. Its WiFi module runs in transparent
 *         passthrough mode and pushes the thermometer's raw UART frames to
 *         whichever host AT+NETP names.
 *   sim - synthesise a plausible cook so HomeKit can be tested with no
 *         hardware and no pairing.
 *
 * Both emit the same events, so index.js does not care which is in use:
 *   'frame'  (decodedFrame)   a valid D+ frame arrived
 *   'up'     ()               transport ready
 *   'down'   (reasonString)   transport lost
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');
const dplus = require('./dplus');
const emax = require('./emax');

/**
 * Listen for the device's telemetry over UDP.
 *
 * This is the transport the stock firmware actually uses. The module runs in
 * transparent passthrough mode with AT+NETP set to
 * "UDP,CLIENT,<port>,<host>", so it pushes the thermometer's raw D+ UART frames
 * as UDP payloads to whichever host is configured. Point AT+NETP at the machine
 * running Homebridge and no interception is needed anywhere.
 *
 * We are the server here: bind the port and wait. The device's address is
 * learned from the first datagram, so replies (e.g. a status poll) can be sent
 * back to it without configuring an address.
 */
class UdpTransport extends EventEmitter {
  constructor({ port, bindAddress = '0.0.0.0', log, deviceAddress = null }) {
    super();
    Object.assign(this, { port, bindAddress, log, deviceAddress });
    this.socket = null;
    this.streams = new Map(); // per-sender reassembly
  }

  start() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('listening', () => {
      const a = socket.address();
      this.log.info(`listening for device telemetry on udp ${a.address}:${a.port}`);
      this.emit('up');
    });

    socket.on('message', (msg, rinfo) => {
      this.deviceAddress = rinfo;
      const key = `${rinfo.address}:${rinfo.port}`;
      let streams = this.streams.get(key);
      if (!streams) {
        // One parser per format. The EM2251 sends 'emax'; 'dplus' is kept for
        // sibling products on the same platform that use the generic framing.
        streams = { emax: new emax.FrameStream(), dplus: new dplus.FrameStream() };
        this.streams.set(key, streams);
      }

      // UDP preserves message boundaries, so pick the parser from the first byte
      const first = msg[0];
      let frames = [];
      if (first === emax.START || first === emax.END) {
        frames = streams.emax.push(msg).map((f) => ({ format: 'emax', frame: f }));
      } else if (first === dplus.HEADER) {
        frames = streams.dplus.push(msg).map((f) => ({ format: 'dplus', frame: f }));
      }

      if (!frames.length) {
        this.log.debug(
          `udp ${key}: ${msg.length}B undecoded: ${msg.toString('hex')}`,
        );
      }
      for (const { format, frame } of frames) this.emit('frame', frame, format);
    });

    socket.on('error', (err) => {
      this.log.error(`udp socket error: ${err.message}`);
      this.emit('down', err.message);
    });

    socket.bind(this.port, this.bindAddress);
  }

  /** Send a frame back to whichever address last talked to us. */
  send(frame) {
    if (!this.socket || !this.deviceAddress) return;
    this.socket.send(frame, this.deviceAddress.port, this.deviceAddress.address);
  }

  stop() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
    }
    this.socket = null;
    this.streams.clear();
  }
}

/**
 * Simulated thermometer. Runs a believable cook: the probe climbs toward the
 * target with a slowing curve (and a stall, because real brisket does that),
 * then trips the alarm. Frames are built in exactly the layout the config
 * declares and pushed through the real decoder, so this exercises the whole
 * path apart from the socket itself.
 */
class SimTransport extends EventEmitter {
  constructor({ log, fields, intervalMs = 5000, startC = 20, targetC = 93 }) {
    super();
    Object.assign(this, { log, fields, intervalMs, startC, targetC });
    this.probeC = startC;
    this.timer = null;
    this.ticks = 0;
  }

  start() {
    this.log.info('simulator running: no device, no network, no pairing');
    this.emit('up');
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    setImmediate(() => this.tick());
  }

  tick() {
    this.ticks += 1;
    const remaining = this.targetC - this.probeC;
    // stall between roughly 65 and 70 C, like a real cook
    const stalling = this.probeC > 65 && this.probeC < 70;
    const rate = stalling ? 0.04 : Math.max(0.08, remaining * 0.05);
    this.probeC = Math.min(this.targetC + 2, this.probeC + rate);

    // Only the fields actually mapped exist in the body. On the EM2251 the
    // device reports temperature alone, so target/alarm/battery are blank.
    const f = this.fields;
    const mapped = ['probe', 'target', 'alarm', 'battery'].filter((k) => f[k]);
    const size = Math.max(...mapped.map((k) => dplus.fieldExtent(f[k]))) + 1;
    const body = Buffer.alloc(size);

    const toRaw = (celsius) => {
      const native = f.unit.toUpperCase() === 'F' ? celsius * 1.8 + 32 : celsius;
      return (native - f.offset) / f.scale;
    };

    dplus.writeField(body, f.probe, toRaw(this.probeC));
    if (f.target) dplus.writeField(body, f.target, toRaw(this.targetC));
    if (f.alarm) {
      dplus.writeField(body, f.alarm, this.probeC >= this.targetC ? 1 : 0);
    }
    if (f.battery) {
      dplus.writeField(body, f.battery, Math.max(5, 100 - this.ticks));
    }

    this.emit('frame', dplus.decode(dplus.encode(dplus.FUNC.STATUS_REPORT, body)));
  }

  send() {
    /* the simulator ignores commands */
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function createTransport(config, log) {
  switch (config.transport) {
    case 'udp':
      return new UdpTransport({
        port: config.listenPort || 17000,
        bindAddress: config.bindAddress || '0.0.0.0',
        log,
      });
    case 'sim':
      return new SimTransport({ log, fields: config.fields });
    default:
      throw new Error(
        `unknown transport "${config.transport}"; use udp or sim`,
      );
  }
}

module.exports = {
  createTransport,
  UdpTransport,
  SimTransport,
};
