import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/filter_ui.dart' show ActiveChip;
import 'package:durbun/src/inspector/inspector.dart' show InspectorBubble;
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody pending(String text) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: 'application/json');
}

DurbunInspectorStore filledStore() {
  final store = DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;
  store
    ..ingest(buildNetRequest(id: '1', ts: 1000, method: 'GET', url: 'https://api.example.com/v1/orders', headers: const [['Accept', 'application/json']]))
    ..ingest(buildNetResponse(
      id: '1',
      ts: 1120,
      status: 500,
      headers: const [['Content-Type', 'application/json']],
      body: pending('{"error":"db down","detail":{"code":42}}'),
      timings: const {'dns': 10, 'connect': 20, 'wait': 80},
    ))
    ..ingest({kEncodedLineKey: jsonEncode({'type': 'net.request', 'id': 'okhttp-1', 'ts': 1200, 'method': 'POST', 'url': 'https://pay.example.com/charge', 'headers': [], 'source': 'okhttp'})})
    ..ingest(buildLog(level: 'info', message: 'Sepet açıldı', tag: 'cart', ts: 900))
    ..ingest(buildLog(level: 'info', message: 'Sepet açıldı', tag: 'cart', ts: 901))
    ..ingest(buildLog(level: 'fatal', message: 'Unhandled exception: Bad state: boom', kind: 'crash', ts: 1300, error: buildErrorInfo(type: 'StateError', message: 'boom', stack: '#0 main (file:///app/main.dart:10)')));
  return store;
}

Widget app(DurbunInspectorStore store, {Locale locale = const Locale('en'), bool bubble = false}) => MaterialApp(
  locale: locale,
  supportedLocales: const [Locale('en'), Locale('tr')],
  localizationsDelegates: GlobalMaterialLocalizations.delegates,
  builder: (context, child) => DurbunInspector(store: store, showBubble: bubble, child: child!),
  home: const Scaffold(body: Center(child: Text('the app'))),
);

Future<void> phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

const MethodChannel shakeChannel = MethodChannel('dev.durbun/shake');

/// What the plugin would send when the phone is shaken.
Future<void> shake(WidgetTester tester) async {
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    shakeChannel.name,
    const StandardMethodCodec().encodeMethodCall(const MethodCall('shake')),
    (_) {},
  );
  await tester.pumpAndSettle();
}

void main() {
  final listenCalls = <Object?>[];
  setUp(() {
    listenCalls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(shakeChannel, (call) async {
      if (call.method == 'listen') listenCalls.add(call.arguments);
      return true;
    });
  });
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(shakeChannel, null));

  testWidgets('shaking opens the panel; nothing is drawn over the app; the sensor is off in the background', (tester) async {
    await phone(tester);
    final store = filledStore();
    await tester.pumpWidget(app(store));
    expect(listenCalls, [true], reason: 'the plugin is asked to listen while the app is in front');
    expect(find.byType(InspectorBubble), findsNothing, reason: 'no bubble by default');
    await shake(tester);
    expect(find.text('/v1/orders'), findsOneWidget, reason: 'the panel opens on Network');
    expect(listenCalls.last, false, reason: 'no sensor while the panel is open');
    await shake(tester);
    expect(find.text('/v1/orders'), findsOneWidget, reason: 'a second shake does not stack another panel');
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.text('/v1/orders'), findsNothing);
    expect(listenCalls.last, true, reason: 'listening again once the panel is closed');

    for (final st in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
      tester.binding.handleAppLifecycleStateChanged(st);
    }
    expect(listenCalls.last, false);
    for (final st in [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
      tester.binding.handleAppLifecycleStateChanged(st);
    }
    expect(listenCalls.last, true);

    await tester.pumpWidget(const SizedBox());
    expect(listenCalls.last, false, reason: 'unmounting stops listening');
  });

  testWidgets('without the SDK nothing listens for shakes', (tester) async {
    await tester.pumpWidget(MaterialApp(builder: DurbunInspector.builder, home: const Text('the app')));
    expect(listenCalls.where((x) => x == true), isEmpty);
  });

  testWidgets('without the SDK (release / off) only the app shows', (tester) async {
    await tester.pumpWidget(MaterialApp(builder: DurbunInspector.builder, home: const Text('the app')));
    expect(find.text('the app'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('durbun-bubble-badge')), findsNothing);
  });

  testWidgets('optional bubble → logs: repeats merged, requests in the stream, crash detail with stack', (tester) async {
    await phone(tester);
    final store = filledStore();
    await tester.pumpWidget(app(store, bubble: true));
    expect(find.byKey(const ValueKey<String>('durbun-bubble-badge')), findsOneWidget, reason: 'a 500 and a crash are unseen');
    await tester.tap(find.byType(InspectorBubble));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Logs').first);
    await tester.pumpAndSettle();

    expect(find.text('Sepet açıldı'), findsOneWidget, reason: 'two identical lines are one row');
    expect(find.text('×2'), findsOneWidget);
    expect(find.textContaining('api.example.com/v1/orders'), findsOneWidget, reason: 'requests are rows of the log stream');
    expect(find.text('Crash'), findsOneWidget);

    await tester.ensureVisible(find.text('Errors only'));
    await tester.tap(find.text('Errors only'));
    await tester.pumpAndSettle();
    expect(find.text('Sepet açıldı'), findsNothing);
    await tester.tap(find.text('Unhandled exception: Bad state: boom'));
    await tester.pumpAndSettle();
    expect(find.textContaining('StateError: boom'), findsOneWidget);
    expect(find.textContaining('#0 main'), findsOneWidget);
  });

  testWidgets('network: rows, filters, detail with reason phrase, JSON tree and timing', (tester) async {
    await phone(tester);
    final store = filledStore();
    await tester.pumpWidget(app(store));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Network').first);
    await tester.pumpAndSettle();

    expect(find.text('/v1/orders'), findsOneWidget);
    expect(find.text('/charge'), findsOneWidget);
    expect(find.text('okhttp'), findsOneWidget);
    expect(find.text('500'), findsOneWidget);

    await tester.tap(find.text('Filters'));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(BottomSheet), matching: find.text('GET')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.text('/charge'), findsNothing, reason: 'the method chip hides the POST');
    await tester.tap(find.widgetWithText(ActiveChip, 'GET'));
    await tester.pumpAndSettle();
    expect(find.text('/charge'), findsOneWidget, reason: 'the × on the active chip removes it');
    await tester.enterText(find.byType(TextField).last, 'status:5xx');
    await tester.pumpAndSettle();
    expect(find.text('/charge'), findsNothing, reason: 'status:5xx hides the pending call');
    await tester.enterText(find.byType(TextField).last, 'host:pay');
    await tester.pumpAndSettle();
    expect(find.text('/v1/orders'), findsNothing);
    await tester.enterText(find.byType(TextField).last, '');
    await tester.pumpAndSettle();

    await tester.tap(find.text('/v1/orders'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Internal Server Error'), findsWidgets);
    await tester.tap(find.textContaining('Response').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('"db down"'), findsOneWidget, reason: 'JSON preview is a tree');
    expect(find.text('{ 1 }'), findsNothing, reason: 'small objects start open');
    await tester.tap(find.text('Timing'));
    await tester.pumpAndSettle();
    expect(find.text('DNS lookup'), findsOneWidget);
    expect(find.text('Waiting (TTFB)'), findsOneWidget);
  });

  testWidgets('Network first; a swipe goes to Logs and back, each keeps its search', (tester) async {
    await phone(tester);
    final store = filledStore();
    await tester.pumpWidget(app(store));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    expect(find.text('/v1/orders'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'orders');
    await tester.pumpAndSettle();

    await tester.fling(find.byType(TabBarView), const Offset(-500, 0), 1500);
    await tester.pumpAndSettle();
    expect(find.text('Sepet açıldı'), findsOneWidget, reason: 'swiped to Logs');
    expect(find.text('/charge'), findsNothing);

    store.ingest(buildLog(level: 'info', message: 'while away', tag: 'cart', ts: 1400));
    await tester.fling(find.byType(TabBarView), const Offset(500, 0), 1500);
    await tester.pumpAndSettle();
    expect(find.text('/v1/orders'), findsOneWidget);
    expect(find.text('/charge'), findsNothing, reason: 'Network kept its search');
    expect(find.widgetWithText(TextField, 'orders'), findsOneWidget);
  });

  testWidgets('Turkish texts and the device tab', (tester) async {
    await phone(tester);
    final store = filledStore()
      ..ingest({'type': 'hello', 'app': {'id': 'com.example', 'name': 'Örnek', 'version': '1.2.3'}, 'device': {'platform': 'android', 'model': 'Pixel 8', 'osVersion': '15'}, 'sdk': {'version': '0.1.0', 'layers': ['dart', 'android']}, 'capabilities': ['logs', 'network', 'crash', 'metrics']});
    await tester.pumpWidget(app(store, locale: const Locale('tr')));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    expect(find.text('Sadece hatalar'), findsOneWidget);
    await tester.tap(find.byTooltip('Araçlar').first);
    await tester.pumpAndSettle();
    expect(find.text('Yalnızca telefonda'), findsOneWidget);
    expect(find.text('Kural yok'), findsOneWidget);
    await tester.tap(find.text('Cihaz ve SDK'));
    await tester.pumpAndSettle();
    expect(find.text('Örnek'), findsOneWidget);
    expect(find.text('Kotlin'), findsOneWidget);
    expect(find.text('Neler görünüyor?'), findsOneWidget);
  });
}

