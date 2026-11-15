import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/perf_view.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> openPerformance(WidgetTester tester, DurbunInspectorStore s) async {
  await tester.pumpWidget(MaterialApp(
      builder: (c, child) => DurbunInspector(store: s, child: child!),
      home: const Scaffold(body: Text('app'))));
  await tester.pumpAndSettle();
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Tools').first);
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.text('Performance'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Performance'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('only tiles the app can fill; an odd last tile takes the row', (tester) async {
    final s = DurbunInspectorStore(notifyDelay: Duration.zero)
      // heapMB on the wire is ignored: the phone has no Dart heap source.
      ..ingest(buildMetric(
          fps: 60, jankyFrames: 0, frameBuildMs: 3, frameRasterMs: 4, memoryMB: 210, heapMB: 80, cpu: 12, threads: 30));
    await openPerformance(tester, s);

    expect(find.textContaining('heap'), findsNothing);
    final tiles = tester.widgetList<StatTile>(find.byType(StatTile)).toList();
    expect(tiles.map((t) => t.label), <String>['FPS', 'Janky frames', 'Build', 'Raster', 'Memory', 'CPU', 'Threads']);
    expect(tiles.first.lead, isTrue, reason: 'FPS leads, on its own row');
    expect(tiles[1].width, lessThan(tiles.first.width * 0.6), reason: 'the rest two per row');
    expect(tiles.last.width, tiles[1].width, reason: 'six secondary tiles: three full rows');
  });

  testWidgets('under the lead, an odd last tile takes the whole row', (tester) async {
    final s = DurbunInspectorStore(notifyDelay: Duration.zero)
      ..ingest(buildMetric(fps: 60, memoryMB: 210, cpu: 12));
    await openPerformance(tester, s);

    final tiles = tester.widgetList<StatTile>(find.byType(StatTile)).toList();
    expect(tiles, hasLength(6));
    // FPS leads; five secondary tiles: two rows of two, the last one alone across.
    expect(tiles.last.width, tiles.first.width);
    expect(tiles.sublist(1, 5).map((t) => t.width).toSet(), hasLength(1));
  });

  testWidgets('a 120 Hz screen: the chart line and the note use 120 FPS and 8.3 ms', (tester) async {
    tester.view.display.refreshRate = 120;
    addTearDown(tester.view.display.resetRefreshRate);
    final s = DurbunInspectorStore(notifyDelay: Duration.zero)
      ..ingest(buildMetric(fps: 118, jankyFrames: 2, frameBuildMs: 6, frameRasterMs: 7, memoryMB: 210));
    await openPerformance(tester, s);

    final charts = tester.widgetList<ChartCard>(find.byType(ChartCard)).toList();
    expect(charts[0].guide, 120);
    expect(charts[0].minTop, 120, reason: '118 FPS fits under the top');
    expect(charts[1].guide, closeTo(8.33, 0.01));
    // 118 of 120 is not a drop: no warning color on the tile.
    expect(tester.widget<StatTile>(find.byType(StatTile).first).color, isNull);
    await tester.dragUntilVisible(
      find.textContaining('Dashed line'),
      find.ancestor(of: find.byType(ChartCard).first, matching: find.byType(Scrollable)).first,
      const Offset(0, -200),
    );
    expect(find.textContaining('120 FPS'), findsOneWidget);
    expect(find.textContaining('8.3 ms'), findsOneWidget);
  });
}
