import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@durbun/protocol';
import { LogMasker } from './maskLog';

describe('LogMasker', () => {
  it('masks tokens, auth headers, cookies and secret pairs in text', () => {
    const m = new LogMasker();
    const out = m.text('login ok token=abc123456 user=can Authorization: Bearer abcdefgh12345 {"password":"hunter2","name":"x"}');
    expect(out).toContain(`token=${SECRET_MASK}`);
    expect(out).toContain('user=can');
    expect(out).toContain(`Bearer ${SECRET_MASK}`);
    expect(out).toContain(`"password":"${SECRET_MASK}"`);
    expect(out).toContain('"name":"x"');
    expect(m.count).toBe(3);
  });
  it('masks JWTs and query values by name, leaves plain text alone', () => {
    const m = new LogMasker();
    expect(m.text('jwt eyJhbGciOiJI.eyJzdWIiOiIx.c2ln here')).toBe(`jwt ${SECRET_MASK} here`);
    expect(m.text('GET https://h/a?api_key=XYZ&page=2')).toContain('page=2');
    expect(m.text('GET https://h/a?api_key=XYZ&page=2')).not.toContain('XYZ');
    expect(m.text('nothing secret here: 42 items')).toBe('nothing secret here: 42 items');
  });
  it('masks values under secret names in structured data', () => {
    const m = new LogMasker();
    expect(m.data({ user: 'can', auth: { token: 't-1' }, list: ['password=p'] })).toEqual({ user: 'can', auth: { token: SECRET_MASK }, list: [`password=${SECRET_MASK}`] });
    expect(m.count).toBe(2);
  });
});
