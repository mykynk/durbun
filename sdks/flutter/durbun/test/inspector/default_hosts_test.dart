import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

DurbunInspectorStore _store() => DurbunInspectorStore(notifyDelay: Duration.zero)
  ..ingest(buildNetRequest(id: '1', ts: 1, method: 'GET', url: 'https://api.example.com/v1/accounts', headers: const []))
  ..ingest(buildNetResponse(id: '1', ts: 2, status: 200, headers: const []))
  ..ingest(buildNetRequest(id: '2', ts: 3, method: 'POST', url: 'https://firebasestorage.googleapis.com/v0/b/app/o?name=avatar.jpg', headers: const []))
  ..ingest(buildNetResponse(id: '2', ts: 4, status: 200, headers: const []))
  ..ingest(buildNetRequest(id: '3', ts: 5, method: 'GET', url: 'https://firebasestorage.googleapis.com/v0/b/app/o/avatar.jpg', headers: const []))
  ..ingest(buildNetResponse(id: '3', ts: 6, status: 500, headers: const []))
  ..ingest(buildLog(level: 'info', message: 'app started', ts: 0.5));

Future<void> _open(WidgetTester tester, DurbunInspectorStore store, List<String> hosts) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    builder: (c, child) => DurbunInspector(store: store, defaultHosts: hosts, child: child!),
    home: const Scaffold(body: Text('app')),
  ));
  Durbun.showInspector();
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('dev.durbun/shake'), (_) async => true));

  test('host patterns: exact, *.domain (with the domain itself), *, none', () {
    expect(hostMatchesPatterns('api.example.com', ['api.example.com']), isTrue);
    expect(hostMatchesPatterns('API.Example.com', ['api.example.com']), isTrue);
    expect(hostMatchesPatterns('cdn.api.example.com', ['*.example.com']), isTrue);
    expect(hostMatchesPatterns('example.com', ['*.example.com']), isTrue);
    expect(hostMatchesPatterns('badexample.com', ['*.example.com']), isFalse);
    expect(hostMatchesPatterns('firebasestorage.googleapis.com', ['*.example.com']), isFalse);
    expect(hostMatchesPatterns('anything.io', ['*']), isTrue);
    expect(hostMatchesPatterns('anything.io', []), isTrue, reason: 'no list: every host');
  });

  testWidgets('only the default hosts are listed; the rest are counted and can be ticked in', (tester) async {
    final store = _store();
    await _open(tester, store, const ['*.example.com']);
    // Logs: the Firebase calls are not rows of the stream either.
    expect(find.textContaining('api.example.com/v1/accounts'), findsOneWidget);
    expect(find.textContaining('firebasestorage'), findsNothing);

    await tester.tap(find.byTooltip('Network').first);
    await tester.pumpAndSettle();
    expect(find.text('/v1/accounts'), findsOneWidget);
    expect(find.textContaining('/v0/b/app'), findsNothing);
    expect(find.text('2 on other hosts'), findsOneWidget, reason: 'nothing is hidden silently');
    expect(find.text('1'), findsWidgets, reason: 'the tab badge counts listed requests only');

    await tester.tap(find.text('2 on other hosts'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('firebasestorage.googleapis.com'), 120,
        scrollable: find.descendant(of: find.byType(BottomSheet), matching: find.byType(Scrollable)).first);
    expect(find.text('default'), findsOneWidget, reason: 'api.example.com is marked as a default host');
    await tester.ensureVisible(find.text('firebasestorage.googleapis.com'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('firebasestorage.googleapis.com'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.textContaining('/v0/b/app'), findsNWidgets(2));
    expect(find.text('2 on other hosts'), findsNothing);

    await tester.tap(find.text('Filters'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reset filters'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.textContaining('/v0/b/app'), findsNothing, reason: 'reset goes back to the defaults');
  });

  testWidgets('without defaultHosts every host is listed, as before', (tester) async {
    await _open(tester, _store(), const []);
    await tester.tap(find.byTooltip('Network').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('/v0/b/app'), findsNWidgets(2));
    expect(find.textContaining('on other hosts'), findsNothing);
  });
}
