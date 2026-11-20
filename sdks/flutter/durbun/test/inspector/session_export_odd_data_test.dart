import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/session_export.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/strings.dart';
import 'package:flutter_test/flutter_test.dart';

/// Session export with odd data a real app sends (broken URLs, garbage
/// bodies, negative or huge times, native wire bodies, streams): every
/// format, masked or not, finishes and stays valid. An export that throws
/// halfway showed only "The export could not be made" on the phone.

PendingBody _b(List<int> bytes, String ct, {String? enc}) => PendingBody(
    bytes: Uint8List.fromList(bytes),
    size: bytes.length,
    truncated: false,
    limit: 1 << 22,
    capture: true,
    contentType: ct,
    contentEncoding: enc);

DurbunInspectorStore _fed(List<Map<String, Object?>> messages) {
  final s = DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;
  for (final m in messages) {
    s.ingest(m);
  }
  return s;
}

void main() {
  final cases = <String, List<Map<String, Object?>>>{
    'bad percent url': [
      buildNetRequest(
          id: 'a', ts: 1000, method: 'GET', url: 'https://x.com/a%zz?q=100%&token=%E0%A4%A', headers: const [])
    ],
    'no scheme url': [buildNetRequest(id: 'a', ts: 1000, method: 'GET', url: 'not a url ::', headers: const [])],
    'empty url': [buildNetRequest(id: 'a', ts: 1000, method: '', url: '', headers: const [])],
    'huge ts': [buildNetRequest(id: 'a', ts: 1.7e18, method: 'GET', url: 'https://x.com', headers: const [])],
    'zero ts': [buildNetRequest(id: 'a', ts: 0, method: 'GET', url: 'https://x.com', headers: const [])],
    'resp before ts': [
      buildNetRequest(id: 'a', ts: 5000, method: 'GET', url: 'https://x.com', headers: const []),
      buildNetResponse(id: 'a', ts: 1000, status: 200, headers: const [])
    ],
    'gzip garbage': [
      buildNetRequest(id: 'a', ts: 1000, method: 'GET', url: 'https://x.com', headers: const []),
      buildNetResponse(
          id: 'a',
          ts: 1100,
          status: 200,
          headers: const [
            ['Content-Encoding', 'gzip']
          ],
          body: _b([1, 2, 3, 4], 'application/json', enc: 'gzip'))
    ],
    'binary': [
      buildNetRequest(
          id: 'a',
          ts: 1000,
          method: 'POST',
          url: 'https://x.com',
          headers: const [
            ['Content-Type', 'application/octet-stream']
          ],
          body: _b(List<int>.generate(300, (i) => i % 256), 'application/octet-stream')),
      buildNetResponse(
          id: 'a',
          ts: 1100,
          status: 200,
          headers: const [
            ['Content-Type', 'image/png']
          ],
          body: _b(List<int>.generate(300, (i) => 255 - i % 256), 'image/png'))
    ],
    'weird cookies': [
      buildNetRequest(id: 'a', ts: 1000, method: 'GET', url: 'https://x.com', headers: const [
        ['Cookie', ';;=;a'],
        ['Set-Cookie', '=x']
      ]),
      buildNetResponse(id: 'a', ts: 1100, status: 200, headers: const [
        ['Set-Cookie', ''],
        ['Set-Cookie', 'a=b; Path=/'],
        ['Location', '%%']
      ])
    ],
    'timings odd': [
      buildNetRequest(id: 'a', ts: 1000, method: 'GET', url: 'https://x.com', headers: const []),
      buildNetResponse(
          id: 'a',
          ts: 1100,
          status: 200,
          headers: const [],
          timings: {'dns': -5, 'connect': 1e308, 'tls': double.nan, 'wait': 'x'},
          remoteAddress: '[::1',
          protocol: 'h2')
    ],
    'status 0 + error': [
      buildNetRequest(id: 'a', ts: 1000, method: 'GET', url: 'https://x.com', headers: const []),
      buildNetError(id: 'a', ts: 1100, error: 'SocketException: Failed host lookup'),
    ],
    'json body masks': [
      buildNetRequest(
          id: 'a',
          ts: 1000,
          method: 'POST',
          url: 'https://x.com?password=1',
          headers: const [
            ['Content-Type', 'application/json'],
            ['Authorization', 'Bearer abc']
          ],
          body: _b(utf8.encode('{"password":"x","nested":{"token":12},"arr":[1,2]}'), 'application/json')),
      buildNetResponse(
          id: 'a',
          ts: 1100,
          status: 401,
          headers: const [
            ['Content-Type', 'application/json; charset=utf-8']
          ],
          body: _b(utf8.encode('{"error":"bad"'), 'application/json'))
    ],
    'form body': [
      buildNetRequest(
          id: 'a',
          ts: 1000,
          method: 'POST',
          url: 'https://x.com',
          headers: const [
            ['Content-Type', 'application/x-www-form-urlencoded']
          ],
          body: _b(utf8.encode('a=%zz&password=%'), 'application/x-www-form-urlencoded')),
    ],
    'multipart': [
      buildNetRequest(
          id: 'a',
          ts: 1000,
          method: 'POST',
          url: 'https://x.com',
          headers: const [
            ['Content-Type', 'multipart/form-data; boundary=xx']
          ],
          body: _b(utf8.encode('--xx\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n--xx--'),
              'multipart/form-data; boundary=xx')),
    ],
    'native raw wire body': [
      {
        'type': 'net.request',
        'id': 'n',
        'ts': 1000.5,
        'method': 'GET',
        'url': 'https://api.x.com/v1?x=1',
        'headers': [
          ['A', 'b']
        ],
        'source': 'okhttp',
        'native': true
      },
      {
        'type': 'net.response',
        'id': 'n',
        'ts': 1200.5,
        'status': 200,
        'headers': [
          ['Content-Type', 'application/json']
        ],
        'body': {'encoding': 'utf8', 'data': '{"a":1}', 'size': 7},
        'timings': {'dnsMs': 1, 'connectMs': 2}
      },
    ],
    'native base64 body': [
      {
        'type': 'net.request',
        'id': 'n',
        'ts': 1000,
        'method': 'GET',
        'url': 'https://api.x.com',
        'headers': [],
        'source': 'urlsession',
        'native': true
      },
      {
        'type': 'net.response',
        'id': 'n',
        'ts': 1200,
        'status': 200,
        'headers': [],
        'body': {'encoding': 'base64', 'data': '!!notbase64', 'size': 3, 'truncated': true}
      },
    ],
    'graphql': [
      buildNetRequest(
          id: 'a',
          ts: 1000,
          method: 'POST',
          url: 'https://x.com/graphql',
          headers: const [
            ['Content-Type', 'application/json']
          ],
          body: _b(utf8.encode('{"query":"query Q { a }","operationName":null,"variables":{"password":"p"}}'),
              'application/json')),
    ],
    'ws': [
      buildNetRequest(id: 'w', ts: 1000, method: 'GET', url: 'wss://x.com/ws', headers: const []),
      buildNetResponse(id: 'w', ts: 1100, status: 101, headers: const []),
      buildNetWs(id: 'w', ts: 1200, dir: 'out', opcode: 'text', size: 3, body: _b(utf8.encode('abc'), 'text/plain')),
      buildNetWs(
          id: 'w', ts: 1300, dir: 'in', opcode: 'binary', size: 3, body: _b([0, 1, 2], 'application/octet-stream')),
      buildNetWs(id: 'w', ts: 1400, dir: 'in', opcode: 'close', size: 0, closeCode: 1000, closeReason: 'bye'),
    ],
    'sse': [
      buildNetRequest(id: 's', ts: 1000, method: 'GET', url: 'https://x.com/sse', headers: const []),
      buildNetResponse(id: 's', ts: 1100, status: 200, headers: const [
        ['Content-Type', 'text/event-stream']
      ]),
      buildNetSse(id: 's', ts: 1200, event: 'x', size: 2, body: _b(utf8.encode('hi'), 'text/plain')),
      buildNetSse(id: 's', ts: 1300, end: true),
    ],
  };
  final t = InspectorStrings.forLanguage('en');
  const ctx = ExportContext(nowMs: 1762630500000, app: 'Shop', device: 'Pixel 8', utcOffsetMinutes: 180);

  group('odd data still exports', () {
    for (final MapEntry(key: name, value: messages) in cases.entries) {
      for (final mask in <bool>[true, false]) {
        test('$name${mask ? '' : ', unmasked'}', () {
          final s = _fed(messages);
          final ids = <Object?>{for (final m in messages) m['id']};
          final md = sessionExport(s.calls, ExportOptions(format: ExportFormat.markdown, mask: mask), t, ctx).join();
          expect(md, startsWith('# '));
          expect(md, isNot(contains(t.exportItemFailed)), reason: 'nothing skipped');
          final har =
              jsonDecode(sessionExport(s.calls, ExportOptions(format: ExportFormat.har, mask: mask), t, ctx).join())
                  as Map<String, Object?>;
          final entries = (har['log']! as Map)['entries']! as List;
          expect(entries, hasLength(ids.length));
          for (final e in entries.cast<Map<String, Object?>>()) {
            expect(DateTime.tryParse(e['startedDateTime']! as String), isNotNull, reason: 'a real date, always');
            expect((e['time']! as num).isFinite, isTrue);
          }
        });
      }
    }
  });

  test('a time no date can hold reads as its arrival; a broken end time leaves no duration', () {
    final before = DateTime.now().millisecondsSinceEpoch;
    final s = _fed(<Map<String, Object?>>[
      buildNetRequest(id: 'a', ts: 1.7e18, method: 'GET', url: 'https://x.com/late', headers: const []),
      buildNetResponse(id: 'a', ts: double.infinity, status: 200, headers: const []),
      buildLog(level: 'error', message: 'nanoseconds', ts: 1.7e18),
    ]);
    final call = s.calls.single;
    expect(call.ts, greaterThanOrEqualTo(before));
    expect(call.duration, isNotNull, reason: 'the end reads as its arrival too');
    expect(s.logs.single.ts, greaterThanOrEqualTo(before));
    final har = jsonDecode(sessionHar(s.calls, const ExportOptions(format: ExportFormat.har), ctx).join()) as Map;
    final entry = ((har['log'] as Map)['entries'] as List).single as Map;
    expect(DateTime.parse(entry['startedDateTime'] as String).year, DateTime.now().year);
    expect(
        sessionMarkdown(s.calls, const ExportOptions(format: ExportFormat.markdown), t, ctx).join(), contains('/late'));
  });
}
