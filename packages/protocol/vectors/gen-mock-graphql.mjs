// Writes mock-graphql.json: test vectors for mock matching v2 (the GraphQL operation condition), computed by the
// protocol's reference functions (`graphqlOperationsOf`, `mockRuleMatchesRequest`, `findMockRuleForRequest`).
// Every SDK port (JS, Kotlin, Swift, Dart) checks its own implementation against this one file.
//
// Run from the repository root (uses the pre-installed tsx loader, no downloads):
//   node --import tsx packages/protocol/vectors/gen-mock-graphql.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOCK_GRAPHQL_MAX_CHARS,
  findMockRuleForRequest,
  graphqlOperationsOf,
  mockRuleMatches,
  mockRuleMatchesRequest,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'mock-graphql.json');

const GQL = 'https://api.example.com/graphql';
const JSON_CT = 'application/json; charset=utf-8';
const post = (body, contentType = JSON_CT, extra = {}) => ({ method: 'POST', url: GQL, contentType, body, ...extra });
const payload = (p) => post(JSON.stringify(p));
const get = (query) => ({ method: 'GET', url: `${GQL}?${query}` });

/**
 * A request whose JSON body is exactly `length` UTF-16 code units long:
 * `{"operationName":"Big","query":"query Big { a }","pad":"<fill…><a…>"}` (+ `trailing` spaces). Large bodies are
 * written as `bodyPattern` ([text, times] pairs joined in order) to keep the file small; ports expand it into `body`.
 */
function bigPost(length, fill = 'a', trailing = 0) {
  const head = '{"operationName":"Big","query":"query Big { a }","pad":"';
  const tail = '"}';
  const room = length - head.length - tail.length;
  const times = Math.floor(room / fill.length);
  const rest = room - times * fill.length;
  const bodyPattern = [[head, 1], [fill, times], ['a', rest], [tail, 1], [' ', trailing]].filter(([, t]) => t > 0);
  const request = { method: 'POST', url: GQL, contentType: JSON_CT, bodyPattern };
  if (expand(request).body.length !== length + trailing) throw new Error('bigPost length');
  return request;
}

/** The request as the reference sees it (`bodyPattern` expanded into `body`). */
function expand(request) {
  if (!request.bodyPattern) return request;
  const { bodyPattern, ...rest } = request;
  return { ...rest, body: bodyPattern.map(([text, times]) => text.repeat(times)).join('') };
}

// [description, request]
const operationCases = [
  // JSON payloads
  ['operationName wins, type from the named operation', payload({ operationName: 'GetUser', query: 'query GetUser($id: ID!) { user(id: $id) { id } }', variables: { id: '1' } })],
  ['no operationName: first operation of the document', payload({ query: 'query GetFeed { feed { id } } query Other { x }' })],
  ['operationName selects among several operations', payload({ operationName: 'B', query: 'query A { a } mutation B { b } subscription C { c }' })],
  ['operationName not in the document: name only, type unknown', payload({ operationName: 'Missing', query: 'query Present { a }' })],
  ['mutation', payload({ query: 'mutation LikeStory($id: ID!) { likeStory(storyId: $id) { id } }' })],
  ['subscription', payload({ query: 'subscription OnMessage { messageAdded { id } }' })],
  ['anonymous shorthand query', payload({ query: '{ me { id } }' })],
  ['anonymous query keyword', payload({ query: 'query { me { id } }' })],
  ['anonymous mutation with variables', payload({ query: 'mutation($id: ID!) { archive(id: $id) }' })],
  ['fragment first, then the operation', payload({ query: 'fragment F on User { id } query WithFragment { me { ...F } }' })],
  ['comments, strings and block strings are skipped', payload({ query: '# query Fake { x }\n"""block query Fake2 { y }""" query Real(arg: "query Nope") { z }' })],
  ['comment between keyword and name', payload({ query: 'query # note\n  Named { a }' })],
  ['commas and BOM are insignificant', payload({ query: '﻿,,query ,, Comma { a }' })],
  ['words inside selections are not operations', payload({ query: '{ query { mutation } } mutation Late { x }' })],
  ['empty operationName is ignored', payload({ operationName: '', query: 'query Fallback { a }' })],
  ['non-string operationName is ignored', payload({ operationName: 7, query: 'query Fallback { a }' })],
  ['persisted query: operationName only', payload({ operationName: 'GetPersisted', variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } })],
  ['neither query nor operationName', payload({ variables: { a: 1 } })],
  ['query that is not a string', payload({ query: { a: 1 } })],
  ['document without operations', payload({ query: 'fragment F on User { id }' })],
  ['case is kept', payload({ query: 'query getUSER { a }' })],
  // batched
  ['batched array: one operation per element', post(JSON.stringify([{ operationName: 'A', query: 'query A { a }' }, { query: 'mutation B { b }' }, 7, { variables: {} }]))],
  ['batched array without operations', post('[1, 2, {"x": 1}]')],
  ['empty array', post('[]')],
  // body forms
  ['application/graphql body: first operation', post('query FromDoc { a } mutation Second { b }', 'application/graphql')],
  ['application/graphql without operations', post('fragment F on User { id }', 'application/graphql; charset=utf-8')],
  ['application/graphql+json is JSON', post(JSON.stringify({ query: 'query J { a }' }), 'application/graphql-response+json')],
  ['JSON detected by the first character whatever the content type', post(JSON.stringify({ query: 'query NoCt { a }' }), undefined)],
  ['surrounding ASCII whitespace is trimmed', post(`\r\n\t ${JSON.stringify({ query: 'query Trim { a }' })} \n`)],
  ['invalid JSON', post('{"query": "query Broken { a }"')],
  ['not JSON, not GraphQL', post('a=1&query=query%20Form%20%7B%20a%20%7D', 'application/x-www-form-urlencoded')],
  ['whitespace-only body counts as no body (POST)', post('  \n ')],
  ['no body (POST): unknown', { method: 'POST', url: GQL }],
  ['empty body string (POST): unknown', post('')],
  // size bound (UTF-16 code units of the untrimmed body)
  ['body at the bound', bigPost(MOCK_GRAPHQL_MAX_CHARS)],
  ['body one over the bound', bigPost(MOCK_GRAPHQL_MAX_CHARS + 1)],
  ['multi-byte UTF-8 at the bound (UTF-16 length counts)', bigPost(MOCK_GRAPHQL_MAX_CHARS, 'ş')],
  ['astral chars (two UTF-16 units each) one over the bound', bigPost(MOCK_GRAPHQL_MAX_CHARS + 1, '😀')],
  ['astral chars at the bound (fewer characters than units)', bigPost(MOCK_GRAPHQL_MAX_CHARS, '😀')],
  ['trailing spaces push the untrimmed body over the bound', bigPost(MOCK_GRAPHQL_MAX_CHARS - 2, 'a', 3)],
  // GET
  ['GET with query and operationName', get(`operationName=GetUser&query=${encodeURIComponent('query GetUser { me { id } } query Other { x }')}&variables=%7B%7D`)],
  ['GET with query only', get(`query=${encodeURIComponent('query OnlyQuery { a }')}`)],
  ['GET with + for spaces', get('query=query+PlusName+%7B+a+%7D')],
  ['GET %2B stays a plus sign', get('operationName=A%2BB')],
  ['GET persisted query (operationName and extensions)', get(`operationName=GetPersisted&extensions=${encodeURIComponent('{"persistedQuery":{"version":1}}')}`)],
  ['GET first occurrence wins', get('operationName=First&operationName=Second')],
  ['GET fragment part is not the query string', { method: 'GET', url: `${GQL}?query=${encodeURIComponent('query Frag { a }')}#operationName=Hash` }],
  ['GET lowercase method', { method: 'get', url: `${GQL}?operationName=Lower` }],
  ['GET undecodable query string', get('operationName=Bad%E0%A4%A&x=1')],
  ['GET without GraphQL parameters', get('page=2')],
  ['GET without a query string', { method: 'GET', url: GQL }],
  ['GET with a body uses the body', { method: 'GET', url: `${GQL}?operationName=FromUrl`, contentType: JSON_CT, body: JSON.stringify({ operationName: 'FromBody' }) }],
  ['POST does not read URL parameters', { method: 'POST', url: `${GQL}?operationName=FromUrl` }],
  // strict JSON (RFC 8259, as JSON.parse reads it): lenient parsers (org.json, JSON5) must not be used by a port
  ['JSON: single quotes are invalid', post("{'operationName': 'Single'}")],
  ['JSON: unquoted key is invalid', post('{operationName: "Unquoted"}')],
  ['JSON: trailing comma is invalid', post('{"operationName": "Trailing",}')],
  ['JSON: number with a leading zero is invalid', post('{"operationName": "Zero", "n": 01}')],
  ['JSON: number ending in a dot is invalid', post('{"operationName": "Dot", "n": 1.}')],
  ['JSON: number with an empty exponent is invalid', post('{"operationName": "Exp", "n": 1e}')],
  ['JSON: a plus sign before a number is invalid', post('{"operationName": "Plus", "n": +1}')],
  ['JSON: a huge exponent is valid', post('{"operationName": "Huge", "n": -1.5E+400}')],
  ['JSON: a raw tab inside a string is invalid', post('{"operationName": "Tab\tName"}')],
  ['JSON: an unknown escape is invalid', post('{"operationName": "Esc\\x41"}')],
  ['JSON: a short unicode escape is invalid', post('{"operationName": "Esc\\u41"}')],
  ['JSON: escapes in keys and values are decoded', post('{"operation\\u004Eame": "Esc\\u0061ped\\/"}')],
  ['JSON: a lone surrogate escape is valid', post('{"operationName": "Lone", "x": "\\ud800"}')],
  ['JSON: the last duplicate key wins', post('{"operationName": "First", "operationName": "Second"}')],
  ['JSON: a duplicate key may drop the name', post('{"operationName": "First", "operationName": null, "query": "query Doc { a }"}')],
  ['JSON: trailing data is invalid', post('{"operationName": "Tail"} x')],
  ['JSON: two documents are invalid', post('{"operationName": "One"}{}')],
  ['JSON: non-ASCII whitespace is invalid', post('{"operationName": "Nbsp"}')],
  ['JSON: misspelled literal is invalid', post('{"operationName": "Lit", "x": nul}')],
  ['JSON: deep nesting is valid', post(`{"operationName": "Deep", "x": ${'['.repeat(3000)}${']'.repeat(3000)}}`)],
  ['JSON: unterminated deep nesting is invalid', post(`{"operationName": "Deep", "x": ${'['.repeat(3000)}}`)],
  ['JSON: non-ASCII operation names are kept', payload({ operationName: 'İşlemÇ😀' })],
  ['batched array: nested arrays are not payloads', post('[[{"operationName": "Nested"}], {"operationName": "Flat"}]')],
  ['content type is case-insensitive', post('query Upper { a }', 'Application/GraphQL')],
  ['keywords are case-sensitive', post('Query Upper { a } query Lower { b }', 'application/graphql')],
  ['application/graphql shorthand document', post('{ me { id } }', 'application/graphql')],
  // URL decoding (decodeURIComponent: strict UTF-8)
  ['GET percent-encoded UTF-8', get('operationName=%C3%A7ay%F0%9F%98%80')],
  ['GET literal non-ASCII characters are kept', get('operationName=çay')],
  ['GET overlong UTF-8 is undecodable', get('operationName=%C0%80')],
  ['GET an encoded surrogate is undecodable', get('operationName=%ED%A0%80')],
  ['GET a truncated sequence is undecodable', get('operationName=%C3x')],
  ['GET an undecodable pair elsewhere makes all unknown', get('%ZZ=1&operationName=Fine')],
  ['GET a name without = is empty', get('operationName&query=query+Later+%7B+a+%7D')],
  ['GET empty pairs are skipped', get('&&operationName=Skips&&')],
  ['GET lowercase percent escapes', get('operationName=%c3%a7')],
];

const respond = { type: 'respond', status: 200 };
let n = 0;
const rule = (when, extra = {}) => ({ id: `g${++n}`, enabled: true, method: 'POST', url: '/graphql', match: 'contains', action: respond, createdAt: 0, ...(when === undefined ? {} : { when }), ...extra });
const gq = (operationName, operationType) => ({ graphql: operationType ? { operationName, operationType } : { operationName } });

const getUser = payload({ operationName: 'GetUser', query: 'query GetUser { me { id } }' });
const matchCases = [
  [rule(gq('GetUser')), getUser],
  [rule(gq('GetUser', 'query')), getUser],
  [rule(gq('GetUser', 'mutation')), getUser],
  [rule(gq('getuser')), getUser],
  [rule(gq('GetFeed')), getUser],
  [rule(undefined), getUser],
  [rule({}), getUser],
  [rule(gq('GetUser'), { enabled: false }), getUser],
  [rule(gq('GetUser'), { method: 'GET' }), getUser],
  [rule(gq('GetUser'), { url: '/rest' }), getUser],
  [rule(gq('GetUser'), { apps: ['com.example.app'] }), { ...getUser, appId: 'com.example.app' }],
  [rule(gq('GetUser'), { apps: ['com.example.app'] }), { ...getUser, appId: 'com.other.app' }],
  [rule(gq('GetPersisted')), payload({ operationName: 'GetPersisted', extensions: { persistedQuery: { version: 1 } } })],
  [rule(gq('GetPersisted', 'query')), payload({ operationName: 'GetPersisted', extensions: { persistedQuery: { version: 1 } } })],
  [rule(gq('Missing', 'query')), payload({ operationName: 'Missing', query: 'query Present { a }' })],
  [rule(gq('B')), post(JSON.stringify([{ query: 'query A { a }' }, { query: 'mutation B { b }' }]))],
  [rule(gq('B', 'mutation')), post(JSON.stringify([{ query: 'query A { a }' }, { query: 'mutation B { b }' }]))],
  [rule(gq('B', 'query')), post(JSON.stringify([{ query: 'query A { a }' }, { query: 'mutation B { b }' }]))],
  [rule(gq('Anything')), payload({ query: '{ me { id } }' })],
  [rule(gq('GetUser')), { method: 'POST', url: GQL }],
  [rule(gq('GetUser')), post('{"operationName": "GetUser"')],
  [rule(gq('Big')), bigPost(MOCK_GRAPHQL_MAX_CHARS)],
  [rule(gq('Big')), bigPost(MOCK_GRAPHQL_MAX_CHARS + 1)],
  [rule(gq('GetUser'), { method: 'GET' }), get('operationName=GetUser')],
  [rule(gq('GetUser'), { method: '*' }), get(`query=${encodeURIComponent('query GetUser { a }')}`)],
  [rule(gq('FromDoc', 'query')), post('query FromDoc { a }', 'application/graphql')],
  // malformed or unknown conditions never match
  [rule({ graphql: {} }), getUser],
  [rule({ graphql: { operationName: '' } }), getUser],
  [rule({ graphql: { operationName: 7 } }), getUser],
  [rule({ graphql: { operationName: 'GetUser', operationType: 'Query' } }), getUser],
  [rule({ graphql: 'GetUser' }), getUser],
  [rule({ headers: [['x-test', '1']] }), getUser],
  [rule({ graphql: { operationName: 'GetUser' }, headers: [['x-test', '1']] }), getUser],
  [rule({ graphql: null }), getUser],
];

const findRules = [
  rule(gq('GetFeed')),
  rule(gq('GetUser', 'mutation')),
  rule(gq('GetUser')),
  rule(undefined, { id: 'catch-all-graphql' }),
];
const findCases = [
  getUser,
  payload({ operationName: 'GetFeed', query: 'query GetFeed { a }' }),
  payload({ operationName: 'GetUser', query: 'mutation GetUser { a }' }),
  payload({ operationName: 'Other', query: 'query Other { a }' }),
  { method: 'POST', url: GQL },
  { method: 'GET', url: 'https://api.example.com/rest/users' },
];

const file = {
  about:
    'Mock matching v2 test vectors (GraphQL operation condition), generated from the reference functions in packages/protocol/src/index.ts. Requests: { method, url, appId?, contentType?, body? }; a large body is given as bodyPattern instead: [text, times] pairs, body = each text repeated times, joined in order. Body lengths count UTF-16 code units. operations[].expected is graphqlOperationsOf(request): a list of { name?, type? } or null (unknown). matches[].expected is mockRuleMatchesRequest(rule, request); matchesNoBody is mockRuleMatches(rule, method, url, appId) (the old signature, no body). finds[].expectedId is findMockRuleForRequest(rules, request)?.id.',
  regenerate: 'node --import tsx packages/protocol/vectors/gen-mock-graphql.mjs',
  maxChars: MOCK_GRAPHQL_MAX_CHARS,
  operations: operationCases.map(([description, request]) => ({ description, request, expected: graphqlOperationsOf(expand(request)) })),
  matches: matchCases.map(([r, request]) => ({
    rule: r,
    request,
    expected: mockRuleMatchesRequest(r, expand(request)),
    matchesNoBody: mockRuleMatches(r, request.method, request.url, request.appId),
  })),
  finds: {
    rules: findRules,
    cases: findCases.map((request) => ({ request, expectedId: findMockRuleForRequest(findRules, expand(request))?.id ?? null })),
  },
};

writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`);
const ops = file.operations.filter((c) => c.expected).length;
const hits = file.matches.filter((c) => c.expected).length;
console.log(`wrote ${out}: ${file.operations.length} operation cases (${ops} known), ${file.matches.length} match cases (${hits} match), ${findCases.length} find cases`);
