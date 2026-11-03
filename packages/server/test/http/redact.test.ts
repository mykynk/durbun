/**
 * Dart VM service auth tokens never reach a diagnostics log line (the Mac app copies every line into
 * main.log, which users share): unit cases, the logger wrapper, and the wiring in startServer.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlutterVmModule, Logger } from '../../src/types';
import { startServerWith, type StartedServer } from '../../src/server';
import { redactingLogger } from '../../src/util/logger';
import { redactLogArg, redactSecrets } from '../../src/util/redact';
import { FakeDriver, FakeHub, FakeSdk, makeTempDir } from './fakes';

function recorder(lines: string[], scope = ''): Logger {
  const write = (level: string) => (message: string, ...args: unknown[]) =>
    lines.push(`${level}${scope} ${message}${args.length ? ` ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} | ${a.stack ?? ''}` : String(a))).join(' ')}` : ''}`);
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error'), child: (s) => recorder(lines, `${scope}[${s}]`) };
}

describe('VM service token redaction', () => {
  it('masks the token of service, WebSocket, DDS and DevTools URLs and keeps the rest', () => {
    expect(redactSecrets('http://127.0.0.1:5555/AbC=/')).toBe('http://127.0.0.1:5555/•••/');
    expect(redactSecrets('attached to pati (pid 4321) at ws://127.0.0.1:50300/7eDf_fKkFnM=/ws via DDS')).toBe(
      'attached to pati (pid 4321) at ws://127.0.0.1:50300/•••/ws via DDS',
    );
    expect(redactSecrets('VM service redirected ws://127.0.0.1:5555/xGm5ma3sRbA=/ws → ws://127.0.0.1:61234/Q-9sa_Lx2b0=/ws')).toBe(
      'VM service redirected ws://127.0.0.1:5555/•••/ws → ws://127.0.0.1:61234/•••/ws',
    );
    expect(redactSecrets('http://127.0.0.1:61234/AbCdEfGhIjk=/devtools/?uri=ws://127.0.0.1:61234/AbCdEfGhIjk=/ws')).toBe(
      'http://127.0.0.1:61234/•••/devtools/?uri=ws://127.0.0.1:61234/•••/ws',
    );
    expect(redactSecrets('open http://127.0.0.1:9100?uri=http%3A%2F%2F127.0.0.1%3A5555%2FAbC%3D%2F&x=1')).toBe(
      'open http://127.0.0.1:9100?uri=http%3A%2F%2F127.0.0.1%3A5555%2F•••%2F&x=1',
    );
    expect(redactSecrets('ws://[::1]:5555/AbC-x_9==/ws, ws://localhost:5555/tok=')).toBe('ws://[::1]:5555/•••/ws, ws://localhost:5555/•••');
    expect(redactSecrets('The Dart VM service is listening on //127.0.0.1:41935/Ab0-c_d1E2f=/')).toBe('The Dart VM service is listening on //127.0.0.1:41935/•••/');
    // nothing that looks like a token: unchanged
    for (const text of ['GET https://api.pati.app/v1/pets?page=2 → 200', 'ws://127.0.0.1:5555/ws', 'a == b', 'http://x/y=z/']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it('the logger wrapper masks messages, string and Error arguments and child loggers, without touching the Error', () => {
    const lines: string[] = [];
    const logger = redactingLogger(recorder(lines));
    const err = Object.assign(new Error('Too many redirects while connecting to ws://127.0.0.1:5555/AbC=/ws'), { code: 'EREDIRECT' });
    logger.child('flutter-vm').warn('auto-attach to http://127.0.0.1:5555/AbC=/ failed', 'url ws://127.0.0.1:5555/AbC=/ws', err, 42);
    logger.info('plain line');
    expect(lines.join('\n')).not.toContain('AbC=');
    expect(lines[0]).toMatch(/^warn\[flutter-vm\] auto-attach to http:\/\/127\.0\.0\.1:5555\/•••\/ failed url ws:\/\/127\.0\.0\.1:5555\/•••\/ws Error: Too many redirects while connecting to ws:\/\/127\.0\.0\.1:5555\/•••\/ws \| /);
    expect(lines[1]).toBe('info plain line');
    expect(err.message).toContain('AbC='); // the caller's error is not modified
    expect((redactLogArg(err) as NodeJS.ErrnoException).code).toBe('EREDIRECT');
    const clean = new Error('nothing secret');
    expect(redactLogArg(clean)).toBe(clean);
  });
});

describe('startServer logs through the redacting logger', () => {
  let dir: string;
  let running: StartedServer | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a module logging a VM service URL through its context logger writes no token to the embedder\'s logger', async () => {
    dir = await makeTempDir('durbun-redact-');
    const lines: string[] = [];
    const vm: FlutterVmModule = {
      start: async (ctx) => {
        ctx.logger.info('attached to pati (pid 4321) at ws://127.0.0.1:50300/7eDf_fKkFnM=/ws');
        ctx.logger.child('session').debug('VM service redirected', new Error('to ws://127.0.0.1:61234/Q-9sa_Lx2b0=/ws'));
      },
      stop: async () => {},
      status: () => ({ id: 'flutter-vm', available: true, active: true }),
      checks: async () => [],
      attach: async () => ({ appId: 'app:1' }),
      detach: async () => {},
    };
    running = await startServerWith(
      { httpPort: 0, sdkPort: 39_771, demo: false, dataDir: path.join(dir, 'data'), verbose: false },
      {
        createHub: () => new FakeHub(),
        createSdkLayer: () => new FakeSdk(),
        createPlatform: () => ({ drivers: [new FakeDriver('android', 'android:')], services: { forwardToDevice: async () => ({ host: '127.0.0.1', port: 1, dispose: async () => {} }) } }),
        createFlutterVmModule: () => vm,
        createDemoDriver: () => new FakeDriver('demo', 'demo:'),
      },
      { logger: recorder(lines), moduleDir: dir, driverStartWaitMs: 500 },
    );
    const vmLines = lines.filter((l) => l.includes('VM service') || l.includes('attached to'));
    expect(vmLines).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(/7eDf_fKkFnM|Q-9sa_Lx2b0/);
    expect(vmLines[0]).toContain('ws://127.0.0.1:50300/•••/ws');
  });
});
