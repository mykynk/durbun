// Logs, events and dart:io HTTP from background isolates reach the SDK that
// runs in the main isolate.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:durbun/durbun.dart';
import 'package:flutter/foundation.dart' show compute;
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

/// Runs in a `compute` isolate (a closure would capture the test's server,
/// which cannot be sent to an isolate).
Future<bool> _fetchInWorker(String url) async {
  final ok = await Durbun.attachIsolate();
  final client = HttpClient();
  final req = await client.getUrl(Uri.parse(url));
  req.headers.set('authorization', 'Bearer s3cr3t');
  await (await req.close()).drain<void>();
  client.close();
  return ok;
}

/// In a background isolate: a WebSocket with dart:io's own shared client
/// (fresh in this isolate, so created through the attached capture), one
/// message before [control] says go and one after, then an event stream.
Future<bool> _streamsInWorker(List<Object> args) async {
  final base = args[0] as String;
  final control = args[1] as SendPort;
  final ok = await Durbun.attachIsolate();
  final go = ReceivePort();
  final ws = await WebSocket.connect('ws://$base/ws');
  final echoes = StreamIterator<Object?>(ws);
  ws.add('a');
  await echoes.moveNext();
  control.send(go.sendPort);
  await go.first;
  ws.add('b');
  await echoes.moveNext();
  await ws.close(1000);
  await echoes.cancel();
  final client = HttpClient();
  final res = await (await client.getUrl(Uri.parse('http://$base/sse'))).close();
  await res.drain<void>();
  client.close();
  return ok;
}

/// An event stream read in a background isolate.
Future<void> _sseInWorker(String base) async {
  await Durbun.attachIsolate();
  final client = HttpClient();
  final res = await (await client.getUrl(Uri.parse('http://$base/sse'))).close();
  await res.drain<void>();
  client.close();
}

void main() {
  test('without a running SDK, attaching an isolate says false and logging is a no-op', () async {
    final attached = await Isolate.run(() async {
      Durbun.log('nobody listens');
      return Durbun.attachIsolate();
    });
    expect(attached, isFalse);
  });

  group('with the SDK in the main isolate', () {
    late FakeDesktop desktop;
    late FakeSdkConnection conn;
    late HttpServer origin;

    setUp(() async {
      origin = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      origin.listen((req) async {
        req.response.headers.contentType = ContentType.json;
        req.response.write(jsonEncode(<String, Object?>{'path': req.uri.path}));
        await req.response.close();
      });
      desktop = await FakeDesktop.start();
      await Durbun.init(DurbunOptions(
        enabled: true,
        port: desktop.port,
        listenForUsb: false,
        useBackgroundIsolate: false,
        metrics: false,
        redactHeaders: const <String>['Authorization'],
      ));
      conn = await desktop.nextConnection();
    });

    tearDown(() async {
      await Durbun.dispose();
      await desktop.close();
      await origin.close(force: true);
    });

    test('Durbun.log and Durbun.event from Isolate.run need no setup', () async {
      await Isolate.run(() {
        Durbun.w('parsed 120 items', tag: 'feed', data: <String, Object?>{'items': 120});
        Durbun.e('bad item', error: const FormatException('id missing'));
        Durbun.event('feed.parsed', <String, Object?>{'ms': 42});
      });
      final log = await conn.waitForLog('parsed 120 items');
      expect(log['level'], 'warn');
      expect(log['tag'], 'feed');
      expect(log['data'], <String, Object?>{'items': 120});
      final err = await conn.waitForLog('bad item');
      expect((err['error']! as Map<String, Object?>)['message'], contains('id missing'));
      final event = await conn.waitFor((m) => m['type'] == 'event' && m['name'] == 'feed.parsed');
      expect(event['props'], <String, Object?>{'ms': 42});
    });

    test('attachIsolate captures the isolate\'s dart:io HTTP, with the main isolate\'s redaction', () async {
      final url = 'http://127.0.0.1:${origin.port}/feed';
      final attached = await compute(_fetchInWorker, url);
      expect(attached, isTrue);
      final request = await conn.waitFor((m) => m['type'] == 'net.request' && m['url'] == url);
      expect(request['id'], startsWith('isolate'));
      final headers = <String, String>{
        for (final h in request['headers']! as List<Object?>) ((h! as List<Object?>)[0]! as String).toLowerCase(): (h as List<Object?>)[1]! as String,
      };
      expect(headers['authorization'], '••••');
      final response = await conn.waitFor((m) => m['type'] == 'net.response' && m['id'] == request['id']);
      expect(response['status'], 200);
      expect((response['body']! as Map<String, Object?>)['data'], '{"path":"/feed"}');
    });

    test('in the main isolate attachIsolate is a no-op that says true', () async {
      expect(await Durbun.attachIsolate(), isTrue);
    });
  });

  group('stream messages from an attached isolate', () {
    late FakeDesktop desktop;
    late FakeSdkConnection conn;
    late HttpServer origin;

    setUp(() async {
      origin = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      origin.listen((req) async {
        if (req.uri.path == '/ws') {
          // Echo until the client closes (dart:io then closes this side).
          // ignore: close_sinks
          final ws = await WebSocketTransformer.upgrade(req);
          ws.listen(ws.add);
          return;
        }
        req.response
          ..headers.contentType = ContentType('text', 'event-stream')
          ..write('data: one\n\ndata: two\n\n');
        await req.response.close();
      });
      desktop = await FakeDesktop.start(config: <String, Object?>{
        ...FakeDesktop.defaultConfig(),
        'captureStreams': true,
        'maxStreamMessageBytes': 1024,
      });
      await Durbun.init(DurbunOptions(
        enabled: true,
        port: desktop.port,
        listenForUsb: false,
        useBackgroundIsolate: false,
        metrics: false,
      ));
      conn = await desktop.nextConnection();
    });

    tearDown(() async {
      await Durbun.dispose();
      await desktop.close();
      await origin.close(force: true);
    });

    test('travel like HTTP and follow a config change at once', () async {
      final control = ReceivePort();
      final base = '127.0.0.1:${origin.port}';
      final worker = compute(_streamsInWorker, <Object>[base, control.sendPort]);
      final go = await control.first as SendPort;
      final request = await conn.waitFor((m) => m['type'] == 'net.request' && '${m['url']}'.endsWith('/ws'));
      final id = request['id']! as String;
      expect(id, startsWith('isolate'));
      expect(request['url'], 'ws://$base/ws');
      await conn.waitForCount((m) => m['type'] == 'net.ws' && m['id'] == id, 2);
      // The desktop turns stream messages off; the isolate hears of it.
      conn.send(<String, Object?>{'type': 'config', 'config': FakeDesktop.defaultConfig()});
      await Future<void>.delayed(const Duration(milliseconds: 200));
      go.send(true);
      expect(await worker, isTrue);
      final sse = await conn.waitFor((m) => m['type'] == 'net.request' && '${m['url']}'.endsWith('/sse'));
      final sseEnd = await conn.waitForNetEnd(sse['id']! as String);
      expect((sseEnd['body']! as Map)['data'], contains('data: two'), reason: 'off: reported as before');
      final frames = conn.received.where((m) => m['type'] == 'net.ws' && m['id'] == id).toList();
      expect(frames.where((m) => m['opcode'] == 'text').map((m) => (m['body']! as Map)['data']), <String>['a', 'a']);
      expect(frames.where((m) => m['opcode'] == 'close').map((m) => m['dir']), contains('out'),
          reason: 'a started stream is finished after the setting went off');
      expect(conn.received.where((m) => m['type'] == 'net.sse'), isEmpty);
    });

    test('an event stream from an isolate while streams are on', () async {
      final base = '127.0.0.1:${origin.port}';
      await compute(_sseInWorker, base);
      final sse = await conn.waitFor((m) => m['type'] == 'net.request' && '${m['url']}'.endsWith('/sse'));
      final id = sse['id']! as String;
      final events = await conn.waitForCount((m) => m['type'] == 'net.sse' && m['id'] == id, 3);
      expect(events.map((m) => (m['body'] as Map?)?['data']), <Object?>['one', 'two', null]);
      expect(events.last['end'], isTrue);
      final response = conn.received.firstWhere((m) => m['type'] == 'net.response' && m['id'] == id);
      expect(response.containsKey('body'), isFalse);
    });
  });
}
