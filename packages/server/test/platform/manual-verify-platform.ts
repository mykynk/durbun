/**
 * Manual check of createPlatform() against the real tools of this machine (adb, xcrun, usbmuxd,
 * idevicesyslog). Read-only: lists devices, prints driver status + doctor checks, then stops.
 * Usage: npx tsx test/platform/manual-verify-platform.ts
 */
import { createPlatform } from '../../src/platform';
import { Adb } from '../../src/platform/android/adb';
import { parseAdbDevices } from '../../src/platform/android/parsers';
import { liveChildCount } from '../../src/platform/exec';
import { resolveAdb } from '../../src/platform/tools';
import { createCtx } from './helpers';

async function main() {
  const tool = resolveAdb({});
  if (tool) {
    const adb = new Adb(tool);
    console.log('ADB', tool.path, tool.source, await adb.version());
    const r = await adb.devices();
    console.log('ADB DEVICES ok=%s rows=%j raw=%j', r.ok, parseAdbDevices(r.stdout), r.stdout);
  } else console.log('ADB not found');

  const ctx = createCtx();
  const platform = createPlatform();
  const t0 = Date.now();
  await Promise.all(platform.drivers.map((d) => d.start(ctx)));
  console.log('STARTED in', Date.now() - t0, 'ms');
  await new Promise((r) => setTimeout(r, 4500));
  for (const d of platform.drivers) {
    console.log('STATUS', JSON.stringify(d.status()));
    console.log('CHECKS', JSON.stringify(await d.checks()));
  }
  console.log('DEVICES', JSON.stringify([...ctx.hub.devices.values()].map((d) => [d.id, d.state, d.logs.status])));
  const sim = await platform.services.forwardToDevice('ios-sim:ABC', 50123);
  console.log('FORWARD sim', JSON.stringify({ host: sim.host, port: sim.port }));
  await platform.services.forwardToDevice('ios:not-connected', 1).catch((e: Error) => console.log('FORWARD ios error:', e.message));
  await platform.services.forwardToDevice('demo:1', 1).catch((e: Error) => console.log('FORWARD demo error:', e.message));
  await Promise.all(platform.drivers.map((d) => d.stop()));
  console.log('STOPPED; live children', liveChildCount());
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('FAILED', e);
    process.exit(1);
  },
);
