// Screen changes, lifecycle lines and the body options set from code.
import 'dart:async';

import 'package:durbun/durbun.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

Future<void> eventually(bool Function() condition, {Duration timeout = const Duration(seconds: 10)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  group('body options', () {
    tearDown(Durbun.dispose);

    test('maxBodyBytes and captureBodies apply before any desktop, capped at 10 MiB', () async {
      final port = await freePort();
      await Durbun.init(DurbunOptions(
        enabled: true,
        port: port,
        maxBodyBytes: 3 * 1024 * 1024,
        useBackgroundIsolate: false,
      ));
      expect(DurbunNetwork.maxBodyBytes, 3 * 1024 * 1024);
      expect(DurbunNetwork.captureBodies, isTrue);
      await Durbun.dispose();

      await Durbun.init(DurbunOptions(
        enabled: true,
        port: port,
        maxBodyBytes: 50 * 1024 * 1024,
        captureBodies: false,
        useBackgroundIsolate: false,
      ));
      expect(DurbunNetwork.maxBodyBytes, 10 * 1024 * 1024);
      expect(DurbunNetwork.captureBodies, isFalse);
    });

    test('the desktop limit wins once it connects; captureBodies: false holds', () async {
      final desktop = await FakeDesktop.start(
        config: FakeDesktop.defaultConfig(maxBodyBytes: 2048),
      );
      addTearDown(desktop.close);
      await Durbun.init(DurbunOptions(
        enabled: true,
        port: desktop.port,
        maxBodyBytes: 5 * 1024 * 1024,
        captureBodies: false,
        useBackgroundIsolate: false,
      ));
      await desktop.nextConnection();
      await eventually(() => Durbun.isConnected);
      await eventually(() => DurbunNetwork.maxBodyBytes == 2048);
      expect(DurbunNetwork.captureBodies, isFalse, reason: 'the desktop asked for bodies; the app said never');
    });
  });

  testWidgets('screen changes and lifecycle lines reach the desktop', (tester) async {
    late FakeDesktop desktop;
    late FakeSdkConnection conn;
    await tester.runAsync(() async {
      desktop = await FakeDesktop.start(appId: 'app:screens');
      await Durbun.init(DurbunOptions(
        enabled: true,
        port: desktop.port,
        captureNetwork: false,
        metrics: false,
        useBackgroundIsolate: false,
      ));
      conn = await desktop.nextConnection();
      await eventually(() => Durbun.isConnected);
    });
    final observer = DurbunNavigatorObserver();
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navigator,
      navigatorObservers: [observer],
      routes: {
        '/': (_) => const Text('home'),
        '/details': (_) => const Text('details'),
      },
    ));
    unawaited(navigator.currentState!.pushNamed('/details'));
    await tester.pumpAndSettle();
    // A dialog and an unnamed page do not change the reported screen.
    unawaited(showDialog<void>(context: navigator.currentContext!, builder: (_) => const Text('dialog')));
    await tester.pumpAndSettle();
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
    unawaited(navigator.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Text('unnamed'))));
    await tester.pumpAndSettle();
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
    expect(observer.currentScreen, '/');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);

    await tester.runAsync(() async {
      final events = await conn.waitForCount((m) => m['type'] == 'event' && m['name'] == 'navigation', 3);
      expect(events.map((e) => e['props']).toList(), [
        {'to': '/'},
        {'from': '/', 'to': '/details'},
        {'from': '/details', 'to': '/'},
      ]);
      await conn.waitForLog('AppLifecycleState.resumed');
      final lines = conn.ofType('log').where((m) => m['tag'] == 'lifecycle').map((m) => m['message']).toList();
      expect(lines, containsAllInOrder(<String>[
        'AppLifecycleState.paused',
        'AppLifecycleState.resumed',
      ]));
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(
        conn.ofType('event').where((m) => m['name'] == 'navigation'),
        hasLength(3),
        reason: 'no event for the dialog or the unnamed page',
      );
      await Durbun.dispose();
      await desktop.close();
    });
    // The in-app panel's store batches its change notices.
    await tester.pump(const Duration(milliseconds: 300));
  });
}
