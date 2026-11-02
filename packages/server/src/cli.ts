/**
 * `durbun` command line (SPEC §5.8):
 *   durbun [--port 9750] [--sdk-port 9751] [--lan] [--demo] [--no-open] [--data-dir ~/.durbun]
 *          [--ui-dir PATH] [--verbose] [--help] [--version]
 * Starts the server, prints a bilingual (Turkish · English) banner and opens the UI — on macOS in a
 * Chromium "app window" when one of the known browsers is installed. If the port already belongs to a
 * running Dürbün, it just opens that one and exits.
 *
 * The module runs `runCli()` only when executed directly (node dist/durbun.mjs, tsx src/cli.ts);
 * bin/durbun.mjs imports the bundle and calls `runCli()` itself; tests import the helpers.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORTS } from '@durbun/protocol';
import { defaultDataDir, expandHome, tildify } from './config';
import { errorMessage } from './http/util';
import { installShutdownHandlers, ServerStartError, startServer, type StartedServer } from './server';
import type { StartServerOptions } from './types';
import { createLogger, setLogLevel } from './util/logger';
import { SERVER_VERSION } from './version';

/* ────────────────────────────── arguments ────────────────────────────── */

export interface CliOptions {
  port: number;
  sdkPort: number;
  /** undefined = use settings.allowLan. */
  lan?: boolean;
  demo: boolean;
  open: boolean;
  dataDir: string;
  uiDir?: string;
  verbose: boolean;
}

export type ParsedArgs =
  | { kind: 'run'; options: CliOptions }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

const VALUE_FLAGS = ['--port', '--sdk-port', '--data-dir', '--ui-dir'] as const;
const BOOLEAN_FLAGS = ['--lan', '--no-lan', '--demo', '--open', '--no-open', '--verbose', '--help', '--version'] as const;
const KNOWN_FLAGS = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

function suggestion(flag: string): string {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(flag, known);
    if (d < bestDistance) {
      bestDistance = d;
      best = known;
    }
  }
  return best && bestDistance <= 3 ? ` (did you mean ${best}?)` : '';
}

export function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,5}$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n >= 1 && n <= 65_535 ? n : undefined;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const o: CliOptions = {
    port: DEFAULT_PORTS.http,
    sdkPort: DEFAULT_PORTS.sdk,
    demo: false,
    open: true,
    dataDir: defaultDataDir(),
    verbose: false,
  };
  const error = (message: string): ParsedArgs => ({ kind: 'error', message });

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inline: string | undefined;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === '-h') arg = '--help';
    else if (arg === '-v' || arg === '-V') arg = '--version';
    else if (arg === '-p') arg = '--port';
    else if (arg === '--debug') arg = '--verbose';

    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          value = next;
          i++;
        }
      }
      if (value === undefined || value.trim() === '') return error(`${arg} needs a value`);
      switch (arg) {
        case '--port':
        case '--sdk-port': {
          const port = parsePort(value);
          if (port === undefined) return error(`${arg} must be a port number between 1 and 65535 (got "${value}")`);
          if (arg === '--port') o.port = port;
          else o.sdkPort = port;
          break;
        }
        case '--data-dir':
          o.dataDir = path.resolve(expandHome(value.trim()));
          break;
        case '--ui-dir':
          o.uiDir = path.resolve(expandHome(value.trim()));
          break;
      }
      continue;
    }
    if ((BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      if (inline !== undefined) return error(`${arg} does not take a value`);
      switch (arg) {
        case '--help':
          return { kind: 'help' };
        case '--version':
          return { kind: 'version' };
        case '--lan':
          o.lan = true;
          break;
        case '--no-lan':
          o.lan = false;
          break;
        case '--demo':
          o.demo = true;
          break;
        case '--open':
          o.open = true;
          break;
        case '--no-open':
          o.open = false;
          break;
        case '--verbose':
          o.verbose = true;
          break;
      }
      continue;
    }
    if (arg.startsWith('-')) return error(`Unknown option ${arg}${suggestion(arg)}`);
    return error(`Unexpected argument "${arg}"`);
  }
  if (o.port === o.sdkPort) return error('--port and --sdk-port must be different');
  return { kind: 'run', options: o };
}

/* ────────────────────────────── output ────────────────────────────── */

export interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  cyan(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  violet(s: string): string;
}

export function paint(enabled: boolean): Paint {
  const wrap = (open: string, close: string) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    cyan: wrap('36', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    red: wrap('31', '39'),
    violet: wrap('38;5;141', '39'),
  };
}

/** ANSI colors only for a TTY, honoring NO_COLOR / FORCE_COLOR / TERM=dumb. */
export function shouldColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

export function helpText(c: Paint = paint(false)): string {
  const flag = (f: string) => c.cyan(f.padEnd(18));
  return [
    `${c.violet('◉◉')} ${c.bold('Dürbün')} ${SERVER_VERSION}`,
    `   Android & iOS canlı log, ağ ve performans izleyici`,
    `   ${c.dim('live logs, network & performance inspector for Android and iOS')}`,
    '',
    `${c.bold('Kullanım · Usage')}   durbun [seçenekler · options]`,
    '',
    `  ${flag('--port <n>')}HTTP/arayüz portu ${c.dim(`· HTTP & UI port (default ${DEFAULT_PORTS.http})`)}`,
    `  ${flag('--sdk-port <n>')}SDK TCP portu ${c.dim(`· raw TCP port for app SDKs (default ${DEFAULT_PORTS.sdk})`)}`,
    `  ${flag('--lan')}Yerel ağdaki cihazlara aç ${c.dim('· accept SDK connections over Wi-Fi/LAN')}`,
    `  ${flag('--demo')}Demo verisiyle başlat ${c.dim('· start with realistic demo data, no device needed')}`,
    `  ${flag('--no-open')}Arayüzü açma ${c.dim("· don't open the UI window")}`,
    `  ${flag('--data-dir <dir>')}Ayar ve geçici dosyalar ${c.dim('· settings & temp files (default ~/.durbun)')}`,
    `  ${flag('--ui-dir <dir>')}Derlenmiş arayüz klasörü ${c.dim('· built UI folder (default: dist/ui)')}`,
    `  ${flag('--verbose')}Ayrıntılı tanılama logları ${c.dim('· verbose diagnostics on stderr')}`,
    `  ${flag('-h, --help')}Bu yardım ${c.dim('· this help')}`,
    `  ${flag('-v, --version')}Sürüm ${c.dim('· print the version')}`,
    '',
    `${c.bold('Örnekler · Examples')}`,
    `  durbun                 ${c.dim('# başlat ve arayüzü aç · start and open the UI')}`,
    `  durbun --demo          ${c.dim('# cihaz olmadan dene · try it without a device')}`,
    `  durbun --lan           ${c.dim('# Wi-Fi üzerinden SDK · SDK over Wi-Fi')}`,
  ].join('\n');
}

export interface BannerInput {
  url: string;
  info: { version: string; ports: { http: number; sdk: number }; demo: boolean; lan: boolean; hostAddresses: string[] };
  warnings: string[];
  dataDir: string;
  sdkListening: boolean;
}

export function renderBanner(s: BannerInput, c: Paint = paint(false)): string {
  const label = (t: string) => c.dim(t.padEnd(16));
  const lines = [
    '',
    `  ${c.violet('◉◉')} ${c.bold('Dürbün')} ${c.dim('v' + s.info.version)}`,
    `     ${c.dim('canlı log + ağ izleyici · live logs & network inspector')}`,
    '',
    `  ${c.green('➜')}  ${label('Arayüz · UI')}${c.cyan(c.bold(s.url))}`,
  ];
  const sdkLine = s.sdkListening ? `127.0.0.1:${s.info.ports.sdk}` : c.yellow(`${s.info.ports.sdk} (kapalı · not listening)`);
  lines.push(`  ${c.green('➜')}  ${label('SDK (TCP)')}${sdkLine}`);
  if (s.info.lan) {
    const hosts = s.info.hostAddresses.slice(0, 3);
    lines.push(
      `  ${c.green('➜')}  ${label('Wi-Fi / LAN')}${hosts.length ? hosts.map((h) => `${h}:${s.info.ports.sdk}`).join(', ') : c.yellow('ağ adresi yok · no network address')}`,
    );
  }
  lines.push(`  ${c.green('➜')}  ${label('Veri · Data')}${tildify(s.dataDir)}`);
  if (s.info.demo) lines.push(`  ${c.green('➜')}  ${label('Demo')}açık · on`);
  lines.push(
    '',
    `  ${c.bold('Sonraki adımlar · Next steps')}`,
    `   • Android: USB hata ayıklamayı açıp cihazı takın ${c.dim('· enable USB debugging, plug the device in')}`,
    `   • iOS: cihazı takıp "Bu Bilgisayara Güven"e dokunun ${c.dim('· plug in, tap "Trust This Computer"')}`,
    `   • Simülatör ve emülatörler kendiliğinden görünür ${c.dim('· simulators & emulators appear automatically')}`,
    `   • Uygulama logları ve ağ için SDK'yı ekleyin ${c.dim('· add the SDK for app logs & network (UI → SDK kurulumu)')}`,
  );
  if (!s.info.demo) lines.push(`   • Cihaz yok mu? ${c.cyan('durbun --demo')} ${c.dim('· no device? try the demo')}`);
  if (s.warnings.length > 0) {
    lines.push('');
    for (const w of s.warnings) lines.push(`  ${c.yellow('⚠')} ${w}`);
  }
  lines.push('', `  ${c.dim('Durdurmak için Ctrl+C · press Ctrl+C to stop')}`, '');
  return lines.join('\n');
}

export function portBusyMessage(port: number, c: Paint = paint(false)): string {
  return [
    `${c.red('✖')} Port ${port} başka bir program tarafından kullanılıyor ${c.dim(`· port ${port} is used by another program`)}`,
    `  Kim kullanıyor · who: ${c.cyan(`lsof -nP -iTCP:${port} -sTCP:LISTEN`)}`,
    `  Başka portla başlatın · use another port: ${c.cyan(`durbun --port ${port === 65_535 ? port - 10 : port + 10}`)}`,
  ].join('\n');
}

/* ────────────────────────────── opening the UI ────────────────────────────── */

/** Chromium browsers that support `--app=<url>` windows, in order of preference (SPEC §5.8). */
export const APP_WINDOW_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc', 'Chromium'] as const;

export function findAppWindowBrowser(exists: (p: string) => boolean = existsSync, home: string = os.homedir()): string | undefined {
  for (const name of APP_WINDOW_BROWSERS) {
    for (const dir of ['/Applications', path.join(home, 'Applications')]) {
      if (exists(path.join(dir, `${name}.app`))) return name;
    }
  }
  return undefined;
}

export interface OpenCommand {
  cmd: string;
  args: string[];
  /** Human description for the banner. */
  how: string;
}

export function openCommands(url: string, platform: NodeJS.Platform = process.platform, browser?: string): OpenCommand[] {
  if (platform === 'darwin') {
    const fallback: OpenCommand = { cmd: 'open', args: [url], how: 'varsayılan tarayıcı · default browser' };
    return browser
      ? [{ cmd: 'open', args: ['-na', browser, '--args', `--app=${url}`], how: `${browser} uygulama penceresi · app window` }, fallback]
      : [fallback];
  }
  if (platform === 'win32') return [{ cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url], how: 'default browser' }];
  return [{ cmd: 'xdg-open', args: [url], how: 'default browser' }];
}

function runDetached(cmd: string, args: string[], timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
      child.unref();
      setTimeout(() => finish(true), timeoutMs).unref(); // still launching: assume it works
    } catch {
      finish(false);
    }
  });
}

/** Open `url`, preferring an app window. Resolves with how it was opened, or undefined on failure. */
export async function openUi(url: string): Promise<string | undefined> {
  const browser = process.platform === 'darwin' ? findAppWindowBrowser() : undefined;
  for (const c of openCommands(url, process.platform, browser)) {
    if (await runDetached(c.cmd, c.args)) return c.how;
  }
  return undefined;
}

/** Is a Dürbün already answering on this port? (GET /api/health) */
export async function probeDurbun(port: number, timeoutMs = 1_500): Promise<{ version: string } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; name?: unknown; version?: unknown };
    if (body && body.ok === true && body.name === 'durbun') return { version: String(body.version ?? '?') };
  } catch {
    /* nothing there, or not HTTP */
  }
  return undefined;
}

/* ────────────────────────────── main ────────────────────────────── */

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  color: boolean;
}

const defaultIo = (): CliIo => ({
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => process.stderr.write(line + '\n'),
  color: shouldColor(process.stdout),
});

async function openExisting(
  port: number,
  version: string,
  shouldOpen: boolean,
  io: CliIo,
  c: Paint,
  open: (url: string) => Promise<string | undefined>,
): Promise<void> {
  const url = `http://localhost:${port}`;
  io.out(`${c.violet('◉◉')} Dürbün zaten çalışıyor ${c.dim(`· already running (v${version})`)} → ${c.cyan(url)}`);
  if (!shouldOpen) return;
  const how = await open(url);
  io.out(how ? `   ${c.dim(`Açıldı · opened: ${how}`)}` : `   Tarayıcıda açın · open in your browser: ${url}`);
}

/**
 * Run the CLI. Resolves with an exit code when the command is finished, or `undefined` while the server
 * keeps running (it exits through the signal handlers).
 */
/** Injection points for tests. */
export interface MainDeps {
  startServer?: (opts: StartServerOptions) => Promise<StartedServer>;
  exit?: (code: number) => void;
  openUi?: (url: string) => Promise<string | undefined>;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = defaultIo(),
  deps: MainDeps = {},
): Promise<number | undefined> {
  const start = deps.startServer ?? startServer;
  const open = deps.openUi ?? openUi;
  const c = paint(io.color);
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.out(helpText(c));
    return 0;
  }
  if (parsed.kind === 'version') {
    io.out(SERVER_VERSION);
    return 0;
  }
  if (parsed.kind === 'error') {
    io.err(`${c.red('✖')} ${parsed.message}`);
    io.err(`  Yardım · help: ${c.cyan('durbun --help')}`);
    return 2;
  }
  const o = parsed.options;
  if (o.verbose) setLogLevel('debug');
  const major = Number.parseInt(process.versions.node, 10);
  if (major < 20) {
    io.err(`${c.red('✖')} Dürbün Node.js 20+ gerektirir ${c.dim(`· needs Node.js 20 or newer (found ${process.versions.node})`)}`);
    return 1;
  }

  const running = await probeDurbun(o.port);
  if (running) {
    await openExisting(o.port, running.version, o.open, io, c, open);
    return 0;
  }

  // Signal handlers go in before the start: a Ctrl+C while drivers are still starting must wait for the
  // start to finish and then stop everything (otherwise logcat / log stream children could be orphaned).
  const starting = start({
    httpPort: o.port,
    sdkPort: o.sdkPort,
    lan: o.lan,
    demo: o.demo,
    dataDir: o.dataDir,
    uiDir: o.uiDir,
    verbose: o.verbose,
  });
  let stopRequested = false;
  const removeSignalHandlers = installShutdownHandlers(
    {
      stop: async () => {
        stopRequested = true;
        const started = await starting.catch(() => undefined);
        await started?.stop();
      },
    },
    { log: io.err, exit: deps.exit },
  );

  let server: StartedServer;
  try {
    server = await starting;
  } catch (err) {
    removeSignalHandlers();
    if (stopRequested) return 130;
    if (err instanceof ServerStartError && err.code === 'EADDRINUSE') {
      const other = await probeDurbun(o.port);
      if (other) {
        await openExisting(o.port, other.version, o.open, io, c, open);
        return 0;
      }
      io.err(portBusyMessage(o.port, c));
      return 1;
    }
    io.err(`${c.red('✖')} Dürbün başlatılamadı ${c.dim('· could not start')}: ${errorMessage(err)}`);
    if (o.verbose && err instanceof Error && err.stack) io.err(c.dim(err.stack));
    return 1;
  }

  if (stopRequested) return undefined; // shutting down already; the signal handler exits the process

  io.out(renderBanner({ url: server.url, info: server.info, warnings: server.warnings, dataDir: server.dataDir, sdkListening: server.sdkListening }, c));
  if (o.open) {
    const how = await open(server.url);
    io.out(how ? `  ${c.dim(`Arayüz açıldı · UI opened: ${how}`)}` : `  Tarayıcıda açın · open in your browser: ${c.cyan(server.url)}`);
  }
  return undefined;
}

/** Entry used by bin/durbun.mjs and direct execution: runs main() and applies the exit code. */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // `durbun --help | head -3` closes stdout early: exit quietly instead of crashing with EPIPE.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    });
  }
  // A bug in one module must not take down the whole tool (and with it every captured log).
  const logger = createLogger('durbun');
  process.on('uncaughtException', (err) => logger.error(`unexpected error (still running): ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => logger.error(`unhandled rejection (still running): ${errorMessage(reason)}`));
  try {
    const code = await main(argv);
    if (code !== undefined) {
      process.exitCode = code;
      // Leave time for stdout to flush, but never hang on a stray handle.
      setTimeout(() => process.exit(code), 300).unref();
    }
  } catch (err) {
    process.stderr.write(`✖ ${errorMessage(err)}\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 300).unref();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) void runCli();
