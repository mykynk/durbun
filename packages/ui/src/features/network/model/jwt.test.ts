import { describe, expect, it } from 'vitest';
import { decodeJwt, findJwts, jwtStateAt } from './jwt';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (claims: Record<string, unknown>) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.c2ln`;

describe('jwt', () => {
  it('decodes header, claims and time claims (Bearer prefix allowed)', () => {
    const jwt = decodeJwt(`Bearer ${token({ sub: 'u1', exp: 2000, iat: 1000, name: 'Çağrı' })}`, 'Authorization');
    expect(jwt?.header.alg).toBe('HS256');
    expect(jwt?.claims.sub).toBe('u1');
    expect(jwt?.claims.name).toBe('Çağrı');
    expect(jwt?.times).toEqual({ exp: 2_000_000, iat: 1_000_000 });
  });
  it('ignores values that only look like a token', () => {
    expect(decodeJwt('eyJhbGciOi…')).toBeNull();
    expect(decodeJwt('eyJ.not.json')).toBeNull();
    expect(decodeJwt('abc')).toBeNull();
  });
  it('finds tokens inside header and cookie values, once each', () => {
    const t1 = token({ sub: 'a' });
    const found = findJwts([
      { name: 'Authorization', value: `Bearer ${t1}` },
      { name: 'Cookie', value: `sid=1; at=${t1}; other=${token({ sub: 'b' })}` },
    ]);
    expect(found.map((j) => [j.name, j.claims.sub])).toEqual([
      ['Authorization', 'a'],
      ['Cookie', 'b'],
    ]);
  });
  it('says whether the token was usable when the request was sent', () => {
    const j = decodeJwt(token({ exp: 100, nbf: 50 }))!;
    expect(jwtStateAt(j, 40_000)).toBe('notYet');
    expect(jwtStateAt(j, 60_000)).toBe('valid');
    expect(jwtStateAt(j, 100_000)).toBe('expired');
    expect(jwtStateAt(decodeJwt(token({ sub: 'x' }))!, 1)).toBe('noExpiry');
  });
});
