import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/perf_view.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/theme.dart';
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
  testWidgets('the frame rate leads; tiles only for what the app can fill', (tester) async {
    final s = DurbunInspectorStore(notifyDelay: Duration.zero)
      // heapMB on the wire is ignored: the phone has no Dart heap source.
      ..ingest(buildMetric(
          fps: 60, jankyFrames: 0, frameBuildMs: 3, frameRasterMs: 4, memoryMB: 210, heapMB: 80, cpu: 12, threads: 30));
    await openPerformance(tester, s);

    expect(find.textContaining('heap'), findsNothing);
    final hero = tester.widget<FpsHero>(find.byType(FpsHero));
    expect(hero.fps, 60);
    expect(find.textContaining('Janky frames: 0 last second'), findsOneWidget, reason: 'janky frames under the figure');
    final tiles = tester.widgetList<StatTile>(find.byType(StatTile)).toList();
    expect(tiles.map((t) => t.label), <String>['Build', 'Raster', 'Memory', 'CPU']);
    expect(tiles.last.sub, '30 threads', reason: 'threads ride on the CPU tile');
    final widths = tiles.map((t) => t.width).toSet();
    expect(widths, hasLength(1), reason: 'four tiles: two full rows of two');
    expect(tiles.first.width, lessThan(tester.getSize(find.byType(FpsHero)).width * 0.6));
  });

  testWidgets('an odd last tile takes the whole row', (tester) async {
    final s = DurbunInspectorStore(notifyDelay: Duration.zero)
      ..ingest(buildMetric(fps: 60, memoryMB: 210, threads: 30));
    await openPerformance(tester, s);

    final tiles = tester.widgetList<StatTile>(find.byType(StatTile)).toList();
    // Build, Raster, Memory, Threads (no CPU): even, two rows of two.
    expect(tiles.map((t) => t.label), <String>['Build', 'Raster', 'Memory', 'Threads']);
    s.ingest(buildMetric(fps: 60, memoryMB: 210));
    await tester.pumpAndSettle();
    final three = tester.widgetList<StatTile>(find.byType(StatTile)).toList();
    expect(three, hasLength(3));
    expect(three.last.width, greaterThan(three.first.width * 1.8), reason: 'the third alone across');
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
    // 118 of 120 is not a drop: the figure stays green.
    expect(tester.widget<FpsHero>(find.byType(FpsHero)).color, anyOf(DurbunColors.light.success, DurbunColors.dark.success));
    await tester.dragUntilVisible(
      find.textContaining('Dashed line'),
      find.ancestor(of: find.byType(ChartCard).first, matching: find.byType(Scrollable)).first,
      const Offset(0, -200),
    );
    expect(find.textContaining('120 FPS'), findsNWidgets(2), reason: 'the chart target and the note');
    expect(find.textContaining('8.3 ms'), findsNWidgets(2), reason: 'the chart title and the note');
  });
}
