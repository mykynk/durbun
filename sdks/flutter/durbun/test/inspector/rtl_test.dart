// The panel in a right-to-left app: English text, laid out left to right.
import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/cupertino.dart' show CupertinoLocalizations, DefaultCupertinoLocalizations;
import 'package:flutter/foundation.dart' show SynchronousFuture;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _RtlWidgets extends DefaultWidgetsLocalizations {
  const _RtlWidgets();

  @override
  TextDirection get textDirection => TextDirection.rtl;
}

/// Any locale, fixed resources (stands in for an Arabic app's delegates).
class _Any<T> extends LocalizationsDelegate<T> {
  const _Any(this.value);

  final T value;

  @override
  bool isSupported(Locale locale) => true;

  @override
  Future<T> load(Locale locale) => SynchronousFuture<T>(value);

  @override
  bool shouldReload(_Any<T> old) => false;
}

void main() {
  testWidgets('in an Arabic (RTL) app the panel is English and left to right', (tester) async {
    final store = DurbunInspectorStore(notifyDelay: Duration.zero);
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('ar'),
      supportedLocales: const <Locale>[Locale('ar')],
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        _Any<WidgetsLocalizations>(_RtlWidgets()),
        _Any<MaterialLocalizations>(DefaultMaterialLocalizations()),
        _Any<CupertinoLocalizations>(DefaultCupertinoLocalizations()),
      ],
      builder: (c, child) => DurbunInspector(store: store, child: child!),
      home: const Scaffold(body: Text('app')),
    ));
    expect(Directionality.of(tester.element(find.text('app'))), TextDirection.rtl);
    Durbun.showInspector();
    await tester.pumpAndSettle();

    final network = find.text('Network').first;
    expect(network, findsOneWidget, reason: 'English, the panel has no Arabic');
    expect(Directionality.of(tester.element(network)), TextDirection.ltr);
    expect(Localizations.localeOf(tester.element(network)).languageCode, 'en');
  });

  testWidgets('Report a bug in an RTL app: English, left to right, nothing clipped', (tester) async {
    final store = DurbunInspectorStore(notifyDelay: Duration.zero);
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('ar'),
      supportedLocales: const <Locale>[Locale('ar')],
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        _Any<WidgetsLocalizations>(_RtlWidgets()),
        _Any<MaterialLocalizations>(DefaultMaterialLocalizations()),
        _Any<CupertinoLocalizations>(DefaultCupertinoLocalizations()),
      ],
      builder: (c, child) => DurbunInspector(store: store, child: child!),
      home: const Scaffold(body: Text('app')),
    ));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Tools').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('durbun-tools-bug')));
    await tester.pumpAndSettle();
    final note = find.text('What happened?');
    expect(note, findsOneWidget);
    expect(Directionality.of(tester.element(note)), TextDirection.ltr);
    // The note's label starts at the left edge of the page.
    final page = tester.getTopLeft(find.ancestor(of: note, matching: find.byType(Scaffold)).first).dx;
    expect(tester.getTopLeft(note).dx - page, lessThan(40));
  });

  testWidgets('a Turkish app keeps Turkish texts', (tester) async {
    final store = DurbunInspectorStore(notifyDelay: Duration.zero);
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('tr'),
      supportedLocales: const <Locale>[Locale('tr')],
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        _Any<WidgetsLocalizations>(DefaultWidgetsLocalizations()),
        _Any<MaterialLocalizations>(DefaultMaterialLocalizations()),
        _Any<CupertinoLocalizations>(DefaultCupertinoLocalizations()),
      ],
      builder: (c, child) => DurbunInspector(store: store, child: child!),
      home: const Scaffold(body: Text('app')),
    ));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    expect(find.text('Ağ'), findsWidgets);
    expect(Directionality.of(tester.element(find.text('Ağ').first)), TextDirection.ltr);
  });

  testWidgets('WebSocket messages in an RTL app: left to right, sent and received arrows the same way', (tester) async {
    final store = DurbunInspectorStore(notifyDelay: Duration.zero)..attached = true;
    store
      ..ingest(buildNetRequest(id: 'w', ts: 1000, method: 'GET', url: 'wss://api.example.com/chat', headers: const <List<String>>[]))
      ..ingest(buildNetResponse(id: 'w', ts: 1040, status: 101, headers: const <List<String>>[]))
      ..streamOpened('w', kind: 'ws', ts: 1040);
    final hello = Uint8List.fromList(utf8.encode('{"type":"hello"}'));
    store
      ..streamWs('w', 1100, 'out', 'text', hello.length, hello, null, null)
      ..streamWs('w', 1200, 'in', 'text', hello.length, hello, null, null);
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('ar'),
      supportedLocales: const <Locale>[Locale('ar')],
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        _Any<WidgetsLocalizations>(_RtlWidgets()),
        _Any<MaterialLocalizations>(DefaultMaterialLocalizations()),
        _Any<CupertinoLocalizations>(DefaultCupertinoLocalizations()),
      ],
      builder: (c, child) => DurbunInspector(store: store, child: child!),
      home: const Scaffold(body: Text('app')),
    ));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Network').first);
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('/chat').first);
    await tester.pumpAndSettle();
    final rows = find.textContaining('"hello"');
    expect(rows, findsNWidgets(2));
    expect(Directionality.of(tester.element(rows.first)), TextDirection.ltr);
    final page = tester.getTopLeft(find.ancestor(of: rows.first, matching: find.byType(Scaffold)).first).dx;
    expect(tester.getTopLeft(rows.first).dx - page, lessThan(80), reason: 'the text starts on the left');
    expect(find.byIcon(Icons.north_east_rounded), findsWidgets);
    expect(find.byIcon(Icons.south_west_rounded), findsWidgets);
  });
}
