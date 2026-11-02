// Generates Tests/DurbunTests/Fixtures/mock-vectors.json from the REFERENCE matcher
// (`mockRuleMatches` / `findMockRule` in packages/protocol/src/index.ts), so the Swift tests prove
// parity case by case. Run from anywhere (Node >= 22.18 strips TypeScript types natively):
//
//   node sdks/ios/scripts/generate-mock-vectors.mjs
//
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { mockRuleMatches, findMockRule } = await import(join(here, '../../../packages/protocol/src/index.ts'));

const base = { enabled: true, method: '*', action: { type: 'delay', delayMs: 0 }, createdAt: 1730540000000 };
let counter = 0;
const rule = (match, url, extra = {}) => ({ ...base, id: `r${++counter}`, match, url, ...extra });

const rules = [
  // contains
  rule('contains', 'api/users'),
  rule('contains', 'API/USERS'),
  rule('contains', ''),
  rule('contains', 'users?id=1'),
  rule('contains', 'graphql'),
  rule('contains', '%c3%a7ay'),
  rule('contains', 'path\nwith'),
  // exact
  rule('exact', 'https://api.example.com/v1/users/42'),
  rule('exact', 'HTTPS://API.EXAMPLE.COM/V1/USERS/42'),
  rule('exact', 'https://api.example.com/v1/users'),
  rule('exact', ''),
  // glob
  rule('glob', '*/users/*'),
  rule('glob', 'https://api.example.com/v1/*'),
  rule('glob', '*.png'),
  rule('glob', '*/users/?'),
  rule('glob', '*/users/??'),
  rule('glob', 'https://*.example.com/*'),
  rule('glob', '*'),
  rule('glob', ''),
  rule('glob', '*users*'),
  rule('glob', '*[1]*'),
  rule('glob', '*(a|b)*'),
  rule('glob', '*a$b'),
  rule('glob', '*\\*'),
  rule('glob', '*.json?*'),
  rule('glob', '*{id}*'),
  rule('glob', '+*'),
  rule('glob', '^*'),
  rule('glob', 'https://example.com/path*'),
  rule('glob', 'https://example.com/path?withnewline'),
  rule('glob', 'HTTP://LOCALHOST:8080/*'),
  rule('glob', '*?include=*&sort=*'),
  // regex
  rule('regex', '/users/\\d+$'),
  rule('regex', '^https://api\\.example\\.com'),
  rule('regex', 'USERS'),
  rule('regex', '('),
  rule('regex', ''),
  rule('regex', '\\.(png|jpg)$'),
  rule('regex', '[a-z]+://'),
  rule('regex', '(?<version>v\\d)/'),
  rule('regex', 'users|orders'),
  rule('regex', '\\?include='),
  rule('regex', '^http:'),
  rule('regex', 'a\\$b'),
  // method / apps / enabled / unknown match type
  rule('contains', 'example', { method: 'GET' }),
  rule('contains', 'example', { method: 'get' }),
  rule('contains', 'example', { method: 'POST' }),
  rule('contains', 'example', { apps: [] }),
  rule('contains', 'example', { apps: ['com.mykynk.pati'] }),
  rule('contains', 'example', { apps: ['com.other.app'] }),
  rule('contains', 'example', { enabled: false }),
  rule('prefix', 'https://'),
];

const urls = [
  'https://api.example.com/v1/users/42',
  'https://api.example.com/v1/users/42?include=orders&sort=desc',
  'https://API.Example.com/V1/Users',
  'http://localhost:8080/graphql',
  'https://cdn.example.com/img/logo.png',
  'https://api.example.com/v1/users/7',
  'https://api.example.com/search?q=%C3%A7ay',
  'https://api.example.com/v1/[1]/x',
  'https://api.example.com/a$b',
  'https://example.com/path\nwithnewline',
  'https://example.com/api/(a|b)/data.json?v=1',
  'https://example.com/{id}/file*',
  '',
];

const methods = ['GET', 'post'];
const appIds = [null, 'com.mykynk.pati'];

const cases = [];
rules.forEach((r, ri) => {
  urls.forEach((u, ui) => {
    for (const m of methods) {
      for (const a of appIds) {
        cases.push({ r: ri, u: ui, m, a, e: mockRuleMatches(r, m, u, a ?? undefined) });
      }
    }
  });
});

// First-match-wins scenarios.
const byId = (id) => {
  const found = rules.find((r) => r.id === id);
  if (!found) throw new Error(`unknown rule ${id}`);
  return found;
};
const ordered = [
  ['r51', 'r1', 'r15'], // disabled first, then contains, then glob
  ['r15', 'r12', 'r1'], // glob order
  ['r36', 'r35', 'r33'], // invalid regex never matches
  ['r50', 'r49', 'r48'], // apps filter
].map((ids) => ids.map(byId));
const finds = [];
ordered.forEach((list, li) => {
  urls.forEach((u, ui) => {
    for (const m of methods) {
      for (const a of appIds) {
        const hit = findMockRule(list, m, u, a ?? undefined);
        finds.push({ l: li, u: ui, m, a, id: hit ? hit.id : null });
      }
    }
  });
});

const out = {
  generatedBy: 'sdks/ios/scripts/generate-mock-vectors.mjs (reference: packages/protocol/src/index.ts)',
  rules,
  urls,
  cases,
  lists: ordered.map((list) => list.map((r) => rules.indexOf(r))),
  finds,
};
const target = join(here, '../Tests/DurbunTests/Fixtures/mock-vectors.json');
writeFileSync(target, JSON.stringify(out) + '\n');
const positives = cases.filter((c) => c.e).length;
console.log(`wrote ${cases.length} match cases (${positives} matches) and ${finds.length} first-match cases to ${target}`);
