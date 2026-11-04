import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/body_search.dart';
import 'package:durbun/src/inspector/json_tree.dart' show JsonSearchIndex, pathsToMatches;
import 'package:durbun/src/inspector/network_view.dart' show CallDetailPage;
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/text_match.dart';
import 'package:durbun/src/inspector/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody _pending(String text, {String type = 'application/json'}) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: type);
}

/// A response whose matches sit deep in the tree and far down the page.
String _bigJson({int items = 120}) => jsonEncode(<String, Object?>{
      'items': <Object?>[
        for (var i = 0; i < items; i++)
          <String, Object?>{
            'id': i,
            'branch': <String, Object?>{'city': i == 7 || i == 64 || i == 111 ? 'Şanlıurfa' : 'Ankara', 'note': 'şube $i açık'},
          },
      ],
    });

DurbunInspectorStore _store(String body, {String type = 'application/json'}) => DurbunInspectorStore(notifyDelay: Duration.zero)
  ..bodyResolver = wireBodyFromPending
  ..ingest(buildNetRequest(id: '1', ts: 1, method: 'GET', url: 'https://api.example.com/v1/branches', headers: const []))
  ..ingest(buildNetResponse(id: '1', ts: 2, status: 200, headers: <List<String>>[['Content-Type', type]], body: _pending(body, type: type)));

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Future<void> _openResponse(WidgetTester tester, DurbunInspectorStore store) async {
  await tester.pumpWidget(MaterialApp(home: CallDetailPage(call: store.calls.single, store: store)));
  await tester.pumpAndSettle();
  await tester.tap(find.textContaining('Response').first);
  await tester.pumpAndSettle();
}

/// Types into the find field and waits out the debounce.
Future<void> _find(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField).last, text);
  await tester.pump(const Duration(milliseconds: 250));
  await tester.pumpAndSettle();
}

FindableLinesState _state(WidgetTester tester) => tester.state<FindableLinesState>(find.byType(FindableLines));

String _counter(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((t) => t.data ?? '')
    .firstWhere((s) => RegExp(r'^\d+ / \d+\+?$').hasMatch(s) || s == 'No match' || s == '2+ chars', orElse: () => '');

/// The row holding the selected match (marked in the current colour) is on
/// the screen.
void _currentOnScreen(WidgetTester tester) {
  final c = DurbunColors.of(tester.element(find.byType(FindableLines)));
  final current = c.warning.withValues(alpha: 0.55);
  final rows = find.byWidgetPredicate((w) {
    if (w is! RichText) return false;
    var hit = false;
    w.text.visitChildren((s) {
      if (s is TextSpan && s.style?.backgroundColor == current) hit = true;
      return !hit;
    });
    return hit;
  });
  final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
  expect(rows.evaluate(), isNotEmpty, reason: 'the current match is built');
  final r = tester.getRect(rows.first);
  expect(r.top >= 0 && r.bottom <= screen.height, isTrue, reason: 'the current match is on screen ($r)');
}

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('dev.durbun/shake'), (_) async => true));

  group('model', () {
    test('every occurrence, in reading order, across styled pieces', () {
      const st = TextStyle();
      final lines = <SearchLine>[
        SearchLine(const [('city', st), (': ', st), ('"Şanlıurfa"', st)]),
        SearchLine(const [('note', st), (': ', st), ('"urfa urfa"', st)]),
      ];
      final occ = findOccurrences(lines, foldText('URFA'));
      expect(occ, [(0, 12, 16), (1, 7, 11), (1, 12, 16)]);
      final span = markLine(lines[1], [(7, 11), (12, 16)], (12, 16), const Color(0xFF00FF00), const Color(0xFFFF0000));
      final marked = <(String, Color?)>[];
      span.visitChildren((s) {
        if (s is TextSpan && s.text != null) marked.add((s.text!, s.style?.backgroundColor));
        return true;
      });
      expect(marked.where((m) => m.$2 != null), [('urfa', const Color(0xFF00FF00)), ('urfa', const Color(0xFFFF0000))]);
      expect(span.toPlainText(), 'note: "urfa urfa"');
    });

    test('rows: a long line is cut by width, a match across a cut is marked on both rows', () {
      const st = TextStyle();
      final lines = [SearchLine(const [('a', st)]), SearchLine([('x' * 25, st)]), SearchLine(const [('', st)])];
      expect(wrapRows(lines, (_) => 10), [(0, 0, 1), (1, 0, 10), (1, 10, 20), (1, 20, 25), (2, 0, 0)]);
      final line = SearchLine(const [('abcdefghij', st)]);
      String marked(TextSpan s) {
        final b = StringBuffer();
        s.visitChildren((x) {
          if (x is TextSpan && x.style?.backgroundColor != null) b.write(x.text);
          return true;
        });
        return '$b';
      }

      expect(marked(markSlice(line, 0, 5, [(3, 7)], null, const Color(0xFF000001), const Color(0xFF000002))), 'de');
      expect(marked(markSlice(line, 5, 10, [(3, 7)], null, const Color(0xFF000001), const Color(0xFF000002))), 'fg');
    });

    test('the JSON index opens the same containers as walking the tree', () {
      final v = jsonDecode(_bigJson(items: 20));
      final idx = JsonSearchIndex(v);
      for (final q in ['urfa', 'city', 'sube 3', 'items']) {
        expect(idx.pathsToMatches(foldText(q)), pathsToMatches(v, q), reason: q);
      }
    });
  });

  group('JSON preview', () {
    testWidgets('a count, next / previous, and the match scrolled into view', (tester) async {
      await _phone(tester);
      await _openResponse(tester, _store(_bigJson()));
      await _find(tester, 'sanliurfa');
      expect(_counter(tester), '1 / 3', reason: 'Turkish letters and case do not matter');
      _currentOnScreen(tester);

      await tester.tap(find.byTooltip('Next match'));
      await tester.pumpAndSettle();
      expect(_counter(tester), '2 / 3');
      _currentOnScreen(tester);
      await tester.tap(find.byTooltip('Next match'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Next match'));
      await tester.pumpAndSettle();
      expect(_counter(tester), '1 / 3', reason: 'wraps around');
      await tester.tap(find.byTooltip('Previous match'));
      await tester.pumpAndSettle();
      expect(_counter(tester), '3 / 3');
      _currentOnScreen(tester);

      await _find(tester, 'istanbul');
      expect(_counter(tester), 'No match');
    });

    testWidgets('one letter does not search', (tester) async {
      await _phone(tester);
      await _openResponse(tester, _store(_bigJson()));
      final before = _state(tester).searches;
      await _find(tester, 'a');
      expect(_counter(tester), '2+ chars');
      expect(_state(tester).searches, before);
    });

    testWidgets('the search carries over to Code, which has line numbers', (tester) async {
      await _phone(tester);
      await _openResponse(tester, _store(const JsonEncoder.withIndent('  ').convert(jsonDecode(_bigJson()))));
      await _find(tester, 'urfa');
      await tester.tap(find.byTooltip('View'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Code'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.byType(TextField).last).controller!.text, 'urfa');
      expect(_counter(tester), '1 / 3');
      _currentOnScreen(tester);
      expect(find.byWidgetPredicate((w) => w is Text && RegExp(r'^\d+$').hasMatch(w.data ?? '')), findsWidgets, reason: 'line numbers');
    });
  });

  testWidgets('plain text body: find in the code view', (tester) async {
    await _phone(tester);
    final text = [for (var i = 0; i < 400; i++) i == 350 ? 'ERROR: hesap kilitli' : 'satır $i'].join('\n');
    await _openResponse(tester, _store(text, type: 'text/plain'));
    await _find(tester, 'kilitli');
    expect(_counter(tester), '1 / 1');
    _currentOnScreen(tester);
  });

  group('large bodies', () {
    testWidgets('letters typed within the debounce search once (200 KB JSON)', (tester) async {
      await _phone(tester);
      final body = _bigJson(items: 3600);
      expect(body.length, greaterThan(200 * 1024));
      await _openResponse(tester, _store(body));
      final before = _state(tester).searches;
      for (final q in ['ş', 'şa', 'şan', 'şanl', 'şanlı']) {
        await tester.enterText(find.byType(TextField).last, q);
        await tester.pump(const Duration(milliseconds: 60));
      }
      await tester.pump(const Duration(milliseconds: 250));
      await tester.pumpAndSettle();
      expect(_state(tester).searches, before + 1);
      expect(_counter(tester), '1 / 3');
    });

    testWidgets('store notifications for other things do not rebuild the body; its own response does', (tester) async {
      await _phone(tester);
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..bodyResolver = wireBodyFromPending
        ..ingest(buildNetRequest(id: '1', ts: 1, method: 'POST', url: 'https://api.example.com/v1/login', headers: const [['Content-Type', 'application/json']], body: _pending('{"user":"ayşe"}')));
      await tester.pumpWidget(MaterialApp(home: CallDetailPage(call: store.calls.single, store: store)));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Request').first);
      await tester.pumpAndSettle();
      await _find(tester, 'ayse');
      final st = _state(tester);
      final builds = st.builds, searches = st.searches;
      for (var i = 0; i < 30; i++) {
        store.ingest(buildLog(level: 'info', message: 'app log $i', ts: 10.0 + i));
        await tester.pump(const Duration(milliseconds: 16));
      }
      store.ingest(buildNetRequest(id: '2', ts: 50, method: 'GET', url: 'https://api.example.com/v1/other', headers: const []));
      await tester.pumpAndSettle();
      expect((st.builds, st.searches), (builds, searches), reason: 'unrelated store changes leave the page alone');
      expect(_counter(tester), '1 / 1');

      store.ingest(buildNetResponse(id: '1', ts: 60, status: 200, headers: const []));
      await tester.pumpAndSettle();
      expect(find.textContaining('200'), findsWidgets, reason: 'the page still follows its own call');
    });
  });

  testWidgets('a body search in the list opens the detail on that body, found', (tester) async {
    await _phone(tester);
    final store = _store(_bigJson());
    await tester.pumpWidget(MaterialApp(builder: (c, child) => DurbunInspector(store: store, child: child!), home: const Scaffold(body: Text('app'))));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Network').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Filters'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Search bodies too'), 120,
        scrollable: find.descendant(of: find.byType(BottomSheet), matching: find.byType(Scrollable)).first);
    await tester.ensureVisible(find.text('Search bodies too'));
    await tester.tap(find.text('Search bodies too'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'şanlıurfa');
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('/v1/branches'));
    await tester.pumpAndSettle();

    final field = tester.widgetList<TextField>(find.byType(TextField)).last;
    expect(field.controller!.text, 'sanliurfa', reason: 'the folded search word is carried over');
    expect(_counter(tester), '1 / 3', reason: 'opened on the Response body with the match found');
    _currentOnScreen(tester);
  });

  group('no "deactivated widget" error when the row that opened a page is gone', () {
    Future<void> openAndPullTheRowAway(WidgetTester tester, String tab, String rowText) async {
      await _phone(tester);
      final store = _store(_bigJson(items: 3))..ingest(buildLog(level: 'info', message: 'Sepet açıldı', ts: 0.5));
      await tester.pumpWidget(MaterialApp(builder: (c, child) => DurbunInspector(store: store, child: child!), home: const Scaffold(body: Text('app'))));
      Durbun.showInspector();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip(tab).first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining(rowText).first);
      await tester.pumpAndSettle();
      // The list under the page changes: the row's element is disposed.
      store.clear();
      await tester.pumpAndSettle();
      // Then MediaQuery changes (the keyboard closing, the theme switching).
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      tester.view.viewInsets = const FakeViewPadding(bottom: 600);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      tester.view.resetViewInsets();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    }

    testWidgets('request detail opened from the Network list', (tester) => openAndPullTheRowAway(tester, 'Network', '/v1/branches'));
    testWidgets('log detail opened from the Logs stream', (tester) => openAndPullTheRowAway(tester, 'Logs', 'Sepet açıldı'));
    testWidgets('request detail opened from a row of the Logs stream', (tester) => openAndPullTheRowAway(tester, 'Logs', 'api.example.com/v1/branches'));
  });
}
