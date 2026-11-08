import { describe, expect, it } from 'vitest';
import { checkForUpdates, compareVersions, createRateLimiter, LATEST_RELEASE_API, parseVersion } from '../src/updates';

describe('versions', () => {
  it('parses tags with or without v, pre-release and build parts', () => {
    expect(parseVersion('v1.2.3')).toEqual({ parts: [1, 2, 3], pre: '' });
    expect(parseVersion('0.2.0-beta.1+abc')).toEqual({ parts: [0, 2, 0], pre: 'beta.1' });
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion('latest')).toBeUndefined();
  });
  it('orders like semver', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('x', '1.0.0')).toBeNaN();
  });
});

describe('checkForUpdates', () => {
  const reply = (status: number, body: unknown) => async (url: string) => {
    expect(url).toBe(LATEST_RELEASE_API);
    return { status, body };
  };
  it('reports a newer release with its page', async () => {
    const r = await checkForUpdates('0.1.0', reply(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/mykynk/durbun/releases/tag/v0.2.0' }));
    expect(r).toEqual({ kind: 'newer', version: '0.2.0', url: 'https://github.com/mykynk/durbun/releases/tag/v0.2.0' });
  });
  it('never opens a page outside the project', async () => {
    const r = await checkForUpdates('0.1.0', reply(200, { tag_name: 'v0.2.0', html_url: 'https://evil.example/x' }));
    expect(r).toMatchObject({ kind: 'newer', url: 'https://github.com/mykynk/durbun/releases/latest' });
  });
  it('is current for the same or an older release, none before the first release', async () => {
    expect(await checkForUpdates('0.2.0', reply(200, { tag_name: 'v0.2.0' }))).toEqual({ kind: 'current', version: '0.2.0' });
    expect(await checkForUpdates('0.3.0', reply(200, { tag_name: 'v0.2.0' }))).toEqual({ kind: 'current', version: '0.3.0' });
    expect(await checkForUpdates('0.1.0', reply(404, null))).toEqual({ kind: 'none' });
  });
  it('fails softly on errors and odd replies', async () => {
    expect(await checkForUpdates('0.1.0', reply(403, null))).toEqual({ kind: 'failed', error: 'HTTP 403' });
    expect((await checkForUpdates('0.1.0', reply(200, { tag_name: 'nightly' }))).kind).toBe('failed');
    expect(
      await checkForUpdates('0.1.0', async () => {
        throw new Error('offline');
      }),
    ).toEqual({ kind: 'failed', error: 'offline' });
  });
});

describe('createRateLimiter', () => {
  it('allows max per window and reports what it dropped', () => {
    let now = 0;
    const next = createRateLimiter(2, 1_000, () => now);
    expect(next()).toEqual({ allowed: true, dropped: 0 });
    expect(next()).toEqual({ allowed: true, dropped: 0 });
    expect(next().allowed).toBe(false);
    expect(next().allowed).toBe(false);
    now = 1_000;
    expect(next()).toEqual({ allowed: true, dropped: 2 });
  });
});
