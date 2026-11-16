// ignore_for_file: cancel_subscriptions, close_sinks
// The explicit stream wrappers for stacks dart:io does not carry:
// DurbunNetwork.webSocket and DurbunHttpCall.eventStream.
import 'dart:async';
import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

/// A sink like `WebSocketSink`: close takes a code and a reason.
class FakeWebSocketSink implements StreamSink<Object?> {
  final List<Object?> added = <Object?>[];
  int? closeCode;
  String? closeReason;
  bool closed = false;
  final Completer<void> _done = Completer<void>();

  @override
  void add(Object? event) => added.add(event);

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<Object?> stream) => stream.forEach(add);

  @override
  Future<void> close([int? code, String? reason]) {
    closed = true;
    closeCode = code;
    closeReason = reason;
    if (!_done.isCompleted) _done.complete();
    return _done.future;
  }

  @override
  Future<void> get done => _done.future;
}

Map<String, Object?> streamsConfig(bool on) => <String, Object?>{
  ...FakeDesktop.defaultConfig(),
  'captureStreams': on,
  'maxStreamMessageBytes': 1024,
};

void main() {
  late FakeDesktop desktop;
  late FakeSdkConnection conn;

  Future<void> setStreams(bool on) async {
    conn.send(<String, Object?>{'type': 'config', 'config': streamsConfig(on)});
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (DurbunNetwork.capturesStreams != on) {
      if (DateTime.now().isAfter(deadline)) throw TimeoutException('config not applied');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  setUp(() async {
    desktop = await FakeDesktop.start(config: streamsConfig(true));
    await Durbun.init(DurbunOptions(
      enabled: true,
      port: desktop.port,
      listenForUsb: false,
      useBackgroundIsolate: false,
      metrics: false,
      redactHeaders: const <String>['Authorization'],
    ));
    conn = await desktop.nextConnection();
    await setStreams(true);
  });

  tearDown(() async {
    await Durbun.dispose();
    await desktop.close();
  });

  List<Map<String, Object?>> of(String id) => conn.received.where((m) => m['id'] == id).toList();

  group('DurbunNetwork.webSocket', () {
    test('handshake, messages both ways and the close codes', () async {
      final ws = DurbunNetwork.webSocket(
        Uri.parse('https://chat.example.com/socket'),
        headers: const <List<String>>[<String>['Authorization', 'Bearer x']],
        protocols: const <String>['chat.v2'],
        source: 'cupertino',
      )!;
      final incoming = StreamController<Object?>();
      final inner = FakeWebSocketSink();
      final got = <Object?>[];
      final stream = ws.incoming(incoming.stream, closeInfo: () => (1000, 'görüşürüz'));
      final sub = stream.listen(got.add);
      final sink = ws.outgoing<Object?>(inner);
      ws.opened(protocol: 'chat.v2');
      sink.add('selam');
      incoming.add('selam geri');
      incoming.add(<int>[1, 2, 3]);
      await Future<void>.delayed(Duration.zero);
      await sink.close(1000, 'bye');
      await incoming.close();
      await sub.asFuture<void>();

      expect(inner.added, <Object?>['selam']);
      expect(inner.closeCode, 1000, reason: 'the code reached the WebSocket sink');
      expect(inner.closeReason, 'bye');
      expect(got, <Object?>['selam geri', <int>[1, 2, 3]]);

      final messages = await conn.waitForCount((m) => m['id'] == ws.id, 7);
      expect(messages.map((m) => m['type']), <String>[
        'net.request', 'net.response', 'net.ws', 'net.ws', 'net.ws', 'net.ws', 'net.ws',
      ]);
      final request = messages[0];
      expect(request['url'], 'wss://chat.example.com/socket');
      expect(request['source'], 'cupertino');
      final headers = <String, String>{for (final h in request['headers']! as List) (h as List)[0] as String: h[1] as String};
      expect(headers['Authorization'], '••••');
      expect(headers['sec-websocket-protocol'], 'chat.v2');
      expect(messages[1]['status'], 101);
      final frames = messages.skip(2).toList();
      expect(frames.map((m) => '${m['dir']} ${m['opcode']}'), <String>[
        'out text', 'in text', 'in binary', 'out close', 'in close',
      ]);
      expect((frames[1]['body']! as Map)['data'], 'selam geri');
      expect(base64Decode((frames[2]['body']! as Map)['data']! as String), <int>[1, 2, 3]);
      expect(frames[3]['closeCode'], 1000);
      expect(frames[4]['closeReason'], 'görüşürüz');
      expect(frames.every((m) => m['size'] is int), isTrue);
    });

    test('nothing is reported while the desktop does not take stream messages; '
        'the entry appears with the first message after it does', () async {
      await setStreams(false);
      final ws = DurbunNetwork.webSocket(Uri.parse('wss://chat.example.com/late'))!;
      ws
        ..opened()
        ..received('unseen')
        ..sent('unseen too');
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(of(ws.id), isEmpty);
      await setStreams(true);
      ws.received('seen');
      final messages = await conn.waitForCount((m) => m['id'] == ws.id, 3);
      expect(messages.map((m) => m['type']), <String>['net.request', 'net.response', 'net.ws']);
      expect((messages[2]['body']! as Map)['data'], 'seen');
    });

    test('a failed handshake is a failed request; an end without a code is a broken connection', () async {
      final refused = DurbunNetwork.webSocket(Uri.parse('wss://down.example.com/'))!..failed('Connection refused');
      final error = await conn.waitFor((m) => m['type'] == 'net.error' && m['id'] == refused.id);
      expect(error['error'], 'Connection refused');

      final ws = DurbunNetwork.webSocket(Uri.parse('wss://chat.example.com/drop'))!;
      final incoming = StreamController<Object?>();
      final sub = ws.incoming(incoming.stream, closeInfo: () => (null, null)).listen((_) {});
      incoming.add('hi');
      await incoming.close();
      await sub.asFuture<void>();
      final broken = await conn.waitFor((m) => m['type'] == 'net.error' && m['id'] == ws.id);
      expect(broken['error'], contains('without a close frame'));
    });
  });

  group('DurbunHttpCall.eventStream', () {
    test('headers at once, one message per event, the end', () async {
      final call = DurbunNetwork.begin(method: 'GET', url: Uri.parse('https://api.example.com/feed'), source: 'cronet')!;
      final events = call.eventStream(
        status: 200,
        headers: const <List<String>>[<String>['content-type', 'text/event-stream']],
      )!;
      final source = StreamController<List<int>>();
      final read = <int>[];
      final done = events.tap(source.stream).listen(read.addAll).asFuture<void>();
      source
        ..add(utf8.encode('event: tick\nid: 9\nda'))
        ..add(utf8.encode('ta: bir\n\ndata: iki\n\n'));
      await source.close();
      await done;
      expect(utf8.decode(read), 'event: tick\nid: 9\ndata: bir\n\ndata: iki\n\n');
      final messages = await conn.waitForCount((m) => m['id'] == call.id, 5);
      expect(messages.map((m) => m['type']), <String>['net.request', 'net.response', 'net.sse', 'net.sse', 'net.sse']);
      expect(messages[1].containsKey('body'), isFalse);
      expect(messages[2]['event'], 'tick');
      expect(messages[2]['eventId'], '9');
      expect((messages[3]['body']! as Map)['data'], 'iki');
      expect(messages[4]['end'], isTrue);
    });

    test('the app cancelling is net.error cancelled; off means null (report the body as usual)', () async {
      final call = DurbunNetwork.begin(method: 'GET', url: Uri.parse('https://api.example.com/live'))!;
      final events = call.eventStream(status: 200)!;
      final source = StreamController<List<int>>();
      final sub = events.tap(source.stream).listen((_) {});
      source.add(utf8.encode('data: x\n\n'));
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();
      final error = await conn.waitFor((m) => m['type'] == 'net.error' && m['id'] == call.id);
      expect(error['cancelled'], isTrue);

      await setStreams(false);
      final plain = DurbunNetwork.begin(method: 'GET', url: Uri.parse('https://api.example.com/old'))!;
      expect(plain.eventStream(status: 200), isNull);
    });
  });
}
