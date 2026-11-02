import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findAppWindowBrowser,
  helpText,
  main,
  openCommands,
  paint,
  parseArgs,
  portBusyMessage,
  probeDurbun,
  renderBanner,
  shouldColor,
  type CliIo,
} from '../../src/cli';
import type { StartedServer } from '../../src/server';

const ANSI = /\x1b\[/;

function io(): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l), color: false };
}

describe('parseArgs', () => {
  it('uses the SPEC defaults', () => {
    expect(parseArgs([])).toEqual({
      kind: 'run',
      options: { port: 9750, sdkPort: 9751, demo: false, open: true, dataDir: path.join(os.homedir(), '.durbun'), verbose: false },
    });
  });

  it('parses every flag, in both --flag value and --flag=value forms', () => {
    const r = parseArgs(['--port', '9760', '--sdk-port=9761', '--lan', '--demo', '--no-open', '--data-dir', '~/durbun-data', '--ui-dir=./dist/ui', '--verbose']);
    expect(r).toEqual({
      kind: 'run',
      options: {
        port: 9760,
        sdkPort: 9761,
        lan: true,
        demo: true,
        open: false,
        dataDir: path.join(os.homedir(), 'durbun-data'),
        uiDir: path.resolve('./dist/ui'),
        verbose: true,
      },
    });
    expect(parseArgs(['-p', '8000'])).toMatchObject({ options: { port: 8000 } });
    expect(parseArgs(['--no-lan'])).toMatchObject({ options: { lan: false } });
    expect(parseArgs(['--debug'])).toMatchObject({ options: { verbose: true } });
  });

  it('handles help and version', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--demo', '-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
  });

  it('explains mistakes', () => {
    expect(parseArgs(['--prot', '9000'])).toEqual({ kind: 'error', message: 'Unknown option --prot (did you mean --port?)' });
    expect(parseArgs(['--port'])).toEqual({ kind: 'error', message: '--port needs a value' });
    expect(parseArgs(['--port', '--demo'])).toEqual({ kind: 'error', message: '--port needs a value' });
    expect(parseArgs(['--port', '70000'])).toMatchObject({ kind: 'error', message: expect.stringContaining('between 1 and 65535') });
    expect(parseArgs(['--port', '9751'])).toEqual({ kind: 'error', message: '--port and --sdk-port must be different' });
    expect(parseArgs(['--demo=yes'])).toEqual({ kind: 'error', message: '--demo does not take a value' });
    expect(parseArgs(['start'])).toEqual({ kind: 'error', message: 'Unexpected argument "start"' });
    expect(parseArgs(['--zzzzzzzz'])).toEqual({ kind: 'error', message: 'Unknown option --zzzzzzzz' });
  });
});

describe('output', () => {
  const banner = {
    url: 'http://localhost:9750',
    info: { version: '0.1.0', ports: { http: 9750, sdk: 9751 }, demo: false, lan: true, hostAddresses: ['192.168.1.20'] },
    warnings: ['The web UI is not built yet: run "npm run build"'],
    dataDir: path.join(os.homedir(), '.durbun'),
    sdkListening: true,
  };

  it('renders a bilingual banner without colors when not a TTY', () => {
    const text = renderBanner(banner, paint(false));
    expect(text).not.toMatch(ANSI);
    expect(text).toContain('http://localhost:9750');
    expect(text).toContain('127.0.0.1:9751');
    expect(text).toContain('192.168.1.20:9751');
    expect(text).toContain('~/.durbun');
    expect(text).toContain('Sonraki adımlar · Next steps');
    expect(text).toContain('durbun --demo');
    expect(text).toContain('⚠ The web UI is not built yet');
    expect(text).toContain('Ctrl+C');
  });

  it('uses ANSI colors only when enabled', () => {
    expect(renderBanner(banner, paint(true))).toMatch(ANSI);
    expect(helpText(paint(false))).not.toMatch(ANSI);
    expect(helpText()).toContain('--sdk-port');
  });

  it('decides on colors from TTY + NO_COLOR/FORCE_COLOR', () => {
    expect(shouldColor({ isTTY: true }, {})).toBe(true);
    expect(shouldColor({ isTTY: false }, {})).toBe(false);
    expect(shouldColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(shouldColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
  });

  it('explains a busy port', () => {
    const msg = portBusyMessage(9750);
    expect(msg).toContain('lsof -nP -iTCP:9750 -sTCP:LISTEN');
    expect(msg).toContain('durbun --port 9760');
  });
});

describe('opening the UI', () => {
  it('prefers the first installed Chromium browser for an app window', () => {
    const installed = (apps: string[]) => (p: string) => apps.includes(p);
    expect(findAppWindowBrowser(installed(['/Applications/Brave Browser.app']), '/Users/y')).toBe('Brave Browser');
    expect(findAppWindowBrowser(installed(['/Applications/Brave Browser.app', '/Applications/Google Chrome.app']), '/Users/y')).toBe('Google Chrome');
    expect(findAppWindowBrowser(installed(['/Users/y/Applications/Arc.app']), '/Users/y')).toBe('Arc');
    expect(findAppWindowBrowser(installed(['/Applications/Safari.app']), '/Users/y')).toBeUndefined();
  });

  it('builds open commands per platform', () => {
    expect(openCommands('http://localhost:9750', 'darwin', 'Brave Browser')).toEqual([
      { cmd: 'open', args: ['-na', 'Brave Browser', '--args', '--app=http://localhost:9750'], how: 'Brave Browser uygulama penceresi · app window' },
      { cmd: 'open', args: ['http://localhost:9750'], how: 'varsayılan tarayıcı · default browser' },
    ]);
    expect(openCommands('http://localhost:9750', 'darwin')).toHaveLength(1);
    expect(openCommands('http://localhost:9750', 'linux')[0]!.cmd).toBe('xdg-open');
  });
});

describe('main', () => {
  it('prints help, version and argument errors with exit codes', async () => {
    const a = io();
    expect(await main(['--help'], a)).toBe(0);
    expect(a.lines.join('\n')).toContain('Kullanım · Usage');
    const b = io();
    expect(await main(['--version'], b)).toBe(0);
    expect(b.lines).toEqual(['0.1.0']);
    const c = io();
    expect(await main(['--bogus'], c)).toBe(2);
    expect(c.errors[0]).toContain('Unknown option --bogus');
    expect(c.errors[1]).toContain('durbun --help');
  });

  it('detects an already running Dürbün and exits 0 without starting another', async () => {
    const fake = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: 'durbun', version: '0.1.0' }));
      } else res.end();
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    const port = (fake.address() as { port: number }).port;
    try {
      expect(await probeDurbun(port)).toEqual({ version: '0.1.0' });
      const out = io();
      expect(await main(['--port', String(port), '--sdk-port', String(port === 9751 ? 9752 : 9751), '--no-open'], out)).toBe(0);
      expect(out.lines[0]).toContain('Dürbün zaten çalışıyor');
      expect(out.lines[0]).toContain(`http://localhost:${port}`);
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });

  it('a Ctrl+C while the server is still starting waits for the start, then stops it (no banner)', async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r())); // free port: nothing answers /api/health

    let resolveStart!: (s: StartedServer) => void;
    let startCalled = false;
    let stops = 0;
    const exits: number[] = [];
    const fakeServer = {
      url: `http://localhost:${port}`,
      info: { version: '0.1.0', ports: { http: port, sdk: 9751 }, demo: false, lan: false, hostAddresses: [] },
      warnings: [],
      dataDir: '/tmp/durbun',
      sdkListening: true,
      stop: async () => {
        stops++;
      },
    } as unknown as StartedServer;
    const out = io();
    const before = process.listenerCount('SIGHUP');
    const running = main(['--port', String(port), '--sdk-port', String(port === 9751 ? 9752 : 9751), '--no-open'], out, {
      startServer: () => {
        startCalled = true;
        return new Promise<StartedServer>((r) => (resolveStart = r));
      },
      exit: (code) => exits.push(code),
    });
    for (let i = 0; i < 100 && !startCalled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(startCalled).toBe(true);
    expect(process.listenerCount('SIGHUP')).toBe(before + 1); // handlers are in place before the start finishes
    process.emit('SIGHUP', 'SIGHUP');
    await new Promise((r) => setTimeout(r, 20));
    expect(stops).toBe(0); // nothing to stop yet
    resolveStart(fakeServer);
    expect(await running).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(stops).toBe(1);
    expect(exits).toEqual([0]);
    expect(out.lines.join('\n')).not.toContain('Arayüz · UI');
    expect(out.errors.join('\n')).toContain('Kapatılıyor');
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      for (const l of process.listeners(s).slice(before)) process.off(s, l as () => void);
    }
  });

  it('probeDurbun ignores other HTTP servers and closed ports', async () => {
    const other = http.createServer((_req, res) => res.end('{"ok":true,"name":"something-else"}'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const port = (other.address() as { port: number }).port;
    expect(await probeDurbun(port)).toBeUndefined();
    await new Promise<void>((r) => other.close(() => r()));
    expect(await probeDurbun(port, 300)).toBeUndefined();
  });
});
