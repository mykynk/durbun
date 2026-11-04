import 'dart:convert';

import 'package:durbun/src/inspector/share_report.dart';
import 'package:durbun/src/inspector/share_sheet.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/strings.dart';
import 'package:flutter_test/flutter_test.dart';

InspectorBody _utf8(String data) => InspectorBody(encoding: 'utf8', data: data, size: utf8.encode(data).length);

/// The same request as `shareReport.test.ts` on the desktop: both must print the same report.
final ShareInput _login = ShareInput(
  method: 'POST',
  url: 'https://api.example.com/v1/login?lang=tr&access_token=abc123',
  state: 'complete',
  status: 401,
  startTs: DateTime.utc(2026, 11, 4, 16, 22, 19, 768).millisecondsSinceEpoch.toDouble(),
  utcOffsetMinutes: 180,
  durationMs: 120,
  source: 'dio',
  app: 'Shop 2.4.1 (com.example.shop)',
  device: 'Pixel 8 · Android 15',
  requestHeaders: const <List<String>>[
    ['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig'],
    ['Content-Type', 'application/json'],
    ['Cookie', 'sid=s3cr3t; theme=dark'],
    ['X-Request-ID', '7f3a9c'],
  ],
  requestContentType: 'application/json',
  requestBody: _utf8('{"user":"ayşe","password":"hunter2","remember":true,"tags":[]}'),
  responseHeaders: const <List<String>>[
    ['Content-Type', 'application/json; charset=utf-8'],
    ['Set-Cookie', 'session=abc; Path=/; HttpOnly'],
    ['CF-RAY', '8a1b-IST'],
  ],
  responseContentType: 'application/json; charset=utf-8',
  responseBody: _utf8('{"error":"invalid_grant","retry":12345678901234567890}'),
);

const String _expected = r"""POST https://api.example.com/v1/login?lang=tr&access_token=••••
→ 401 Unauthorized · 120 ms

- Time: 2026-11-04 19:22:19.768 (UTC+03:00) · 2026-11-04T16:22:19.768Z
- App: Shop 2.4.1 (com.example.shop)
- Device: Pixel 8 · Android 15
- Client: dio
- Trace IDs: X-Request-ID 7f3a9c · CF-RAY 8a1b-IST

Request headers (4):
```http
Authorization: Bearer ••••
Content-Type: application/json
Cookie: sid=••••; theme=••••
X-Request-ID: 7f3a9c
```

Request body (application/json, 63 B):
```json
{
  "user": "ayşe",
  "password": "••••",
  "remember": true,
  "tags": []
}
```

Response headers (3):
```http
Content-Type: application/json; charset=utf-8
Set-Cookie: session=••••; Path=/; HttpOnly
CF-RAY: 8a1b-IST
```

Response body (application/json, 54 B):
```json
{
  "error": "invalid_grant",
  "retry": 12345678901234567890
}
```

cURL:
```bash
curl 'https://api.example.com/v1/login?lang=tr&access_token=••••' \
  -H 'Authorization: Bearer ••••' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: sid=••••; theme=••••' \
  -H 'X-Request-ID: 7f3a9c' \
  --data-raw '{"user":"ayşe","password":"••••","remember":true,"tags":[]}'
```

Secret values (tokens, cookies, passwords) are masked as ••••.""";

ShareInput _with(
  ShareInput b, {
  String? url,
  String? state,
  int? status,
  bool clearStatus = false,
  String? error,
  bool? mocked,
  String? mockRule,
  List<List<String>>? responseHeaders,
  String? requestContentType,
  String? responseContentType,
  InspectorBody? requestBody,
  InspectorBody? responseBody,
  bool clearRequestBody = false,
  bool requestBodyMissing = false,
}) =>
    ShareInput(
      method: b.method,
      url: url ?? b.url,
      state: state ?? b.state,
      status: clearStatus ? null : (status ?? b.status),
      error: error ?? b.error,
      startTs: b.startTs,
      utcOffsetMinutes: b.utcOffsetMinutes,
      durationMs: b.durationMs,
      source: b.source,
      app: b.app,
      device: b.device,
      mocked: mocked ?? b.mocked,
      mockRule: mockRule ?? b.mockRule,
      requestHeaders: b.requestHeaders,
      responseHeaders: responseHeaders ?? b.responseHeaders,
      requestContentType: requestContentType ?? b.requestContentType,
      responseContentType: responseContentType ?? b.responseContentType,
      requestBody: clearRequestBody ? null : (requestBody ?? b.requestBody),
      responseBody: responseBody ?? b.responseBody,
      requestBodyMissing: requestBodyMissing,
    );

void main() {
  final en = InspectorStrings.forLanguage('en');

  test('prints the agreed format (same as the desktop)', () {
    expect(buildShareReport(_login, const ShareOptions(), en), _expected);
  });

  test('keeps every value when masking is off; bodies and cURL can be left out', () {
    final r = buildShareReport(_login, const ShareOptions(mask: false, bodies: false, curl: false), en);
    expect(r, contains('access_token=abc123'));
    expect(r, contains('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig'));
    expect(r, isNot(contains(kShareMask)));
    expect(r, isNot(contains('Request body')));
    expect(r, isNot(contains('cURL')));
  });

  test('failures, pending requests, mocks and missing bodies', () {
    final failed = buildShareReport(
      _with(_login,
          state: 'failed',
          clearStatus: true,
          error: "SocketException: Failed host lookup: 'api.example.com'",
          responseHeaders: const <List<String>>[],
          mocked: true,
          mockRule: 'Login 503'),
      const ShareOptions(),
      en,
    );
    expect(failed, contains('→ Failed · 120 ms'));
    expect(failed, contains("Error:\n```\nSocketException: Failed host lookup: 'api.example.com'\n```"));
    expect(failed, contains('- Mocked: the response came from the Dürbün mock rule “Login 503”, not from the server'));
    expect(buildShareReport(_with(_login, state: 'pending', clearStatus: true), const ShareOptions(), en), contains('→ Pending: no response yet'));
    expect(buildShareReport(_with(_login, clearRequestBody: true, requestBodyMissing: true), const ShareOptions(), en),
        contains('Request body: not captured'));
    final tr = buildShareReport(_login, const ShareOptions(), InspectorStrings.forLanguage('tr'));
    expect(tr, contains('İstek başlıkları (4):'));
    expect(tr, contains('Gizli değerler (token, çerez, parola) •••• ile maskelendi.'));
  });

  test('long bodies are cut; binary or partly captured ones are noted', () {
    final r = buildShareReport(
        _with(_login, responseContentType: 'text/plain', responseBody: _utf8('x' * (kMaxSharedBodyChars + 5))), const ShareOptions(), en);
    expect(r, contains('… 5 more characters not shown'));
    final upload = buildShareReport(
        _with(_login, requestContentType: 'text/plain', requestBody: _utf8('x' * (kMaxSharedBodyChars + 5))), const ShareOptions(), en);
    expect(upload, contains("-H 'X-Request-ID: 7f3a9c'\n```\n\nThe request body is too long and is left out of cURL."));
    expect(upload, isNot(contains('--data-raw')));
    final bin = buildShareReport(
        _with(_login, responseContentType: 'image/png', responseBody: InspectorBody(encoding: 'base64', data: 'iVBORw0KGgo=', size: 2048)),
        const ShareOptions(),
        en);
    expect(bin, contains('Response body (image/png, 8 B of 2.0 KB captured): binary, not included'));
  });

  test('a body with a code fence gets a longer fence', () {
    final r = buildShareReport(_with(_login, responseContentType: 'text/markdown', responseBody: _utf8('a\n```\nb')), const ShareOptions(), en);
    expect(r, contains('````\na\n```\nb\n````'));
  });

  test('form fields and URL passwords are masked', () {
    final r = buildShareReport(
      _with(_login,
          url: 'https://bob:pa55@api.example.com/x',
          requestContentType: 'application/x-www-form-urlencoded',
          requestBody: _utf8('grant_type=password&username=bob&password=pa55&client_secret=s')),
      const ShareOptions(),
      en,
    );
    expect(r, contains('POST https://bob:••••@api.example.com/x'));
    expect(r, contains('grant_type=password&username=bob&password=••••&client_secret=••••'));
  });

  test('secret names', () {
    for (final n in ['Authorization', 'x-api-key', 'X-CSRF-Token', 'refresh_token', 'client_secret', 'sessionId', 'Cookie']) {
      expect(isSecretName(n), isTrue, reason: n);
    }
    for (final n in ['Content-Type', 'x-request-id', 'user', 'code', 'key', 'author']) {
      expect(isSecretName(n), isFalse, reason: n);
    }
  });

  test('JSON is indented without parsing it', () {
    expect(reindentJson('{"a":[1,{"b":"x,y"}],"c":{} }'), '{\n  "a": [\n    1,\n    {\n      "b": "x,y"\n    }\n  ],\n  "c": {}\n}');
    expect(reindentJson('{"cut":"abc'), '{\n  "cut": "abc');
  });

  test('device line: the name first, a CPU is not a model', () {
    expect(deviceLabel({'platform': 'ios', 'name': 'iPhone 16 Pro', 'model': 'iPhone17,1', 'osVersion': '18.2'}),
        'iPhone 16 Pro (iPhone17,1) · iOS 18.2');
    expect(deviceLabel({'platform': 'android', 'name': 'Pixel 8', 'model': 'Pixel 8', 'osVersion': '15'}), 'Pixel 8 · Android 15');
    expect(deviceLabel({'platform': 'ios', 'model': 'arm64', 'osVersion': '27.2'}), 'iOS 27.2');
  });

  test('time line: local with offset, then UTC', () {
    expect(shareTime(DateTime.utc(2026, 1, 1, 0, 0, 0, 5).millisecondsSinceEpoch.toDouble(), -330),
        '2025-12-31 18:30:00.005 (UTC-05:30) · 2026-01-01T00:00:00.005Z');
  });
}
