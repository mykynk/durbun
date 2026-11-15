import 'dart:async';
import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/flutter/durbun.dart' show durbunBackend;
import 'package:durbun/src/inspector/panel_prefs_io.dart' show debugPanelPrefsDir, debugResetPanelPrefs;
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/widgets.dart' show DButton;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

Widget sdkApp() => MaterialApp(
      locale: const Locale('en'),
      builder: DurbunInspector.builder,
      home: const Scaffold(body: Center(child: Text('the app'))),
    );

Future<void> phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

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

/// Starts the SDK against [port] (nothing there unless a fake desktop is).
Future<void> startSdk(WidgetTester tester, int port) async {
  await tester.runAsync(() async {
    DurbunInspectorStore.instance = DurbunInspectorStore(notifyDelay: Duration.zero);
    await Durbun.init(DurbunOptions(
        enabled: true, port: port, listenForUsb: false, useBackgroundIsolate: false, metrics: false, captureNetwork: false));
  });
}

Future<void> stopSdk(WidgetTester tester) async {
  await tester.runAsync(Durbun.dispose);
  await tester.pump(const Duration(milliseconds: 250));
}

/// Lets real file and socket work finish while the test clock stands still.
Future<void> settleIo(WidgetTester tester, {int rounds = 12}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump();
  }
}

void main() {
  testWidgets('show() without the SDK opens a page that says why and what to do', (tester) async {
    await phone(tester);
    await tester.pumpWidget(sdkApp());
    expect(durbunBackend().startState.name, 'notStarted');
    DurbunInspector.show();
    await tester.pumpAndSettle();
    expect(find.text('Dürbün has not started'), findsOneWidget);
    expect(find.textContaining('Durbun.run or Durbun.init'), findsOneWidget);
    expect(find.byTooltip('Copy'), findsOneWidget, reason: 'the copy button in the snippet\'s corner');
    await tester.tap(find.widgetWithText(DButton, 'Close'));
    await tester.pumpAndSettle();
    expect(find.text('Dürbün has not started'), findsNothing);
    expect(find.text('the app'), findsOneWidget);
  });

  testWidgets('Mac connection: the failure explained, a bad address refused, a good one connects and is forgotten',
      (tester) async {
    await phone(tester);
    final port = await tester.runAsync(deadPort);
    late FakeDesktop desktop;
    await tester.runAsync(() async => desktop = await FakeDesktop.start(appId: 'app:panel-host'));
    await startSdk(tester, port!);
    await tester.pumpWidget(sdkApp());
    await tester.runAsync(() => eventually(() => durbunBackend().connectionReport?.attempts.isNotEmpty ?? false));
    DurbunInspector.show();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Tools').first);
    await tester.pumpAndSettle();
    expect(find.text('Mac connection'), findsOneWidget);
    expect(find.text('App tools'), findsOneWidget);
    await tester.tap(find.text('Mac connection'));
    await tester.pumpAndSettle();
    expect(find.text('The Dürbün desktop is not open'), findsOneWidget);
    expect(find.textContaining('127.0.0.1:$port'), findsOneWidget, reason: 'the attempt is listed');

    final field = find.byKey(const ValueKey<String>('durbun-mac-address'));
    await tester.enterText(field, 'my mac');
    await tester.tap(find.text('Connect'));
    await tester.pump();
    expect(find.text('Enter an IP address or name, e.g. 192.168.1.20'), findsOneWidget);
    await tester.enterText(field, '127.0.0.1:99999');
    await tester.tap(find.text('Connect'));
    await tester.pump();
    expect(find.text('The port must be a number from 1 to 65535'), findsOneWidget);

    await tester.enterText(field, 'http://127.0.0.1:${desktop.port}/');
    await tester.tap(find.text('Connect'));
    await tester.pump();
    await tester.runAsync(() => eventually(() => Durbun.isConnected));
    await tester.pumpAndSettle();
    expect(find.text('127.0.0.1:${desktop.port}'), findsOneWidget, reason: 'the cleaned address stays in the field');
    expect(find.text('Forget the address'), findsOneWidget, reason: 'no build address: the reset forgets');
    expect(find.text('The Dürbün desktop is not open'), findsNothing);

    await tester.tap(find.text('Forget the address'));
    await tester.pump();
    await tester.runAsync(() => eventually(() => !Durbun.isConnected));
    await tester.pumpAndSettle();
    expect(find.text('Forget the address'), findsNothing);
    expect(durbunBackend().connectionReport?.lanFromPanel, isFalse);

    await tester.runAsync(desktop.close);
    await stopSdk(tester);
  });

  testWidgets('App tools: the app’s own controls work from the panel', (tester) async {
    await phone(tester);
    var cleared = 0;
    var flag = false;
    Durbun.addAction(DurbunAction.button(id: 'app.clearCache', label: 'Clear cache', onPressed: (_) {
      cleared++;
      return 'ok';
    }));
    Durbun.addAction(DurbunAction.toggle(id: 'app.flag', label: 'New checkout', value: () => flag, onChanged: (v) => flag = v));
    addTearDown(() {
      Durbun.removeAction('app.clearCache');
      Durbun.removeAction('app.flag');
    });
    final port = await tester.runAsync(deadPort);
    await startSdk(tester, port!);
    await tester.pumpWidget(sdkApp());
    DurbunInspector.show();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Tools').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('App tools'));
    await tester.pumpAndSettle();
    expect(find.text('Clear cache'), findsOneWidget);
    expect(find.text('New checkout'), findsOneWidget);

    await tester.tap(find.byType(Switch).first);
    await settleIo(tester, rounds: 3);
    expect(flag, isTrue);
    expect(tester.widget<Switch>(find.byType(Switch).first).value, isTrue);

    await tester.tap(find.text('Clear cache'));
    await tester.pumpAndSettle();
    expect(find.text('Run “Clear cache”?'), findsOneWidget, reason: 'the app’s own buttons ask first');
    await tester.tap(find.text('Run'));
    await settleIo(tester, rounds: 3);
    expect(cleared, 1);
    expect(find.text('Clear cache: ok'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await stopSdk(tester);
  });

  testWidgets('the shake hint shows once per install', (tester) async {
    await phone(tester);
    final dir = Directory.systemTemp.createTempSync('durbun-prefs-test');
    debugPanelPrefsDir = dir.path;
    debugResetPanelPrefs();
    DurbunInspector.debugResetOnce();
    addTearDown(() {
      debugPanelPrefsDir = null;
      DurbunInspector.debugResetOnce();
      dir.deleteSync(recursive: true);
    });
    final port = await tester.runAsync(deadPort);
    await startSdk(tester, port!);
    await tester.pumpWidget(sdkApp());
    final hint = find.byKey(const ValueKey<String>('durbun-shake-hint'));
    expect(hint, findsNothing);
    await tester.pump(const Duration(seconds: 2));
    await settleIo(tester);
    expect(hint, findsOneWidget);
    expect(find.text('Shake the phone to open the Dürbün panel'), findsOneWidget);
    expect(File('${dir.path}/shake-hint-shown').existsSync(), isTrue);
    await tester.pump(const Duration(seconds: 8));
    expect(hint, findsNothing, reason: 'it goes by itself');

    // Next launch: kept, so not again.
    await tester.pumpWidget(const SizedBox());
    DurbunInspector.debugResetOnce();
    await tester.pumpWidget(sdkApp());
    await tester.pump(const Duration(seconds: 2));
    await settleIo(tester);
    expect(hint, findsNothing);

    await stopSdk(tester);
  });
}
