import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody pending(String text) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(
      bytes: bytes,
      size: bytes.length,
      truncated: false,
      limit: 1 << 20,
      capture: true,
      contentType: 'application/json');
}

DurbunInspectorStore filledStore() {
  final store = DurbunInspectorStore(notifyDelay: Duration.zero)
    ..bodyResolver = wireBodyFromPending;
  store
    ..ingest(buildNetRequest(
        id: '1',
        ts: 1000,
        method: 'GET',
        url: 'https://api.example.com/v1/orders',
        headers: const [
          ['Accept', 'application/json']
        ]))
    ..ingest(buildNetResponse(
        id: '1',
        ts: 1120,
        status: 500,
        headers: const [
          ['Content-Type', 'application/json']
        ],
        body: pending('{"error":"db down"}')))
    ..ingest({
      kEncodedLineKey: jsonEncode({
        'type': 'net.request',
        'id': 'okhttp-1',
        'ts': 1200,
        'method': 'POST',
        'url': 'https://pay.example.com/charge',
        'headers': [],
        'source': 'okhttp'
      })
    })
    ..ingest(buildLog(level: 'info', message: 'Sepet açıldı', tag: 'cart'))
    ..ingest(buildLog(
        level: 'fatal',
        message: 'Unhandled exception: Bad state: boom',
        kind: 'crash',
        error: buildErrorInfo(
            type: 'StateError',
            message: 'boom',
            stack: '#0 main (file:///app/main.dart:10)')));
  return store;
}

Widget app(DurbunInspectorStore store, {Locale locale = const Locale('en')}) =>
    MaterialApp(
      locale: locale,
      supportedLocales: const [Locale('en'), Locale('tr')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) => DurbunInspector(store: store, child: child!),
      home: const Scaffold(body: Center(child: Text('the app'))),
    );

void main() {
  testWidgets('without the SDK (release / off) only the app shows',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
        builder: DurbunInspector.builder, home: const Text('the app')));
    expect(find.text('the app'), findsOneWidget);
    expect(find.byIcon(Icons.travel_explore), findsNothing);
  });

  testWidgets(
      'bubble → panel: requests newest first, detail with status and body, back to the app',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final store = filledStore();
    await tester.pumpWidget(app(store));

    expect(find.byKey(const ValueKey<String>('durbun-bubble-badge')),
        findsOneWidget,
        reason: 'a 500 and a crash are unseen');
    await tester.tap(find.byIcon(Icons.travel_explore));
    await tester.pumpAndSettle();

    expect(find.text('Network · 2'), findsOneWidget);
    expect(find.text('Errors · 1'), findsOneWidget);
    expect(find.textContaining('/charge'), findsOneWidget);
    expect(find.textContaining('okhttp'), findsOneWidget);
    expect(find.text('500'), findsOneWidget);
    expect(find.text('…'), findsWidgets,
        reason: 'the OkHttp call is still pending');

    await tester.tap(find.textContaining('/v1/orders').first);
    await tester.pumpAndSettle();
    expect(find.text('500'), findsOneWidget);
    await tester.tap(find.text('Response'));
    await tester.pumpAndSettle();
    expect(find.textContaining('"error": "db down"'), findsOneWidget,
        reason: 'JSON bodies are pretty printed');

    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.text('the app'), findsOneWidget);
    expect(
        find.byKey(const ValueKey<String>('durbun-bubble-badge')), findsNothing,
        reason: 'opening the panel marks errors seen');
  });

  testWidgets('logs and errors tabs, crash stack in the detail, Turkish texts',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final store = filledStore();
    await tester.pumpWidget(app(store, locale: const Locale('tr')));
    Durbun.showInspector();
    await tester.pumpAndSettle();

    expect(find.text('Ağ · 2'), findsOneWidget);
    await tester.tap(find.text('Loglar'));
    await tester.pumpAndSettle();
    expect(find.text('Sepet açıldı'), findsOneWidget);
    expect(find.text('Çökme'), findsOneWidget);

    await tester.tap(find.text('Hatalar · 1'));
    await tester.pumpAndSettle();
    expect(find.text('Sepet açıldı'), findsNothing);
    await tester.tap(find.text('Unhandled exception: Bad state: boom'));
    await tester.pumpAndSettle();
    expect(find.text('Yığın izi'), findsOneWidget);
    expect(find.textContaining('#0 main'), findsOneWidget);
  });

  testWidgets('search narrows the request list', (tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final store = filledStore();
    await tester.pumpWidget(app(store));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'charge');
    await tester.pumpAndSettle();
    expect(find.textContaining('/charge'), findsOneWidget);
    expect(find.textContaining('/v1/orders'), findsNothing);
    await tester.enterText(find.byType(TextField).first, '');
    await tester.tap(find.text('Failures only'));
    await tester.pumpAndSettle();
    expect(find.textContaining('/v1/orders'), findsOneWidget);
    expect(find.textContaining('/charge'), findsNothing);
  });
}
