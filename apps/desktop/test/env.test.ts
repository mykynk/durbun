import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinPath, loginShell, mergeShellEnv, parseEnvBlock, readLoginShellEnv, shellCommand } from '../src/env';

const M = '__DURBUN_ENV_0123456789ab__';

/** What `zsh -ilc` prints with a chatty profile: motd/plugin noise, then our marked `env -0` block. */
function zshOutput(vars: Record<string, string>, noise = true): string {
  const block = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0');
  return `${noise ? 'Last login: Mon Nov  2 09:12:44 on ttys003\n\x1b[1;32m[oh-my-zsh]\x1b[0m Random theme "robbyrussell" loaded\n' : ''}${M}${block}\0${M}${noise ? '\nzsh: exit 0\n' : ''}`;
}

describe('parseEnvBlock', () => {
  it('reads the variables between the markers and ignores profile noise', () => {
    const out = zshOutput({
      PATH: '/Users/dev/fvm/default/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      ANDROID_HOME: '/Users/dev/Library/Android/sdk',
      JAVA_HOME: '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      PS1: '%n@%m %1~ %# ',
    });
    const env = parseEnvBlock(out, M)!;
    expect(env.PATH).toBe('/Users/dev/fvm/default/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env.ANDROID_HOME).toBe('/Users/dev/Library/Android/sdk');
    expect(env.JAVA_HOME).toBe('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
    expect(env.PS1).toBe('%n@%m %1~ %# ');
  });

  it('keeps values containing "=" and newlines (null-separated output)', () => {
    const env = parseEnvBlock(zshOutput({ LESSOPEN: '|/opt/homebrew/bin/lesspipe.sh %s', MULTI: 'a\nb=c' }), M)!;
    expect(env.MULTI).toBe('a\nb=c');
    expect(env.LESSOPEN).toBe('|/opt/homebrew/bin/lesspipe.sh %s');
  });

  it('returns null without a complete block', () => {
    expect(parseEnvBlock('Last login: …\n', M)).toBeNull();
    expect(parseEnvBlock(`${M}PATH=/usr/bin`, M)).toBeNull();
    expect(parseEnvBlock(`${M}${M}`, M)).toBeNull();
  });

  it('skips malformed entries', () => {
    const env = parseEnvBlock(`${M}=oops\0BAD KEY=x\0OK=1\0${M}`, M)!;
    expect(env).toEqual({ OK: '1' });
  });
});

describe('mergeShellEnv', () => {
  const home = '/Users/dev';
  const finder = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home };

  it('puts the shell PATH first, keeps the old entries, adds existing tool folders, dedupes', () => {
    const changes = mergeShellEnv(
      finder,
      { PATH: '/Users/dev/fvm/default/bin:/opt/homebrew/bin:/usr/bin:/bin', ANDROID_HOME: '/Users/dev/Library/Android/sdk' },
      { home, exists: (p) => p === '/opt/homebrew/bin' || p === '/Users/dev/Library/Android/sdk/platform-tools' },
    );
    expect(changes.PATH).toBe('/Users/dev/fvm/default/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/dev/Library/Android/sdk/platform-tools');
    expect(changes.ANDROID_HOME).toBe('/Users/dev/Library/Android/sdk');
    expect(changes).not.toHaveProperty('JAVA_HOME');
  });

  it('without a shell env still adds the well-known folders that exist', () => {
    const changes = mergeShellEnv(finder, null, { home, exists: (p) => p === '/opt/homebrew/bin' });
    expect(changes.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
    expect(Object.keys(changes)).toEqual(['PATH']);
  });

  it('takes the variables the server\'s tool lookup reads (fvm cache, Xcode choice, adb server port)', () => {
    const changes = mergeShellEnv(
      finder,
      {
        PATH: '/usr/bin:/bin',
        FVM_CACHE_PATH: '/Volumes/Work/fvm',
        FVM_HOME: '/Users/dev/.fvm',
        DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer',
        ANDROID_ADB_SERVER_PORT: '5038',
        PS1: '%n@%m %1~ %# ',
      },
      { home, exists: () => false },
    );
    expect(changes).toMatchObject({
      FVM_CACHE_PATH: '/Volumes/Work/fvm',
      FVM_HOME: '/Users/dev/.fvm',
      DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer',
      ANDROID_ADB_SERVER_PORT: '5038',
    });
    expect(changes).not.toHaveProperty('PS1');
  });

  it('does not override with empty values and reports no change when equal', () => {
    const current = { PATH: '/usr/bin:/bin', JAVA_HOME: '/jdk' };
    expect(mergeShellEnv(current, { PATH: '/usr/bin:/bin', JAVA_HOME: '' }, { home, exists: () => false })).toEqual({});
  });

  it('joinPath drops empties and duplicates', () => {
    expect(joinPath('/a::/b', undefined, '/a:/c')).toBe('/a:/b:/c');
  });
});

describe('loginShell', () => {
  it('prefers $SHELL, then the passwd entry', () => {
    expect(loginShell({ SHELL: '/opt/homebrew/bin/fish' })).toBe('/opt/homebrew/bin/fish');
    expect(loginShell({})).toMatch(/^\//);
  });
});

describe('readLoginShellEnv (fake shells)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-env-'));
  const script = (name: string, body: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  it('runs `<shell> -ilc <cmd>` and parses the marked block despite noise', async () => {
    // $1 = -ilc, $2 = the command
    const shell = script('chatty.sh', 'echo "Welcome to fake shell"; [ "$1" = "-ilc" ] || exit 9; eval "$2"; echo "bye"');
    const r = await readLoginShellEnv({ shell, env: { PATH: '/usr/bin:/bin', ANDROID_HOME: '/sdk', HOME: '/Users/dev' }, timeoutMs: 5_000 });
    expect(r.error).toBeUndefined();
    expect(r.env?.ANDROID_HOME).toBe('/sdk');
    expect(r.env?.DURBUN_SHELL_ENV).toBe('1');
  });

  it('times out on a hanging profile and never rejects', async () => {
    const shell = script('hang.sh', 'sleep 30');
    const started = Date.now();
    const r = await readLoginShellEnv({ shell, timeoutMs: 300 });
    expect(r.env).toBeNull();
    expect(r.error).toMatch(/timed out/);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('a profile that prints the block and then hangs still resolves quickly', async () => {
    const shell = script('slow-exit.sh', 'eval "$2"; sleep 30');
    const started = Date.now();
    const r = await readLoginShellEnv({ shell, env: { PATH: '/usr/bin:/bin', X: 'y' }, timeoutMs: 5_000 });
    expect(r.env?.X).toBe('y');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('reports a missing shell as an error', async () => {
    const r = await readLoginShellEnv({ shell: path.join(dir, 'nope'), timeoutMs: 1_000 });
    expect(r.env).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('the command uses only printf and /usr/bin/env', () => {
    expect(shellCommand(M)).toBe(`printf '%s' '${M}'; /usr/bin/env -0; printf '%s' '${M}'`);
  });
});
