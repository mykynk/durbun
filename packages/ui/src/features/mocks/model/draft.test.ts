import { describe, expect, it } from 'vitest';
import type { NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { draftFromRequest, guessFailKind } from './draft';

function entry(p: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id: 'app:1:7',
    appId: 'app:1',
    deviceId: 'demo:1',
    source: 'dart:io',
    method: 'GET',
    url: 'https://api.pati.app/v1/pets?page=2',
    host: 'api.pati.app',
    path: '/v1/pets?page=2',
    startTs: 1,
    state: 'complete',
    status: 200,
    requestHeaders: [],
    responseHeaders: [['content-type', 'application/json; charset=utf-8']],
    responseContentType: 'application/json; charset=utf-8',
    hasRequestBody: false,
    hasResponseBody: true,
    ...p,
  };
}

const detail = (e: NetworkEntry, responseBody: NetworkDetail['responseBody']): NetworkDetail => ({ ...e, responseBody });

describe('draftFromRequest', () => {
  it('copies method, exact URL, status, content type and the text body; scopes to the app', () => {
    const e = entry();
    const { draft, notes } = draftFromRequest(e, detail(e, { encoding: 'utf8', data: '{"items":[]}', size: 12 }), 'com.mykynk.pati');
    expect(notes).toEqual([]);
    expect(draft).toEqual({
      enabled: true,
      name: 'GET /v1/pets',
      method: 'GET',
      url: 'https://api.pati.app/v1/pets?page=2',
      match: 'exact',
      apps: ['com.mykynk.pati'],
      action: { type: 'respond', status: 200, headers: [['content-type', 'application/json; charset=utf-8']], body: '{"items":[]}', bodyEncoding: 'utf8' },
    });
  });

  it('keeps binary bodies as base64', () => {
    const e = entry({ url: 'https://cdn.pati.app/img/1.png', path: '/img/1.png', responseContentType: 'image/png' });
    const { draft } = draftFromRequest(e, detail(e, { encoding: 'base64', data: 'iVBORw0KGgo=', size: 8 }));
    expect(draft.action).toEqual({ type: 'respond', status: 200, headers: [['content-type', 'image/png']], body: 'iVBORw0KGgo=', bodyEncoding: 'base64' });
    expect(draft.apps).toBeUndefined();
  });

  it('notes size-only, truncated, evicted and unavailable bodies', () => {
    const e = entry();
    expect(draftFromRequest(e, detail(e, { encoding: 'utf8', data: '', size: 9000, truncated: true })).notes).toEqual(['bodyNotCaptured']);
    const cut = draftFromRequest(e, detail(e, { encoding: 'utf8', data: '{"a":', size: 9000, truncated: true }));
    expect(cut.notes).toEqual(['bodyTruncated']);
    expect((cut.draft.action as { body?: string }).body).toBe('{"a":');
    expect(draftFromRequest(entry({ bodyEvicted: true }), null).notes).toEqual(['bodyEvicted']);
    expect(draftFromRequest(e, null).notes).toEqual(['detailUnavailable']);
  });

  it('turns failed requests into fail rules with the matching error kind', () => {
    const timeout = draftFromRequest(entry({ state: 'failed', status: undefined, error: 'TimeoutException after 0:00:15.000000: Future not completed' }), null);
    expect(timeout.draft.action).toEqual({ type: 'fail', error: 'timeout' });
    const custom = draftFromRequest(entry({ state: 'failed', status: undefined, error: 'Weird thing happened' }), null);
    expect(custom.draft.action).toEqual({ type: 'fail', error: 'custom', message: 'Weird thing happened' });
  });

  it('flags GraphQL (shared URL) and names the rule after the operation', () => {
    const e = entry({ method: 'POST', url: 'https://gql.pati.app/graphql', path: '/graphql', graphql: { operationType: 'query', operationName: 'GetPet' } });
    const { draft, notes } = draftFromRequest(e, detail(e, { encoding: 'utf8', data: '{"data":{}}', size: 11 }));
    expect(notes).toContain('graphqlSharedUrl');
    expect(draft.name).toBe('query GetPet');
  });

  it('pending requests start from a 200 JSON skeleton; unknown methods match any', () => {
    const { draft, notes } = draftFromRequest(entry({ state: 'pending', status: undefined, method: '?' }), null);
    expect(notes).toEqual(['noResponse']);
    expect(draft.method).toBe('*');
    expect(draft.action).toMatchObject({ type: 'respond', status: 200, body: '{}' });
  });
});

describe('guessFailKind', () => {
  it('maps SDK error texts', () => {
    expect(guessFailKind("SocketException: Failed host lookup: 'cdn.pati.app'")).toBe('dns');
    expect(guessFailKind('java.net.UnknownHostException: Unable to resolve host')).toBe('dns');
    expect(guessFailKind('HandshakeException: Handshake error in client (CERTIFICATE_VERIFY_FAILED)')).toBe('tls');
    expect(guessFailKind('SocketException: Connection refused (OS Error: Connection refused, errno = 111)')).toBe('connection');
    expect(guessFailKind('The request timed out.')).toBe('timeout');
    expect(guessFailKind(undefined)).toBe('connection');
  });
});
