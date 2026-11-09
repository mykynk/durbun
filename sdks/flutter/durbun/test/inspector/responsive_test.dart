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
      // Mocks is listed only while the desktop is connected.
      for (final tool in ['Performance', 'Statistics', 'Device & SDK']) {
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
    });
  }
}
