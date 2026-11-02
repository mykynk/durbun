#!/usr/bin/env node
/**
 * Development mode: the server from source (`tsx watch`, restarts on every change) and the Vite dev
 * server for the UI (hot reload), side by side with prefixed output. Opens http://localhost:5173 once
 * Vite is ready (an app window on macOS when Chrome/Brave/Edge/Arc/Chromium is installed).
 *
 *   npm run dev                      # server + UI
 *   npm run dev -- --demo            # with demo data (any server flag is passed through)
 *   npm run dev -- --port 9760       # the Vite proxy follows the server port
 *   npm run dev -- --no-open         # don't open a browser window
 *
 * Ctrl+C stops both (gracefully); a second Ctrl+C kills them.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const UI_URL = 'http://localhost:5173';

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'Dürbün geliştirme modu · development mode',
      '',
      '  npm run dev [-- <server flags>] [-- --no-open]',
      '',
      '  Sunucu kaynaktan (tsx watch) + arayüz (Vite) birlikte çalışır.',
      '  Runs the server from source (tsx watch) and the UI (Vite) together.',
      `  UI: ${UI_URL}   ·   server flags: --demo --port <n> --sdk-port <n> --lan --data-dir <dir> --verbose`,
    ].join('\n'),
  );
  process.exit(0);
}

const openBrowser = !argv.includes('--no-open');
const serverArgs = argv.filter((a) => a !== '--no-open' && a !== '--open');
const httpPort = readPort(serverArgs) ?? 9750;

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const tint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (line) => process.stdout.write(`${tint('2', '[dev]'.padEnd(9))}${line}\n`);

function readPort(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a === '-p') return Number(args[i + 1]) || undefined;
    if (a.startsWith('--port=')) return Number(a.slice(7)) || undefined;
  }
  return undefined;
}

const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
for (const [name, file] of [
  ['tsx', tsxCli],
  ['vite', viteCli],
]) {
  if (!existsSync(file)) {
    console.error(`✖ ${name} is not installed (${path.relative(root, file)}). Run "npm install" in ${root} first.`);
    process.exit(1);
  }
}

/** @type {{ name: string; child: import('node:child_process').ChildProcess; exited: boolean }[]} */
const children = [];
let shuttingDown = false;
let exitCode = 0;

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  if (color) env.FORCE_COLOR = '1';
  return env;
}

function run(name, tintCode, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { name, child, exited: false };
  children.push(entry);
  const prefix = tint(tintCode, `[${name}]`.padEnd(9));
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
      process.stdout.write(`${prefix}${line}\n`);
      if (name === 'ui' && /Local:/.test(line)) onUiReady();
    });
  }
  child.on('error', (err) => say(`${name} could not start: ${err.message}`));
  // 'close' (not 'exit'): fires once the child's output is drained, so its last lines are printed.
  child.on('close', (code, signal) => {
    entry.exited = true;
    if (!shuttingDown) {
      say(tint('31', `${name} exited unexpectedly (${signal ?? `code ${code}`}) — stopping the other process`));
      exitCode = code || 1;
      shutdown('child-exit');
    } else if (children.every((c) => c.exited)) {
      process.exit(exitCode);
    }
  });
  return child;
}

/* ───────────── opening the UI ───────────── */

const APP_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc', 'Chromium'];
let opened = false;

function openUi() {
  if (opened || !openBrowser || shuttingDown) return;
  opened = true;
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    const browser = APP_BROWSERS.find((b) => ['/Applications', path.join(os.homedir(), 'Applications')].some((d) => existsSync(path.join(d, `${b}.app`))));
    cmd = 'open';
    args = browser ? ['-na', browser, '--args', `--app=${UI_URL}`] : [UI_URL];
  } else if (process.platform === 'win32') {
    cmd = 'rundll32';
    args = ['url.dll,FileProtocolHandler', UI_URL];
  } else {
    cmd = 'xdg-open';
    args = [UI_URL];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => say(`open ${UI_URL} in your browser`));
    child.unref();
    say(`opening ${tint('36', UI_URL)}`);
  } catch {
    say(`open ${UI_URL} in your browser`);
  }
}

function onUiReady() {
  // Give the server a moment so the first WebSocket attempt usually succeeds; the UI reconnects anyway.
  setTimeout(openUi, 400).unref();
}

/* ───────────── shutdown ───────────── */

function alive() {
  return children.filter((c) => !c.exited);
}

function shutdown(reason) {
  if (shuttingDown) {
    // Second Ctrl+C: no more waiting.
    for (const { child } of alive()) child.kill('SIGKILL');
    process.exit(exitCode || 130);
  }
  shuttingDown = true;
  say('stopping… (Ctrl+C again to force)');
  // On Ctrl+C the terminal already sent SIGINT to the whole process group (both children); signaling them
  // again would make the server skip its graceful shutdown. Other reasons need an explicit signal.
  if (reason !== 'SIGINT') for (const { child } of alive()) child.kill('SIGTERM');
  const escalate = setTimeout(() => {
    for (const { child } of alive()) child.kill('SIGTERM');
    setTimeout(() => {
      for (const { child } of alive()) child.kill('SIGKILL');
      process.exit(exitCode || 1);
    }, 3_000).unref();
  }, 8_000);
  escalate.unref();
  if (alive().length === 0) process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

/* ───────────── start ───────────── */

say(`server from source → http://127.0.0.1:${httpPort}  ·  UI with hot reload → ${UI_URL}`);
run('server', '35', [tsxCli, 'watch', '--clear-screen=false', 'src/cli.ts', '--no-open', ...serverArgs], path.join(root, 'packages', 'server'), {});
run('ui', '36', [viteCli, '--clearScreen', 'false'], path.join(root, 'packages', 'ui'), { DURBUN_SERVER: `http://127.0.0.1:${httpPort}` });
