#!/usr/bin/env node
'use strict';

/**
 * Run the simulator on its own and print what the plugin would publish to
 * HomeKit. Useful for sanity-checking the field mapping before restarting
 * Homebridge, and for seeing the pipeline work with no device attached.
 *
 *   node tools/sim-run.js
 *   node tools/sim-run.js --unit F --scale 1
 */

const dplus = require('../lib/dplus');
const { SimTransport } = require('../lib/transport');
const { DEFAULT_FIELDS } = require('../index');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const fields = {
  ...DEFAULT_FIELDS,
  ...(args.probe ? { probe: args.probe } : {}),
  ...(args.target ? { target: args.target } : {}),
  ...(args.scale ? { scale: Number(args.scale) } : {}),
  ...(args.offset ? { offset: Number(args.offset) } : {}),
  ...(args.unit ? { unit: args.unit } : {}),
};

const log = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.log(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
  debug: () => {},
};

console.log('field mapping:', JSON.stringify(fields));
console.log('interval: 2s, Ctrl-C to stop\n');

const sim = new SimTransport({
  log,
  fields,
  intervalMs: 2000,
  startC: 20,
  targetC: 93,
});

const conv = { scale: fields.scale, offset: fields.offset, unit: fields.unit };

sim.on('frame', (frame) => {
  const probeC = dplus.toCelsius(dplus.readField(frame.body, fields.probe), conv);
  const targetC = dplus.toCelsius(dplus.readField(frame.body, fields.target), conv);
  const alarm = dplus.readField(frame.body, fields.alarm);
  const battery = dplus.readField(frame.body, fields.battery);
  const f = (c) => (c * 9) / 5 + 32;

  console.log(
    `${frame.name}  body=${frame.body.toString('hex')}  ` +
      `probe=${probeC.toFixed(1)}C/${f(probeC).toFixed(0)}F  ` +
      `target=${targetC.toFixed(1)}C/${f(targetC).toFixed(0)}F  ` +
      `reached=${alarm ? 'yes' : 'no'}  battery=${battery}%`,
  );
});

sim.start();
process.on('SIGINT', () => {
  sim.stop();
  console.log('\nstopped');
  process.exit(0);
});
