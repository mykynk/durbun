import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:durbun/durbun_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart' as http_io;

import '../support/fake_desktop.dart';

/// Local origin server the app talks to (through the Dürbün wrapper).
class Origin {
  late HttpServer server;
  final Map<String, int> hits = <String, int>{};
  final Map<String, String> lastBodies = <String, String>{};
  final Map<String, Map<String, List<String>>> lastHeaders = <String, Map<String, List<String>>>{};

  static final Uint8List pngBytes = Uint8List.fromList([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, //
    for (var i = 0; i < 2040; i++) (i * 31) & 0xff,
  ]);

  String get base => 'http://127.0.0.1:${server.port}';

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      try {
        await _handle(req);
      } catch (_) {
        // The client aborted or cancelled (tests do that on purpose).
      }
    });
  }

  Future<void> _handle(HttpRequest req) async {
    final path = req.uri.path;
    hits[path] = (hits[path] ?? 0) + 1;
    final headers = <String, List<String>>{};
    req.headers.forEach((k, v) => headers[k] = v);
    lastHeaders[path] = headers;
    final body = await utf8.decoder.bind(req).join();
    lastBodies[path] = body;
    final res = req.response;
    switch (path) {
      case '/json':
        res.headers.contentType = ContentType.json;
        res.write(jsonEncode({'hello': 'dünya', 'items': [1, 2, 3]}));
      case '/echo':
        res.statusCode = 201;
        res.headers.contentType = ContentType.json;
        res.write(jsonEncode({'received': body, 'length': utf8.encode(body).length}));
      case '/missing':
        res.statusCode = 404;
        res.headers.contentType = ContentType.json;
        res.write('{"error":"not found"}');
      case '/slow':
        final ms = int.tryParse(req.uri.queryParameters['ms'] ?? '') ?? 300;
        await Future<void>.delayed(Duration(milliseconds: ms));
        res.headers.contentType = ContentType.text;
        res.write('slow ok');
      case '/image':
        res.headers.contentType = ContentType('image', 'png');
        res.add(pngBytes);
      case '/gzip':
        res.headers.contentType = ContentType.json;
        res.headers.set(HttpHeaders.contentEncodingHeader, 'gzip');
        res.add(gzip.encode(utf8.encode(jsonEncode({'compressed': true, 'pad': 'x' * 500}))));
      case '/redirect':
        res.statusCode = HttpStatus.found;
        res.headers.set(HttpHeaders.locationHeader, req.uri.queryParameters['to'] ?? '/json');
      case '/big':
        res.headers.contentType = ContentType.text;
        res.write('x' * 5000);
      case '/stream':
        res.headers.contentType = ContentType.text;
        res.bufferOutput = false;
        for (var i = 0; i < 6; i++) {
          res.write('chunk $i\n');
          await res.flush();
          await Future<void>.delayed(const Duration(milliseconds: 60));
        }
      case '/ws':
        // ignore: close_sinks
        final socket = await WebSocketTransformer.upgrade(req);
        socket.listen((m) => socket.add('echo: $m'));
        return;
      default:
        res.statusCode = 200;
        res.write('ok');
    }
    await res.close();
  }
}

void main() {
  final origin = Origin();
  late FakeDesktop desktop;
  late DurbunClient client;
  late FakeSdkConnection conn;

  setUpAll(() async {
    await origin.start();
    desktop = await FakeDesktop.start(appId: 'app:http');
    client = DurbunClient.start(
      DurbunOptions(
        enabled: true,
        port: desktop.port,
        appId: 'com.example.http',
        redactHeaders: const ['Authorization'],
      ),
    );
    conn = await desktop.nextConnection();
    expect(await client.waitForConnection(const Duration(seconds: 5)), isTrue);
  });

  tearDownAll(() async {
    await client.dispose();
    await desktop.close();
    await origin.server.close(force: true);
  });

  /// Finds the request whose URL ends with [suffix] and its final message.
  Future<(Map<String, Object?>, Map<String, Object?>)> net(String suffix) async {
    final req = await conn.waitFor(
      (m) => m['type'] == 'net.request' && (m['url']! as String).endsWith(suffix),
      description: 'net.request $suffix',
    );
    final end = await conn.waitForNetEnd(req['id']! as String);
    return (req, end);
  }

  Map<String, String> headerMap(Object? pairs) => {
    for (final p in (pairs! as List).cast<List<Object?>>()) (p[0]! as String).toLowerCase(): p[1]! as String,
  };

  Future<void> setMocks(List<Map<String, Object?>> rules) async {
    conn.send({'type': 'mocks', 'rules': rules});
    final ids = rules.map((r) => r['id']).toList();
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (client.mocks.map((r) => r.id).join(',') != ids.join(',')) {
      if (DateTime.now().isAfter(deadline)) fail('mocks not applied');
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  Map<String, Object?> rule(String id, String url, Map<String, Object?> action, {String method = '*', String match = 'contains', List<String>? apps}) => {
    'id': id,
    'enabled': true,
    'method': method,
    'url': url,
    'match': match,
    if (apps != null) 'apps': apps,
    'action': action,
    'createdAt': 1,
  };

  test('HttpClient() is wrapped by the installed overrides', () {
    final c = HttpClient();
    expect(c, isA<DurbunHttpClient>());
    c.close();
  });

  test('GET JSON: request, response, body, timings, remote address', () async {
    final c = HttpClient();
    final req = await c.getUrl(Uri.parse('${origin.base}/json?case=get'));
    req.headers.set('Authorization', 'Bearer s3cr3t');
    req.headers.set('X-Request-Id', 'abc-123');
    final res = await req.close();
    final text = await utf8.decoder.bind(res).join();
    c.close();
    expect(jsonDecode(text), {'hello': 'dünya', 'items': [1, 2, 3]});

    final (r, end) = await net('/json?case=get');
    expect(r['method'], 'GET');
    expect(r['url'], '${origin.base}/json?case=get');
    expect(r['source'], 'dart:io');
    expect(r.containsKey('body'), isFalse);
    final reqHeaders = headerMap(r['headers']);
    expect(reqHeaders['authorization'], '••••');
    expect(reqHeaders['x-request-id'], 'abc-123');
    expect(reqHeaders['user-agent'], startsWith('Dart/'));
    expect(reqHeaders['host'], '127.0.0.1:${origin.server.port}');
    expect(origin.lastHeaders['/json']!['authorization'], ['Bearer s3cr3t'],
        reason: 'redaction is only for the report');

    expect(end['type'], 'net.response');
    expect(end['status'], 200);
    expect(end['statusText'], 'OK');
    expect(end['protocol'], 'HTTP/1.1');
    expect(end['remoteAddress'], '127.0.0.1:${origin.server.port}');
    expect(headerMap(end['headers'])['content-type'], 'application/json; charset=utf-8');
    expect(end['body'], {'encoding': 'utf8', 'data': text, 'size': utf8.encode(text).length});
    final timings = end['timings']! as Map<String, Object?>;
    expect(timings.keys, containsAll(<String>['connect', 'send', 'wait', 'receive']));
    expect((end['ts']! as num) >= (r['ts']! as num), isTrue);
  });

  test('POST bodies via write / add / addStream are captured, app traffic untouched', () async {
    final c = HttpClient();
    final payload = jsonEncode({'name': 'Yusuf', 'city': 'İzmir', 'tags': ['ğ', 'ş']});

    final r1 = await c.postUrl(Uri.parse('${origin.base}/echo?via=write'));
    r1.headers.contentType = ContentType.json;
    r1.write(payload);
    final res1 = await r1.close();
    final echoed = jsonDecode(await utf8.decoder.bind(res1).join()) as Map<String, Object?>;
    expect(echoed['received'], payload);

    final r2 = await c.postUrl(Uri.parse('${origin.base}/echo?via=add'));
    r2.headers.contentType = ContentType('text', 'plain', charset: 'utf-8');
    r2.add(utf8.encode('part1-'));
    r2.writeAll(['a', 'b', 'c'], ',');
    r2.writeln('!');
    r2.writeCharCode(0x41);
    await (await r2.close()).drain<void>();
    expect(origin.lastBodies['/echo'], 'part1-a,b,c!\nA');

    final r3 = await c.postUrl(Uri.parse('${origin.base}/echo?via=stream'));
    r3.headers.contentType = ContentType('application', 'octet-stream');
    await r3.addStream(Stream<List<int>>.fromIterable([[1, 2, 3], [4, 5]]));
    await (await r3.close()).drain<void>();
    c.close();

    final (q1, e1) = await net('/echo?via=write');
    expect(q1['method'], 'POST');
    expect(q1['body'], {'encoding': 'utf8', 'data': payload, 'size': utf8.encode(payload).length});
    expect(e1['status'], 201);
    final (q2, _) = await net('/echo?via=add');
    expect((q2['body']! as Map)['data'], 'part1-a,b,c!\nA');
    final (q3, _) = await net('/echo?via=stream');
    expect(q3['body'], {'encoding': 'base64', 'data': base64Encode([1, 2, 3, 4, 5]), 'size': 5});
  });

  test('404, binary image (base64) and HEAD', () async {
    final c = HttpClient();
    final notFound = await (await c.getUrl(Uri.parse('${origin.base}/missing?case=404'))).close();
    expect(notFound.statusCode, 404);
    await notFound.drain<void>();
    final image = await (await c.getUrl(Uri.parse('${origin.base}/image?case=png'))).close();
    // Same chunk types as dart:io (Dio relies on Uint8List chunks).
    final bytes = await image.cast<Uint8List>().fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    expect(bytes, Origin.pngBytes);
    final head = await (await c.headUrl(Uri.parse('${origin.base}/json?case=head'))).close();
    await head.drain<void>();
    c.close();

    final (_, e404) = await net('/missing?case=404');
    expect(e404['status'], 404);
    expect(e404['statusText'], 'Not Found');
    expect((e404['body']! as Map)['data'], '{"error":"not found"}');
    final (_, ePng) = await net('/image?case=png');
    expect(ePng['body'], {'encoding': 'base64', 'data': base64Encode(Origin.pngBytes), 'size': Origin.pngBytes.length});
    final (qHead, eHead) = await net('/json?case=head');
    expect(qHead['method'], 'HEAD');
    expect(eHead['status'], 200);
    expect(eHead.containsKey('body'), isFalse);
  });

  test('gzip: decoded by dart:io or (autoUncompress=false) by the SDK', () async {
    final c = HttpClient();
    final auto = await (await c.getUrl(Uri.parse('${origin.base}/gzip?case=auto'))).close();
    expect(auto.compressionState, HttpClientResponseCompressionState.decompressed);
    final autoText = await utf8.decoder.bind(auto).join();
    c.autoUncompress = false;
    final raw = await (await c.getUrl(Uri.parse('${origin.base}/gzip?case=raw'))).close();
    expect(raw.compressionState, HttpClientResponseCompressionState.compressed);
    final rawBytes = await raw.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    expect(utf8.decode(gzip.decode(rawBytes)), autoText, reason: 'app still gets gzip bytes');
    c.close();

    final (_, eAuto) = await net('/gzip?case=auto');
    expect((eAuto['body']! as Map)['data'], autoText);
    final (_, eRaw) = await net('/gzip?case=raw');
    expect(eRaw['body'], {'encoding': 'utf8', 'data': autoText, 'size': autoText.length});
  });

  test('redirects dart:io follows itself: one entry per hop, the final response on the last', () async {
    final c = HttpClient();
    // /redirect → /redirect → /json?case=redir-final
    final second = Uri.encodeQueryComponent('/json?case=redir-final');
    final first = Uri.encodeQueryComponent('/redirect?case=redir-hop&to=$second');
    final req = await c.getUrl(Uri.parse('${origin.base}/redirect?case=redir&to=$first'));
    req.headers.set('X-Trace', 'hop-1');
    final res = await req.close();
    expect(res.redirects, hasLength(2));
    final text = await utf8.decoder.bind(res).join();
    c.close();

    final (q1, e1) = await net('/redirect?case=redir&to=$first');
    expect(q1['method'], 'GET');
    expect(e1['status'], 302);
    expect(headerMap(e1['headers'])['location'], '/redirect?case=redir-hop&to=$second');
    expect(e1.containsKey('body'), isFalse);
    final (q2, e2) = await net('/redirect?case=redir-hop&to=$second');
    expect(q2['method'], 'GET');
    expect(headerMap(q2['headers'])['x-trace'], 'hop-1');
    expect(e2['status'], 302);
    final (q3, e3) = await net('/json?case=redir-final');
    expect(q3['url'], '${origin.base}/json?case=redir-final');
    expect(e3['status'], 200);
    expect((e3['body']! as Map)['data'], text);
    expect(int.parse(q1['id']! as String) < int.parse(q3['id']! as String), isTrue);
  });

  test('manual redirect() is reported as a second request', () async {
    final c = HttpClient();
    final req = await c.getUrl(Uri.parse('${origin.base}/redirect?case=manual'));
    req.followRedirects = false;
    final first = await req.close();
    expect(first.statusCode, 302);
    await first.drain<void>();
    final second = await first.redirect();
    expect(second.statusCode, 200);
    await second.drain<void>();
    c.close();
    final (_, e1) = await net('/redirect?case=manual');
    expect(e1['status'], 302);
    final hop = await conn.waitFor((m) => m['type'] == 'net.request' && m['url'] == '${origin.base}/json');
    final e2 = await conn.waitForNetEnd(hop['id']! as String);
    expect(e2['status'], 200);
  });

  test('large bodies are truncated to config.maxBodyBytes; captureBodies=false sends sizes only', () async {
    conn.send({
      'type': 'config',
      'config': FakeDesktop.defaultConfig(maxBodyBytes: 1000),
    });
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(client.maxBodyBytes, 1000);
    final c = HttpClient();
    final res = await (await c.getUrl(Uri.parse('${origin.base}/big?case=trunc'))).close();
    expect((await utf8.decoder.bind(res).join()).length, 5000);

    conn.send({'type': 'config', 'config': FakeDesktop.defaultConfig(captureBodies: false)});
    await Future<void>.delayed(const Duration(milliseconds: 200));
    final res2 = await (await c.getUrl(Uri.parse('${origin.base}/big?case=nobody'))).close();
    await res2.drain<void>();
    c.close();
    conn.send({'type': 'config', 'config': FakeDesktop.defaultConfig()});
    await Future<void>.delayed(const Duration(milliseconds: 200));

    final (_, e1) = await net('/big?case=trunc');
    final body = e1['body']! as Map<String, Object?>;
    expect(body['size'], 5000);
    expect(body['truncated'], isTrue);
    expect((body['data']! as String).length, 1000);
    final (_, e2) = await net('/big?case=nobody');
    expect(e2['body'], {'encoding': 'utf8', 'data': '', 'size': 5000, 'truncated': true});
  });

  test('connection refused and abort() are reported as net.error', () async {
    final closedPort = await freePort();
    final c = HttpClient();
    await expectLater(
      c.getUrl(Uri.parse('http://127.0.0.1:$closedPort/nothing-here')),
      throwsA(isA<SocketException>()),
    );
    final (q, e) = await net('/nothing-here');
    expect(q['headers'], isEmpty);
    expect(e['type'], 'net.error');
    expect(e['error'], contains('SocketException'));

    final req = await c.getUrl(Uri.parse('${origin.base}/slow?ms=3000&case=abort'));
    final pending = req.close();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    req.abort();
    await expectLater(pending, throwsA(isA<HttpException>()));
    c.close(force: true);
    final (_, ea) = await net('/slow?ms=3000&case=abort');
    expect(ea['type'], 'net.error');
    expect(ea['cancelled'], isTrue);
  });

  test('a cancelled body stream is reported with what arrived (truncated)', () async {
    final c = HttpClient();
    final res = await (await c.getUrl(Uri.parse('${origin.base}/stream?case=cancel'))).close();
    final first = Completer<void>();
    late StreamSubscription<List<int>> sub;
    sub = res.listen((chunk) {
      if (!first.isCompleted) first.complete();
    });
    await first.future;
    await sub.cancel();
    c.close(force: true);
    final (_, end) = await net('/stream?case=cancel');
    expect(end['status'], 200);
    final body = end['body']! as Map<String, Object?>;
    expect(body['truncated'], isTrue);
    expect(body['data'], startsWith('chunk 0'));
  });

  test('subscription handlers can be replaced and asFuture works', () async {
    final c = HttpClient();
    final res = await (await c.getUrl(Uri.parse('${origin.base}/stream?case=asfuture'))).close();
    final received = BytesBuilder();
    // ignore: cancel_subscriptions
    final sub = res.listen(null);
    sub.onData(received.add);
    await sub.asFuture<void>();
    c.close();
    expect(utf8.decode(received.takeBytes()), startsWith('chunk 0\nchunk 1'));
    final (_, end) = await net('/stream?case=asfuture');
    expect((end['body']! as Map)['data'], contains('chunk 5'));
  });

  test('a response nobody reads is still reported (without body)', () async {
    final previous = DurbunHttpTuning.unconsumedResponseDelay;
    DurbunHttpTuning.unconsumedResponseDelay = const Duration(milliseconds: 150);
    addTearDown(() => DurbunHttpTuning.unconsumedResponseDelay = previous);
    final c = HttpClient();
    final res = await (await c.getUrl(Uri.parse('${origin.base}/json?case=unread'))).close();
    final (_, end) = await net('/json?case=unread');
    expect(end['status'], 200);
    expect(end.containsKey('body'), isFalse);
    expect((end['timings']! as Map)['receive'], 0, reason: 'no made-up receive time');
    await res.drain<void>();
    c.close();
  });

  test('a body read late is still captured (the tee stays armed)', () async {
    final c = HttpClient();
    final res = await (await c.getUrl(Uri.parse('${origin.base}/json?case=late-read'))).close();
    final req = await conn.waitFor(
      (m) => m['type'] == 'net.request' && (m['url']! as String).endsWith('/json?case=late-read'),
    );
    // The app looks at the headers first and reads the body a while later.
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(
      conn.received.where((m) => m['type'] == 'net.response' && m['id'] == req['id']),
      isEmpty,
      reason: 'not reported before the body is read',
    );
    final text = await utf8.decoder.bind(res).join();
    c.close();
    final end = await conn.waitForNetEnd(req['id']! as String);
    expect((end['body']! as Map)['data'], text);
  });

  test('package:http (IOClient) traffic is captured', () async {
    final response = await http.get(Uri.parse('${origin.base}/json?case=pkg-http'));
    expect(response.statusCode, 200);
    final ioClient = http_io.IOClient();
    final posted = await ioClient.post(
      Uri.parse('${origin.base}/echo?case=pkg-http'),
      headers: {'content-type': 'application/json'},
      body: '{"a":1}',
    );
    ioClient.close();
    expect(posted.statusCode, 201);
    final (_, e1) = await net('/json?case=pkg-http');
    expect((e1['body']! as Map)['data'], response.body);
    final (q2, e2) = await net('/echo?case=pkg-http');
    expect((q2['body']! as Map)['data'], '{"a":1}');
    expect(e2['status'], 201);
  });

  test('WebSocket upgrade (detachSocket) is reported as 101', () async {
    // flutter_tester already used dart:io's static WebSocket client (to talk to
    // the test runner) before Dürbün was installed, so pass a fresh client.
    final ws = await WebSocket.connect(
      'ws://127.0.0.1:${origin.server.port}/ws',
      customClient: HttpClient(),
    );
    ws.add('merhaba');
    final reply = await ws.first;
    expect(reply, 'echo: merhaba');
    await ws.close();
    // dart:io performs the upgrade as an http:// GET.
    final req = await conn.waitFor(
      (m) => m['type'] == 'net.request' && m['url'] == 'http://127.0.0.1:${origin.server.port}/ws',
    );
    expect(headerMap(req['headers'])['upgrade'], 'websocket');
    final end = await conn.waitForNetEnd(req['id']! as String);
    expect(end['status'], 101);
    expect(end['statusText'], 'Switching Protocols');
  });

  group('mocks', () {
    tearDown(() => setMocks(const []));

    test('respond: synthesized response, the network is never touched', () async {
      await setMocks([
        rule('mock-users', '/mocked/users', {
          'type': 'respond',
          'status': 201,
          'headers': [
            ['X-Mocked', 'yes'],
          ],
          'body': '{"users":[{"id":1,"name":"Ada"}]}',
          'delayMs': 200,
        }, method: 'GET'),
      ]);
      final c = HttpClient();
      final sw = Stopwatch()..start();
      final req = await c.getUrl(Uri.parse('${origin.base}/mocked/users?case=respond'));
      req.headers.set('Authorization', 'Bearer abc');
      final res = await req.close();
      final text = await utf8.decoder.bind(res).join();
      sw.stop();
      c.close();
      expect(res.statusCode, 201);
      expect(res.reasonPhrase, 'Created');
      expect(res.headers.value('x-mocked'), 'yes');
      expect(res.headers.value('x-durbun-mock'), 'mock-users');
      expect(res.headers.contentType?.mimeType, 'application/json');
      expect(jsonDecode(text), {'users': [{'id': 1, 'name': 'Ada'}]});
      expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(190));
      expect(origin.hits['/mocked/users'], isNull);

      final (q, end) = await net('/mocked/users?case=respond');
      expect(headerMap(q['headers'])['authorization'], '••••');
      expect(end['type'], 'net.response');
      expect(end['mocked'], isTrue);
      expect(end['mockRuleId'], 'mock-users');
      expect(end['status'], 201);
      expect((end['body']! as Map)['data'], text);
    });

    test('respond with a base64 body and package:http', () async {
      await setMocks([
        rule('mock-img', '*/avatar/*.png', {
          'type': 'respond',
          'status': 200,
          'headers': [
            ['Content-Type', 'image/png'],
          ],
          'body': base64Encode(Origin.pngBytes),
          'bodyEncoding': 'base64',
        }, match: 'glob'),
      ]);
      final response = await http.get(Uri.parse('${origin.base}/avatar/42.png'));
      expect(response.statusCode, 200);
      expect(response.bodyBytes, Origin.pngBytes);
      expect(origin.hits['/avatar/42.png'], isNull);
    });

    test('delay: the real request runs after the delay and is marked mocked', () async {
      await setMocks([rule('slow-down', r'/json\?case=delay$', {'type': 'delay', 'delayMs': 300}, match: 'regex')]);
      final hitsBefore = origin.hits['/json'] ?? 0;
      final sw = Stopwatch()..start();
      final c = HttpClient();
      final res = await (await c.getUrl(Uri.parse('${origin.base}/json?case=delay'))).close();
      await res.drain<void>();
      c.close();
      expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(290));
      expect(origin.hits['/json'], hitsBefore + 1);
      final (_, end) = await net('/json?case=delay');
      expect(end['status'], 200);
      expect(end['mocked'], isTrue);
      expect(end['mockRuleId'], 'slow-down');
    });

    test('fail rules raise the natural dart:io exceptions', () async {
      final cases = <String, Matcher>{
        'connection': isA<SocketException>().having((e) => e.message, 'message', 'Connection refused'),
        'dns': isA<SocketException>().having((e) => e.message, 'message', "Failed host lookup: '127.0.0.1'"),
        'tls': isA<HandshakeException>(),
        'timeout': isA<SocketException>().having((e) => e.message, 'message', contains('timed out')),
        'custom': isA<HttpException>().having((e) => e.message, 'message', 'Backend down'),
      };
      for (final entry in cases.entries) {
        await setMocks([
          rule('fail-${entry.key}', '/fail/${entry.key}', {
            'type': 'fail',
            'error': entry.key,
            if (entry.key == 'custom') 'message': 'Backend down',
            'delayMs': 50,
          }),
        ]);
        final c = HttpClient();
        await expectLater(
          c.getUrl(Uri.parse('${origin.base}/fail/${entry.key}')),
          throwsA(entry.value),
          reason: entry.key,
        );
        c.close();
        final (_, end) = await net('/fail/${entry.key}');
        expect(end['type'], 'net.error', reason: entry.key);
        expect(end['mocked'], isTrue);
        expect(end['mockRuleId'], 'fail-${entry.key}');
      }
      expect(origin.hits.keys.where((k) => k.startsWith('/fail')), isEmpty);
    });

    test('timeout fail with connectionTimeout set mimics dart:io message (Dio maps it)', () async {
      await setMocks([rule('to', '/fail/connect-timeout', {'type': 'fail', 'error': 'timeout'})]);
      final c = HttpClient()..connectionTimeout = const Duration(seconds: 5);
      await expectLater(
        c.getUrl(Uri.parse('${origin.base}/fail/connect-timeout')),
        throwsA(isA<SocketException>().having(
          (e) => e.message,
          'message',
          startsWith('HTTP connection timed out after 0:00:05.000000'),
        )),
      );
      c.close();
    });

    test('rules for another app or another method do not apply', () async {
      await setMocks([
        rule('other-app', '/json?case=scoped', {'type': 'respond', 'status': 500}, apps: ['com.someone.else']),
        rule('post-only', '/json?case=scoped', {'type': 'respond', 'status': 500}, method: 'POST'),
      ]);
      final c = HttpClient();
      final res = await (await c.getUrl(Uri.parse('${origin.base}/json?case=scoped'))).close();
      await res.drain<void>();
      c.close();
      expect(res.statusCode, 200);
      final (_, end) = await net('/json?case=scoped');
      expect(end.containsKey('mocked'), isFalse);
    });

    test('a mocked 302 is followed through the wrapper', () async {
      await setMocks([
        rule('redirect-mock', '/old-endpoint', {
          'type': 'respond',
          'status': 302,
          'headers': [
            ['Location', '/json?case=mock-redirect'],
          ],
        }),
      ]);
      final c = HttpClient();
      final res = await (await c.getUrl(Uri.parse('${origin.base}/old-endpoint'))).close();
      final text = await utf8.decoder.bind(res).join();
      c.close();
      expect(res.statusCode, 200);
      expect(jsonDecode(text), containsPair('hello', 'dünya'));
      final (_, e1) = await net('/old-endpoint');
      expect(e1['status'], 302);
      expect(e1['mocked'], isTrue);
      final (_, e2) = await net('/json?case=mock-redirect');
      expect(e2['status'], 200);
    });
  });

  group('overrides chaining', () {
    test('previous HttpOverrides are kept and re-wrapped after replacement', () async {
      final replacement = _UserAgentOverrides('custom-agent/1.0');
      HttpOverrides.global = replacement;
      expect(DurbunHttpOverrides.ensureInstalled(client), isTrue);
      expect(DurbunHttpOverrides.ensureInstalled(client), isFalse);
      final c = HttpClient();
      expect(c, isA<DurbunHttpClient>());
      expect((c as DurbunHttpClient).inner.userAgent, 'custom-agent/1.0');
      final res = await (await c.getUrl(Uri.parse('${origin.base}/json?case=chained'))).close();
      await res.drain<void>();
      c.close();
      final (q, _) = await net('/json?case=chained');
      expect(headerMap(q['headers'])['user-agent'], 'custom-agent/1.0');
      final current = DurbunHttpOverrides.currentGlobal;
      expect(current, isA<DurbunHttpOverrides>());
      expect((current! as DurbunHttpOverrides).previous, same(replacement));
    });
  });
}

class _UserAgentOverrides extends HttpOverrides {
  _UserAgentOverrides(this.agent);
  final String agent;

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context)..userAgent = agent;
}
