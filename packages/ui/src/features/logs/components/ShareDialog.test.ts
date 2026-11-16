import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { SECRET_MASK } from '@durbun/protocol';
import { LogMasker } from '../model/maskLog';
import { logShareReport } from './ShareDialog';
import '../i18n';

const line: LogEntry = {
  id: 1,
  ts: Date.UTC(2026, 10, 16, 9, 0, 0),
  deviceId: 'android:x',
  appId: 'app:1',
  source: 'app',
  level: 'info',
  tag: 'auth',
  message: 'login ok token=abc123456',
  data: { user: 'can', otp: 123456, session: { id: 'sid-1', trusted: true }, mfa: false, list: ['password=p'] },
  error: { type: 'AuthError', message: 'bad password=hunter2', stack: 'at login (auth.dart:1)' },
};

describe('log share report', () => {
  it('masks the message, the structured data and the error when masking is on', () => {
    const m = new LogMasker();
    const r = logShareReport(line, {}, 'en', (e) => e.message, m);
    expect(r).toContain(`token=${SECRET_MASK}`);
    expect(r).not.toContain('abc123456');
    expect(r).not.toContain('123456,');
    expect(r).toContain(`"otp": "${SECRET_MASK}"`);
    expect(r).toContain('"user": "can"');
    expect(r).toContain(`"password=${SECRET_MASK}"`);
    expect(r).not.toContain('hunter2');
    expect(m.count).toBeGreaterThanOrEqual(4);
  });

  it('keeps every value without a masker', () => {
    const r = logShareReport(line, {}, 'en', (e) => e.message);
    expect(r).toContain('"otp": 123456');
    expect(r).toContain('token=abc123456');
  });

  it('prints no structured data for device and system lines (Dürbün’s own fields)', () => {
    const r = logShareReport({ ...line, source: 'device' }, {}, 'en', (e) => e.message, new LogMasker());
    expect(r).not.toContain('"otp"');
  });
});
