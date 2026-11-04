import { describe, expect, it } from 'vitest';
import { DEFAULT_SHARE_OPTIONS, MASK, MAX_SHARED_BODY_CHARS, buildShareReport, isSecretName, reindentJson, shareTime, type ShareInput } from './shareReport';
import { shareLabels } from '../share';

const utf8 = (data: string) => ({ encoding: 'utf8' as const, data, size: new TextEncoder().encode(data).length });

/** The same request as `share_report_test.dart` in the Flutter SDK: both must print the same report. */
const login: ShareInput = {
  method: 'POST',
  url: 'https://api.example.com/v1/login?lang=tr&access_token=abc123',
  state: 'complete',
  status: 401,
  startTs: Date.UTC(2026, 10, 4, 16, 22, 19, 768),
  utcOffsetMinutes: 180,
  duration: 120,
  source: 'dio',
  app: 'Shop 2.4.1 (com.example.shop)',
  device: 'Pixel 8 · Android 15',
  requestHeaders: [
    ['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig'],
    ['Content-Type', 'application/json'],
    ['Cookie', 'sid=s3cr3t; theme=dark'],
    ['X-Request-ID', '7f3a9c'],
  ],
  requestContentType: 'application/json',
  requestBody: utf8('{"user":"ayşe","password":"hunter2","remember":true,"tags":[]}'),
  responseHeaders: [
    ['Content-Type', 'application/json; charset=utf-8'],
    ['Set-Cookie', 'session=abc; Path=/; HttpOnly'],
    ['CF-RAY', '8a1b-IST'],
  ],
  responseContentType: 'application/json; charset=utf-8',
  responseBody: utf8('{"error":"invalid_grant","retry":12345678901234567890}'),
};

const EXPECTED = `POST https://api.example.com/v1/login?lang=tr&access_token=••••
→ 401 Unauthorized · 120 ms

- Time: 2026-11-04 19:22:19.768 (UTC+03:00) · 2026-11-04T16:22:19.768Z
- App: Shop 2.4.1 (com.example.shop)
- Device: Pixel 8 · Android 15
- Client: dio
- Trace IDs: X-Request-ID 7f3a9c · CF-RAY 8a1b-IST

Request headers (4):
\`\`\`http
Authorization: Bearer ••••
Content-Type: application/json
Cookie: sid=••••; theme=••••
X-Request-ID: 7f3a9c
\`\`\`

Request body (application/json, 63 B):
\`\`\`json
{
  "user": "ayşe",
  "password": "••••",
  "remember": true,
  "tags": []
}
\`\`\`

Response headers (3):
\`\`\`http
Content-Type: application/json; charset=utf-8
Set-Cookie: session=••••; Path=/; HttpOnly
CF-RAY: 8a1b-IST
\`\`\`

Response body (application/json, 54 B):
\`\`\`json
{
  "error": "invalid_grant",
  "retry": 12345678901234567890
}
\`\`\`

cURL:
\`\`\`bash
curl 'https://api.example.com/v1/login?lang=tr&access_token=••••' \\
  -H 'Authorization: Bearer ••••' \\
  -H 'Content-Type: application/json' \\
  -H 'Cookie: sid=••••; theme=••••' \\
  -H 'X-Request-ID: 7f3a9c' \\
  --data-raw '{"user":"ayşe","password":"••••","remember":true,"tags":[]}'
\`\`\`

Secret values (tokens, cookies, passwords) are masked as ••••.`;

const en = shareLabels('en');

describe('share report', () => {
  it('prints the agreed format (same as the Flutter panel)', () => {
    expect(buildShareReport(login, DEFAULT_SHARE_OPTIONS, en)).toBe(EXPECTED);
  });

  it('keeps every value when masking is off, and leaves out bodies and cURL on request', () => {
    const r = buildShareReport(login, { mask: false, bodies: false, curl: false }, en);
    expect(r).toContain('access_token=abc123');
    expect(r).toContain('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig');
    expect(r).not.toContain(MASK);
    expect(r).not.toContain('Request body');
    expect(r).not.toContain('cURL');
    expect(r).not.toContain('masked');
  });

  it('describes failures, pending requests, mocks and missing bodies', () => {
    const failed = buildShareReport(
      { ...login, state: 'failed', status: undefined, error: "SocketException: Failed host lookup: 'api.example.com'", responseHeaders: [], responseBody: null, mocked: true, mockRule: 'Login 503' },
      DEFAULT_SHARE_OPTIONS,
      en,
    );
    expect(failed).toContain('→ Failed · 120 ms');
    expect(failed).toContain("Error:\n```\nSocketException: Failed host lookup: 'api.example.com'\n```");
    expect(failed).toContain('- Mocked: the response came from the Dürbün mock rule “Login 503”, not from the server');
    expect(buildShareReport({ ...login, state: 'pending', status: undefined, duration: undefined }, DEFAULT_SHARE_OPTIONS, en)).toContain('→ Pending: no response yet');
    const missing = buildShareReport({ ...login, requestBody: null, requestBodyMissing: true }, DEFAULT_SHARE_OPTIONS, en);
    expect(missing).toContain('Request body: not captured');
    const tr = buildShareReport(login, DEFAULT_SHARE_OPTIONS, shareLabels('tr'));
    expect(tr).toContain('İstek başlıkları (4):');
    expect(tr).toContain('Gizli değerler (token, çerez, parola) •••• ile maskelendi.');
  });

  it('cuts long bodies and notes binary or partly captured ones', () => {
    const long = 'x'.repeat(MAX_SHARED_BODY_CHARS + 5);
    const r = buildShareReport({ ...login, responseContentType: 'text/plain', responseBody: utf8(long) }, DEFAULT_SHARE_OPTIONS, en);
    expect(r).toContain('… 5 more characters not shown');
    const upload = buildShareReport({ ...login, requestContentType: 'text/plain', requestBody: utf8(long) }, DEFAULT_SHARE_OPTIONS, en);
    expect(upload).toContain("-H 'X-Request-ID: 7f3a9c'\n```\n\nThe request body is too long and is left out of cURL.");
    expect(upload).not.toContain('--data-raw');
    const bin = buildShareReport({ ...login, responseContentType: 'image/png', responseBody: { encoding: 'base64', data: 'iVBORw0KGgo=', size: 2048 } }, DEFAULT_SHARE_OPTIONS, en);
    expect(bin).toContain('Response body (image/png, 8 B of 2.0 KB captured): binary, not included');
  });

  it('a body with a code fence gets a longer fence', () => {
    const r = buildShareReport({ ...login, responseContentType: 'text/markdown', responseBody: utf8('a\n```\nb') }, DEFAULT_SHARE_OPTIONS, en);
    expect(r).toContain('````\na\n```\nb\n````');
  });

  it('masks form fields and URL passwords', () => {
    const r = buildShareReport(
      { ...login, url: 'https://bob:pa55@api.example.com/x', requestContentType: 'application/x-www-form-urlencoded', requestBody: utf8('grant_type=password&username=bob&password=pa55&client_secret=s') },
      DEFAULT_SHARE_OPTIONS,
      en,
    );
    expect(r).toContain('POST https://bob:••••@api.example.com/x');
    expect(r).toContain('grant_type=password&username=bob&password=••••&client_secret=••••');
  });

  it('secret names', () => {
    for (const n of ['Authorization', 'x-api-key', 'X-CSRF-Token', 'refresh_token', 'client_secret', 'sessionId', 'Cookie']) expect(isSecretName(n)).toBe(true);
    for (const n of ['Content-Type', 'x-request-id', 'user', 'code', 'key', 'author']) expect(isSecretName(n)).toBe(false);
  });

  it('indents JSON without parsing it', () => {
    expect(reindentJson('{"a":[1,{"b":"x,y"}],"c":{} }')).toBe('{\n  "a": [\n    1,\n    {\n      "b": "x,y"\n    }\n  ],\n  "c": {}\n}');
    expect(reindentJson('{"cut":"abc')).toBe('{\n  "cut": "abc');
  });

  it('time line: local with offset, then UTC', () => {
    expect(shareTime(Date.UTC(2026, 0, 1, 0, 0, 0, 5), -330)).toBe('2025-12-31 18:30:00.005 (UTC-05:30) · 2026-01-01T00:00:00.005Z');
  });
});
