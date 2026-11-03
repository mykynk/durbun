import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/body_search.dart';
import 'package:durbun/src/inspector/network_view.dart' show CallDetailPage, codeRows;
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/text_match.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody _pending(String text, {String type = 'application/json'}) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: type);
}

/// A response whose matches sit deep in the tree and far down the page.
String _bigJson() => jsonEncode(<String, Object?>{
      'items': <Object?>[
        for (var i = 0; i < 120; i++)
          <String, Object?>{
            'id': i,
            'branch': <String, Object?>{'city': i == 7 || i == 64 || i == 111 ? 'Şanlıurfa' : 'Ankara'},
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

String _counter(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((t) => t.data ?? '')
    .firstWhere((s) => RegExp(r'^\d+ / \d+\+?$').hasMatch(s) || s == 'No match', orElse: () => '');

/// The line holding the selected match is on screen (not just in the list).
void _currentOnScreen(WidgetTester tester, String text) {
  // SelectableText lines are EditableTexts; textContaining finds both kinds.
  final hits = find.textContaining(text);
  final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
  expect(hits.evaluate().isNotEmpty, isTrue, reason: '"$text" is built');
  var onScreen = false;
  for (var i = 0; i < hits.evaluate().length; i++) {
    final r = tester.getRect(hits.at(i));
    if (r.top >= 0 && r.bottom <= screen.height) onScreen = true;
  }
  expect(onScreen, isTrue, reason: '"$text" is scrolled into view');
}

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('dev.durbun/shake'), (_) async => true));

  group('model', () {
    test('every occurrence, in reading order, across styled pieces', () {
      const st = TextStyle();
      final lines = <SearchLine>[
        const SearchLine([('city', st), (': ', st), ('"Şanlıurfa"', st)]),
        const SearchLine([('note', st), (': ', st), ('"urfa urfa"', st)]),
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

    test('code rows: line numbers, a long line cut into pieces', () {
      final rows = codeRows('a\n${'x' * 900}\nb\n');
      expect([for (final r in rows) '${r.$1}${r.$3 ? '' : '+'}:${r.$2.length}'], ['1:1', '2:400', '2+:400', '2+:100', '3:1']);
    });
  });

  group('JSON preview', () {
    testWidgets('a count, next / previous, and the match scrolled into view', (tester) async {
      await _phone(tester);
      await _openResponse(tester, _store(_bigJson()));
      await tester.enterText(find.byType(TextField), 'sanliurfa');
      await tester.pumpAndSettle();
      expect(_counter(tester), '1 / 3', reason: 'Turkish letters and case do not matter');
      _currentOnScreen(tester, 'Şanlıurfa');

      await tester.tap(find.byTooltip('Next match'));
      await tester.pumpAndSettle();
      expect(_counter(tester), '2 / 3');
      _currentOnScreen(tester, 'Şanlıurfa');
      await tester.tap(find.byTooltip('Next match'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Next match'));
      await tester.pumpAndSettle();
      expect(_counter(tester), '1 / 3', reason: 'wraps around');
      await tester.tap(find.byTooltip('Previous match'));
      await tester.pumpAndSettle();
      expect(_counter(tester), '3 / 3');
      _currentOnScreen(tester, 'Şanlıurfa');

      await tester.enterText(find.byType(TextField), 'istanbul');
      await tester.pumpAndSettle();
      expect(_counter(tester), 'No match');
    });

    testWidgets('the search carries over to Code, which has line numbers', (tester) async {
      await _phone(tester);
      await _openResponse(tester, _store(_bigJson()));
      await tester.enterText(find.byType(TextField), 'urfa');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Code'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, 'urfa');
      expect(_counter(tester), '1 / 3');
      _currentOnScreen(tester, 'Şanlıurfa');
      expect(find.text('1'), findsWidgets, reason: 'line numbers');
    });
  });

  testWidgets('plain text body: find in the code view', (tester) async {
    await _phone(tester);
    final text = [for (var i = 0; i < 400; i++) i == 350 ? 'ERROR: hesap kilitli' : 'satır $i'].join('\n');
    await _openResponse(tester, _store(text, type: 'text/plain'));
    await tester.enterText(find.byType(TextField), 'kilitli');
    await tester.pumpAndSettle();
    expect(_counter(tester), '1 / 1');
    _currentOnScreen(tester, 'hesap kilitli');
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
    _currentOnScreen(tester, 'Şanlıurfa');
  });
}
