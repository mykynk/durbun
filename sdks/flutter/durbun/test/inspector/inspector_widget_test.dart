import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/inspector.dart' show InspectorBubble;
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
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

Widget app(DurbunInspectorStore store, {Locale locale = const Locale('en')}) => MaterialApp(
  locale: locale,
  supportedLocales: const [Locale('en'), Locale('tr')],
  localizationsDelegates: GlobalMaterialLocalizations.delegates,
  builder: (context, child) => DurbunInspector(store: store, child: child!),
  home: const Scaffold(body: Center(child: Text('the app'))),
);

Future<void> phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets('without the SDK (release / off) only the app shows', (tester) async {
    await tester.pumpWidget(MaterialApp(builder: DurbunInspector.builder, home: const Text('the app')));
    expect(find.text('the app'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('durbun-bubble-badge')), findsNothing);
  });

  testWidgets('bubble → logs: repeats merged, requests in the stream, crash detail with stack', (tester) async {
    await phone(tester);
    final store = filledStore();
    await tester.pumpWidget(app(store));
    expect(find.byKey(const ValueKey<String>('durbun-bubble-badge')), findsOneWidget, reason: 'a 500 and a crash are unseen');
    await tester.tap(find.byType(InspectorBubble));
    await tester.pumpAndSettle();

    expect(find.text('Sepet açıldı'), findsOneWidget, reason: 'two identical lines are one row');
    expect(find.text('×2'), findsOneWidget);
    expect(find.textContaining('api.example.com/v1/orders'), findsOneWidget, reason: 'requests are rows of the log stream');
    expect(find.text('Crash'), findsOneWidget);

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

    await tester.tap(find.text('GET').first);
    await tester.pumpAndSettle();
    expect(find.text('/charge'), findsNothing, reason: 'the method chip hides the POST');
    await tester.tap(find.text('GET').first);
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

  testWidgets('Turkish texts and the device tab', (tester) async {
    await phone(tester);
    final store = filledStore()
      ..ingest({'type': 'hello', 'app': {'id': 'com.example', 'name': 'Örnek', 'version': '1.2.3'}, 'device': {'platform': 'android', 'model': 'Pixel 8', 'osVersion': '15'}, 'sdk': {'version': '0.1.0', 'layers': ['dart', 'android']}, 'capabilities': ['logs', 'network', 'crash', 'metrics']});
    await tester.pumpWidget(app(store, locale: const Locale('tr')));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    expect(find.text('Sadece hatalar'), findsOneWidget);
    expect(find.text('Yalnızca telefonda'), findsOneWidget);
    await tester.tap(find.byTooltip('Cihaz').first);
    await tester.pumpAndSettle();
    expect(find.text('Örnek'), findsOneWidget);
    expect(find.text('Kotlin'), findsOneWidget);
    expect(find.text('Neler görünüyor?'), findsOneWidget);
  });
}

