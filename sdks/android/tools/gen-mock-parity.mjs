// Regenerates durbun/src/test/resources/mock-parity.json from the protocol's reference matcher, so the
// Kotlin MockMatcher is tested against the exact TypeScript semantics.
//
// Run from the repository root (uses the pre-installed tsx loader, no downloads):
//   node --import tsx sdks/android/tools/gen-mock-parity.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMockRule, mockRuleMatches } from '../../../packages/protocol/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'durbun', 'src', 'test', 'resources', 'mock-parity.json');

const respond = { type: 'respond', status: 200 };
let n = 0;
const rule = (match, url, extra = {}) => ({
  id: `r${++n}`,
  enabled: true,
  method: '*',
  url,
  match,
  action: respond,
  createdAt: 0,
  ...extra,
});

const API = 'https://api.example.com';
const matchCases = [
  // contains
  [rule('contains', '/api/users'), 'GET', 'https://x.com/API/Users?id=1'],
  [rule('contains', ''), 'GET', 'https://x.com/'],
  [rule('contains', 'USERS'), 'GET', `${API}/users/42`],
  [rule('contains', '/ürün'), 'GET', 'https://x.com/ÜRÜN/1'],
  [rule('contains', '/istanbul'), 'GET', 'https://x.com/İSTANBUL'],
  [rule('contains', '/İstanbul'), 'GET', 'https://x.com/i̇stanbul'],
  // exact
  [rule('exact', `${API}/Users`), 'GET', `${API}/users`],
  [rule('exact', `${API}/users`), 'GET', `${API}/users/`],
  [rule('exact', ''), 'GET', ''],
  // glob
  [rule('glob', `${API}/*`), 'GET', `${API}/users/42`],
  [rule('glob', `${API}/*`), 'GET', `https://evil.example.com/users`],
  [rule('glob', '*/users/?'), 'GET', `${API}/users/4`],
  [rule('glob', '*/users/?'), 'GET', `${API}/users/42`],
  [rule('glob', 'https://x.com/a.b+c(1)/*'), 'GET', 'https://x.com/a.b+c(1)/z'],
  [rule('glob', 'https://x.com/a.b+c(1)/*'), 'GET', 'https://x.com/aXb+c(1)/z'],
  [rule('glob', '*[v1]*'), 'GET', 'https://x.com/[v1]/a'],
  [rule('glob', '*[v1]*'), 'GET', 'https://x.com/v/a'],
  [rule('glob', '*price=$5^{x}|y\\z*'), 'GET', 'https://x.com/?price=$5^{x}|y\\z&a=1'],
  [rule('glob', 'api.example.com'), 'GET', API],
  [rule('glob', 'HTTPS://API.EXAMPLE.COM/*'), 'GET', `${API}/a`],
  [rule('glob', '**'), 'GET', 'https://anything/at/all?x=1'],
  [rule('glob', 'https://x.com/v?'), 'GET', 'https://x.com/v1'],
  [rule('glob', 'https://x.com/v?'), 'GET', 'https://x.com/v'],
  [rule('glob', '*/graphql'), 'POST', `${API}/graphql`],
  [rule('glob', '*/graphql'), 'POST', `${API}/graphql?op=Me`],
  [rule('glob', ''), 'GET', ''],
  [rule('glob', '*'), 'GET', 'line1\nline2'],
  // regex (case-sensitive, searched anywhere, invalid never matches)
  [rule('regex', 'users/\\d+$'), 'GET', `${API}/users/42`],
  [rule('regex', 'users/\\d+$'), 'GET', `${API}/users/42/posts`],
  [rule('regex', 'Users'), 'GET', `${API}/users`],
  [rule('regex', 'example'), 'GET', `${API}/users`],
  [rule('regex', '(['), 'GET', `${API}/users`],
  [rule('regex', '^https://api\\.example\\.com/(?<id>\\d+)$'), 'GET', `${API}/123`],
  [rule('regex', '\\?page=[2-9]'), 'GET', `${API}/feed?page=3`],
  // method
  [rule('contains', 'users', { method: 'GET' }), 'get', `${API}/users`],
  [rule('contains', 'users', { method: 'get' }), 'GET', `${API}/users`],
  [rule('contains', 'users', { method: 'POST' }), 'GET', `${API}/users`],
  [rule('contains', 'users', { method: 'DELETE' }), 'DELETE', `${API}/users/1`],
  // enabled / apps
  [rule('contains', 'users', { enabled: false }), 'GET', `${API}/users`],
  [rule('contains', 'users', { apps: ['com.mykynk.pati'] }), 'GET', `${API}/users`, 'com.mykynk.pati'],
  [rule('contains', 'users', { apps: ['com.mykynk.pati'] }), 'GET', `${API}/users`, 'com.other.app'],
  [rule('contains', 'users', { apps: ['com.mykynk.pati'] }), 'GET', `${API}/users`, undefined],
  [rule('contains', 'users', { apps: [] }), 'GET', `${API}/users`, undefined],
];

const cases = matchCases.map(([r, method, url, appId]) => ({
  rule: r,
  method,
  url,
  ...(appId === undefined ? {} : { appId }),
  expected: mockRuleMatches(r, method, url, appId),
}));

const ordered = [
  rule('contains', '/users', { id: 'first', enabled: false }),
  rule('glob', `${API}/users/*`, { id: 'second', method: 'POST' }),
  rule('regex', 'users/\\d+', { id: 'third' }),
  rule('contains', 'users', { id: 'fourth' }),
];
const findCases = [
  ['GET', `${API}/users/42`, undefined],
  ['POST', `${API}/users/42`, undefined],
  ['GET', `${API}/users`, undefined],
  ['GET', `${API}/orders`, undefined],
].map(([method, url, appId]) => ({
  method,
  url,
  expectedId: findMockRule(ordered, method, url, appId)?.id ?? null,
}));

writeFileSync(out, JSON.stringify({ generatedFrom: 'packages/protocol/src/index.ts', cases, find: { rules: ordered, cases: findCases } }, null, 2) + '\n');
console.log(`wrote ${cases.length} match cases and ${findCases.length} find cases to ${out}`);
