// The Tools sheet says what is off and what the panel cannot see.
import 'package:durbun/durbun.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _tools(WidgetTester tester, {Locale? locale}) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final store = DurbunInspectorStore(notifyDelay: Duration.zero);
  await tester.pumpWidget(MaterialApp(
      locale: locale,
      builder: (c, child) => DurbunInspector(store: store, child: child!),
      home: const Scaffold(body: Text('app'))));
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Tools').first);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('Previous run is listed while off and explains how to turn it on', (tester) async {
    await _tools(tester);
    await tester.ensureVisible(find.text('Previous run'));
    await tester.pumpAndSettle();
    expect(find.text('When on, the last launch stays here'), findsOneWidget);
    expect(find.text('Off'), findsOneWidget, reason: 'the state is said once, on the right');
    await tester.tap(find.text('Previous run'));
    await tester.pumpAndSettle();
    expect(find.text('Previous run is off'), findsOneWidget);
    expect(find.textContaining('keepPreviousRun: true'), findsWidgets);
    expect(find.byTooltip('Copy'), findsOneWidget);
  });

  testWidgets('Device & SDK lists what is not captured', (tester) async {
    await _tools(tester);
    await tester.tap(find.text('Device & SDK'));
    await tester.pumpAndSettle();
    final list = find.byType(Scrollable).last;
    await tester.dragUntilVisible(find.text('What is not captured?'), list, const Offset(0, -300));
    for (final title in <String>['Background isolates', 'dart:developer log()', 'WebView', 'Some WebSocket and event stream messages']) {
      await tester.dragUntilVisible(find.text(title), list, const Offset(0, -200));
      expect(find.text(title), findsOneWidget);
    }
  });
}
