// Dürbün SDK smoke test (pure Dart, no Flutter):
//
//   dart run tool/smoke.dart              # against a running desktop (127.0.0.1:9751)
//   dart run tool/smoke.dart --dry-run    # against an in-process fake desktop
//   dart run tool/smoke.dart --help
//
// Connects like an app would, sends logs of every level, an event, an error
// with a stack trace, a crash, then performs real HTTP requests (GET JSON,
// POST JSON, 404, slow, PNG image, gzip, a body stream that breaks after the
// headers, a refused connection) against a local HTTP server through the
// SDK's dart:io wrapper, sends process metrics, flushes and exits.
//
// While it lingers (--linger) the desktop can drive its actions: a button
// (`smoke.ping`), a toggle (`smoke.verbose`), a select (`smoke.theme`) and
// `smoke.request` ({path, method, body} params) which makes one more request
// through the SDK — e.g. to see a mock rule set from the desktop apply.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:durbun/durbun_core.dart';
import 'package:durbun/src/core/process_sampler.dart';
import 'package:durbun/src/core/protocol.dart' show buildMetric;

import '../test/support/fake_desktop.dart';

const _usage = '''
Dürbün SDK smoke test

Usage: dart run tool/smoke.dart [options]

  --host <ip>        Desktop address (default 127.0.0.1)
  --port <n>         Desktop SDK port (default 9751)
  --timeout <sec>    How long to wait for the desktop (default 10)
  --linger <sec>     Stay connected this long after the traffic (default 2),
                     e.g. to try app actions from the desktop UI
  --no-isolate       Run the transport on the main isolate
  --dry-run          Use an in-process fake desktop instead (no desktop needed)
  -h, --help         Show this help

Exit codes: 0 ok · 1 verification failed (dry run) · 2 desktop unreachable · 64 bad usage
''';

Future<void> main(List<String> args) async {
  final options = _parseArgs(args);
  if (options == null) {
    stdout.write(_usage);
    exitCode = args.contains('--help') || args.contains('-h') ? 0 : 64;
    return;
  }
  exitCode = await _run(options);
}

class _Options {
  String host = '127.0.0.1';
  int port = kDefaultSdkPort;
  int timeoutSec = 10;
  int lingerSec = 2;
  bool isolate = true;
  bool dryRun = false;
}

_Options? _parseArgs(List<String> args) {
  final o = _Options();
  for (var i = 0; i < args.length; i++) {
    final a = args[i];
    String next() {
      if (i + 1 >= args.length) throw FormatException('$a needs a value');
      return args[++i];
    }

    try {
      switch (a) {
        case '-h':
        case '--help':
          return null;
        case '--host':
          o.host = next();
        case '--port':
          o.port = int.parse(next());
        case '--timeout':
          o.timeoutSec = int.parse(next());
        case '--linger':
          o.lingerSec = int.parse(next());
        case '--no-isolate':
          o.isolate = false;
        case '--dry-run':
          o.dryRun = true;
        default:
          stderr.writeln('Unknown option: $a');
          return null;
      }
    } on FormatException catch (e) {
      stderr.writeln(e.message);
      return null;
    }
  }
  return o;
}

void _say(String line) => stdout.writeln(line);

Future<int> _run(_Options o) async {
  FakeDesktop? fake;
  if (o.dryRun) {
    fake = await FakeDesktop.start(appId: 'app:smoke');
    o.host = '127.0.0.1';
    o.port = fake.port;
    _say('🧪 Dry run: fake desktop on 127.0.0.1:${fake.port}');
  }

  final origin = await _Origin.start();
  _say('🌐 Local HTTP server on ${origin.base}');

  final client = DurbunClient.start(
    DurbunOptions(
      enabled: true,
      host: o.host == '127.0.0.1' ? null : o.host,
      port: o.port,
      appId: 'dev.durbun.smoke',
      appName: 'Dürbün Smoke',
      appVersion: kSdkVersion,
      useBackgroundIsolate: o.isolate,
    ),
    extraCapabilities: const <String>['metrics'],
  );
  var clicks = 0;
  var verbose = false;
  var theme = 'system';
  client.addActions(<DurbunAction>[
    DurbunAction.button(
      id: 'smoke.ping',
      label: 'Ping the smoke app',
      group: 'smoke',
      onPressed: (_) {
        clicks++;
        client.log(DurbunLogLevel.info, 'Pong from the smoke app ($clicks)', tag: 'smoke');
        return {'clicks': clicks};
      },
    ),
    DurbunAction.toggle(
      id: 'smoke.verbose',
      label: 'Verbose logging',
      group: 'smoke',
      value: () => verbose,
      onChanged: (v) {
        verbose = v;
        client.log(DurbunLogLevel.info, 'Verbose logging ${v ? 'on' : 'off'}', tag: 'smoke');
      },
    ),
    DurbunAction.select(
      id: 'smoke.theme',
      label: 'Theme',
      group: 'smoke',
      options: const <DurbunActionOption>[
        DurbunActionOption('system', 'System'),
        DurbunActionOption('light', 'Light'),
        DurbunActionOption('dark', 'Dark'),
      ],
      value: () => theme,
      onChanged: (v) {
        theme = v;
        client.log(DurbunLogLevel.info, 'Theme → $v', tag: 'smoke');
      },
    ),
    DurbunAction.button(
      id: 'smoke.request',
      label: 'Make a request',
      group: 'smoke',
      onPressed: (params) => _probe(origin, params),
    ),
  ]);

  // Process metrics (memory, CPU, threads) like the Flutter glue sends them.
  final sampler = ProcessSampler()..sample();
  void sendMetric() {
    final s = sampler.sample();
    client.metric(buildMetric(cpu: s.cpu, memoryMB: s.memoryMB, threads: s.threads));
  }

  final metricsTimer = Timer.periodic(const Duration(seconds: 1), (_) => sendMetric());

  _say('🔭 Connecting to Dürbün at ${o.host}:${o.port} …');
  final connected = await client.waitForConnection(Duration(seconds: o.timeoutSec));
  if (!connected) {
    stderr.writeln(
      '✖ The Dürbün desktop is not reachable at ${o.host}:${o.port}.\n'
      '  Start it first (e.g. `npm start` in the repo, or `durbun`), or use --dry-run.',
    );
    metricsTimer.cancel();
    await client.dispose();
    await origin.close();
    await fake?.close();
    return 2;
  }
  _say('✔ Connected via ${client.connection.via} '
      '(server ${client.connection.server}, app session ${client.connection.appId})');
  sendMetric();

  // Logs of every level.
  client.log(DurbunLogLevel.verbose, 'Verbose: cache lookup for key "home_feed"', tag: 'cache');
  client.log(DurbunLogLevel.debug, 'Debug: building HomeScreen with 24 items', tag: 'ui');
  client.log(DurbunLogLevel.info, 'Kullanıcı giriş yaptı', tag: 'auth', data: {'userId': 42, 'method': 'apple'});
  client.log(DurbunLogLevel.warn, 'Token expires in 30 s, refreshing', tag: 'auth');
  try {
    jsonDecode('{"broken": ');
  } catch (e, st) {
    client.log(DurbunLogLevel.error, 'Ödeme yanıtı çözümlenemedi', tag: 'payment', error: e, stackTrace: st);
  }
  client.log(
    DurbunLogLevel.fatal,
    'Fatal: database migration 12 → 13 failed\nTable "orders" is locked\nRetry scheduled',
    tag: 'db',
  );
  client.log(DurbunLogLevel.info, {
    'event': 'cart_updated',
    'items': [
      {'sku': 'TSHIRT-M', 'qty': 2, 'price': 249.9},
      {'sku': 'MUG', 'qty': 1, 'price': 129.0},
    ],
    'total': 628.8,
  }, tag: 'cart');
  client.event('purchase', {'amount': 49.9, 'currency': 'TRY', 'items': 3});
  try {
    throw StateError('Cart is empty');
  } catch (e, st) {
    client.log(DurbunLogLevel.fatal, 'Unhandled exception: $e', tag: 'crash', error: e, stackTrace: st, kind: 'crash');
  }
  _say('✔ Sent 8 logs (every level, JSON, error with stack, crash) and 1 event');

  // Real HTTP through the SDK's dart:io wrapper.
  final http = HttpClient();
  final results = <String>[];
  Future<void> request(String label, Future<HttpClientResponse> Function() send) async {
    final sw = Stopwatch()..start();
    try {
      final res = await send();
      final bytes = await res.fold<int>(0, (n, chunk) => n + chunk.length);
      results.add('$label → ${res.statusCode} · ${sw.elapsedMilliseconds} ms · $bytes B');
    } catch (e) {
      results.add('$label → ${e.runtimeType} (${sw.elapsedMilliseconds} ms)');
    }
  }

  await request('GET  /api/users', () async {
    final r = await http.getUrl(Uri.parse('${origin.base}/api/users?page=1'));
    r.headers.set(HttpHeaders.acceptHeader, 'application/json');
    r.headers.set(HttpHeaders.authorizationHeader, 'Bearer smoke-token');
    return r.close();
  });
  await request('POST /api/orders', () async {
    final r = await http.postUrl(Uri.parse('${origin.base}/api/orders'));
    r.headers.contentType = ContentType.json;
    r.write(jsonEncode({'productId': 'TSHIRT-M', 'quantity': 2, 'note': 'Kapıya bırakın'}));
    return r.close();
  });
  await request('GET  /api/missing', () async => (await http.getUrl(Uri.parse('${origin.base}/api/missing'))).close());
  await request('GET  /api/slow', () async => (await http.getUrl(Uri.parse('${origin.base}/api/slow?ms=1200'))).close());
  await request('GET  /images/logo.png', () async => (await http.getUrl(Uri.parse('${origin.base}/images/logo.png'))).close());
  await request('GET  /api/feed (gzip)', () async => (await http.getUrl(Uri.parse('${origin.base}/api/feed'))).close());
  await request('GET  /api/broken (body breaks)', () async => (await http.getUrl(Uri.parse('${origin.base}/api/broken'))).close());
  final closedPort = await freePort();
  await request('GET  refused', () async => (await http.getUrl(Uri.parse('http://127.0.0.1:$closedPort/health'))).close());
  http.close();
  for (final line in results) {
    _say('  $line');
  }
  client.log(DurbunLogLevel.info, 'Smoke traffic done (${results.length} requests)', tag: 'smoke');

  final flushed = await client.flush(const Duration(seconds: 5));
  _say(flushed ? '✔ Everything flushed to the desktop' : '⚠ Flush timed out');
  if (o.lingerSec > 0 && !o.dryRun) {
    _say('… staying connected for ${o.lingerSec} s (try the smoke actions in the desktop UI)');
    await Future<void>.delayed(Duration(seconds: o.lingerSec));
  }
  metricsTimer.cancel();

  var code = 0;
  if (fake != null) code = await _verify(fake) ? 0 : 1;
  await client.dispose(flushTimeout: const Duration(seconds: 2));
  await origin.close();
  await fake?.close();
  _say(code == 0 ? '🎉 Smoke test finished' : '✖ Smoke test failed');
  return code;
}

/// Dry run: check what the fake desktop received.
Future<bool> _verify(FakeDesktop desktop) async {
  final conn = await desktop.nextConnection();
  final checks = <String, bool>{};
  try {
    // 8 requests; the broken body stream reports a response AND an error.
    await conn.waitForCount((m) => m['type'] == 'net.response' || m['type'] == 'net.error', 9);
  } catch (_) {}
  final levels = conn.ofType('log').map((m) => m['level']).toSet();
  final requests = conn.ofType('net.request');
  final responses = conn.ofType('net.response');
  String? statusFor(String path) {
    final req = requests.where((m) => (m['url']! as String).contains(path)).firstOrNull;
    if (req == null) return null;
    final res = responses.where((m) => m['id'] == req['id']).firstOrNull;
    return res?['status']?.toString();
  }

  checks['hello with app id dev.durbun.smoke'] =
      (conn.hello?['app'] as Map?)?['id'] == 'dev.durbun.smoke';
  checks['logs of all 6 levels'] =
      levels.containsAll(['verbose', 'debug', 'info', 'warn', 'error', 'fatal']);
  checks['error log carries a stack trace'] = conn
      .ofType('log')
      .any((m) => (m['error'] as Map?)?['stack'] != null);
  checks['event "purchase"'] = conn.ofType('event').any((m) => m['name'] == 'purchase');
  checks['GET /api/users → 200 + JSON body'] = statusFor('/api/users') == '200' &&
      responses.any((m) => ((m['body'] as Map?)?['data'] as String? ?? '').contains('Ada'));
  checks['POST /api/orders → 201 with request body'] = statusFor('/api/orders') == '201' &&
      requests.any((m) => ((m['body'] as Map?)?['data'] as String? ?? '').contains('TSHIRT-M'));
  checks['GET /api/missing → 404'] = statusFor('/api/missing') == '404';
  checks['GET /api/slow → 200'] = statusFor('/api/slow') == '200';
  checks['PNG body as base64'] = responses.any((m) => (m['body'] as Map?)?['encoding'] == 'base64');
  checks['gzip body decoded'] = statusFor('/api/feed') == '200';
  final broken = requests.where((m) => (m['url']! as String).contains('/api/broken')).firstOrNull;
  checks['broken body → net.response (truncated) + net.error'] = broken != null &&
      responses.any((m) => m['id'] == broken['id'] && (m['body'] as Map?)?['truncated'] == true) &&
      conn.ofType('net.error').any((m) => m['id'] == broken['id']);
  checks['crash log'] = conn.ofType('log').any((m) => m['kind'] == 'crash');
  checks['refused connection → net.error'] = conn.ofType('net.error').length >= 2;
  checks['authorization header present'] = requests.any(
    (m) => (m['headers']! as List).any((h) => (h as List)[0] == 'authorization'),
  );
  checks['no invalid NDJSON lines'] = conn.invalidLines.isEmpty;

  _say('Dry-run verification:');
  checks.forEach((name, ok) => _say('  ${ok ? '✔' : '✖'} $name'));
  return checks.values.every((ok) => ok);
}

class _Origin {
  _Origin._(this.server);

  final HttpServer server;

  String get base => 'http://127.0.0.1:${server.port}';

  static Future<_Origin> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final origin = _Origin._(server);
    final logo = _binocularsPng(48);
    server.listen((req) async {
      try {
        final body = await utf8.decoder.bind(req).join();
        final res = req.response;
        switch (req.uri.path) {
          case '/api/users':
            res.headers.contentType = ContentType.json;
            res.write(jsonEncode({
              'page': 1,
              'users': [
                {'id': 1, 'name': 'Ada', 'city': 'İstanbul'},
                {'id': 2, 'name': 'Yusuf', 'city': 'İzmir'},
              ],
            }));
          case '/api/orders':
            res.statusCode = HttpStatus.created;
            res.headers.contentType = ContentType.json;
            res.headers.set(HttpHeaders.locationHeader, '/api/orders/1001');
            res.write(jsonEncode({'id': 1001, 'status': 'created', 'echo': jsonDecode(body)}));
          case '/api/slow':
            final ms = int.tryParse(req.uri.queryParameters['ms'] ?? '') ?? 1000;
            await Future<void>.delayed(Duration(milliseconds: ms));
            res.headers.contentType = ContentType.text;
            res.write('slow but fine');
          case '/images/logo.png':
            res.headers.contentType = ContentType('image', 'png');
            res.headers.set(HttpHeaders.cacheControlHeader, 'max-age=3600');
            res.add(logo);
          case '/api/feed':
            res.headers.contentType = ContentType.json;
            res.headers.set(HttpHeaders.contentEncodingHeader, 'gzip');
            res.add(gzip.encode(utf8.encode(jsonEncode({
              'items': [for (var i = 1; i <= 20; i++) {'id': i, 'title': 'Gönderi $i'}],
            }))));
          case '/api/probe':
            res.headers.contentType = ContentType.json;
            res.write(jsonEncode({'real': true, 'from': 'origin'}));
          case '/api/broken':
            // Headers and the start of the body, then the connection dies.
            final socket = await res.detachSocket(writeHeaders: false);
            socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n'
                'content-length: 5000\r\n\r\n{"items":[1,2,3');
            await socket.flush();
            await Future<void>.delayed(const Duration(milliseconds: 50));
            socket.destroy();
            return;
          default:
            res.statusCode = HttpStatus.notFound;
            res.headers.contentType = ContentType.json;
            res.write(jsonEncode({'error': 'not_found', 'path': req.uri.path}));
        }
        await res.close();
      } catch (_) {}
    });
    return origin;
  }

  Future<void> close() => server.close(force: true);
}

/// `smoke.request` action: one request through the SDK's dart:io wrapper.
/// Params: `path` (default /api/probe), `method` (GET), `body` (JSON value).
Future<Map<String, Object?>> _probe(_Origin origin, Map<String, Object?> params) async {
  final path = params['path']?.toString() ?? '/api/probe';
  final method = (params['method']?.toString() ?? 'GET').toUpperCase();
  final http = HttpClient();
  final sw = Stopwatch()..start();
  try {
    final req = await http.openUrl(method, Uri.parse('${origin.base}$path'));
    final body = params['body'];
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.write(body is String ? body : jsonEncode(body));
    }
    final res = await req.close();
    final text = await const Utf8Decoder(allowMalformed: true).bind(res).join();
    return <String, Object?>{
      'status': res.statusCode,
      'body': text.length > 500 ? text.substring(0, 500) : text,
      'ms': sw.elapsedMilliseconds,
    };
  } catch (e) {
    return <String, Object?>{'error': e.toString(), 'type': e.runtimeType.toString(), 'ms': sw.elapsedMilliseconds};
  } finally {
    http.close(force: true);
  }
}

/// A tiny RGBA PNG (two violet circles = binoculars) so the desktop's image
/// preview has something real to show.
Uint8List _binocularsPng(int size) {
  final raw = BytesBuilder();
  final r = size * 0.27;
  final cy = size / 2;
  for (var y = 0; y < size; y++) {
    raw.addByte(0); // filter: none
    for (var x = 0; x < size; x++) {
      final d1 = math.sqrt(math.pow(x - size * 0.3, 2) + math.pow(y - cy, 2));
      final d2 = math.sqrt(math.pow(x - size * 0.7, 2) + math.pow(y - cy, 2));
      final inside = d1 <= r || d2 <= r;
      final lens = d1 <= r * 0.45 || d2 <= r * 0.45;
      if (lens) {
        raw.add([0xE6, 0xE9, 0xF0, 0xFF]);
      } else if (inside) {
        raw.add([0x7C, 0x6C, 0xF2, 0xFF]);
      } else {
        raw.add([0, 0, 0, 0]);
      }
    }
  }
  final out = BytesBuilder()..add([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  void chunk(String type, List<int> data) {
    final typeBytes = ascii.encode(type);
    out.add(_u32(data.length));
    out.add(typeBytes);
    out.add(data);
    out.add(_u32(_crc32([...typeBytes, ...data])));
  }

  chunk('IHDR', [..._u32(size), ..._u32(size), 8, 6, 0, 0, 0]);
  chunk('IDAT', ZLibEncoder().convert(raw.takeBytes()));
  chunk('IEND', const []);
  return out.takeBytes();
}

List<int> _u32(int v) => [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];

int _crc32(List<int> bytes) {
  var crc = 0xFFFFFFFF;
  for (final b in bytes) {
    crc ^= b;
    for (var k = 0; k < 8; k++) {
      crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1;
    }
  }
  return crc ^ 0xFFFFFFFF;
}
