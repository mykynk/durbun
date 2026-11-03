import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const { cspViolations, PAGE_CHECKS } = await import('../src/selftest');

/** Runs the self-test's page script against stand-ins for the page globals. */
function runPageChecks(answers: Record<string, string>): Promise<Record<string, unknown>> {
  const fetch = async (url: string) => {
    if (!(url in answers)) throw new Error('blocked');
    const body = answers[url]!;
    return { json: async () => JSON.parse(body) };
  };
  const document = { querySelector: () => null, documentElement: { getAttribute: () => null }, title: 'Dürbün' };
  const run = new Function('fetch', 'document', 'location', 'navigator', 'window', 'getComputedStyle', `return ${PAGE_CHECKS};`);
  return run(fetch, document, { href: 'http://127.0.0.1:9810/' }, { language: 'en' }, {}, () => ({ getPropertyValue: () => '' }));
}

describe('self-test page checks', () => {
  it('report a server whose /api/doctor is not JSON instead of losing the whole report', async () => {
    const out = await runPageChecks({ '/api/health': '{"ok":true,"name":"durbun","version":"0.0.9"}', '/api/doctor': '<!doctype html><title>Dürbün</title>' });
    expect(out.health).toEqual({ ok: true, name: 'durbun', version: '0.0.9' });
    expect(out.doctor).toMatch(/^error: /);
    expect(out.externalFetch).toBe('blocked (blocked)');
    expect(out.href).toBe('http://127.0.0.1:9810/');
  });
});

describe('cspViolations', () => {
  it('picks the console lines of Content-Security-Policy refusals', () => {
    const lines = [
      { level: 'debug', message: 'Rendering was performed in a subtree hidden by content-visibility.', source: '' },
      { level: 'error', message: "Connecting to 'https://example.com/' violates the following Content Security Policy directive: \"connect-src 'self'\".", source: '' },
      { level: 'error', message: 'Refused to execute inline script because it violates the following Content Security Policy directive', source: 'x' },
    ];
    expect(cspViolations(lines).map((l) => l.message.slice(0, 10))).toEqual(['Connecting', 'Refused to']);
  });
});
