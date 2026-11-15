import 'dart:async';
import 'dart:io';

import 'package:durbun/durbun_core.dart';
import 'package:durbun/src/core/connection_report.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

Future<void> eventually(bool Function() condition, {Duration timeout = const Duration(seconds: 10)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

Future<int> deadPort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = s.port;
  await s.close();
  return port;
}

DurbunOptions options(int port, {required bool isolate}) => DurbunOptions(
      enabled: true,
      port: port,
      appId: 'com.example.durbun_test',
      appName: 'Dürbün Test',
      listenForUsb: false,
      captureNetwork: false,
      metrics: false,
      useBackgroundIsolate: isolate,
    );

void main() {
  for (final isolate in <bool>[true, false]) {
    final mode = isolate ? 'background isolate' : 'same isolate';

    group('connection report ($mode)', () {
      DurbunClient? client;
      FakeDesktop? desktop;

      tearDown(() async {
        await client?.dispose();
        client = null;
        await desktop?.close();
        desktop = null;
      });

      test('a failed round says what was tried and why', () async {
        final port = await deadPort();
        final c = client = DurbunClient.start(options(port, isolate: isolate));
        var notified = 0;
        c.addReportListener(() => notified++);
        await eventually(() => c.connectionReport.attempts.isNotEmpty);
        final r = c.connectionReport;
        expect(r.connected, isFalse);
        expect(r.attempts.first.endpoint, '127.0.0.1:$port');
        expect(r.attempts.first.kind, 'refused');
        // This host is a desktop computer: nothing listens on the port.
        expect(r.issue, ConnectIssue.desktopNotRunning);
        expect(r.lanEndpoint, isNull);
        expect(r.lanFromPanel, isFalse);
        expect(notified, greaterThan(0));
      });

      test('an address set at run time is tried at once, and null goes back', () async {
        final port = await deadPort();
        final d = desktop = await FakeDesktop.start(appId: 'app:panel');
        final c = client = DurbunClient.start(options(port, isolate: isolate));
        await eventually(() => c.connectionReport.attempts.isNotEmpty);

        c.setDesktopHost('127.0.0.1:${d.port}');
        expect(c.panelHost, '127.0.0.1:${d.port}');
        var r = c.connectionReport;
        expect(r.trying, isTrue, reason: 'the first round with the new address has not ended');
        expect(r.attempts, isEmpty);
        expect(r.lanFromPanel, isTrue);
        expect(r.lanEndpoint, '127.0.0.1:${d.port}');

        await d.nextConnection();
        await eventually(() => c.connectionReport.connected);
        r = c.connectionReport;
        expect(r.via, contains('${d.port}'));
        expect(r.issue, isNull);
        expect(r.everConnected, isTrue);

        // Back to the build's address (none): the Wi-Fi link closes.
        c.setDesktopHost(null);
        await eventually(() => !c.connectionReport.connected);
        await eventually(() => c.connectionReport.attempts.isNotEmpty);
        r = c.connectionReport;
        expect(r.lanFromPanel, isFalse);
        expect(r.lanEndpoint, isNull);
        expect(r.attempts.map((a) => a.endpoint), isNot(contains('127.0.0.1:${d.port}')));
      });

      test('a wrong run-time address is diagnosed on its own attempt', () async {
        final port = await deadPort();
        final other = await deadPort();
        final c = client = DurbunClient.start(options(port, isolate: isolate));
        c.setDesktopHost('127.0.0.1:$other');
        await eventually(() => c.connectionReport.attempts.length >= 2);
        final r = c.connectionReport;
        expect(r.issue, ConnectIssue.lanRefused);
        expect(r.attempts.map((a) => a.endpoint), contains('127.0.0.1:$other'));
      });
    });
  }

  group('actions from the panel', () {
    DurbunClient? client;
    FakeDesktop? desktop;

    tearDown(() async {
      await client?.dispose();
      client = null;
      await desktop?.close();
      desktop = null;
    });

    test('button, toggle and select run here and the desktop sees the new values', () async {
      final d = desktop = await FakeDesktop.start(appId: 'app:actions');
      final c = client = DurbunClient.start(options(d.port, isolate: false));
      var pressed = 0;
      var on = false;
      var env = 'prod';
      c.addActions(<DurbunAction>[
        DurbunAction.button(id: 'app.clear', label: 'Clear cache', onPressed: (_) {
          pressed++;
          return 'cleared';
        }),
        DurbunAction.toggle(id: 'app.flag', label: 'Flag', value: () => on, onChanged: (v) => on = v),
        DurbunAction.select(
          id: 'app.env',
          label: 'Environment',
          options: const <DurbunActionOption>[
            DurbunActionOption('prod', 'Prod'),
            DurbunActionOption('staging', 'Staging'),
          ],
          value: () => env,
          onChanged: (v) => env = v,
        ),
        DurbunAction.button(id: 'app.fail', label: 'Fail', onPressed: (_) => throw StateError('nope')),
      ]);
      final conn = await d.nextConnection();
      expect(await c.waitForConnection(const Duration(seconds: 5)), isTrue);

      expect(await c.runAction('app.clear'), 'cleared');
      expect(pressed, 1);
      await c.runAction('app.flag', <String, Object?>{'value': true});
      expect(on, isTrue);
      await c.runAction('app.env', <String, Object?>{'value': 'staging'});
      expect(env, 'staging');
      await expectLater(c.runAction('app.fail'), throwsA(isA<StateError>()));
      await expectLater(c.runAction('nope.unknown'), throwsArgumentError);

      final described = {for (final a in c.describeActions()) a['id']: a};
      expect(described['app.flag']!['value'], isTrue);
      expect(described['app.env']!['value'], 'staging');
      await eventually(() => conn.received.any((m) =>
          m['type'] == 'actions' &&
          (m['actions'] as List).any((a) => a is Map && a['id'] == 'app.env' && a['value'] == 'staging')));
    });
  });
}
