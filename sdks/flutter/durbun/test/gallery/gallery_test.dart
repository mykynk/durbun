// Renders every screen of the in-app panel to PNG files for design review.
//
// Skipped unless DURBUN_GALLERY_DIR is set:
//   DURBUN_GALLERY_DIR=/tmp/panel flutter test test/gallery --concurrency=2 -r failures-only
// DURBUN_GALLERY_LANG=en renders the panel in English (default: tr).
//
// Phone size 390 x 844 at pixel ratio 2, light and dark. Real fonts
// are read from disk at test time (Roboto and Material Icons from the Flutter
// SDK cache, a monospace face from the system); nothing is copied into the
// package. Writes <name>-<theme>.png per screen, contact sheets of four
// screens (sheet-NN-<theme>.png) and errors.txt with any layout error seen.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:durbun/durbun.dart';
import 'package:durbun/src/flutter/durbun.dart' show durbunBackend;
import 'package:durbun/src/inspector/filter_ui.dart' show FilterButton;
import 'package:durbun/src/inspector/inspector.dart' show ShakeHint;
import 'package:durbun/src/inspector/logs_view.dart' show LogRow;
import 'package:durbun/src/inspector/network_view.dart' show CallRow;
import 'package:durbun/src/inspector/run_log.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/strings.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';
import 'pati_seed.dart';

final String? _outDir = Platform.environment['DURBUN_GALLERY_DIR'];
final bool _skip = _outDir == null || _outDir!.isEmpty;

final String _lang = Platform.environment['DURBUN_GALLERY_LANG'] == 'en' ? 'en' : 'tr';

/// The panel's texts in the gallery's language (the flows find controls by them).
final InspectorStrings tr = InspectorStrings.forLanguage(_lang);
const Size kPhone = Size(390, 844);
const Size kLandscape = Size(844, 390);
const Size kTablet = Size(834, 1194);

final GlobalKey _frame = GlobalKey(debugLabel: 'gallery.frame');

/// Shot names in the order taken, per theme, with their logical size.
final Map<String, List<(String, Size)>> _shots = <String, List<(String, Size)>>{'light': [], 'dark': []};
final List<String> _errors = <String>[];

const MethodChannel _shake = MethodChannel('dev.durbun/shake');

Future<void> _loadFonts() async {
  final flutterBin = File(Platform.resolvedExecutable).parent; // .../bin/cache/artifacts/engine/<platform>
  // FLUTTER_ROOT is set by `flutter test`; fall back to the engine path.
  final root = Platform.environment['FLUTTER_ROOT'] ??
      flutterBin.path.split('${Platform.pathSeparator}bin${Platform.pathSeparator}cache').first;
  final material = '$root/bin/cache/artifacts/material_fonts';
  Future<void> load(String family, List<String> paths) async {
    final loader = FontLoader(family);
    var any = false;
    for (final p in paths) {
      final f = File(p);
      if (!f.existsSync()) continue;
      any = true;
      loader.addFont(Future<ByteData>.value(ByteData.sublistView(f.readAsBytesSync())));
    }
    if (any) await loader.load();
  }

  final roboto = <String>[
    for (final w in <String>['Regular', 'Medium', 'Bold', 'Light', 'Italic']) '$material/Roboto-$w.ttf',
  ];
  await load('Roboto', roboto);
  await load('MaterialIcons', <String>['$material/MaterialIcons-Regular.otf']);
  // The panel's mono family ('monospace', fallback Menlo).
  const mono = <String>['/System/Library/Fonts/SFNSMono.ttf'];
  await load('monospace', mono);
  await load('Menlo', mono);
}

String _theme(WidgetTester tester) =>
    tester.platformDispatcher.platformBrightness == Brightness.dark ? 'dark' : 'light';

/// Lets animations finish without waiting forever on a live view.
Future<void> settle(WidgetTester tester) async {
  try {
    await tester.pumpAndSettle(const Duration(milliseconds: 50), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
  } catch (_) {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }
}

/// Text whose style names no family (an app bar title, a text button with
/// its own style) is drawn by the phone in its system font, but by the test
/// engine as boxes: give those paragraphs Roboto before the picture.
void _systemFont(RenderObject node) {
  if (node is RenderParagraph) {
    final span = node.text;
    if (span is TextSpan && span.style?.fontFamily == null) {
      node.text = TextSpan(
        text: span.text,
        children: span.children,
        style: (span.style ?? const TextStyle()).copyWith(fontFamily: 'Roboto'),
        recognizer: span.recognizer,
        semanticsLabel: span.semanticsLabel,
        locale: span.locale,
        spellOut: span.spellOut,
      );
    }
  }
  node.visitChildren(_systemFont);
}

Future<void> shot(WidgetTester tester, String name) async {
  await settle(tester);
  _systemFont(_frame.currentContext!.findRenderObject()!);
  await tester.pump();
  final theme = _theme(tester);
  final boundary = _frame.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final logical = tester.view.physicalSize / tester.view.devicePixelRatio;
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: tester.view.devicePixelRatio);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    File('$_outDir/$name-$theme.png').writeAsBytesSync(data!.buffer.asUint8List());
  });
  _shots[theme]!.add((name, logical));
}

/// One step of a flow: a missing widget is written to errors.txt instead of
/// ending the whole flow.
Future<void> step(WidgetTester tester, String name, Future<void> Function() body) async {
  try {
    await body();
  } catch (e, st) {
    final at = '$st'.split('\n').where((l) => l.contains('gallery_test.dart')).take(2).join(' < ');
    _errors.add('[${_theme(tester)}] $name: ${'$e'.split('\n').take(4).join(' / ')}${at.isEmpty ? '' : ' @ $at'}');
  }
}

class PatiHome extends StatelessWidget {
  const PatiHome({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Pati')),
        body: ListView(
          children: const <Widget>[
            ListTile(leading: Icon(Icons.pets), title: Text('Luna'), subtitle: Text('Tekir · 4,6 kg')),
            ListTile(leading: Icon(Icons.pets), title: Text('Pamuk'), subtitle: Text('Van kedisi · 3,9 kg')),
            ListTile(leading: Icon(Icons.event), title: Text('Aşı randevusu'), subtitle: Text('21 Kasım, 10:30')),
            ListTile(leading: Icon(Icons.shopping_cart_outlined), title: Text('Sepet'), subtitle: Text('3 ürün')),
          ],
        ),
      );
}

/// The host app: its own (orange) theme, Turkish, the panel in its builder.
Widget patiApp({DurbunInspectorStore? store, bool keepPreviousRun = false, bool bubble = false, Widget? overlay}) => RepaintBoundary(
      key: _frame,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        locale: Locale(_lang),
        supportedLocales: const <Locale>[Locale('tr'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        theme: ThemeData(colorSchemeSeed: const Color(0xFFE07A3F)),
        darkTheme: ThemeData(colorSchemeSeed: const Color(0xFFE07A3F), brightness: Brightness.dark),
        builder: (context, child) => DurbunInspector(
          store: store,
          keepPreviousRun: keepPreviousRun,
          showBubble: bubble,
          showHint: false,
          child: overlay == null ? child! : Stack(children: <Widget>[child!, overlay]),
        ),
        home: const PatiHome(),
      ),
    );

/// A journal without files, as in the previous-run tests.
class GalleryJournal extends RunJournal {
  GalleryJournal(this.records, {PreviousRunInfo? previous}) : _previous = ValueNotifier<PreviousRunInfo?>(previous);

  final List<Map<String, Object?>>? records;
  final ValueNotifier<PreviousRunInfo?> _previous;

  @override
  bool recording = true;

  @override
  ValueListenable<PreviousRunInfo?> get previous => _previous;

  @override
  // Before the live store's first record (4 min ago): a crash of this run
  // is not taken for a late crash of the previous one.
  double get startedAtMs => DateTime.now().millisecondsSinceEpoch - 5 * 60 * 1000.0;

  @override
  void flushNow() {}

  @override
  Future<List<Map<String, Object?>>?> readPrevious() async => records;
}

List<Map<String, Object?>> previousRecords() {
  final s = patiStore(now: DateTime.now().millisecondsSinceEpoch - 30 * 60 * 1000.0, withMetrics: false);
  final lines = <String>[];
  RunRecorder(s, lines.addAll, startedAtMs: DateTime.now().millisecondsSinceEpoch - 36 * 60 * 1000.0)
    ..start()
    ..flushNow()
    ..stop();
  return decodeRunLines(lines);
}

/// One gallery flow, rendered in light and in dark.
void gallery(String name, Future<void> Function(WidgetTester tester) body,
    {Size size = kPhone, double textScale = 1}) {
  for (final dark in <bool>[false, true]) {
    testWidgets('$name (${dark ? 'dark' : 'light'})', (tester) async {
      tester.view.physicalSize = size * 2;
      tester.view.devicePixelRatio = 2;
      // A current phone: status bar and home indicator.
      final landscape = size.width > size.height;
      tester.view.padding = FakeViewPadding(top: landscape ? 0 : 94, bottom: landscape ? 42 : 68, left: landscape ? 94 : 0);
      tester.view.viewPadding = FakeViewPadding(top: landscape ? 0 : 94, bottom: landscape ? 42 : 68, left: landscape ? 94 : 0);
      tester.platformDispatcher.platformBrightnessTestValue = dark ? Brightness.dark : Brightness.light;
      tester.platformDispatcher.textScaleFactorTestValue = textScale;
      tester.platformDispatcher.localeTestValue = Locale(_lang);
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearAllTestValues);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(_shake, (_) async => true);
      addTearDown(() =>
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null));
      final previous = FlutterError.onError;
      FlutterError.onError = (details) {
        final text = details.exceptionAsString().split('\n').first;
        _errors.add('[${dark ? 'dark' : 'light'}] $name: $text');
      };
      // flutter_test draws shadows as hard edges; a phone blurs them.
      debugDisableShadows = false;
      try {
        await body(tester);
      } finally {
        FlutterError.onError = previous;
        debugDisableShadows = true;
      }
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
    }, skip: _skip);
  }
}

Future<DurbunInspectorStore> openPanel(WidgetTester tester, {DurbunInspectorStore? store, bool keep = false}) async {
  final s = store ?? patiStore();
  // A fresh app: no page of an earlier flow stays open.
  await tester.pumpWidget(const SizedBox());
  await settle(tester);
  await tester.pumpWidget(patiApp(store: s, keepPreviousRun: keep));
  await settle(tester);
  Durbun.showInspector();
  await settle(tester);
  return s;
}

Future<void> tapText(WidgetTester tester, String text, {bool last = false}) async {
  final f = find.text(text);
  await tester.tap(last ? f.last : f.first);
  await settle(tester);
}

Future<void> openTools(WidgetTester tester) async {
  await tester.tap(find.byTooltip(tr.tools).first);
  await settle(tester);
}

Future<void> tapTool(WidgetTester tester, String label) async {
  await openTools(tester);
  final f = find.text(label);
  await tester.scrollUntilVisible(f, 120, scrollable: find.byType(Scrollable).last);
  await settle(tester);
  await tester.tap(f.first);
  await settle(tester);
}

Future<void> back(WidgetTester tester) async {
  await tester.binding.handlePopRoute();
  await settle(tester);
}

Finder row(String text) => find.textContaining(text, findRichText: true);

/// A segment ("Başlıklar 6") or any other text that may carry a count.
Future<void> tapLabel(WidgetTester tester, String text) async {
  await tester.tap(find.textContaining(text, findRichText: true).first);
  await settle(tester);
}

Future<void> openRow(WidgetTester tester, String text) async {
  final f = row(text);
  final rows = find.byType(CallRow).evaluate().isNotEmpty ? find.byType(CallRow) : find.byType(LogRow);
  final list = find
      .ancestor(
          of: rows.first,
          matching: find.byWidgetPredicate((w) => w is Scrollable && axisDirectionToAxis(w.axisDirection) == Axis.vertical))
      .first;
  if (f.hitTestable().evaluate().isEmpty) {
    // Start from the top so the search only has to scroll one way.
    tester.state<ScrollableState>(list).position.jumpTo(0);
    await tester.pump();
    if (f.hitTestable().evaluate().isEmpty) {
      await tester.scrollUntilVisible(f.first, 200, scrollable: list, maxScrolls: 30);
    }
  }
  await settle(tester);
  await tester.tap(f.first);
  await settle(tester);
}

/* The SDK for the connection and app-tools pages. */

Future<void> eventually(bool Function() condition, {Duration timeout = const Duration(seconds: 10)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

Future<int> deadPort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = s.port;
  await s.close();
  return port;
}

Future<void> startSdk(WidgetTester tester, int port) async {
  await tester.runAsync(() async {
    DurbunInspectorStore.instance = DurbunInspectorStore(notifyDelay: Duration.zero);
    await Durbun.init(DurbunOptions(
        enabled: true, port: port, listenForUsb: false, useBackgroundIsolate: false, metrics: false, captureNetwork: false));
  });
}

Future<void> stopSdk(WidgetTester tester) async {
  await tester.runAsync(Durbun.dispose);
  await tester.pump(const Duration(milliseconds: 250));
}

void addPatiActions() {
  var env = 'staging';
  var fakeGps = false;
  Durbun.addAction(DurbunAction.button(id: 'app.clearCart', label: 'Empty the cart', onPressed: (_) => null));
  Durbun.addAction(DurbunAction.button(id: 'app.resetOnboarding', label: 'Show onboarding again', onPressed: (_) => null));
  Durbun.addAction(DurbunAction.toggle(
      id: 'app.fakeGps', label: 'Fake location (Moda)', value: () => fakeGps, onChanged: (v) => fakeGps = v));
  Durbun.addAction(DurbunAction.select(
    id: 'app.env',
    label: 'API environment',
    options: const <DurbunActionOption>[
      DurbunActionOption('prod', 'Production'),
      DurbunActionOption('staging', 'Staging'),
      DurbunActionOption('local', 'Local'),
    ],
    value: () => env,
    onChanged: (v) => env = v,
  ));
}

void main() {
  setUpAll(() async {
    if (_skip) return;
    Directory(_outDir!).createSync(recursive: true);
    await _loadFonts();
  });

  /* Network */

  gallery('network', (tester) async {
    await openPanel(tester);
    await shot(tester, '01-network-list');
    await step(tester, 'search', () async {
      await tester.enterText(find.byType(TextField).hitTestable().first, 'pets');
      await settle(tester);
      await shot(tester, '02-network-search');
      await tester.enterText(find.byType(TextField).hitTestable().first, '');
      await settle(tester);
    });
    await step(tester, 'filters', () async {
      await tester.tap(find.byType(FilterButton).hitTestable().first);
      await settle(tester);
      await shot(tester, '03-network-filters');
      // Tick a status and a method, then back to the list with chips.
      final sheet = find.byType(BottomSheet);
      await tester.tap(find.descendant(of: sheet, matching: find.text('5xx')).first);
      await tester.tap(find.descendant(of: sheet, matching: find.text('GET')).first);
      await settle(tester);
      await shot(tester, '04-network-filters-on');
      await tapText(tester, tr.done);
      await shot(tester, '05-network-filtered');
    });
  });

  gallery('network empty', (tester) async {
    await openPanel(tester, store: DurbunInspectorStore(notifyDelay: Duration.zero)..ingest(patiHello()));
    await shot(tester, '06-network-empty');
    await step(tester, 'logs empty', () async {
      await tester.tap(find.byTooltip(tr.logs).first);
      await settle(tester);
      await shot(tester, '07-logs-empty');
    });
  });

  gallery('request detail', (tester) async {
    await openPanel(tester);
    await step(tester, 'open', () => openRow(tester, '/v2/pets'));
    await shot(tester, '10-detail-general');
    await step(tester, 'request headers', () async {
      await tapLabel(tester, tr.request);
      await tapLabel(tester, tr.headers);
      await shot(tester, '11-detail-request-headers');
    });
    await step(tester, 'response json', () async {
      await tapLabel(tester, tr.response);
      await tapLabel(tester, tr.body);
      await shot(tester, '12-detail-response-json');
    });
    await step(tester, 'code view', () async {
      await tester.tap(find.byTooltip(tr.view).first);
      await settle(tester);
      await shot(tester, '13-detail-view-menu');
      await tapText(tester, tr.code, last: true);
      await shot(tester, '14-detail-response-code');
    });
    await step(tester, 'timing', () async {
      await tapLabel(tester, tr.timing);
      await shot(tester, '15-detail-timing');
    });
    await step(tester, 'more menu', () async {
      await tester.tap(find.byTooltip(tr.moreActions).first);
      await settle(tester);
      await shot(tester, '16-detail-more-menu');
      await tapText(tester, tr.compareEllipsis);
      await shot(tester, '17-compare-picker');
      await tester.tap(find.byType(CallRow).first);
      await settle(tester);
      // The diff is computed off the UI isolate.
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
        await tester.pump();
      }
      await shot(tester, '18-compare');
    });
  });

  gallery('request detail failed', (tester) async {
    await openPanel(tester);
    await step(tester, 'server error', () async {
      await openRow(tester, '/v2/vets/nearby');
      await shot(tester, '20-detail-500');
      await tapLabel(tester, tr.response);
      await shot(tester, '21-detail-500-response');
      await back(tester);
    });
    await step(tester, 'timeout', () async {
      await openRow(tester, '/v2/feed');
      await shot(tester, '22-detail-timeout');
      await back(tester);
    });
    await step(tester, 'mocked', () async {
      await openRow(tester, '/v2/promotions');
      await shot(tester, '23-detail-mocked');
      await back(tester);
    });
    await step(tester, 'graphql', () async {
      await openRow(tester, 'VetAppointments');
      await shot(tester, '24-detail-graphql');
      await tapLabel(tester, tr.request);
      await tapLabel(tester, tr.body);
      await shot(tester, '25-detail-graphql-request');
      await back(tester);
    });
    await step(tester, 'pending', () async {
      await openRow(tester, '/v2/notifications');
      await shot(tester, '26-detail-pending');
      await back(tester);
    });
  });

  gallery('share', (tester) async {
    await openPanel(tester);
    await step(tester, 'share sheet', () async {
      await openRow(tester, '/v2/cart/items');
      await tester.tap(find.byTooltip(tr.share).first);
      await settle(tester);
      await shot(tester, '27-share-sheet');
    });
  });

  /* Logs */

  gallery('logs', (tester) async {
    await openPanel(tester);
    await tester.tap(find.byTooltip(tr.logs).first);
    await settle(tester);
    await shot(tester, '30-logs-list');
    await step(tester, 'log filters', () async {
      await tester.tap(find.byType(FilterButton).hitTestable().first);
      await settle(tester);
      await shot(tester, '31-logs-filters');
      await tapText(tester, tr.done);
    });
    await step(tester, 'error detail', () async {
      await openRow(tester, 'Randevular yüklenemedi');
      await shot(tester, '32-log-detail-error');
      await back(tester);
    });
    await step(tester, 'crash detail', () async {
      await openRow(tester, 'Cart is empty');
      await shot(tester, '33-log-detail-crash');
      await back(tester);
    });
    await step(tester, 'data detail', () async {
      await openRow(tester, 'Sepet güncellendi');
      await shot(tester, '34-log-detail-data');
      await back(tester);
    });
  });

  /* Tools */

  gallery('tools', (tester) async {
    final s = await openPanel(tester);
    await openTools(tester);
    await shot(tester, '40-tools-sheet');
    await step(tester, 'tools scrolled', () async {
      await tester.drag(find.byType(Scrollable).last, const Offset(0, -400));
      await settle(tester);
      await shot(tester, '41-tools-sheet-scrolled');
      await back(tester);
    });
    await step(tester, 'performance', () async {
      await tapTool(tester, tr.performance);
      await shot(tester, '42-performance');
      await tester.drag(find.byType(Scrollable).last, const Offset(0, -600));
      await settle(tester);
      await shot(tester, '43-performance-scrolled');
      await back(tester);
    });
    await step(tester, 'statistics', () async {
      await tapTool(tester, tr.statistics);
      await shot(tester, '44-statistics');
      await tester.drag(find.byType(Scrollable).last, const Offset(0, -600));
      await settle(tester);
      await shot(tester, '45-statistics-scrolled');
      await back(tester);
    });
    await step(tester, 'device', () async {
      await tapTool(tester, tr.deviceAndSdk);
      await shot(tester, '46-device-sdk');
      await tester.scrollUntilVisible(find.text(tr.notCapturedTitle), 300, scrollable: find.byType(Scrollable).last);
      await settle(tester);
      await shot(tester, '47-device-sdk-not-captured');
      await back(tester);
    });
    await step(tester, 'export', () async {
      await tapTool(tester, tr.exportSession);
      await shot(tester, '48-export-sheet');
      await back(tester);
    });
    await step(tester, 'previous off', () async {
      await tapTool(tester, tr.previousRun);
      await shot(tester, '49-previous-run-off');
      await back(tester);
    });
    await step(tester, 'clear confirm', () async {
      await tapTool(tester, tr.clearAll);
      await shot(tester, '50-clear-confirm');
      await tapText(tester, tr.cancel);
    });
    expect(s.calls, isNotEmpty);
  });

  gallery('performance empty', (tester) async {
    await openPanel(tester, store: patiStore(withMetrics: false));
    await tapTool(tester, tr.performance);
    await shot(tester, '55-performance-empty');
  });

  gallery('previous run', (tester) async {
    final none = patiStore();
    RunJournal.register(none, GalleryJournal(null));
    await openPanel(tester, store: none, keep: true);
    await step(tester, 'none', () async {
      await openTools(tester);
      await tester.scrollUntilVisible(find.text(tr.previousRun), 120, scrollable: find.byType(Scrollable).last);
      await settle(tester);
      await shot(tester, '51-tools-previous-none');
      await back(tester);
    });

    final empty = patiStore();
    RunJournal.register(empty, GalleryJournal(null, previous: PreviousRunInfo(savedAt: DateTime.now(), bytes: 1)));
    await openPanel(tester, store: empty, keep: true);
    await step(tester, 'empty', () async {
      await tapTool(tester, tr.previousRun);
      await shot(tester, '52-previous-run-empty');
    });

    final full = patiStore();
    final records = previousRecords();
    RunJournal.register(
        full,
        GalleryJournal(records,
            previous: PreviousRunInfo(savedAt: DateTime.now().subtract(const Duration(minutes: 31)), bytes: 48200)));
    await openPanel(tester, store: full, keep: true);
    await step(tester, 'with data', () async {
      await tapTool(tester, tr.previousRun);
      await shot(tester, '53-previous-run');
      await tester.tap(find.byTooltip(tr.network).first);
      await settle(tester);
      await shot(tester, '54-previous-run-network');
    });
  });

  /* The SDK running: Mac connection and app tools. */

  gallery('connection', (tester) async {
    final port = await tester.runAsync(deadPort);
    addPatiActions();
    await startSdk(tester, port!);
    try {
      await tester.pumpWidget(patiApp());
      await tester.runAsync(() => eventually(() => durbunBackend().connectionReport?.attempts.isNotEmpty ?? false));
      Durbun.showInspector();
      await settle(tester);
      await step(tester, 'tools not connected', () async {
        await openTools(tester);
        await shot(tester, '60-tools-not-connected');
        await back(tester);
      });
      await step(tester, 'not connected', () async {
        await tapTool(tester, tr.macConnection);
        await shot(tester, '61-connection-not-connected');
        await tester.enterText(find.byKey(const ValueKey<String>('durbun-mac-address')), 'ayşenin mac');
        await tester.tap(find.text(tr.connect).first);
        await tester.pump();
        await settle(tester);
        await shot(tester, '62-connection-bad-address');
        await back(tester);
      });
      await step(tester, 'app tools', () async {
        await tapTool(tester, tr.appTools);
        await shot(tester, '63-app-tools');
        await back(tester);
      });
    } finally {
      await stopSdk(tester);
    }
  });

  gallery('connected', (tester) async {
    FakeDesktop? desktop;
    await tester.runAsync(() async => desktop = await FakeDesktop.start(appId: 'app:pati', mocks: <Map<String, Object?>>[
          <String, Object?>{
            'id': 'rule-promos',
            'name': 'Kampanyalar: kış',
            'enabled': true,
            'method': 'GET',
            'url': '/v2/promotions',
            'match': 'contains',
            'action': <String, Object?>{'type': 'respond', 'status': 200, 'delayMs': 300, 'body': '{"items":[]}'},
          },
        ]));
    await startSdk(tester, desktop!.port);
    try {
      await tester.pumpWidget(patiApp());
      await tester.runAsync(() => eventually(() => Durbun.isConnected));
      Durbun.showInspector();
      await settle(tester);
      await shot(tester, '64-network-connected-empty');
      await step(tester, 'tools connected', () async {
        await openTools(tester);
        await shot(tester, '65-tools-connected');
        await back(tester);
      });
      await step(tester, 'connection connected', () async {
        await tapTool(tester, tr.macConnection);
        await shot(tester, '66-connection-connected');
        await back(tester);
      });
      await step(tester, 'mocks', () async {
        await tapTool(tester, tr.mocks);
        await shot(tester, '67-mocks');
        await back(tester);
      });
    } finally {
      await stopSdk(tester);
      await tester.runAsync(() async => desktop?.close());
    }
  });

  gallery('sdk not started', (tester) async {
    await tester.pumpWidget(patiApp());
    DurbunInspector.show();
    await settle(tester);
    await shot(tester, '70-sdk-not-started');
  });

  gallery('sdk off', (tester) async {
    await tester.runAsync(() => Durbun.init(const DurbunOptions(enabled: false)));
    try {
      await tester.pumpWidget(patiApp());
      DurbunInspector.show();
      await settle(tester);
      await shot(tester, '71-sdk-off');
    } finally {
      await stopSdk(tester);
    }
  });

  gallery('first launch hint', (tester) async {
    await tester.pumpWidget(patiApp(
      store: patiStore(),
      overlay: ShakeHint(simulator: true, onDismiss: () {}),
    ));
    await shot(tester, '72-first-launch-hint');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(patiApp(store: patiStore(), bubble: true));
    await shot(tester, '73-bubble');
  });

  /* Sizes */

  gallery('landscape', (tester) async {
    await openPanel(tester);
    await shot(tester, '80-landscape-network');
    await step(tester, 'landscape detail', () async {
      await tester.tap(find.byType(CallRow).at(1));
      await settle(tester);
      await shot(tester, '81-landscape-detail');
    });
  }, size: kLandscape);

  gallery('tablet', (tester) async {
    await openPanel(tester);
    await shot(tester, '82-tablet-network');
    await step(tester, 'tablet tools', () async {
      await openTools(tester);
      await shot(tester, '83-tablet-tools');
    });
  }, size: kTablet);

  gallery('large text', (tester) async {
    await openPanel(tester);
    await shot(tester, '84-text130-network');
    await step(tester, 'large detail', () async {
      await openRow(tester, '/v2/vets/nearby');
      await shot(tester, '85-text130-detail');
      await back(tester);
    });
    await step(tester, 'large logs', () async {
      await tester.tap(find.byTooltip(tr.logs).first);
      await settle(tester);
      await shot(tester, '86-text130-logs');
    });
    await step(tester, 'large tools', () async {
      await openTools(tester);
      await shot(tester, '87-text130-tools');
    });
  }, textScale: 1.3);

  /* Contact sheets: four screens side by side at pixel ratio 1. */

  testWidgets('contact sheets', (tester) async {
    await tester.runAsync(() async {
      for (final theme in <String>['light', 'dark']) {
        final shots = _shots[theme]!;
        final phone = <(String, Size)>[for (final s in shots) if (s.$2 == kPhone) s];
        final other = <(String, Size)>[for (final s in shots) if (s.$2 != kPhone) s];
        final groups = <List<(String, Size)>>[
          for (var i = 0; i < phone.length; i += 4) phone.sublist(i, (i + 4).clamp(0, phone.length)),
          for (var i = 0; i < other.length; i += 2) other.sublist(i, (i + 2).clamp(0, other.length)),
        ];
        for (var g = 0; g < groups.length; g++) {
          await _sheet(groups[g], theme, 'sheet-${(g + 1).toString().padLeft(2, '0')}-$theme.png');
        }
      }
      File('$_outDir/errors.txt').writeAsStringSync('${_errors.join('\n')}\n');
    });
  }, skip: _skip);
}

Future<void> _sheet(List<(String, Size)> shots, String theme, String file) async {
  const pad = 24.0, gap = 24.0, label = 28.0;
  final height = shots.map((s) => s.$2.height).reduce((a, b) => a > b ? a : b);
  final width = shots.fold<double>(0, (w, s) => w + s.$2.width) + gap * (shots.length - 1) + pad * 2;
  final total = Size(width, height + label + pad * 2);
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  final dark = theme == 'dark';
  canvas.drawRect(Offset.zero & total, Paint()..color = dark ? const Color(0xFF2A2D33) : const Color(0xFFD9DCE2));
  var x = pad;
  for (final (name, size) in shots) {
    final bytes = File('$_outDir/$name-$theme.png').readAsBytesSync();
    final codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    final image = frame.image;
    canvas.drawImageRect(
      image,
      Offset.zero & Size(image.width.toDouble(), image.height.toDouble()),
      Offset(x, pad + label) & size,
      Paint()..filterQuality = FilterQuality.high,
    );
    final pb = ui.ParagraphBuilder(ui.ParagraphStyle(fontFamily: 'Roboto', fontSize: 14))
      ..pushStyle(ui.TextStyle(color: dark ? const Color(0xFFE6E9F0) : const Color(0xFF161A23)))
      ..addText(name);
    final p = pb.build()..layout(ui.ParagraphConstraints(width: size.width));
    canvas.drawParagraph(p, Offset(x, pad));
    image.dispose();
    x += size.width + gap;
  }
  final picture = recorder.endRecording();
  final image = await picture.toImage(total.width.ceil(), total.height.ceil());
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  File('$_outDir/$file').writeAsBytesSync(data!.buffer.asUint8List());
  image.dispose();
}
