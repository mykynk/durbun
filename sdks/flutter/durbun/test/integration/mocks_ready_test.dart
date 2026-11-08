// Start-up requests and the desktop's mock rules: requests wait only while a
// desktop has accepted the connection and its welcome is on the way.
import 'dart:async';
import 'dart:io';

import 'package:durbun/durbun_core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

Future<void> eventually(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 10));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

void main() {
  late HttpServer origin;

  setUp(() async {
    origin = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    origin.listen((req) async {
      req.response.write('real');
      await req.response.close();
    });
  });

  tearDown(() => origin.close(force: true));

  Future<(int, Duration)> get(String path) async {
    final watch = Stopwatch()..start();
    final c = HttpClient();
    final res = await (await c.getUrl(Uri.parse('http://127.0.0.1:${origin.port}$path'))).close();
    await res.drain<void>();
    c.close();
    return (res.statusCode, watch.elapsed);
  }

  test('no desktop: the first requests are not delayed', () async {
    // The hello is still held back (as while the plugin's native layer
    // starts) and nothing listens on the desktop port.
    final client = DurbunClient.start(
      DurbunOptions(enabled: true, port: await freePort(), useBackgroundIsolate: false),
      helloGate: Completer<void>().future,
    );
    addTearDown(client.dispose);
    expect(client.mocksReady, isNull);
    final (status, took) = await get('/early');
    expect(status, 200);
    // It used to wait up to 800 ms (3 s with DURBUN_HOST) for a desktop.
    expect(took, lessThan(const Duration(milliseconds: 300)));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    final (_, again) = await get('/early-2');
    expect(again, lessThan(const Duration(milliseconds: 300)));
  });

  test('a desktop mid-handshake: the request waits for its mock rules', () async {
    final rule = <String, Object?>{
      'id': 'early-mock',
      'enabled': true,
      'method': 'GET',
      'url': '/mocked-at-start',
      'match': 'contains',
      'action': <String, Object?>{'type': 'respond', 'status': 299, 'body': 'mocked'},
      'createdAt': 1,
    };
    final desktop = await FakeDesktop.start(autoWelcome: false, mocks: [rule]);
    addTearDown(desktop.close);
    final client = DurbunClient.start(
      DurbunOptions(enabled: true, port: desktop.port, useBackgroundIsolate: false),
    );
    addTearDown(client.dispose);
    final conn = await desktop.nextConnection();
    await eventually(() => client.mocksReady != null);
    final pending = get('/mocked-at-start');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    conn.sendWelcome();
    final (status, _) = await pending;
    expect(status, 299);
    expect(client.mocksReady, isNull, reason: 'connected: nothing waits any more');
  });
}
