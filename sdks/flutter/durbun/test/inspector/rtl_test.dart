// The panel in a right-to-left app: English text, laid out left to right.
import 'package:durbun/durbun.dart';
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
}
