import { describe, expect, it } from 'vitest';
import type { NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { findMatchPlace, matchOffsets } from './findMatch';

const entry = (p: Partial<NetworkEntry> = {}): NetworkEntry =>
  ({ id: '1', method: 'GET', host: 'h', path: '/a?q=Needle', url: 'https://h/a?q=Needle', source: 's', startTs: 0, state: 'complete', requestHeaders: [['X-Trace', 'abc']], responseHeaders: [['X-Res', 'zzz']], hasRequestBody: true, hasResponseBody: true, deviceId: 'd', ...p }) as NetworkEntry;
const text = (s: string) => ({ encoding: 'utf8', data: s, size: s.length }) as unknown as NetworkDetail['responseBody'];

describe('findMatchPlace', () => {
  it('prefers the response body, then the request body, headers and the URL', () => {
    const detail = { requestBody: text('{"token":"needle"}'), responseBody: text('{"a":"NEEDLE"}') } as NetworkDetail;
    expect(findMatchPlace(entry(), detail, 'needle')).toEqual({ tab: 'response', section: 'body' });
    expect(findMatchPlace(entry(), { ...detail, responseBody: text('{}') }, 'needle')).toEqual({ tab: 'request', section: 'body' });
    expect(findMatchPlace(entry(), null, 'zzz')).toEqual({ tab: 'response', section: 'headers' });
    expect(findMatchPlace(entry(), null, 'abc')).toEqual({ tab: 'request', section: 'headers' });
    expect(findMatchPlace(entry(), null, 'needle')).toEqual({ tab: 'request', section: 'query' });
    expect(findMatchPlace(entry({ url: 'https://h/needle/x' }), null, 'needle')).toEqual({ tab: 'general', section: 'url' });
    expect(findMatchPlace(entry(), null, 'nothing')).toBeNull();
  });
  it('marks every occurrence, case-insensitively', () => {
    expect(matchOffsets('Ab ab AB', 'ab')).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
    expect(matchOffsets('abc', '')).toEqual([]);
  });
});
