// Logs, events and dart:io HTTP from background isolates reach the SDK that
// runs in the main isolate.
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
}
