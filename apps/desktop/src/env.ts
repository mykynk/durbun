/**
 * Login-shell environment. An app started from Finder/Dock gets launchd's minimal environment
 * (PATH=/usr/bin:/bin:/usr/sbin:/sbin, no ANDROID_HOME …), so adb, xcrun helpers, idevicesyslog or
 * flutter from Homebrew/fvm/SDK folders would be missing. We ask the user's login shell once
 * (`$SHELL -ilc …`, 3 s timeout) and merge the few variables the server's tools need.
 * Never throws: on any failure the current environment plus well-known folders is used.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHELL_ENV_KEYS = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'FLUTTER_ROOT', 'JAVA_HOME'] as const;
export type ShellEnvKey = (typeof SHELL_ENV_KEYS)[number];

export interface ShellEnvResult {
  /** Variables read from the shell, or null when the shell could not be asked. */
  env: Record<string, string> | null;
  shell: string;
  ms: number;
  error?: string;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** The user's login shell: $SHELL, else the passwd entry (Finder launches have no $SHELL), else zsh. */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL && path.isAbsolute(env.SHELL)) return env.SHELL;
  try {
    const fromPasswd = os.userInfo().shell;
    if (fromPasswd && path.isAbsolute(fromPasswd)) return fromPasswd;
  } catch {
    /* no passwd entry */
  }
  return '/bin/zsh';
}

/** Shell command printing `<marker><env -0 output><marker>`; profile noise before/after is ignored. */
export function shellCommand(marker: string): string {
  return `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`;
}

/** Parse `env -0` output found between the first and the last marker. */
export function parseEnvBlock(stdout: string, marker: string): Record<string, string> | null {
  const start = stdout.indexOf(marker);
  const end = stdout.lastIndexOf(marker);
  if (start < 0 || end <= start) return null;
  const block = stdout.slice(start + marker.length, end);
  const out: Record<string, string> = {};
  for (const entry of block.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = entry.slice(eq + 1);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Folders where developer tools usually live, appended to PATH when present. */
export function wellKnownPathDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'),
  ];
}

export function joinPath(...lists: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of (list ?? '').split(':')) {
      const d = dir.trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(':');
}

export interface MergeOptions {
  home: string;
  /** Only folders that exist are appended (injectable for tests). */
  exists?: (p: string) => boolean;
}

/**
 * New values for SHELL_ENV_KEYS: the shell's PATH first (user order wins), then what the process
 * already had, then well-known folders that exist. Other keys: the shell's non-empty value, else the
 * current one. Returns only the keys whose value changes.
 */
export function mergeShellEnv(current: NodeJS.ProcessEnv, shell: Record<string, string> | null, opts: MergeOptions): Partial<Record<ShellEnvKey, string>> {
  const exists = opts.exists ?? existsSync;
  const changes: Partial<Record<ShellEnvKey, string>> = {};
  const extra = wellKnownPathDirs(opts.home).filter((d) => exists(d)).join(':');
  const pathValue = joinPath(shell?.PATH, current.PATH, extra);
  if (pathValue && pathValue !== current.PATH) changes.PATH = pathValue;
  for (const key of SHELL_ENV_KEYS) {
    if (key === 'PATH') continue;
    const value = shell?.[key];
    if (value && value !== current[key]) changes[key] = value;
  }
  return changes;
}

export interface ReadShellEnvOptions {
  shell?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Ask the login shell for its environment. Resolves within ~timeoutMs, never rejects. */
export function readLoginShellEnv(opts: ReadShellEnvOptions = {}): Promise<ShellEnvResult> {
  const shell = opts.shell ?? loginShell(opts.env);
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const marker = `__DURBUN_ENV_${randomBytes(6).toString('hex')}__`;
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (env: Record<string, string> | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ env, shell, ms: Date.now() - started, error });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-ilc', shellCommand(marker)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // Own process group so a hanging profile (prompts, plugins) can be killed as a whole.
        detached: true,
        env: {
          ...(opts.env ?? process.env),
          // Keep interactive profiles quiet and quick (oh-my-zsh update prompt, tmux autostart).
          DISABLE_AUTO_UPDATE: 'true',
          ZSH_TMUX_AUTOSTART: 'false',
          DURBUN_SHELL_ENV: '1',
        },
      });
    } catch (err) {
      finish(null, (err as Error).message);
      return;
    }
    timer = setTimeout(() => {
      killGroup(child.pid);
      const env = parseEnvBlock(stdout, marker);
      finish(env, env ? undefined : `timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
      // The closing marker arrived: no need to wait for slow exit traps.
      if (stdout.indexOf(marker) !== stdout.lastIndexOf(marker)) {
        const env = parseEnvBlock(stdout, marker);
        if (env) {
          finish(env);
          killGroup(child.pid);
        }
      }
    });
    child.once('error', (err) => finish(null, err.message));
    child.once('close', (code) => {
      const env = parseEnvBlock(stdout, marker);
      finish(env, env ? undefined : `shell exited with code ${code} without printing its environment`);
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Resolve the login-shell environment and merge it into `target` (process.env). Never throws. */
export async function applyLoginShellEnv(
  target: NodeJS.ProcessEnv = process.env,
  opts: ReadShellEnvOptions = {},
): Promise<{ result: ShellEnvResult; changed: ShellEnvKey[] }> {
  const result = await readLoginShellEnv({ env: target, ...opts });
  const changes = mergeShellEnv(target, result.env, { home: target.HOME || os.homedir() });
  for (const [key, value] of Object.entries(changes)) target[key] = value;
  return { result, changed: Object.keys(changes) as ShellEnvKey[] };
}
