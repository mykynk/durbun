import net from 'node:net';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ToolCheck } from '@durbun/protocol';
import { checkNodeVersion, checkPort, mergeChecks, probePort, runDoctor } from '../../src/doctor';
import { makeTempDir } from './fakes';

function listenEphemeral(): Promise<net.Server> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('doctor', () => {
  it('checks the Node.js version', () => {
    expect(checkNodeVersion('22.23.4')).toMatchObject({ id: 'node', status: 'ok', version: 'v22.23.4' });
    expect(checkNodeVersion('v18.19.0')).toMatchObject({ status: 'error', fix: 'brew install node' });
    expect(checkNodeVersion('22.23.4', undefined)).not.toHaveProperty('code');
  });

  it('inside Dürbün.app (process.versions.electron) the node check says it is embedded', () => {
    expect(checkNodeVersion('22.20.0', '39.2.3')).toEqual({
      id: 'node',
      label: 'Node.js',
      status: 'ok',
      version: 'v22.20.0',
      path: process.execPath,
      code: 'doctor.node.embedded',
      params: { electron: '39.2.3', node: '22.20.0' },
      detail: 'Embedded in Dürbün.app (Electron 39.2.3, Node 22.20.0)',
    });
    // too old cannot be fixed with Homebrew there: the app has to be updated
    const old = checkNodeVersion('v18.19.0', '28.0.0');
    expect(old).toMatchObject({ status: 'error', code: 'doctor.node.embedded', params: { electron: '28.0.0', node: '18.19.0' } });
    expect(old.detail).toContain('update the app');
    expect(old).not.toHaveProperty('fix');
  });

  it('probes ports and reports bind failures with a lsof fix', async () => {
    const busy = await listenEphemeral();
    const port = (busy.address() as net.AddressInfo).port;
    expect(await probePort(port)).toBe('in-use');
    expect(await checkPort({ id: 'port-sdk', label: 'SDK port', port, host: '127.0.0.1', state: 'unknown' })).toMatchObject({
      status: 'warn',
      fix: `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    });
    await new Promise<void>((r) => busy.close(() => r()));
    expect(await probePort(port)).toBe('free');
    expect(await checkPort({ id: 'port-sdk', label: 'SDK port', port, host: '127.0.0.1', state: 'failed', error: 'Port in use' })).toMatchObject({
      status: 'error',
      detail: 'Port in use',
    });
    expect(await checkPort({ id: 'port-http', label: 'HTTP', port: 9750, host: '127.0.0.1', state: 'listening' })).toMatchObject({ status: 'ok' });
  });

  it('aggregates driver checks, isolating failures and hangs, and merges duplicates by worst status', async () => {
    const dataDir = await makeTempDir('durbun-doctor-');
    const checks = await runDoctor({
      nodeVersion: '22.1.0',
      dataDir,
      uiDir: null,
      timeoutMs: 100,
      ports: [{ id: 'port-http', label: 'HTTP port 9750', port: 9750, host: '127.0.0.1', state: 'listening' }],
      drivers: [
        {
          id: 'android',
          checks: async (): Promise<ToolCheck[]> => [
            { id: 'adb', label: 'adb', status: 'ok', version: '1.0.41', path: '/opt/homebrew/bin/adb' },
            { id: 'xcrun', label: 'xcrun', status: 'ok' },
          ],
        },
        {
          id: 'ios-sim',
          checks: async (): Promise<ToolCheck[]> => [
            { id: 'xcrun', label: 'Xcode command line tools', status: 'missing', fix: 'xcode-select --install' },
            { id: 'weird', label: 'Weird', status: 'fine' as ToolCheck['status'] },
            { nope: true } as unknown as ToolCheck,
          ],
        },
        {
          id: 'ios-device',
          checks: async () => {
            throw new Error('usbmuxd socket missing');
          },
        },
        { id: 'demo', checks: () => new Promise<ToolCheck[]>(() => {}) },
      ],
      vm: { checks: async () => [{ id: 'flutter', label: 'Flutter', status: 'ok', version: '3.38.0' }] },
    });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(checks.map((c) => c.id)).toEqual(['node', 'data-dir', 'ui-build', 'port-http', 'adb', 'xcrun', 'weird', 'driver-ios-device-checks', 'driver-demo-checks', 'flutter']);
    expect(byId.xcrun).toMatchObject({ status: 'missing', fix: 'xcode-select --install' });
    expect(byId.weird).toMatchObject({ status: 'warn' });
    expect(byId['driver-ios-device-checks']).toMatchObject({ status: 'error', label: 'iOS device', detail: 'Checks failed: usbmuxd socket missing' });
    expect(byId['driver-demo-checks']!.detail).toMatch(/timed out/);
    expect(byId['ui-build']).toMatchObject({ status: 'warn', fix: 'npm run build' });
    expect(byId['data-dir']).toMatchObject({ status: 'ok', path: dataDir });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('mergeChecks keeps the first entry on equal status', () => {
    const merged = mergeChecks([
      { id: 'a', label: 'first', status: 'warn' },
      { id: 'a', label: 'second', status: 'warn' },
      { id: 'a', label: 'third', status: 'ok' },
    ]);
    expect(merged).toEqual([{ id: 'a', label: 'first', status: 'warn' }]);
  });
});
