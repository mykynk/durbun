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

    Future<void> start({int maxBodyBytes = 1048576, bool streams = false}) async {
      desktop = await FakeDesktop.start(config: <String, Object?>{
        ...FakeDesktop.defaultConfig(maxBodyBytes: maxBodyBytes),
        if (streams) 'captureStreams': true,
        if (streams) 'maxStreamMessageBytes': 1024,
      });
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
    (http.Client, StreamController<List<int>>) streaming({int status = 200, String contentType = 'application/json'}) {
      final body = StreamController<List<int>>();
      addTearDown(() => unawaited(body.close()));
      final client = MockClient.streaming((request, _) async => http.StreamedResponse(body.stream, status,
          headers: <String, String>{'content-type': contentType}, reasonPhrase: 'OK', request: request));
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

    test('Server-Sent Events: one message per event while the Mac app asks for them', () async {
      await start(streams: true);
      while (!DurbunNetwork.capturesStreams) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      final (inner, body) = streaming(contentType: 'text/event-stream');
      final response = await DurbunReportingClient(inner).send(http.Request('GET', Uri.parse('https://api.example.com/live')));
      final read = response.stream.toBytes();
      body
        ..add(utf8.encode('event: score\ndata: 1-0\n\n'))
        ..add(utf8.encode('data: 2-0\n\n'));
      await body.close();
      expect(utf8.decode(await read), 'event: score\ndata: 1-0\n\ndata: 2-0\n\n', reason: 'the app reads the same bytes');
      final request = await conn.waitFor((m) => m['type'] == 'net.request');
      final messages = await conn.waitForCount((m) => m['id'] == request['id'], 5);
      expect(messages.map((m) => m['type']), <String>['net.request', 'net.response', 'net.sse', 'net.sse', 'net.sse']);
      expect(messages[1].containsKey('body'), isFalse);
      expect(messages[2]['event'], 'score');
      expect((messages[3]['body']! as Map)['data'], '2-0');
      expect(messages[4]['end'], isTrue);
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
