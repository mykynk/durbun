import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody pending(String text) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: 'application/json');
}

DurbunInspectorStore store() {
  final s = DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;
  s
    ..ingest(buildNetRequest(id: '1', ts: 1000, method: 'DELETE', url: 'https://very-long-subdomain.api.example-company.com/v1/customers/12345678/orders/987654321/items?include=everything&page=2', headers: const [['Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.verylongtokenverylongtokenverylongtoken']]))
    ..ingest(buildNetResponse(id: '1', ts: 1120, status: 503, headers: const [['Content-Type', 'application/json']], body: pending('{"error":"db down"}')))
    ..ingest(buildNetRequest(id: '2', ts: 1200, method: 'GET', url: 'https://x.io/', headers: const []))
    ..ingest(buildNetError(id: '2', ts: 1300, error: 'SocketException: Connection refused'))
    ..ingest(buildLog(level: 'fatal', message: 'Unhandled exception: ' * 10, tag: 'a-very-long-tag-name-for-testing', kind: 'crash', error: buildErrorInfo(type: 'StateError', message: 'boom', stack: '#0 main')))
    ..ingest(buildMetric(fps: 58, jankyFrames: 3, frameBuildMs: 4.2, frameRasterMs: 6.1, memoryMB: 312, heapMB: 80, cpu: 23, threads: 41))
    ..ingest(buildMetric(fps: 31));
  return s;
}

/// A WebSocket with long, binary, control and close messages and a dropped
/// stretch, and an event stream.
DurbunInspectorStore connections() {
  final s = DurbunInspectorStore(notifyDelay: Duration.zero, maxStreamMessages: 40)
    ..bodyResolver = wireBodyFromPending
    ..attached = true;
  Uint8List utf(String v) => Uint8List.fromList(utf8.encode(v));
  s
    ..ingest(buildNetRequest(id: 'w', ts: 1000, method: 'GET', url: 'wss://very-long-subdomain.realtime.example-company.com/v2/sockets/conversations/12345678', headers: const []))
    ..ingest(buildNetResponse(id: 'w', ts: 1040, status: 101, headers: const []))
    ..streamOpened('w', kind: 'ws', ts: 1040);
  for (var i = 0; i < 70; i++) {
    final text = '{"type":"conversation.message.created","id":"msg_$i","text":"${'uzun bir mesaj metni ' * 6}"}';
    s.streamWs('w', 1100.0 + i * 977, i.isEven ? 'in' : 'out', 'text', utf(text).length, utf(text), null, null);
  }
  s
    ..streamWs('w', 90000, 'in', 'binary', 18842, Uint8List.fromList(List<int>.generate(64, (i) => i)), null, null)
    ..streamWs('w', 90100, 'in', 'ping', 0, null, null, null)
    ..streamWs('w', 3700000, 'in', 'close', 40, null, 4401, 'The session expired and the client has to sign in again')
    ..ingest(buildNetRequest(id: 'e', ts: 2000, method: 'GET', url: 'https://api.example.com/v1/adoptions/live-updates', headers: const []))
    ..ingest(buildNetResponse(id: 'e', ts: 2040, status: 200, headers: const [['Content-Type', 'text/event-stream']]))
    ..streamOpened('e', kind: 'sse', ts: 2040);
  for (var i = 0; i < 5; i++) {
    final d = utf('{"pet":"Badem","status":"application.received.by.shelter.volunteer"}');
    s.streamSse('e', 2100.0 + i * 1000, 'adoption.application.status.changed', 'evt_00000000$i', 15000, d.length, d);
  }
  return s;
}

/// No overflow at small, landscape, tablet sizes and doubled text.
void main() {
  for (final (name, size, scale) in <(String, Size, double)>[
    ('small phone 320x568', const Size(320, 568), 1.0),
    ('landscape 844x390', const Size(844, 390), 1.0),
    ('tablet 1024x1366', const Size(1024, 1366), 1.0),
    ('text x2 on 390x844', const Size(390, 844), 2.0),
  ]) {
    testWidgets(name, (tester) async {
      tester.view.physicalSize = size * 2;
      tester.view.devicePixelRatio = 2;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearAllTestValues);
      final s = store();
      await tester.pumpWidget(MaterialApp(builder: (c, child) => DurbunInspector(store: s, child: child!), home: const Scaffold(body: Text('app'))));
      await tester.pumpAndSettle();
      Durbun.showInspector();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Network').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('/v1/customers').first);
      await tester.pumpAndSettle();
      for (final tab in ['Request', 'Response', 'Timing', 'General']) {
        await tester.tap(find.textContaining(tab).first);
        await tester.pumpAndSettle();
      }
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      // The order sheet, every order picked.
      for (final order in ['Slowest first', 'Errors first', 'Arrival order']) {
        await tester.tap(find.byTooltip(RegExp(r'^Sort')).first);
        await tester.pumpAndSettle();
        // The sheet's list builds lazily (large text): scroll it to the row.
        final row = find.descendant(of: find.byType(BottomSheet), matching: find.text(order));
        await tester.scrollUntilVisible(row, 80, scrollable: find.descendant(of: find.byType(BottomSheet), matching: find.byType(Scrollable)).first);
        await tester.pumpAndSettle();
        await tester.tap(row);
        await tester.pumpAndSettle();
      }
      // Performance is a tab of the bottom bar.
      await tester.tap(find.byTooltip('Performance').first);
      await tester.pumpAndSettle();
      // Mocks is listed only while the desktop is connected.
      for (final tool in ['Statistics', 'Device & SDK']) {
        await tester.tap(find.byTooltip('Tools').first);
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text(tool));
        await tester.pumpAndSettle();
        await tester.tap(find.text(tool));
        await tester.pumpAndSettle();
        expect(find.text(tool), findsOneWidget, reason: 'the page is open, titled $tool');
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
      }
      await tester.tap(find.byTooltip('Logs').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Unhandled exception').first);
      await tester.pumpAndSettle();
      // Report a bug from the crash: the page, scrolled to its end, the
      // window widened and the screenshot left out.
      await tester.tap(find.byKey(const ValueKey<String>('durbun-log-bug')));
      await tester.pumpAndSettle();
      expect(find.text('What happened?'), findsOneWidget);
      final list = find.byKey(const ValueKey<String>('durbun-bug-list'));
      await tester.drag(list, const Offset(0, -3000));
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      // And from Tools, about the panel's opening.
      await tester.tap(find.byTooltip('Tools').first);
      await tester.pumpAndSettle();
      // Scrolled down by the visits above: back up to the card.
      final card = find.byKey(const ValueKey<String>('durbun-tools-bug'));
      await tester.scrollUntilVisible(card, -200, scrollable: find.byType(Scrollable).hitTestable().last);
      await tester.pumpAndSettle();
      await tester.tap(card);
      await tester.pumpAndSettle();
      expect(find.text('When the panel opened'), findsOneWidget);
      final wider = find.text('5 min');
      for (var i = 0; i < 20 && wider.hitTestable().evaluate().isEmpty; i++) {
        await tester.drag(list, const Offset(0, -120));
        await tester.pump();
      }
      await tester.tap(wider);
      await tester.pumpAndSettle();
      await tester.drag(list, const Offset(0, -3000));
      await tester.pumpAndSettle();
    });
  }

  for (final (name, size, scale) in <(String, Size, double)>[
    ('connections: small phone 320x568', const Size(320, 568), 1.0),
    ('connections: landscape 844x390', const Size(844, 390), 1.0),
    ('connections: text x1.3 on 390x844', const Size(390, 844), 1.3),
    ('connections: text x2 on 390x844', const Size(390, 844), 2.0),
    ('connections: text x2 landscape 844x390', const Size(844, 390), 2.0),
  ]) {
    testWidgets(name, (tester) async {
      tester.view.physicalSize = size * 2;
      tester.view.devicePixelRatio = 2;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearAllTestValues);
      final s = connections();
      await tester.pumpWidget(MaterialApp(builder: (c, child) => DurbunInspector(store: s, child: child!), home: const Scaffold(body: Text('app'))));
      await tester.pumpAndSettle();
      Durbun.showInspector();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Network').first);
      await tester.pumpAndSettle();
      // Two rows: at doubled text in landscape only one shows at a time.
      Future<void> openRow(String path) async {
        final row = find.textContaining(path).hitTestable();
        for (var i = 0; i < 16 && row.evaluate().isEmpty; i++) {
          // On a request row (the header above scrolls sideways): up to the
          // top first, then down.
          await tester.dragFrom(tester.getCenter(find.text('GET').hitTestable().first), Offset(0, i < 4 ? 80 : -80));
          await tester.pumpAndSettle();
        }
        await tester.tap(row.first);
        await tester.pumpAndSettle();
      }

      await openRow('/conversations/');
      // The list follows the newest: the binary message before the close.
      final binary = find.text('binary').hitTestable();
      for (var i = 0; i < 12 && binary.evaluate().isEmpty; i++) {
        await tester.dragFrom(tester.getCenter(find.text('Closed by the server').hitTestable().first), const Offset(0, 60));
        await tester.pumpAndSettle();
      }
      await tester.tap(binary.first);
      await tester.pumpAndSettle();
      expect(find.byTooltip('Next message'), findsOneWidget);
      await tester.tap(find.byTooltip('Next message'));
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      // The ping/pong switch and the search.
      await tester.tap(find.textContaining('ping/pong').first);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).hitTestable().first, 'msg_6');
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await openRow('/live-updates');
      await tester.tap(find.textContaining('application.status').hitTestable().first);
      await tester.pumpAndSettle();
      expect(find.textContaining(RegExp(r'^Event \d')), findsWidgets, reason: 'the event page is open');
    });
  }
}
