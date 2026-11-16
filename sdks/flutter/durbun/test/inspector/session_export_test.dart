import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/export_file_io.dart';
import 'package:durbun/src/inspector/session_export.dart';
import 'package:durbun/src/inspector/share_report.dart' show kExportMessageChars;
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/strings.dart';
import 'package:flutter_test/flutter_test.dart';

/// Session export: HAR 1.2 shape, the Markdown report, masking with the
/// share report's rules, bodies off, and the file writer.

PendingBody _pending(List<int> bytes, {String contentType = 'application/json'}) => PendingBody(
    bytes: Uint8List.fromList(bytes), size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: contentType);

PendingBody _text(String text, {String contentType = 'application/json'}) => _pending(utf8.encode(text), contentType: contentType);

const String _jwt = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';

DurbunInspectorStore _session() {
  final s = DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;
  s
    // A login with secrets everywhere.
    ..ingest(buildNetRequest(
        id: '1',
        ts: 2000,
        method: 'POST',
        url: 'https://api.example.com/v1/login?lang=tr&access_token=abc123',
        headers: const [
          ['Authorization', _jwt],
          ['Content-Type', 'application/json'],
          ['Cookie', 'sid=s3cr3t; theme=dark'],
        ],
        body: _text('{"user":"ayşe","password":"hunter2"}')))
    ..ingest(buildNetResponse(
        id: '1',
        ts: 2120,
        status: 401,
        protocol: 'h2',
        remoteAddress: '93.184.216.34:443',
        headers: const [
          ['Content-Type', 'application/json'],
          ['Set-Cookie', 'session=abc; Path=/; HttpOnly; Secure'],
        ],
        timings: const {'dns': 10, 'connect': 20, 'tls': 30, 'send': 5, 'wait': 40, 'receive': 15},
        body: _text('{"error":"invalid_grant","token":"zzz"}')))
    // Binary, started first.
    ..ingest(buildNetRequest(id: '2', ts: 1000, method: 'GET', url: 'https://cdn.example.com/a|b.png', headers: const []))
    ..ingest(buildNetResponse(
        id: '2',
        ts: 1050,
        status: 200,
        headers: const [
          ['Content-Type', 'image/png']
        ],
        body: _pending(const [0x89, 0x50, 0x4E, 0x47, 0, 1, 2, 255], contentType: 'image/png')))
    // A timeout.
    ..ingest(buildNetRequest(id: '3', ts: 3000, method: 'GET', url: 'https://api.example.com/v1/slow', headers: const []))
    ..ingest(buildNetError(id: '3', ts: 33000, error: 'TimeoutException after 0:00:30.000000'))
    // Still waiting.
    ..ingest(buildNetRequest(id: '4', ts: 4000, method: 'DELETE', url: 'https://api.example.com/v1/items/9', headers: const []));
  return s;
}

const ExportContext _ctx = ExportContext(nowMs: 1762630500000, app: 'Shop 2.4.1 (com.example.shop)', device: 'Pixel 8 · Android 15', total: 4, utcOffsetMinutes: 180);

Map<String, Object?> _har(DurbunInspectorStore s, {ExportOptions o = const ExportOptions(format: ExportFormat.har)}) =>
    jsonDecode(sessionHar(s.calls, o, _ctx).join()) as Map<String, Object?>;

List<Map<String, Object?>> _entries(Map<String, Object?> har) =>
    ((har['log']! as Map)['entries']! as List).cast<Map<String, Object?>>();

Map<String, Object?> _byUrl(Map<String, Object?> har, String part) =>
    _entries(har).firstWhere((e) => ((e['request']! as Map)['url']! as String).contains(part));

void main() {
  group('HAR 1.2', () {
    test('every required field, of the right type, in start order', () {
      final har = _har(_session());
      final log = har['log']! as Map<String, Object?>;
      expect(log['version'], '1.2');
      expect(log['creator'], {'name': 'Dürbün', 'version': kSdkVersion});
      expect(log['pages'], isEmpty);
      final entries = _entries(har);
      expect(entries, hasLength(4));
      expect([for (final e in entries) DateTime.parse(e['startedDateTime']! as String).millisecondsSinceEpoch],
          [1000, 2000, 3000, 4000], reason: 'HAR viewers expect start order');
      for (final e in entries) {
        expect(e['startedDateTime'], matches(RegExp(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')));
        expect(e['time'], isA<num>().having((n) => n, 'time', greaterThanOrEqualTo(0)));
        expect(e['cache'], isA<Map<String, Object?>>());
        final req = e['request']! as Map<String, Object?>;
        for (final k in ['method', 'url', 'httpVersion']) {
          expect(req[k], isA<String>(), reason: 'request.$k');
        }
        for (final k in ['cookies', 'headers', 'queryString']) {
          expect(req[k], isA<List<Object?>>(), reason: 'request.$k');
        }
        expect(req['headersSize'], -1);
        expect(req['bodySize'], isA<int>());
        final res = e['response']! as Map<String, Object?>;
        expect(res['status'], isA<int>());
        for (final k in ['statusText', 'httpVersion', 'redirectURL']) {
          expect(res[k], isA<String>(), reason: 'response.$k');
        }
        for (final k in ['cookies', 'headers']) {
          expect(res[k], isA<List<Object?>>(), reason: 'response.$k');
        }
        final content = res['content']! as Map<String, Object?>;
        expect(content['size'], isA<int>());
        expect(content['mimeType'], isA<String>());
        expect(res['headersSize'], -1);
        expect(res['bodySize'], isA<int>());
        final timings = e['timings']! as Map<String, Object?>;
        for (final k in ['send', 'wait', 'receive']) {
          expect(timings[k], isA<num>().having((n) => n, k, greaterThanOrEqualTo(0)), reason: 'timings.$k');
        }
        for (final k in ['blocked', 'dns', 'connect', 'ssl']) {
          expect(timings[k], isA<num>().having((n) => n, k, anyOf(-1, greaterThanOrEqualTo(0))), reason: 'timings.$k');
        }
      }
    });

    test('a request with its phases, cookies, server address and Dürbün extras', () {
      final login = _byUrl(_har(_session()), '/v1/login');
      expect(login['time'], 120);
      expect(login['timings'], {'blocked': -1, 'dns': 10, 'connect': 50, 'send': 5, 'wait': 40, 'receive': 15, 'ssl': 30});
      expect(login['serverIPAddress'], '93.184.216.34');
      expect(login['connection'], '443');
      final req = login['request']! as Map<String, Object?>;
      expect(req['method'], 'POST');
      expect(req['httpVersion'], 'h2');
      expect((req['postData']! as Map)['mimeType'], 'application/json');
      final res = login['response']! as Map<String, Object?>;
      expect(res['status'], 401);
      expect(res['statusText'], 'Unauthorized');
      expect((res['cookies']! as List).single, {'name': 'session', 'value': '••••', 'path': '/', 'httpOnly': true, 'secure': true});
      expect(login['_durbun'], containsPair('state', 'complete'));
    });

    test('binary content is base64; a failure and a pending request still have a whole entry', () {
      final har = _har(_session());
      final png = (_byUrl(har, '.png')['response']! as Map)['content']! as Map<String, Object?>;
      expect(png['encoding'], 'base64');
      expect(base64Decode(png['text']! as String), [0x89, 0x50, 0x4E, 0x47, 0, 1, 2, 255]);
      expect(png['mimeType'], 'image/png');

      final slow = _byUrl(har, '/v1/slow');
      expect((slow['response']! as Map)['status'], 0);
      expect((slow['response']! as Map)['_error'], contains('TimeoutException'));
      expect(slow['time'], 30000);
      expect((slow['_durbun']! as Map)['state'], 'failed');

      final pending = _byUrl(har, '/v1/items/9');
      expect(pending['time'], 0);
      expect((pending['_durbun']! as Map)['state'], 'pending');
    });

    test('masked by default: headers, URL and query, cookies, JSON values', () {
      final har = _har(_session());
      final text = jsonEncode(har);
      for (final secret in ['abc123', 'hunter2', 's3cr3t', 'eyJzdWIi', 'zzz']) {
        expect(text, isNot(contains(secret)), reason: '$secret leaked');
      }
      final login = _byUrl(har, '/v1/login');
      final req = login['request']! as Map<String, Object?>;
      expect(req['url'], 'https://api.example.com/v1/login?lang=tr&access_token=••••');
      expect(req['queryString'], [
        {'name': 'lang', 'value': 'tr'},
        {'name': 'access_token', 'value': '••••'},
      ]);
      expect((req['headers']! as List).first, {'name': 'Authorization', 'value': 'Bearer ••••'});
      expect((req['postData']! as Map)['text'], '{"user":"ayşe","password":"••••"}');
      expect(((login['response']! as Map)['content']! as Map)['text'], '{"error":"invalid_grant","token":"••••"}');
      final notes = (har['log']! as Map)['_durbun']! as Map<String, Object?>;
      expect(notes['masked'], true);
      expect(notes['maskedValues'], greaterThan(0));
      expect(notes['app'], 'Shop 2.4.1 (com.example.shop)');
    });

    test('masking off keeps the values; bodies off leaves only sizes', () {
      final raw = jsonEncode(_har(_session(), o: const ExportOptions(format: ExportFormat.har, mask: false)));
      expect(raw, contains('access_token=abc123'));
      expect(raw, contains('hunter2'));

      final sizes = _har(_session(), o: const ExportOptions(format: ExportFormat.har, bodies: false));
      final login = _byUrl(sizes, '/v1/login');
      expect((login['request']! as Map).containsKey('postData'), isFalse);
      final content = (login['response']! as Map)['content']! as Map<String, Object?>;
      expect(content.containsKey('text'), isFalse);
      expect(content['size'], utf8.encode('{"error":"invalid_grant","token":"zzz"}').length);
      expect((login['_durbun']! as Map)['bodiesOmitted'], true);
    });

    test('reading the bodies does not keep them in the store', () {
      final s = _session();
      final before = s.bodyBytes;
      _har(s);
      expect(s.bodyBytes, before, reason: 'an export peeks; it does not grow the body budget');
      expect(s.calls.first.responseBody, isNotNull, reason: 'the panel still decodes them');
    });
  });

  group('Markdown report', () {
    test('header, summary table, a section per request, masked', () {
      final s = _session();
      final calls = s.calls;
      final md = sessionMarkdown(calls, const ExportOptions(), InspectorStrings.forLanguage('en'), _ctx).join();
      expect(md, startsWith('# Dürbün · Network session\n'));
      expect(md, contains('- App: Shop 2.4.1 (com.example.shop)'));
      expect(md, contains('- Requests: 4, as listed on the Network tab'));
      expect(md, contains('1 successful · 1 client errors (4xx) · 0 server errors (5xx) · 1 transport errors · 1 pending'));
      expect(md, contains('| # | Time | Method | Status | Duration | Response size | URL |'));
      expect(md, contains('| 1 | 03:00:02.000 | POST | 401 | 120 ms | 39 B |'), reason: 'local time at UTC+03:00');
      expect(md, contains('| 3 | 03:00:03.000 | GET | FAIL · Timed out | 30.00 s | — |'));
      expect(md, contains(r'https://cdn.example.com/a\|b.png'), reason: 'a | in a cell is escaped');
      expect(md, contains('### 1. POST /v1/login → 401'));
      expect(md, contains('Authorization: Bearer ••••'));
      expect(md, contains('"password": "••••"'));
      expect(md, isNot(contains('hunter2')));
      expect(md, isNot(contains('cURL')), reason: 'no cURL per request in a session');
      expect(md.trimRight(), endsWith('Secret values (tokens, cookies, passwords) are masked as ••••.'));
    });

    test('Turkish, a part of the list, bodies off', () {
      final s = _session();
      final md = sessionMarkdown(s.calls.take(2).toList(), const ExportOptions(bodies: false), InspectorStrings.forLanguage('tr'),
              _ctx)
          .join();
      expect(md, startsWith('# Dürbün · Ağ oturumu\n'));
      expect(md, contains('- İstekler: 2 (4 istekten)'));
      expect(md, isNot(contains('İstek gövdesi')));
    });
  });

  group('WebSocket and SSE messages', () {
    Uint8List utf(String s) => Uint8List.fromList(utf8.encode(s));

    /// A chat socket (auth with a token, text, binary, ping, close) and a
    /// price event stream.
    DurbunInspectorStore streams({int maxStreamMessages = DurbunInspectorStore.kDefaultStreamMessages, bool endSse = true}) {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero, maxStreamMessages: maxStreamMessages)..attached = true;
      s
        ..ingest(buildNetRequest(id: 'w', ts: 1000, method: 'GET', url: 'https://chat.example.com/socket', headers: const [
          ['Upgrade', 'websocket'],
        ]))
        ..ingest(buildNetResponse(id: 'w', ts: 1050, status: 101, headers: const [
          ['Upgrade', 'websocket'],
        ]))
        ..streamOpened('w', kind: 'ws', ts: 1050);
      final auth = utf('{"type":"auth","token":"s3cr3t"}');
      final hello = utf('hello password=hunter2');
      s
        ..streamWs('w', 1100, 'out', 'text', auth.length, auth, null, null)
        ..streamWs('w', 1250, 'in', 'text', hello.length, hello, null, null)
        ..streamWs('w', 1300, 'in', 'binary', 4, Uint8List.fromList(<int>[0, 1, 2, 255]), null, null)
        ..streamWs('w', 1400, 'in', 'ping', 0, null, null, null)
        ..streamWs('w', 2550, 'in', 'close', 5, null, 1000, 'bye')
        ..ingest(buildNetRequest(id: 'e', ts: 3000, method: 'GET', url: 'https://api.example.com/live', headers: const []))
        ..ingest(buildNetResponse(id: 'e', ts: 3040, status: 200, headers: const [
          ['Content-Type', 'text/event-stream'],
        ]))
        ..streamOpened('e', kind: 'sse', ts: 3040);
      final price = utf('{"px":1.5,"apiKey":"k-123"}');
      s.streamSse('e', 3100, 'price', '7', null, price.length, price);
      if (endSse) s.streamEnded('e', 3200);
      return s;
    }

    test('HAR: _webSocketMessages as browsers write them, masked, with the connection under _durbun', () {
      final har = _har(streams());
      final ws = _byUrl(har, 'chat.example.com');
      expect(ws['_webSocketMessages'], <Map<String, Object?>>[
        {'type': 'send', 'time': 1.1, 'opcode': 1, 'data': '{"type":"auth","token":"••••"}'},
        {'type': 'receive', 'time': 1.25, 'opcode': 1, 'data': 'hello password=••••'},
        {'type': 'receive', 'time': 1.3, 'opcode': 2, 'data': 'AAEC/w=='},
        {'type': 'receive', 'time': 1.4, 'opcode': 9, 'data': ''},
        {'type': 'receive', 'time': 2.55, 'opcode': 8, 'data': '1000 bye'},
      ]);
      expect(ws.containsKey('_eventSourceMessages'), isFalse);
      final stream = (ws['_durbun']! as Map)['stream']! as Map;
      expect(stream, containsPair('kind', 'websocket'));
      expect(stream, containsPair('state', 'closed'));
      expect(stream, containsPair('closedBy', 'in'));
      expect(stream, containsPair('closeCode', 1000));
      expect(stream, containsPair('count', 5));
      expect(stream, containsPair('in', 4));
      expect(stream, containsPair('out', 1));
      expect(stream, containsPair('control', 1));
      expect(stream, containsPair('dropped', 0));
      expect(stream, containsPair('lastSeq', 5));

      final sse = _byUrl(har, 'api.example.com/live');
      expect(sse['_eventSourceMessages'], <Map<String, Object?>>[
        {'time': 3.1, 'eventName': 'price', 'eventId': '7', 'data': '{"px":1.5,"apiKey":"••••"}'},
      ]);
      expect(sse.containsKey('_webSocketMessages'), isFalse);
      expect(((sse['_durbun']! as Map)['stream']! as Map)['kind'], 'sse');
      expect((har['log']! as Map)['_durbun'], containsPair('maskedValues', greaterThanOrEqualTo(3)));
    });

    test('HAR: unmasked keeps the values; bodies off keeps the frames without their content', () {
      final raw = _har(streams(), o: const ExportOptions(format: ExportFormat.har, mask: false));
      final rawWs = _byUrl(raw, 'chat.example.com')['_webSocketMessages']! as List;
      expect((rawWs.first as Map)['data'], '{"type":"auth","token":"s3cr3t"}');

      final off = _har(streams(), o: const ExportOptions(format: ExportFormat.har, bodies: false));
      final ws = _byUrl(off, 'chat.example.com');
      expect([for (final m in ws['_webSocketMessages']! as List) (m as Map)['data']], <String>['', '', '', '', '1000 bye']);
      expect((ws['_durbun']! as Map)['bodiesOmitted'], isTrue);
      final sse = _byUrl(off, 'api.example.com/live')['_eventSourceMessages']! as List;
      expect((sse.single as Map)['data'], '');
      expect(jsonEncode(off), isNot(contains('s3cr3t')));
    });

    test('report: the messages under their request, masked, binary left out', () {
      final md = sessionMarkdown(streams().calls, const ExportOptions(), InspectorStrings.forLanguage('en'), _ctx).join();
      expect(md, contains('Messages (WebSocket · closed · 5 messages):'));
      expect(md, contains('#1 · +50 ms · Sent · text · 32 B\n    {"type":"auth","token":"••••"}'));
      expect(md, contains('#2 · +200 ms · Received · text · 22 B\n    hello password=••••'));
      expect(md, contains('#3 · +250 ms · Received · binary · 4 B\n    binary, not included'));
      expect(md, contains('#4 · +350 ms · Received · ping · 0 B\n#5 · +1.50 s · Received · close · 5 B · 1000 · bye'));
      expect(md, contains('Events (SSE · closed · 1 message):'));
      expect(md, contains('#1 · +60 ms · price · id 7 · 27 B\n    {"px":1.5,"apiKey":"••••"}'));
      expect(md, isNot(contains('s3cr3t')));
      expect(md, isNot(contains('hunter2')));
      expect(md, isNot(contains('k-123')));
      expect(md.indexOf('Messages (WebSocket'), greaterThan(md.indexOf('GET /socket')));

      final off = sessionMarkdown(streams().calls, const ExportOptions(bodies: false), InspectorStrings.forLanguage('tr'), _ctx).join();
      expect(off, contains('Mesajlar (WebSocket · kapandı · 5 mesaj):'));
      expect(off, contains('#1 · +50 ms · Gönderildi · text · 32 B\n#2'));
      expect(off, isNot(contains('auth')));
    });

    test('report: a gap where the memory limit removed messages; a long text is cut', () {
      final s = streams(maxStreamMessages: 25, endSse: false);
      for (var i = 0; i < 30; i++) {
        final b = utf('m$i');
        s.streamSse('e', 3300.0 + i, null, null, null, b.length, b);
      }
      final long = utf('x' * (kExportMessageChars + 10));
      s.streamSse('e', 3400, null, null, null, long.length, long);
      final md = sessionMarkdown(s.calls, const ExportOptions(), InspectorStrings.forLanguage('en'), _ctx).join();
      expect(md, contains('Events (SSE · open · 32 messages):'));
      // The kept head (sign-in, subscriptions), the gap, then the newest.
      expect(RegExp(r'^#\d+ · ', multiLine: true).allMatches(md.substring(md.indexOf('Events (SSE'))), hasLength(25));
      expect(RegExp(r'#\d+ · [^\n]*\n    m\d+\n… 7 messages removed by the memory limit\n#\d+ · ').hasMatch(md), isTrue);
      expect(md, contains('    ${'x' * kExportMessageChars}\n    … 10 more characters not shown'));
      final har = _har(s);
      final events = _byUrl(har, 'api.example.com/live')['_eventSourceMessages']! as List;
      expect(events, hasLength(25));
      expect(((_byUrl(har, 'api.example.com/live')['_durbun']! as Map)['stream']! as Map)['dropped'], 7);
    });
  });

  test('file names: the app, then the local time', () {
    final at = DateTime(2026, 11, 8, 21, 35, 7);
    expect(exportFileName(ExportFormat.har, at, appName: 'Shop App!'), 'durbun-shop-app-20261108-213507.har');
    expect(exportFileName(ExportFormat.markdown, at), 'durbun-session-20261108-213507.md');
    expect(exportFileName(ExportFormat.markdown, at, appName: 'Dürbün Örnek'), 'durbun-d-rb-n-rnek-20261108-213507.md');
  });

  group('file writer', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('durbun-export-test'));
    tearDown(() => dir.deleteSync(recursive: true));

    test('writes into durbun-export and deletes exports older than a day', () async {
      final folder = Directory('${dir.path}/durbun-export')..createSync();
      final old = File('${folder.path}/old.md')..writeAsStringSync('x');
      old.setLastModifiedSync(DateTime.now().subtract(const Duration(days: 2)));
      final fresh = File('${folder.path}/fresh.md')..writeAsStringSync('y');

      final path = await writeExportFile('new.har', ['{"log":', '{}', '}'], baseDir: dir.path);
      expect(path, '${folder.path}${Platform.pathSeparator}new.har');
      expect(File(path!).readAsStringSync(), '{"log":{}}');
      expect(old.existsSync(), isFalse);
      expect(fresh.existsSync(), isTrue);
    });

    test('a failure while generating leaves no partial file', () async {
      Iterable<String> broken() sync* {
        yield 'start';
        throw StateError('boom');
      }

      expect(await writeExportFile('bad.md', broken(), baseDir: dir.path), isNull);
      expect(File('${dir.path}/durbun-export/bad.md').existsSync(), isFalse);
    });
  });
}
