import { describe, expect, it } from 'vitest';
import type { LogEntry, NetworkEntry } from '@durbun/protocol';
import { rangeContents } from './RangeBar';

const log = (id: number, ts: number, level: LogEntry['level'] = 'info', appId = 'a1'): LogEntry => ({ id, ts, level, deviceId: 'd', source: 'app', appId, message: `m${id}` }) as LogEntry;
const req = (id: string, startTs: number, endTs?: number, appId = 'a1'): NetworkEntry => ({ id, appId, deviceId: 'd', startTs, endTs, method: 'GET', url: 'u', host: 'h', path: '/p', state: 'complete', source: 's', requestHeaders: [], hasRequestBody: false, hasResponseBody: false }) as NetworkEntry;

describe('what happened in a dragged range', () => {
  it('keeps the target’s lines and the requests that overlap the range, in time order', () => {
    const logs = [log(1, 900), log(2, 1500, 'error'), log(3, 1200), log(4, 1300, 'info', 'other'), log(5, 2500)];
    const reqs = [req('r1', 500, 1100), req('r2', 1800), req('r3', 2100), req('r4', 1000, 1400, 'other')];
    const r = rangeContents(1000, 2000, logs, reqs, (e) => e.appId === 'a1', (e) => e.appId === 'a1');
    expect(r.logs.map((e) => e.id)).toEqual([3, 2]);
    expect(r.errors.map((e) => e.id)).toEqual([2]);
    expect(r.requests.map((e) => e.id)).toEqual(['r1', 'r2']);
  });
});
