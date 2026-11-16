// The README's copy-paste wrapper for package:http clients Dürbün cannot see
// by itself (CronetClient, OkHttpClient): it must report every request and
// leave the response streaming, chunk by chunk, with back-pressure.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../support/fake_desktop.dart';
import '../support/reporting_client.dart';

void main() {
  test('the README shows exactly the tested wrapper', () {
    final readme = File('README.md').readAsStringSync();
    final blocks = RegExp(r'```dart\n([\s\S]*?)```').allMatches(readme).map((m) => m.group(1)!);
    final shown = blocks.firstWhere((b) => b.contains('class DurbunReportingClient'), orElse: () => '');
    expect(shown.trim(), File('test/support/reporting_client.dart').readAsStringSync().trim());
  });

  group('DurbunReportingClient', () {
    late FakeDesktop desktop;
    late FakeSdkConnection conn;

    Future<void> start({int maxBodyBytes = 1048576}) async {
      desktop = await FakeDesktop.start(config: FakeDesktop.defaultConfig(maxBodyBytes: maxBodyBytes));
      await Durbun.init(DurbunOptions(
          enabled: true, port: desktop.port, listenForUsb: false, useBackgroundIsolate: false, metrics: false));
      conn = await desktop.nextConnection();
      final deadline = DateTime.now().add(const Duration(seconds: 10));
      while (DurbunNetwork.maxBodyBytes != maxBodyBytes) {
        if (DateTime.now().isAfter(deadline)) fail('the desktop config never arrived');
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    }

    tearDown(() async {
      await Durbun.dispose();
      await desktop.close();
    });

    /// An inner client whose body the test feeds by hand.
    (http.Client, StreamController<List<int>>) streaming({int status = 200}) {
      final body = StreamController<List<int>>();
      addTearDown(() => unawaited(body.close()));
      final client = MockClient.streaming((request, _) async => http.StreamedResponse(body.stream, status,
          headers: <String, String>{'content-type': 'application/json'}, reasonPhrase: 'OK', request: request));
      return (client, body);
    }

    test('chunks reach the app before the body ends; the report follows the end', () async {
      await start();
      final (inner, body) = streaming();
      final client = DurbunReportingClient(inner);
      final response = await client.send(http.Request('GET', Uri.parse('https://api.example.com/v1/feed?page=1')));
      final request = await conn.waitFor((m) => m['type'] == 'net.request');
      expect(request['url'], 'https://api.example.com/v1/feed?page=1');
      expect(request['source'], 'cronet');

      final got = <List<int>>[];
      final done = Completer<void>();
      response.stream.listen(got.add, onDone: done.complete);
      body.add(utf8.encode('{"items":['));
      await pumpEventQueue();
      expect(got, hasLength(1), reason: 'the first chunk is delivered while the body is still open');
      expect(conn.ofType('net.response'), isEmpty);

      body.add(utf8.encode('1,2]}'));
      await body.close();
      await done.future;
      final end = await conn.waitFor((m) => m['type'] == 'net.response');
      expect(end['id'], request['id']);
      expect(end['status'], 200);
      expect(end['body'], <String, Object?>{'encoding': 'utf8', 'data': '{"items":[1,2]}', 'size': 15});
    });

    test('only the first maxBodyBytes are copied; the app gets every byte', () async {
      await start(maxBodyBytes: 8);
      final (inner, body) = streaming();
      final response = await DurbunReportingClient(inner).send(http.Request('GET', Uri.parse('https://cdn.example.com/big.bin')));
      final read = response.stream.toBytes();
      for (var i = 0; i < 5; i++) {
        body.add(List<int>.filled(4, 0x61 + i));
      }
      await body.close();
      expect((await read).length, 20);
      final end = await conn.waitFor((m) => m['type'] == 'net.response');
      final b = end['body']! as Map<String, Object?>;
      expect(b['data'], 'aaaabbbb');
      expect(b['size'], 20);
      expect(b['truncated'], isTrue);
    });

    test('a body the app stops reading is reported as cancelled; a failing one as an error', () async {
      await start();
      final (inner, body) = streaming();
      final response = await DurbunReportingClient(inner).send(http.Request('GET', Uri.parse('https://api.example.com/stream')));
      final sub = response.stream.listen((_) {});
      body.add(<int>[1, 2, 3]);
      await pumpEventQueue();
      await sub.cancel();
      final cancelled = await conn.waitFor((m) => m['type'] == 'net.error');
      expect(cancelled['cancelled'], isTrue);

      final (inner2, body2) = streaming();
      final failing = await DurbunReportingClient(inner2).send(http.Request('GET', Uri.parse('https://api.example.com/broken')));
      final failed = failing.stream.toBytes();
      body2.addError(const SocketException('Connection reset by peer'));
      await expectLater(failed, throwsA(isA<SocketException>()));
      final errors = await conn.waitForCount((m) => m['type'] == 'net.error', 2);
      expect(errors.last['error'], contains('Connection reset by peer'));
      expect(errors.last['cancelled'], isNull);
    });

    test('a request that fails before any response is reported as an error', () async {
      await start();
      final inner = MockClient((_) async => throw const SocketException('Failed host lookup'));
      await expectLater(
          DurbunReportingClient(inner).send(http.Request('POST', Uri.parse('https://api.example.com/login'))..body = '{}'),
          throwsA(isA<SocketException>()));
      final e = await conn.waitFor((m) => m['type'] == 'net.error');
      expect(e['error'], contains('Failed host lookup'));
    });
  });
}
