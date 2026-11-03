import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/logs_view.dart' show LogFilters, buildStream;
import 'package:durbun/src/inspector/network_model.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/theme.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody pending(String text, [String ct = 'application/json']) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: ct);
}

InspectorCall call({String method = 'GET', String url = 'https://api.example.com/v1/x', List<List<String>> headers = const [], String? body, int? status, double ms = 100, String? error, Map<String, Object?>? timings}) {
  final s = DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;
  s.ingest(buildNetRequest(id: '1', ts: 0, method: method, url: url, headers: headers, body: body == null ? null : pending(body)));
  if (status != null) s.ingest(buildNetResponse(id: '1', ts: ms, status: status, headers: const [], timings: timings));
  if (error != null) s.ingest(buildNetError(id: '1', ts: ms, error: error));
  return s.calls.single;
}

void main() {
  test('tag hues hash exactly like the desktop (FNV-1a % 360)', () {
    expect(fnv1a('auth'), 2503977039);
    expect(hashHue('auth'), 279);
    expect(hashHue('OkHttp'), 311);
    expect(hashHue('flutter'), 41);
    expect(hashHue('çökme'), 163);
  });

  test('short error labels as the desktop', () {
    expect(shortErrorKey('SocketException: Failed host lookup: cdn.x'), 'dns');
    expect(shortErrorKey('TimeoutException after 0:00:30'), 'timeout');
    expect(shortErrorKey('NSURLErrorDomain -1009'), 'offline');
    expect(shortErrorKey('HandshakeException: CERTIFICATE_VERIFY_FAILED'), 'tls');
    expect(shortErrorKey('Connection refused'), 'refused');
    expect(shortErrorKey('weird'), 'generic');
    expect(splitError('SocketException: Failed host lookup'), ('SocketException', 'Failed host lookup'));
  });

  test('query language and chip filters', () {
    final ok = call(status: 200);
    final bad = call(method: 'POST', status: 503, ms: 1500);
    final fail = call(error: 'SocketException: refused');
    bool q(InspectorCall c, String text) => callMatchesQuery(c, parseQuery(text));
    expect(q(bad, 'status:5xx'), isTrue);
    expect(q(ok, 'status:5xx'), isFalse);
    expect(q(bad, 'status:>=500 method:post'), isTrue);
    expect(q(fail, 'is:failed'), isTrue);
    expect(q(bad, 'is:slow'), isTrue);
    expect(q(ok, '-host:example'), isFalse);
    expect(q(ok, 'v1/x'), isTrue);
    final f = NetFilters()..statuses.add('fail');
    expect(callMatchesFilters(fail, f), isTrue);
    expect(callMatchesFilters(bad, f), isFalse);
  });

  test('timing breakdown puts unattributed time first, like the desktop', () {
    final c = call(status: 200, ms: 100, timings: {'dns': 10, 'connect': 20, 'wait': 50});
    final b = timingBreakdown(c);
    expect(b.known, isTrue);
    expect(b.spans.map((s) => s.phase), ['queue', 'dns', 'connect', 'wait']);
    expect(b.spans.first.ms, 20);
    expect(b.spans.last.start, 50);
  });

  test('GraphQL operation from a JSON body', () {
    final c = call(method: 'POST', url: 'https://gql.example.com/graphql', headers: const [['Content-Type', 'application/json']], body: '{"query":"mutation LikeStory(\$id: ID!) { like(id: \$id) }"}');
    expect(graphqlLabel(c), 'mutation LikeStory');
    expect(graphqlLabel(call()), isNull);
  });

  test('copy as cURL / dio / Swift / Kotlin / fetch', () {
    final c = call(
      method: 'POST',
      url: "https://api.example.com/users?q=o'neil",
      headers: const [['Content-Type', 'application/json'], ['Content-Length', '15'], ['Accept-Encoding', 'gzip']],
      body: '{"name":"Ayşe"}',
    );
    expect(
      toCurl(c),
      "curl 'https://api.example.com/users?q=o'\\''neil' \\\n"
      "  -H 'Content-Type: application/json' \\\n"
      "  --data-raw '{\"name\":\"Ayşe\"}' \\\n"
      '  --compressed',
    );
    expect(toDio(c), contains("method: 'POST'"));
    expect(toDio(c), contains("data: '{\"name\":\"Ayşe\"}'"));
    expect(toSwift(c), contains('request.httpMethod = "POST"'));
    expect(toKotlin(c), contains('.method("POST", "{\\"name\\":\\"Ayşe\\"}".toRequestBody("application/json".toMediaType()))'));
    expect(toFetch(c), contains('body: JSON.stringify({'));
    expect(dartString(r'a$b'), r"'a\$b'");
  });

  test('the log stream merges identical lines and interleaves requests by time', () {
    final s = DurbunInspectorStore(notifyDelay: Duration.zero);
    s
      ..ingest(buildLog(level: 'info', message: 'tick', tag: 't', ts: 1))
      ..ingest(buildLog(level: 'info', message: 'tick', tag: 't', ts: 2))
      ..ingest(buildNetRequest(id: '1', ts: 3, method: 'GET', url: 'https://x.io/a', headers: const []))
      ..ingest(buildLog(level: 'info', message: 'tick', tag: 't', ts: 4));
    final items = buildStream(s, LogFilters(), const []);
    expect(items, hasLength(3));
    expect(items[0].repeats, 2);
    expect(items[1].call, isNotNull);
    expect(items[2].repeats, 1);
  });
}
