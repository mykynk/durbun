// Reconnect pacing while no desktop answers: fast at first, slow when idle,
// none in the background, at once on foreground / new address / retry.
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/core/transport/transport_core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

Map<String, Object?> hello() => buildHello(
  app: const {},
  device: const {},
  session: 's',
  capabilities: const [],
  actions: const [],
);

void main() {
  late int refusedPort;

  setUpAll(() async => refusedPort = await freePort());

  /// A core that only ever meets a refused port; [rounds] counts failed rounds.
  (TransportCore, List<int>) start({
    int idleAfterMs = 200,
    int idleMaxBackoffMs = 400,
  }) {
    final rounds = <int>[];
    final clock = Stopwatch()..start();
    final core = TransportCore(
      TransportConfig(
        endpoints: <TransportEndpoint>[TransportEndpoint('127.0.0.1', refusedPort)],
        minBackoffMs: 10,
        maxBackoffMs: 40,
        idleAfterMs: idleAfterMs,
        idleMaxBackoffMs: idleMaxBackoffMs,
      ),
      (event) {
        if (event.first == TransportEvents.roundFailed) rounds.add(clock.elapsedMilliseconds);
      },
    );
    addTearDown(core.stop);
    core
      ..setHello(hello())
      ..start();
    return (core, rounds);
  }

  Future<void> until(bool Function() test, {int ms = 3000}) async {
    final deadline = DateTime.now().add(Duration(milliseconds: ms));
    while (!test() && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  test('rounds slow down after the idle time, within the bound and jitter', () async {
    final (core, rounds) = start();
    await until(() => core.debugBackoffMs > 40);
    expect(core.debugBackoffMs, greaterThan(40), reason: 'past the fast backoff once idle');
    await Future<void>.delayed(const Duration(milliseconds: 1200));
    expect(core.debugBackoffMs, inInclusiveRange(10, 480), reason: 'never past idleMax + 20 %');
    final n = rounds.length;
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(rounds.length - n, lessThanOrEqualTo(2), reason: 'no 3 s-style hammering when idle');
  });

  test('no rounds in the background; at once and fast again in the foreground', () async {
    final (core, rounds) = start();
    await until(() => core.debugBackoffMs > 40);
    core.setBackground(true);
    expect(core.debugInBackground, isTrue);
    await Future<void>.delayed(const Duration(milliseconds: 600));
    final before = rounds.length;
    await Future<void>.delayed(const Duration(milliseconds: 600));
    expect(rounds.length, before, reason: 'nothing while the app is in the background');
    core.setBackground(false);
    await until(() => rounds.length > before, ms: 200);
    expect(rounds.length, greaterThan(before), reason: 'a round right after coming back');
    expect(core.debugBackoffMs, lessThanOrEqualTo(40), reason: 'fast backoff again');
  });

  test('retryNow ends a long wait and a desktop that appears is reached at once', () async {
    final (core, rounds) = start(idleAfterMs: 0, idleMaxBackoffMs: 60000);
    await until(() => core.debugBackoffMs > 1000);
    expect(core.debugBackoffMs, greaterThan(1000));
    final desktop = await FakeDesktop.start();
    addTearDown(desktop.close);
    core.setEndpoints(<TransportEndpoint>[TransportEndpoint('127.0.0.1', desktop.port)]);
    await until(() => core.isConnected, ms: 1000);
    expect(core.isConnected, isTrue, reason: 'a new address is tried at once');
    expect(rounds, isNotEmpty);
  });

  test('retryNow wakes the loop without waiting for the current sleep', () async {
    final (core, rounds) = start(idleAfterMs: 0, idleMaxBackoffMs: 60000);
    await until(() => core.debugBackoffMs > 1000);
    final before = rounds.length;
    core.retryNow();
    await until(() => rounds.length > before, ms: 300);
    expect(rounds.length, greaterThan(before));
  });

  test('the pacing settings cross the isolate boundary', () {
    const config = TransportConfig(
      endpoints: <TransportEndpoint>[],
      idleAfterMs: 1234,
      idleMaxBackoffMs: 5678,
    );
    final copy = TransportConfig.fromMap(config.toMap());
    expect(copy.idleAfterMs, 1234);
    expect(copy.idleMaxBackoffMs, 5678);
    const defaults = TransportConfig(endpoints: <TransportEndpoint>[]);
    expect(defaults.idleAfterMs, 120000);
    expect(defaults.idleMaxBackoffMs, 30000);
  });
}
