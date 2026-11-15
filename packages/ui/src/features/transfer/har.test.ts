import { describe, expect, it } from 'vitest';
import { HarImportError, harToSession, looksLikeHar } from '@durbun/protocol';

const entry = (over: Record<string, unknown> = {}) => ({
  startedDateTime: '2026-11-15T10:00:00.000Z',
  time: 120,
  request: {
    method: 'post',
    url: 'https://api.example.com/v1/login?next=%2Fhome',
    httpVersion: 'HTTP/2',
    headers: [
      { name: ':authority', value: 'api.example.com' },
      { name: 'Content-Type', value: 'application/json' },
    ],
    postData: { mimeType: 'application/json', text: '{"user":"a"}' },
    bodySize: 12,
  },
  response: {
    status: 200,
    statusText: 'OK',
    httpVersion: 'HTTP/2',
    headers: [{ name: 'content-type', value: 'application/json' }],
    content: { size: 11, mimeType: 'application/json', text: '{"ok":true}' },
  },
  timings: { dns: 1, connect: 2, ssl: 3, send: 1, wait: 100, receive: 13 },
  serverIPAddress: '10.0.0.1',
  ...over,
});

describe('harToSession', () => {
  it('turns entries into requests on one virtual device, with no logs', () => {
    const r = harToSession({ log: { version: '1.2', creator: { name: 'WebInspector', version: '537' }, entries: [entry()] } }, { name: 'login', now: 1 });
    expect(r.requests).toBe(1);
    expect(r.creator).toBe('WebInspector');
    expect(r.session.format).toBe('durbun-session');
    expect(r.session.logs).toEqual([]);
    expect(r.session.apps).toEqual([]);
    expect(r.session.devices).toHaveLength(1);
    expect(r.session.devices[0]).toMatchObject({ name: 'login', kind: 'virtual', platform: 'other', state: 'disconnected' });
    const d = r.session.network[0]!;
    expect(d).toMatchObject({
      deviceId: r.session.devices[0]!.id,
      method: 'POST',
      host: 'api.example.com',
      path: '/v1/login?next=%2Fhome',
      status: 200,
      state: 'complete',
      duration: 120,
      protocol: 'http/2',
      remoteAddress: '10.0.0.1',
      requestContentType: 'application/json',
      responseContentType: 'application/json',
      hasRequestBody: true,
      hasResponseBody: true,
    });
    expect(d.startTs).toBe(Date.parse('2026-11-15T10:00:00.000Z'));
    expect(d.endTs).toBe(d.startTs + 120);
    // HTTP/2 pseudo-headers are not request headers.
    expect(d.requestHeaders).toEqual([['Content-Type', 'application/json']]);
    expect(d.requestBody).toEqual({ encoding: 'utf8', data: '{"user":"a"}', size: 12 });
    expect(d.timings).toEqual({ dns: 1, connect: 2, tls: 3, send: 1, wait: 100, receive: 13 });
  });

  it('marks requests without a response as failed and keeps base64 bodies', () => {
    const r = harToSession(
      {
        log: {
          entries: [
            entry({ response: { status: 0, headers: [], content: { size: 0 }, _error: 'net::ERR_CONNECTION_REFUSED' } }),
            entry({ startedDateTime: '2026-11-15T09:00:00.000Z', response: { status: 200, headers: [], content: { mimeType: 'image/png', encoding: 'base64', text: 'iVBORw0K' } } }),
          ],
        },
      },
      { name: 'x' },
    );
    // Sorted by start time.
    expect(r.session.network[0]!.responseBody).toMatchObject({ encoding: 'base64', data: 'iVBORw0K' });
    expect(r.session.network[1]).toMatchObject({ state: 'failed', error: 'net::ERR_CONNECTION_REFUSED' });
    expect(r.session.network[1]!.status).toBeUndefined();
  });

  it("keeps Dürbün's own HAR metadata and makes ids unique", () => {
    const meta = { id: 'n1', source: 'dio', state: 'complete', mocked: true, mockRuleId: 'r1' };
    const r = harToSession({ log: { _durbun: { masked: true }, entries: [entry({ _durbun: meta }), entry({ _durbun: meta })] } }, { name: 'x' });
    expect(r.masked).toBe(true);
    expect(r.session.masked).toBe(true);
    const ids = r.session.network.map((d) => d.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.session.network[0]).toMatchObject({ source: 'dio', mocked: true, mockRuleId: 'r1' });
  });

  it('counts entries without a URL and rejects files that are not a HAR or hold no request', () => {
    const r = harToSession({ log: { entries: [entry(), { request: { method: 'GET' } }] } }, { name: 'x' });
    expect(r.skipped).toBe(1);
    expect(() => harToSession({ format: 'durbun-session' }, { name: 'x' })).toThrow(HarImportError);
    let code: string | undefined;
    try {
      harToSession({ log: { entries: [] } }, { name: 'x' });
    } catch (err) {
      code = (err as HarImportError).code;
    }
    expect(code).toBe('har.empty');
  });
});

describe('looksLikeHar', () => {
  it('tells a HAR head from a session file head', () => {
    expect(looksLikeHar('{\n  "log": {\n    "version": "1.2"')).toBe(true);
    expect(looksLikeHar('{"format":"durbun-session","log":{"entries":[]}}')).toBe(true);
    expect(looksLikeHar('{"format":"durbun-session","version":1}')).toBe(false);
  });
});
