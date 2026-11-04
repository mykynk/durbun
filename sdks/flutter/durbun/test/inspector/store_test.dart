import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/format.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> eventually(bool Function() condition,
    {Duration timeout = const Duration(seconds: 10)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) fail('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

DurbunInspectorStore newStore(
        {int maxLogs = 2000,
        int maxCalls = 300,
        int maxBodyBytes = 24 << 20}) =>
    DurbunInspectorStore(
        maxLogs: maxLogs,
        maxCalls: maxCalls,
        maxBodyBytes: maxBodyBytes,
        notifyDelay: Duration.zero)
      ..bodyResolver = wireBodyFromPending;

Map<String, Object?> req(String id,
        {String url = 'https://api.example.com/v1/items?page=2',
        String method = 'GET',
        Object? body,
        double ts = 1000}) =>
    buildNetRequest(id: id, ts: ts, method: method, url: url, headers: const [
      ['Accept', 'application/json']
    ])
      ..['body'] = body;

PendingBody pending(String text, {String contentType = 'application/json'}) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(
      bytes: bytes,
      size: bytes.length,
      truncated: false,
      limit: 1 << 20,
      capture: true,
      contentType: contentType);
}

void main() {
  group('DurbunInspectorStore', () {
    test('a request and its response become one call with status and duration',
        () {
      final store = newStore();
      store.ingest(req('1'));
      expect(store.calls.single.state, InspectorCallState.pending);
      store.ingest(buildNetResponse(
          id: '1',
          ts: 1250.5,
          status: 200,
          headers: const [
            ['Content-Type', 'application/json']
          ],
          body: pending('{"ok":true}')));
      final call = store.calls.single;
      expect(call.state, InspectorCallState.done);
      expect(call.status, 200);
      expect(call.duration, const Duration(microseconds: 250500));
      expect(call.responseBody!.data, '{"ok":true}');
      expect(call.responseContentType, 'application/json');
      expect(call.isFailure, isFalse);
      expect(store.failureCount, 0);
    });

    test(
        'native lines (OkHttp / URLSession) are decoded and never collide with Dart ids',
        () {
      final store = newStore();
      store.ingest(req('1'));
      final nativeReq = jsonEncode({
        'type': 'net.request',
        'id': '1',
        'ts': 2000,
        'method': 'POST',
        'url': 'https://pay.example.com/charge',
        'headers': [],
        'source': 'okhttp',
        'body': {'encoding': 'utf8', 'data': '{"amount":5}', 'size': 12}
      });
      store.ingest({kEncodedLineKey: nativeReq});
      store.ingest({
        kEncodedLineKey: jsonEncode({
          'type': 'net.response',
          'id': '1',
          'ts': 2100,
          'status': 502,
          'headers': []
        })
      });
      expect(store.calls, hasLength(2));
      final dart = store.calls.first;
      final native = store.calls.last;
      expect(dart.state, InspectorCallState.pending,
          reason: 'the native response must not complete the Dart call');
      expect(native.native, isTrue);
      expect(native.source, 'okhttp');
      expect(native.status, 502);
      expect(native.requestBody!.data, '{"amount":5}');
      expect(store.failureCount, 1);
      store.ingest({
        kEncodedLineKey: jsonEncode({
          'type': 'log',
          'ts': 2200,
          'level': 'warn',
          'tag': 'OkHttp',
          'message': 'retrying'
        })
      });
      expect(store.logs.single.native, isTrue);
      expect(store.logs.single.level, 'warn');
    });

    test(
        'pending bodies are decoded only when looked at, and the message is left as it was',
        () {
      var resolved = 0;
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..bodyResolver = (p) {
          resolved++;
          return wireBodyFromPending(p);
        };
      final message = req('7',
          method: 'POST', body: pending('{"name":"Ayşe"}').toMessageValue());
      final before = Map<String, Object?>.of(message);
      store.ingest(message);
      expect(message, before);
      expect(resolved, 0);
      expect(store.calls.single.requestBody!.data, '{"name":"Ayşe"}');
      expect(store.calls.single.requestBody!.data, '{"name":"Ayşe"}');
      expect(resolved, 1, reason: 'decoded once, then cached');
    });

    test(
        'transport errors fail the call; a cancelled request is not counted as a failure',
        () {
      final store = newStore();
      store
        ..ingest(req('1'))
        ..ingest(req('2'))
        ..ingest(buildNetError(
            id: '1', ts: 1100, error: 'SocketException: Connection refused'))
        ..ingest(buildNetError(
            id: '2', ts: 1100, error: 'cancelled', cancelled: true));
      expect(store.calls.first.state, InspectorCallState.failed);
      expect(store.calls.first.error, contains('Connection refused'));
      expect(store.calls.last.cancelled, isTrue);
      expect(store.failureCount, 1);
    });

    test(
        'logs, events and crashes; the badge counts errors until they are seen',
        () {
      final store = newStore();
      store
        ..ingest(buildLog(
            level: 'info', message: 'hello', tag: 'auth', data: {'userId': 42}))
        ..ingest(buildEvent(name: 'purchase', props: {'amount': 49.9}))
        ..ingest(buildLog(
            level: 'fatal',
            message: 'Unhandled exception',
            kind: 'crash',
            error: buildErrorInfo(
                type: 'StateError', message: 'boom', stack: '#0 main')));
      expect(store.logs, hasLength(3));
      expect(store.logs[1].isEvent, isTrue);
      expect(store.logs[1].message, 'purchase');
      expect(store.logs[2].isCrash, isTrue);
      expect(store.errorCount, 1);
      expect(store.unseenErrors, 1);
      store.markSeen();
      expect(store.unseenErrors, 0);
      store.ingest(req('9'));
      store.ingest(
          buildNetResponse(id: '9', ts: 1001, status: 404, headers: const []));
      expect(store.unseenErrors, 1,
          reason: 'a failed request also lights the badge');
    });

    test('rings are bounded and say how much they dropped', () {
      final store = newStore(maxLogs: 3, maxCalls: 2);
      for (var i = 0; i < 5; i++) {
        store.ingest(buildLog(level: 'info', message: 'line $i'));
        store.ingest(req('$i'));
      }
      expect(store.logs.map((l) => l.message), ['line 2', 'line 3', 'line 4']);
      expect(store.droppedLogs, 2);
      expect(store.calls.map((c) => c.id), ['3', '4']);
      expect(store.droppedCalls, 3);
      // A response for an evicted request is ignored, not an error.
      store.ingest(
          buildNetResponse(id: '0', ts: 1, status: 200, headers: const []));
      expect(store.calls, hasLength(2));
    });

    test('the body budget drops the oldest bodies first, the calls stay', () {
      final store = newStore(maxBodyBytes: 25);
      store
          .ingest(req('1', body: pending('0123456789abcdef').toMessageValue()));
      store
          .ingest(req('2', body: pending('0123456789abcdef').toMessageValue()));
      expect(store.calls, hasLength(2));
      expect(store.calls.first.bodiesDropped, isTrue);
      expect(store.calls.first.requestBody, isNull);
      expect(store.calls.last.requestBody!.data, '0123456789abcdef');
      expect(store.bodyBytes, 16);
    });

    test('garbage never throws', () {
      final store = newStore();
      store
        ..ingest({kEncodedLineKey: '{not json'})
        ..ingest({'type': 'net.response', 'id': 'unknown', 'status': 'x'})
        ..ingest({'type': 'log', 'level': 3, 'message': null})
        ..ingest({'type': 42});
      expect(store.calls, isEmpty);
      expect(store.logs.single.message, '');
    });

    test('clear empties everything', () {
      final store = newStore()
        ..ingest(req('1'))
        ..ingest(buildLog(level: 'error', message: 'x'))
        ..ingest(buildMetric(fps: 60));
      store.clear();
      expect(store.calls, isEmpty);
      expect(store.logs, isEmpty);
      expect(store.lastMetric, isNull);
      expect(store.unseenErrors, 0);
    });
  });

  group('format', () {
    test('cURL repeats the request (quotes escaped, length/host left to curl)',
        () {
      final store = newStore();
      store.ingest(buildNetRequest(
        id: '1',
        ts: 0,
        method: 'POST',
        url: "https://api.example.com/users?q=o'neil",
        headers: const [
          ['Content-Type', 'application/json'],
          ['Content-Length', '15'],
          ['Authorization', 'Bearer abc']
        ],
        body: pending('{"name":"Ayşe"}'),
      ));
      expect(
        curlFor(store.calls.single),
        "curl -X POST 'https://api.example.com/users?q=o'\\''neil' \\\n"
        "  -H 'Content-Type: application/json' \\\n"
        "  -H 'Authorization: Bearer abc' \\\n"
        "  --data-raw '{\"name\":\"Ayşe\"}'",
      );
    });

    test('sizes, durations and JSON', () {
      expect(formatBytes(512), '512 B');
      expect(formatBytes(2048), '2.0 KB');
      expect(formatBytes(3 * 1024 * 1024), '3.0 MB');
      expect(formatDuration(const Duration(milliseconds: 87)), '87 ms');
      expect(formatDuration(const Duration(milliseconds: 1520)), '1.52 s');
      expect(formatDuration(null), '…');
      expect(
          prettyJsonText('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}');
      expect(prettyJsonText('plain text'), isNull);
    });
  });

  group('fed by the SDK, without a desktop', () {
    tearDown(Durbun.dispose);

    test('dart:io requests, logs and their bodies land in the store', () async {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero);
      DurbunInspectorStore.instance = store;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((r) async {
        await r.drain<void>();
        r.response
          ..statusCode = 201
          ..headers.contentType = ContentType.json
          ..write('{"id":7}');
        await r.response.close();
      });
      // Nothing listens on this port: the SDK keeps retrying in the background.
      final unused = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final deadPort = unused.port;
      await unused.close();

      await Durbun.init(DurbunOptions(
          enabled: true,
          port: deadPort,
          listenForUsb: false,
          useBackgroundIsolate: false,
          metrics: false));
      expect(store.attached, isTrue);
      Durbun.log('Kullanıcı giriş yaptı', tag: 'auth');

      final client = HttpClient();
      final request = await client
          .postUrl(Uri.parse('http://127.0.0.1:${server.port}/users'));
      request.headers.contentType = ContentType.json;
      request.write('{"name":"Ayşe"}');
      final response = await request.close();
      await response.drain<void>();
      client.close();

      await eventually(() =>
          store.calls.isNotEmpty &&
          store.calls.single.state == InspectorCallState.done);
      final call = store.calls.single;
      expect(call.method, 'POST');
      expect(call.status, 201);
      expect(call.source, 'dart:io');
      expect(call.requestBody!.data, '{"name":"Ayşe"}');
      expect(call.responseBody!.data, '{"id":7}');
      expect(
          store.logs.any(
              (l) => l.message == 'Kullanıcı giriş yaptı' && l.tag == 'auth'),
          isTrue);
      expect(Durbun.isConnected, isFalse);

      await Durbun.dispose();
      expect(store.attached, isFalse);
    });

    test('DurbunOptions(inspector: false) keeps nothing on the device',
        () async {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero);
      DurbunInspectorStore.instance = store;
      final unused = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final deadPort = unused.port;
      await unused.close();
      await Durbun.init(DurbunOptions(
          enabled: true,
          inspector: false,
          port: deadPort,
          listenForUsb: false,
          useBackgroundIsolate: false,
          metrics: false));
      Durbun.log('not kept');
      expect(store.attached, isFalse);
      expect(store.logs, isEmpty);
    });
  });

  group('device logs (logcat / os_log)', () {
    test('framework chatter stays out, the app and its SDKs stay in', () {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero);
      const tags = <String>[
        'VRI[MainActivity]@49a8a30',
        'ViewRootImpl@3f2a[MainActivity]',
        'SV[173170265 MainActivity]',
        'HWUI',
        'InsetsController',
        'com.apple.network',
        'NETMERA',
        'com.google.firebase',
        'FlutterGeolocator',
        'Foundation',
      ];
      for (final tag in tags) {
        store.ingestDeviceLog(jsonEncode(<String, Object?>{
          'type': 'log',
          'ts': 1700000000000,
          'level': 'info',
          'tag': tag,
          'message': 'from $tag',
        }));
      }
      store.ingestDeviceLog('not json');
      store.ingestDeviceLog('[1,2]');
      expect(store.logs.map((l) => l.tag),
          <String>['NETMERA', 'com.google.firebase', 'FlutterGeolocator', 'Foundation']);
      expect(store.logs.every((l) => l.native), isTrue);
    });
  });
}
