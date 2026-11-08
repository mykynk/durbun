// Queue memory while no desktop is in reach, and the peer-supplied config.
import 'dart:typed_data';

import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/core/transport/transport_core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

Map<String, Object?> response(int id, int bodyBytes) => buildNetResponse(
  id: '$id',
  ts: 1,
  status: 200,
  headers: const <List<String>>[],
  body: PendingBody(
    bytes: Uint8List(bodyBytes),
    size: bodyBytes,
    truncated: false,
    limit: 1 << 20,
    capture: true,
    contentType: 'image/png',
  ),
);

Uint8List bytesOf(Map<String, Object?> message) =>
    (message['body']! as Map)['bytes']! as Uint8List;

void main() {
  group('offline queue budget', () {
    TransportCore core({int offline = 300 * 1024, int graceMs = 30000}) => TransportCore(
      TransportConfig(
        endpoints: const <TransportEndpoint>[],
        maxBufferedBytes: 48 * 1024 * 1024,
        maxOfflineBufferedBytes: offline,
        offlineGraceMs: graceMs,
      ),
      (_) {},
    );

    test('before any desktop connected, image bodies stay within the small budget', () {
      final c = core();
      final sent = <Map<String, Object?>>[];
      for (var i = 0; i < 20; i++) {
        final m = response(i, 100 * 1024);
        sent.add(m);
        c.send(m);
      }
      expect(c.byteBudget, 300 * 1024);
      expect(c.queuedBytes, lessThanOrEqualTo(300 * 1024));
      expect(c.queueLength, 20, reason: 'the requests stay, only old bodies go');
      // The sender's maps are never touched: on a local engine the in-app
      // panel holds the very same objects.
      for (final m in sent) {
        expect(bytesOf(m).length, 100 * 1024);
      }
      c.stop();
    });

    test('a short outage keeps the full budget; after the grace period the queue shrinks', () async {
      final desktop = await FakeDesktop.start();
      final c = TransportCore(
        TransportConfig(
          endpoints: <TransportEndpoint>[TransportEndpoint('127.0.0.1', desktop.port)],
          maxOfflineBufferedBytes: 300 * 1024,
          offlineGraceMs: 300,
        ),
        (_) {},
      );
      addTearDown(c.stop);
      c
        ..setHello(buildHello(app: const {}, device: const {}, session: 's', capabilities: const [], actions: const []))
        ..start();
      final deadline = DateTime.now().add(const Duration(seconds: 5));
      while (!c.isConnected && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(c.isConnected, isTrue);
      expect(c.byteBudget, 48 * 1024 * 1024);
      await desktop.close();
      while (c.isConnected) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      for (var i = 0; i < 10; i++) {
        c.send(response(i, 100 * 1024));
      }
      expect(c.byteBudget, 48 * 1024 * 1024, reason: 'within the grace period');
      expect(c.queuedBytes, greaterThan(1000 * 1024));
      await Future<void>.delayed(const Duration(milliseconds: 450));
      expect(c.byteBudget, 300 * 1024);
      expect(c.queuedBytes, lessThanOrEqualTo(300 * 1024), reason: 'shrunk without a new send');
      expect(c.queueLength, 10);
    });

    test('the budget crosses the isolate boundary', () {
      final map = const TransportConfig(endpoints: <TransportEndpoint>[]).toMap();
      final back = TransportConfig.fromMap(map);
      expect(back.maxOfflineBufferedBytes, 8 * 1024 * 1024);
      expect(back.offlineGraceMs, 30000);
    });
  });

  group('SdkConfig from a peer', () {
    test('maxBodyBytes is clamped to the desktop maximum (10 MiB)', () {
      expect(SdkConfig.fromJson({'maxBodyBytes': 2e9}).maxBodyBytes, kMaxBodyBytesCeiling);
      expect(SdkConfig.fromJson({'maxBodyBytes': double.infinity}).maxBodyBytes, kMaxBodyBytesCeiling);
      expect(SdkConfig.fromJson({'maxBodyBytes': double.nan}).maxBodyBytes, SdkConfig.defaults.maxBodyBytes);
      expect(SdkConfig.fromJson({'maxBodyBytes': 4096}).maxBodyBytes, 4096);
      expect(SdkConfig.fromJson({'metricsIntervalMs': double.infinity}).metricsIntervalMs, 1000);
    });
  });
}
