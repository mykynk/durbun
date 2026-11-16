// The transport queue and stream messages: gated by the latest config,
// dropped first under pressure, the messages that finish a stream kept.
import 'dart:async';

import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/core/transport/transport_core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

Map<String, Object?> ws(int n) => buildNetWs(id: '1', ts: 1, dir: 'in', opcode: 'text', size: n);
Map<String, Object?> close() => buildNetWs(id: '1', ts: 2, dir: 'out', opcode: 'close', size: 2, closeCode: 1000);
Map<String, Object?> log(String text) => buildLog(level: 'info', message: text);

Future<void> until(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 10));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  Map<String, Object?> config({bool? streams}) => <String, Object?>{
    ...FakeDesktop.defaultConfig(),
    if (streams != null) 'captureStreams': streams,
    'maxStreamMessageBytes': 1024,
  };

  test('before any desktop asked for them, stream messages are not even queued', () {
    final core = TransportCore(const TransportConfig(endpoints: <TransportEndpoint>[]), (_) {})
      ..send(ws(1))
      ..send(close())
      ..send(log('kept'));
    expect(core.queueLength, 1);
    core.stop();
  });

  /// Connects to a desktop with [first], drops it, queues [messages] while
  /// offline, reconnects to one with [second]; returns what it received.
  Future<List<Map<String, Object?>>> offlineRun(
    List<Map<String, Object?>> messages, {
    required Map<String, Object?> first,
    required Map<String, Object?> second,
    int maxBuffered = 10,
  }) async {
    var desktop = await FakeDesktop.start(config: first);
    final port = desktop.port;
    final core = TransportCore(
      TransportConfig(
        endpoints: <TransportEndpoint>[TransportEndpoint('127.0.0.1', port)],
        maxBufferedMessages: maxBuffered,
        minBackoffMs: 50,
        maxBackoffMs: 100,
      ),
      (_) {},
    );
    addTearDown(core.stop);
    core
      ..setHello(buildHello(app: const {}, device: const {}, session: 's', capabilities: const [], actions: const []))
      ..start();
    await until(() => core.isConnected);
    await desktop.close();
    await until(() => !core.isConnected);
    messages.forEach(core.send);
    desktop = await FakeDesktop.start(port: port, config: second);
    addTearDown(desktop.close);
    final conn = await desktop.nextConnection();
    await conn.waitFor((m) => m['type'] == 'log' && m['message'] == 'last');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    return conn.received.where((m) => m['type'] != 'hello').toList();
  }

  test('under pressure the oldest stream messages go first; requests, logs and closes stay', () async {
    final request = buildNetRequest(id: '1', ts: 0, method: 'GET', url: 'ws://x/', headers: const []);
    final got = await offlineRun(
      <Map<String, Object?>>[request, for (var i = 0; i < 20; i++) ws(i), close(), log('last')],
      first: config(streams: true),
      second: config(streams: true),
    );
    expect(got.first['type'], 'net.request');
    final frames = got.where((m) => m['type'] == 'net.ws').toList();
    expect(frames.where((m) => m['opcode'] == 'text').map((m) => m['size']), <int>[13, 14, 15, 16, 17, 18, 19]);
    expect(frames.last['opcode'], 'close');
    expect(got.where((m) => m['type'] == 'log').map((m) => m['message']), contains('last'));
  });

  test('a desktop that turned streams off still gets the closes; an older one gets no stream message', () async {
    final off = await offlineRun(
      <Map<String, Object?>>[ws(1), close(), log('last')],
      first: config(streams: true),
      second: config(streams: false),
    );
    expect(off.where((m) => m['type'] == 'net.ws').map((m) => m['opcode']), <String>['close']);
    final older = await offlineRun(
      <Map<String, Object?>>[ws(1), close(), log('last')],
      first: config(streams: true),
      second: config(),
    );
    expect(older.where((m) => m['type'] == 'net.ws'), isEmpty);
    expect(older.where((m) => m['type'] == 'log').map((m) => m['message']), contains('last'));
  });
}
