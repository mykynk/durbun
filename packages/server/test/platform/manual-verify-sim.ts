/**
 * Manual real-simulator verification (NOT part of the vitest suite: no *.test.ts suffix).
 * Usage: npx tsx test/platform/manual-verify-sim.ts <udid> <outDir> [actions|lifecycle]
 *   actions   — drive every simctl action + metrics + settings-triggered stream restart
 *   lifecycle — clear-data / install errors, then SHUTS THE SIMULATOR DOWN and checks the
 *               driver marks it disconnected and leaves no child processes behind.
 * Only use a throwaway simulator (xcrun simctl create durbun-test …).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IosSimDriver } from '../../src/platform/ios/simDriver';
import { liveChildCount } from '../../src/platform/exec';
import { createCtx, waitFor } from './helpers';

const udid = process.argv[2]!;
const outDir = process.argv[3]!;
const phase = process.argv[4] ?? 'actions';
const id = `ios-sim:${udid}`;

async function lifecycle() {
  const ctx = createCtx({ settings: { iosSimLogScope: 'apps', iosSimLogLevel: 'info' }, tempDir: outDir });
  const d = new IosSimDriver();
  await d.start(ctx);
  await waitFor(() => ctx.hub.devices.get(id)?.logs.status === 'streaming', 20_000);
  console.log('STREAMING (apps scope)', JSON.stringify(ctx.hub.devices.get(id)?.logs));
  // clear-data really wipes the container
  const container = execFileSync('/usr/bin/xcrun', ['simctl', 'get_app_container', udid, 'com.apple.mobilesafari', 'data'])
    .toString()
    .trim();
  fs.mkdirSync(path.join(container, 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(container, 'Documents', 'durbun-marker.txt'), 'x');
  const cleared = await d.runAction(id, 'app-clear-data', { appId: 'com.apple.mobilesafari' });
  console.log('CLEAR', JSON.stringify(cleared), 'marker exists after:', fs.existsSync(path.join(container, 'Documents', 'durbun-marker.txt')),
    'Library/Preferences exists:', fs.existsSync(path.join(container, 'Library', 'Preferences')));
  // install error paths
  const fakeApp = path.join(outDir, 'Broken.app');
  fs.mkdirSync(fakeApp, { recursive: true });
  console.log('INSTALL broken .app', JSON.stringify(await d.runAction(id, 'app-install', { file: fakeApp })));
  const zip = path.join(outDir, 'empty.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', path.join(outDir, 'entries.json'), zip]);
  console.log('INSTALL zip without app', JSON.stringify(await d.runAction(id, 'app-install', { file: zip })));
  console.log('UNINSTALL missing', JSON.stringify(await d.runAction(id, 'app-uninstall', { appId: 'com.example.notinstalled' })));
  console.log('PUSH bad payload', JSON.stringify(await d.runAction(id, 'push-notification', { appId: 'com.apple.Preferences', payload: { x: 1 } })));
  console.log('UNKNOWN action', JSON.stringify(await d.runAction(id, 'animations', { enabled: true })));
  // Shut the simulator down underneath the driver.
  const t0 = Date.now();
  execFileSync('/usr/bin/xcrun', ['simctl', 'shutdown', udid]);
  await waitFor(() => ctx.hub.disconnected.find((x) => x.id === id), 15_000);
  console.log('DISCONNECTED after', Date.now() - t0, 'ms', JSON.stringify(ctx.hub.disconnected));
  console.log('SYSTEM', JSON.stringify(ctx.hub.system.map((x) => x.input.code)));
  console.log('LIVE CHILDREN', liveChildCount());
  await d.stop();
  console.log('LIVE CHILDREN after stop', liveChildCount());
}

async function main() {
  if (phase === 'lifecycle') return lifecycle();
  const ctx = createCtx({ settings: { iosSimLogScope: 'all', iosSimLogLevel: 'info' }, tempDir: outDir });
  const d = new IosSimDriver();
  const t0 = Date.now();
  await d.start(ctx);
  const dev = await waitFor(() => ctx.hub.devices.get(id), 20_000);
  console.log('DEVICE', JSON.stringify(dev));
  await waitFor(() => ctx.hub.devices.get(id)?.logs.status === 'streaming', 20_000);
  await waitFor(() => ctx.hub.logs.filter((l) => l.deviceId === id).length > 30, 30_000);
  console.log('STREAMING after', Date.now() - t0, 'ms; logs', ctx.hub.logs.length, 'batches', ctx.hub.batches);
  for (const { entry } of ctx.hub.logs.slice(0, 6)) {
    console.log('  LOG', JSON.stringify({ ...entry, message: entry.message.slice(0, 100) }));
  }
  console.log('SYSTEM', JSON.stringify(ctx.hub.system.map((s) => s.input.code)));
  const run = async (action: string, params: Record<string, unknown> = {}) => {
    const s = Date.now();
    const r = await d.runAction(id, action as never, params);
    const data = Array.isArray(r.data) ? `${r.data.length} items, first=${JSON.stringify(r.data[0])}` : JSON.stringify(r.data);
    console.log(`ACTION ${action} ${JSON.stringify(params)} → ok=${r.ok} code=${r.code} msg=${r.message} data=${data} (${Date.now() - s} ms)`);
    return r;
  };
  await run('screenshot');
  await run('list-apps');
  await run('list-apps', { includeSystem: true });
  await run('appearance', { mode: 'dark' });
  await run('appearance', { mode: 'light' });
  await run('font-scale', { scale: 1.3 });
  await run('font-scale', { scale: 1 });
  await run('status-bar', { mode: 'clean' });
  await run('status-bar', { mode: 'reset' });
  await run('location', { lat: 41.0082, lon: 28.9784 });
  await run('open-url', { url: 'https://example.com/?a=1&b=2' });
  await run('app-launch', { appId: 'com.apple.Preferences' });
  d.watchMetrics(id, { processName: 'com.apple.Preferences' }, true);
  await new Promise((r) => setTimeout(r, 5000));
  d.watchMetrics(id, { processName: 'com.apple.Preferences' }, false);
  console.log('METRICS', JSON.stringify(ctx.hub.metrics));
  await run('app-stop', { appId: 'com.apple.Preferences' });
  await run('app-restart', { appId: 'com.apple.Preferences' });
  await run('push-notification', { appId: 'com.apple.Preferences', payload: { aps: { alert: { title: 'Dürbün', body: 'Test bildirimi' } } } });
  await run('app-clear-data', { appId: 'com.apple.mobilesafari' });
  await run('app-uninstall', { appId: 'com.example.notinstalled' });
  await run('screen-record', { durationSec: 2 });
  await run('logs-restart');
  await waitFor(() => ctx.hub.devices.get(id)?.logs.status === 'streaming', 20_000);
  // Settings change → stream restart with the apps predicate.
  const before = ctx.hub.system.length;
  ctx.setSettings({ iosSimLogScope: 'apps' });
  await waitFor(() => ctx.hub.system.slice(before).some((s) => s.input.code === 'logs.streamStarted'), 20_000);
  console.log('SYSTEM after settings change', JSON.stringify(ctx.hub.system.slice(before).map((s) => s.input.code)));
  console.log('STATUS', JSON.stringify(d.status()));
  console.log('CHECKS', JSON.stringify(await d.checks()));
  console.log('LIVE CHILDREN before stop', liveChildCount());
  await d.stop();
  console.log('LIVE CHILDREN after stop', liveChildCount());
  console.log('DISCONNECTED', JSON.stringify(ctx.hub.disconnected));
  const kinds: Record<string, number> = {};
  for (const { entry } of ctx.hub.logs) kinds[entry.level] = (kinds[entry.level] ?? 0) + 1;
  console.log('LEVELS', JSON.stringify(kinds), 'total', ctx.hub.logs.length);
  fs.writeFileSync(path.join(outDir, 'entries.json'), JSON.stringify(ctx.hub.logs.slice(0, 400), null, 1));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('FAILED', e);
    process.exit(1);
  },
);
