import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import '../../../i18n';
import '../i18n';
import { setLanguage } from '../../../i18n/core';
import { flapSummary, flapTimeRange } from './systemText';

type Ev = Pick<LogEntry, 'code' | 'params' | 'ts'>;
const ev = (code: string, s: number): Ev => ({ code, ts: s * 1000, params: { deviceId: 'ios:1' } });

afterEach(() => setLanguage('en'));

describe('merged connection row text', () => {
  it('one drop: from the drop to the first event that says it is back (not the plug-in connect before it)', () => {
    setLanguage('tr');
    const events = [ev('device.connected', 0), ev('logs.streamStarted', 0.4), ev('device.disconnected', 10), ev('device.connected', 12), ev('logs.streamStarted', 12.5)];
    expect(flapSummary(events, 'Yusuf iPhone’u').text).toBe('Yusuf iPhone’u: bağlantı koptu, 2 sn sonra geri geldi');
  });

  it('one failed log stream: from the failure to the restart', () => {
    setLanguage('tr');
    const events = [ev('device.connected', 0), ev('logs.streamStarted', 0.4), ev('logs.streamError', 20), ev('logs.streamStarted', 23)];
    expect(flapSummary(events, 'Pixel 8').text).toBe('Pixel 8: log akışı kesildi, 3 sn sonra yeniden başladı');
  });

  it('several drops: the time it kept dropping, from the first drop to the newest event', () => {
    setLanguage('en');
    const events = [ev('device.connected', 0), ev('device.disconnected', 20)];
    for (let i = 1; i <= 3; i++) events.push(ev('device.connected', 20 + i * 4 - 2), ev('device.disconnected', 20 + i * 4));
    events.push(ev('device.connected', 34));
    const s = flapSummary(events, 'Pixel 8');
    expect(s.text).toBe('Pixel 8: the connection dropped and came back 4 times · within 14 s');
    expect(s.hint).toMatch(/USB cable/);
  });

  it('falls back to the server’s device name, then to a generic word', () => {
    setLanguage('en');
    const named: Ev[] = [{ ...ev('device.disconnected', 0), params: { device: 'iPad' } }, ev('device.connected', 1)];
    expect(flapSummary(named).text).toMatch(/^iPad: /);
    expect(flapSummary([ev('device.disconnected', 0), ev('device.connected', 1)]).text).toMatch(/^Device: /);
  });

  it('time range: one clock within the same second', () => {
    const clock = (ts: number) => `c${Math.floor(ts / 1000)}`;
    expect(flapTimeRange(1000, 1900, clock)).toBe('c1');
    expect(flapTimeRange(1000, 5000, clock)).toBe('c1–c5');
  });
});
