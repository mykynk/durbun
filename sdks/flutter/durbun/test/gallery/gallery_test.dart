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
import 'package:durbun/src/core/protocol.dart' show buildErrorInfo, buildLog, buildNetWs;
import 'package:durbun/src/flutter/durbun.dart' show durbunBackend;
import 'package:durbun/src/inspector/bug_report_view.dart';
import 'package:durbun/src/inspector/export_sheet.dart' show debugExportWriter;
import 'package:durbun/src/inspector/filter_ui.dart' show FilterButton;
import 'package:durbun/src/inspector/home.dart' show PanelNavBar;
import 'package:durbun/src/inspector/inspector.dart' show ShakeHint;
import 'package:durbun/src/inspector/logs_view.dart' show LogRow;
import 'package:durbun/src/inspector/network_view.dart' show CallRow;
import 'package:durbun/src/inspector/run_log.dart';
import 'package:durbun/src/inspector/share_sheet.dart' show debugShareHandler;
import 'package:durbun/src/inspector/slack.dart' show debugPostSlackForm, debugPostToSlack, debugResetSlackJoins;
import 'package:durbun/src/inspector/slack_sender.dart' show debugResetSlackSender;
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/theme.dart' show debugResetPanelTheme;
import 'package:durbun/src/inspector/widgets.dart' show DButton;
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
Widget patiApp(
        {DurbunInspectorStore? store,
        bool keepPreviousRun = false,
        bool bubble = false,
        Widget? overlay,
        DurbunPanelTools tools = const DurbunPanelTools(),
        bool networkBadge = true,
        bool logsBadge = true}) =>
    RepaintBoundary(
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
          tools: tools,
          showNetworkBadge: networkBadge,
          showLogsBadge: logsBadge,
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

/// A page of the bottom bar, by its label.
Future<void> openTab(WidgetTester tester, String label) async {
  await tester.tap(find.byTooltip(label).first);
  await settle(tester);
}

Future<void> openTools(WidgetTester tester) => openTab(tester, tr.tools);

/// The vertical list on show: the top page's, not one of the tabs kept
/// built offstage.
Finder shownList() => find
    .byWidgetPredicate((w) => w is Scrollable && axisDirectionToAxis(w.axisDirection) == Axis.vertical)
    .hitTestable()
    .last;

Future<void> tapTool(WidgetTester tester, String label) async {
  await openTools(tester);
  final f = find.text(label);
  await tester.scrollUntilVisible(f, 120, scrollable: shownList());
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
  // The list of the page on show (the other tabs stay built offstage).
  final rows = find.byWidgetPredicate((w) => w is CallRow || w is LogRow).hitTestable();
  final list = find
      .ancestor(
          of: rows.first,
          matching: find.byWidgetPredicate((w) => w is Scrollable && axisDirectionToAxis(w.axisDirection) == Axis.vertical))
      .first;
  // A row under the floating bar is drawn but not tappable: hit-testable at
  // the point the tap lands on means above the bar.
  bool clear() {
    final hits = f.hitTestable().evaluate();
    if (hits.isEmpty) return false;
    final box = hits.first.renderObject! as RenderBox;
    final centre = box.localToGlobal(box.size.center(Offset.zero));
    final barTop = find.byType(PanelNavBar).evaluate().isEmpty
        ? double.infinity
        : tester.getTopLeft(find.byType(PanelNavBar)).dy;
    return centre.dy < barTop - 4;
  }

  if (!clear()) {
    // Start from the top so the search only has to scroll one way.
    tester.state<ScrollableState>(list).position.jumpTo(0);
    await tester.pump();
    for (var i = 0; i < 40 && !clear(); i++) {
      await tester.drag(list, const Offset(0, -160));
      await tester.pump();
    }
  }
  await settle(tester);
  await tester.tap(f.hitTestable().first);
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
    await step(tester, 'sort', () async {
      await openPanel(tester);
      await tester.tap(find.byTooltip(tr.sortTitle).first);
      await settle(tester);
      await shot(tester, '08-network-sort');
      await back(tester);
    });
    await step(tester, 'scrolled', () async {
      await tester.drag(find.byType(CallRow).first, const Offset(0, -300));
      await settle(tester);
      await shot(tester, '09-network-scrolled');
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
    await step(tester, 'jwt', () async {
      await tester.tap(find.text('Authorization').first);
      await settle(tester);
      // A tap opens the claims; a long token asks first (claims or full value).
      if (find.text(tr.decodeJwt).evaluate().isNotEmpty) await tapText(tester, tr.decodeJwt, last: true);
      await shot(tester, '19-detail-jwt');
      await back(tester);
    });
    await step(tester, 'copied toast', () async {
      await tester.tap(find.byTooltip(tr.copyUrl).first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await shot(tester, '29-toast-copied');
      await settle(tester);
    });
    await step(tester, 'response json', () async {
      await tapLabel(tester, tr.response);
      await tapLabel(tester, tr.body);
      await shot(tester, '12-detail-response-json');
    });
    await step(tester, 'body search', () async {
      await tester.tap(find.byTooltip(tr.find).first);
      await settle(tester);
      await tester.enterText(find.byType(TextField).last, 'Boncuk');
      await tester.pump(const Duration(milliseconds: 400));
      await settle(tester);
      await shot(tester, '28-detail-body-search');
      await tester.tap(find.byTooltip(tr.find).first);
      await settle(tester);
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
    await step(tester, 'websocket', () async {
      await openRow(tester, '/v2/chat');
      await shot(tester, '26a-detail-websocket');
      await tapLabel(tester, tr.response);
      expect(find.text(tr.webSocketBody), findsOneWidget);
      await shot(tester, '26b-detail-websocket-response');
      await back(tester);
    });
    await step(tester, 'event stream', () async {
      await openRow(tester, '/v2/live/adoptions');
      await tapLabel(tester, tr.response);
      expect(find.text(tr.eventStreamBody), findsOneWidget);
      await shot(tester, '26c-detail-event-stream-response');
      await back(tester);
    });
  });

  /* WebSocket and event stream messages */

  gallery('streams', (tester) async {
    final store = await openPanel(tester, store: streamsStore());
    await shot(tester, 's01-streams-list');
    await step(tester, 'chat messages', () async {
      await openRow(tester, '/v2/chat');
      await shot(tester, 's02-ws-messages');
    });
    await step(tester, 'new messages pill', () async {
      final list = find
          .ancestor(of: find.textContaining('appointment.confirmed', findRichText: true), matching: find.byType(Scrollable))
          .first;
      await tester.drag(list, const Offset(0, 260));
      await tester.pump();
      final now = DateTime.now().millisecondsSinceEpoch.toDouble();
      for (var i = 0; i < 3; i++) {
        final body = textBody('{"type":"typing","from":"Dr. Elif Kaya","n":$i}');
        store.ingest(buildNetWs(id: '30', ts: now + i * 400, dir: 'in', opcode: 'text', size: body.size, body: body));
      }
      await settle(tester);
      await shot(tester, 's03-ws-new-messages-pill');
      await tapText(tester, tr.newMessages(3));
    });
    await step(tester, 'ping pong', () async {
      await tester.tap(find.textContaining(tr.controlHidden(6)).first);
      await settle(tester);
      await shot(tester, 's04-ws-ping-pong-shown');
      await tester.tap(find.text(tr.controlLabel).first);
      await settle(tester);
    });
    await step(tester, 'search', () async {
      await tester.enterText(find.byType(TextField).hitTestable().first, 'apt_91');
      await settle(tester);
      await shot(tester, 's05-ws-search');
      await tester.tap(find.byTooltip(tr.clearSearch).first);
      await settle(tester);
    });
    await step(tester, 'json message', () async {
      await tester.tap(find.textContaining('appointment.proposed', findRichText: true).first);
      await settle(tester);
      await shot(tester, 's06-ws-message-json');
      await back(tester);
    });
    await step(tester, 'binary message', () async {
      await tester.enterText(find.byType(TextField).hitTestable().first, 'ff d8');
      await settle(tester);
      await tester.tap(find.textContaining('ff d8 ff e0', findRichText: true).first);
      await settle(tester);
      await shot(tester, 's07-ws-message-binary');
      await back(tester);
    });
    await step(tester, 'share message', () async {
      await tester.enterText(find.byType(TextField).hitTestable().first, 'auth');
      await settle(tester);
      await tester.tap(find.textContaining('"token"', findRichText: true).first);
      await settle(tester);
      await shot(tester, 's08-ws-message-auth');
      await tester.tap(find.byTooltip(tr.share).first);
      await settle(tester);
      await shot(tester, 's09-ws-message-share-masked');
      await back(tester);
      await back(tester);
      await back(tester);
    });
    await step(tester, 'closed', () async {
      await openRow(tester, '/v2/tracking');
      await shot(tester, 's10-ws-closed-by-server');
      await tester.tap(find.textContaining('server restart', findRichText: true).first);
      await settle(tester);
      await shot(tester, 's11-ws-close-frame');
      await back(tester);
      await back(tester);
    });
    await step(tester, 'failed', () async {
      await openRow(tester, '/v2/notifications');
      await shot(tester, 's12-ws-broke');
      await back(tester);
    });
    await step(tester, 'open empty', () async {
      await openRow(tester, '/v2/live/vet-queue');
      await shot(tester, 's13-ws-open-no-messages');
      await back(tester);
    });
    await step(tester, 'not followed', () async {
      await openRow(tester, '/v1/stream');
      await shot(tester, 's14-ws-okhttp-mac-only');
      await back(tester);
    });
    await step(tester, 'event stream', () async {
      await openRow(tester, '/v2/live/adoptions');
      await shot(tester, 's15-sse-events');
      await tester.tap(find.textContaining('Badem', findRichText: true).first);
      await settle(tester);
      await shot(tester, 's16-sse-event');
      await back(tester);
      await back(tester);
    });
    await step(tester, 'dropped', () async {
      await openRow(tester, '/v2/shop/ticker');
      await shot(tester, 's17-ws-ring-full');
      final list = find
          .ancestor(of: find.textContaining('MAMA-KEDI', findRichText: true).first, matching: find.byType(Scrollable))
          .first;
      final gap = find.textContaining(tr.streamGapHead(20, 180));
      for (var i = 0; i < 30 && gap.hitTestable().evaluate().isEmpty; i++) {
        await tester.drag(list, const Offset(0, 400));
        await tester.pump();
      }
      await settle(tester);
      // The gap in the middle of the card.
      await tester.drag(list, const Offset(0, -120));
      await shot(tester, 's18-ws-dropped-gap');
      await back(tester);
    });
    await step(tester, 'general', () async {
      await openRow(tester, '/v2/chat');
      await tapLabel(tester, tr.general);
      await shot(tester, 's19-ws-general');
      await tapLabel(tester, tr.response);
      await shot(tester, 's20-ws-response');
      await back(tester);
    });
  });

  for (final (name, scale) in <(String, double)>[('text130', 1.3), ('text200', 2)]) {
    gallery('streams $name', (tester) async {
      await openPanel(tester, store: streamsStore());
      await shot(tester, 's30-$name-streams-list');
      await step(tester, 'messages', () async {
        await openRow(tester, '/v2/chat');
        await shot(tester, 's31-$name-ws-messages');
        await tester.tap(find.textContaining('appointment.confirmed', findRichText: true).hitTestable().first);
        await settle(tester);
        await shot(tester, 's32-$name-ws-message-json');
        await back(tester);
        await back(tester);
      });
      await step(tester, 'closed', () async {
        await openPanel(tester, store: streamsStore());
        await openRow(tester, '/v2/tracking');
        await shot(tester, 's33-$name-ws-closed');
        await back(tester);
      });
    }, textScale: scale);
  }

  gallery('streams landscape', (tester) async {
    await openPanel(tester, store: streamsStore());
    await step(tester, 'messages', () async {
      await openRow(tester, '/v2/chat');
      await shot(tester, 's40-landscape-ws-messages');
      await tester.tap(find.textContaining('appointment.confirmed', findRichText: true).hitTestable().first);
      await settle(tester);
      await shot(tester, 's41-landscape-ws-message-json');
      await back(tester);
      await back(tester);
    });
    await step(tester, 'events', () async {
      await openPanel(tester, store: streamsStore());
      await openRow(tester, '/v2/live/adoptions');
      await shot(tester, 's42-landscape-sse-events');
    });
  }, size: kLandscape);

  gallery('streams landscape text200', (tester) async {
    await openPanel(tester, store: streamsStore());
    await step(tester, 'messages', () async {
      await openRow(tester, '/v2/chat');
      await shot(tester, 's43-landscape-text200-ws-messages');
      await tester.tap(find.text('text').hitTestable().last);
      await settle(tester);
      await shot(tester, 's44-landscape-text200-ws-message');
    });
  }, size: kLandscape, textScale: 2);

  gallery('share', (tester) async {
    final store = await openPanel(tester);
    await step(tester, 'share sheet', () async {
      await openRow(tester, '/v2/cart/items');
      await tester.tap(find.byTooltip(tr.share).first);
      await settle(tester);
      await shot(tester, '27-share-sheet');
      await back(tester);
      await back(tester);
    });
    await step(tester, 'share sheet with Slack, a message and a name', () async {
      store.slackWebhook = 'https://hooks.slack.com/services/T000/B000/abcd';
      addTearDown(() {
        store.slackWebhook = null;
        debugResetSlackSender();
      });
      await openRow(tester, '/v2/cart/items');
      await tester.tap(find.byTooltip(tr.share).first);
      await settle(tester);
      final name = find.byKey(const ValueKey<String>('durbun-slack-sender'));
      await tester.ensureVisible(name);
      await tester.enterText(name, 'Ayşe');
      final note = find.byKey(const ValueKey<String>('durbun-share-note'));
      await tester.ensureVisible(note);
      await tester.enterText(note, 'Sepete ekleme ikinci denemede bozuluyor');
      FocusManager.instance.primaryFocus?.unfocus();
      await settle(tester);
      await shot(tester, '27b-share-sheet-slack-message');
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

  gallery('stack without symbols, masked log share', (tester) async {
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    const dwarf = '*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***\n'
        'pid: 4711, tid: 4730, name 1.ui\n'
        'os: android arch: arm64 comp: yes sim: no\n'
        "build_id: '6c3e1a0f9b2d4e7a8c1b5d3f0e9a7c42'\n"
        'isolate_dso_base: 7a5e1c8000, vm_dso_base: 7a5e1c8000\n'
        'isolate_instructions: 7a5e2d4000, vm_instructions: 7a5e2c0000\n'
        '    #00 abs 0000007a5e3d33f3 virt 00000000002793f3 _kDartIsolateSnapshotInstructions+0x1c13f3\n'
        '    #01 abs 0000007a5e3d2a10 virt 0000000000278a10 _kDartIsolateSnapshotInstructions+0x1c0a10\n'
        '    #02 abs 0000007a5e3b9c4c virt 000000000025fc4c _kDartIsolateSnapshotInstructions+0x1a7c4c';
    final s = patiStore()
      ..ingest(buildLog(
          level: 'info',
          message: 'Oturum yenilendi',
          tag: 'auth',
          ts: now - 2000,
          data: <String, Object?>{'userId': 8812, 'accessToken': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4ODEyIn0.c2ln', 'otp': 482913}))
      ..ingest(buildLog(
          level: 'fatal',
          message: 'Unhandled exception: Null check operator used on a null value',
          kind: 'crash',
          ts: now - 1000,
          error: buildErrorInfo(type: '_TypeError', message: 'Null check operator used on a null value', stack: dwarf),
          data: <String, Object?>{'source': 'zone', 'symbolize': 'flutter symbolize -i stack.txt -d <split-debug-info folder>/app.android-arm64.symbols'}));
    await openPanel(tester, store: s);
    await tester.tap(find.byTooltip(tr.logs).first);
    await settle(tester);
    await step(tester, 'no symbols message', () async {
      await openRow(tester, 'Null check operator');
      await shot(tester, '35-log-detail-no-symbols');
      await tapLabel(tester, tr.stack);
      await shot(tester, '36-log-stack-no-symbols');
      await back(tester);
    });
    await step(tester, 'masked log share', () async {
      await openRow(tester, 'Oturum yenilendi');
      await tester.tap(find.byTooltip(tr.shareLogTitle).first);
      await settle(tester);
      await shot(tester, '37-log-share-masked');
    });
  });

  gallery('large text: stack without symbols', (tester) async {
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final s = DurbunInspectorStore(notifyDelay: Duration.zero)
      ..ingest(patiHello())
      ..ingest(buildLog(
          level: 'fatal',
          message: 'Unhandled exception: Null check operator used on a null value',
          kind: 'crash',
          ts: now - 1000,
          error: buildErrorInfo(
              type: '_TypeError',
              message: 'Null check operator used on a null value',
              stack: '*** *** ***\nos: ios arch: arm64 comp: yes sim: no\nisolate_dso_base: 104d1c000, vm_dso_base: 104d1c000\n'
                  '    #00 abs 0000000104f2a3f3 virt 000000000020e3f3 _kDartIsolateSnapshotInstructions+0x1c13f3')));
    await openPanel(tester, store: s);
    await tester.tap(find.byTooltip(tr.logs).first);
    await settle(tester);
    await step(tester, 'large no symbols', () async {
      await openRow(tester, 'Null check operator');
      await tapLabel(tester, tr.stack);
      await shot(tester, '38-text200-stack-no-symbols');
    });
  }, textScale: 2);

  /* Tools */

  gallery('tools', (tester) async {
    final s = await openPanel(tester);
    await openTools(tester);
    await shot(tester, '40-tools-sheet');
    await step(tester, 'tools scrolled', () async {
      await tester.drag(shownList(), const Offset(0, -400));
      await settle(tester);
      await shot(tester, '41-tools-sheet-scrolled');
    });
    await step(tester, 'performance', () async {
      await openTab(tester, tr.performance);
      await shot(tester, '42-performance');
      await tester.drag(shownList(), const Offset(0, -600));
      await settle(tester);
      await shot(tester, '43-performance-scrolled');
    });
    await step(tester, 'statistics', () async {
      await tapTool(tester, tr.statistics);
      await shot(tester, '44-statistics');
      await tester.drag(shownList(), const Offset(0, -600));
      await settle(tester);
      await shot(tester, '45-statistics-scrolled');
      await back(tester);
    });
    await step(tester, 'device', () async {
      await tapTool(tester, tr.deviceAndSdk);
      await shot(tester, '46-device-sdk');
      await tester.scrollUntilVisible(find.text(tr.notCapturedTitle), 300, scrollable: shownList());
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
    await openTab(tester, tr.performance);
    await shot(tester, '55-performance-empty');
  });

  gallery('previous run', (tester) async {
    final none = patiStore();
    RunJournal.register(none, GalleryJournal(null));
    await openPanel(tester, store: none, keep: true);
    await step(tester, 'none', () async {
      await openTools(tester);
      await tester.scrollUntilVisible(find.text(tr.previousRun), 120, scrollable: shownList());
      await settle(tester);
      await shot(tester, '51-tools-previous-none');
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
      });
      await step(tester, 'not connected', () async {
        // No Mac in reach yet: no tile; Device & SDK leads to the page.
        await tapTool(tester, tr.deviceAndSdk);
        final button = find.widgetWithText(DButton, tr.macConnection);
        await tester.ensureVisible(button);
        await settle(tester);
        await tester.tap(button);
        await settle(tester);
        await shot(tester, '61-connection-not-connected');
        await tester.enterText(find.byKey(const ValueKey<String>('durbun-mac-address')), 'ayşenin mac');
        await tester.tap(find.text(tr.connect).first);
        await tester.pump();
        await settle(tester);
        await shot(tester, '62-connection-bad-address');
        await back(tester);
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

  /* Report a bug */

  gallery('bug report', (tester) async {
    _fakeBugShare();
    final store = await openPanel(tester);
    await step(tester, 'with Slack', () async {
      // A connection with the upload key; the bot is not in the channel, so
      // the page shows the "screenshot did not go" notice.
      store.slackWebhook = 'https://hooks.slack.com/services/T000/B000/abcd#token=xoxb-1234-5678-abcdEFGH&channel=C0123ABCD';
      debugPostToSlack = (url, payload) async => (status: 200, answer: 'ok');
      debugPostSlackForm = (url, token, form) async => (status: 200, answer: '{"ok":false,"error":"not_in_channel"}');
      addTearDown(() {
        debugPostToSlack = null;
        debugPostSlackForm = null;
        debugResetSlackJoins();
      });
      await openTab(tester, tr.logs);
      await openRow(tester, 'Cart is empty');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-log-bug')));
      await settle(tester);
      await shot(tester, '114-bug-report-slack');
      await tester.ensureVisible(find.byKey(const ValueKey<String>('durbun-slack-sender')));
      await settle(tester);
      await shot(tester, '114b-bug-report-slack-name');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-bug-slack')));
      await settle(tester);
      await shot(tester, '115-bug-report-slack-no-shot');
      store.slackWebhook = null;
      await back(tester);
      await back(tester);
    });
    await step(tester, 'from a crash', () async {
      await openTab(tester, tr.logs);
      await openRow(tester, 'Cart is empty');
      await shot(tester, '100-log-detail-crash-report');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-log-bug')));
      await settle(tester);
      await shot(tester, '101-bug-report-crash');
      await _typeNote(tester);
      await _revealBug(tester, find.text(tr.bugScreenshotRemove));
      await shot(tester, '102-bug-report-note');
      await tapText(tester, tr.bugScreenshotRemove);
      await shot(tester, '103-bug-report-screenshot-out');
      await tapText(tester, tr.bugScreenshotAdd);
      await tester.tap(find.bySemanticsLabel(tr.bugScreenshotEnlarge).first);
      await settle(tester);
      await shot(tester, '104-bug-report-enlarged');
      await tester.tap(find.byTooltip(tr.close).last);
      await settle(tester);
      await tester.drag(find.byKey(const ValueKey<String>('durbun-bug-list')), const Offset(0, -2000));
      await settle(tester);
      await shot(tester, '105-bug-report-end');
      // The tester picks what goes: logs and device facts out.
      for (final key in <String>['durbun-bug-part-logs', 'durbun-bug-part-facts']) {
        final row = find.byKey(ValueKey<String>(key));
        await tester.ensureVisible(row);
        await settle(tester);
        await tester.tap(row);
        await settle(tester);
      }
      await shot(tester, '105b-bug-report-parts-off');
      final preview = find.byKey(const ValueKey<String>('durbun-bug-preview'));
      await tester.ensureVisible(preview);
      await settle(tester);
      await tester.tap(preview);
      await settle(tester);
      await tester.drag(find.byKey(const ValueKey<String>('durbun-bug-list')), const Offset(0, -500));
      await settle(tester);
      await shot(tester, '105c-bug-report-preview');
      await tester.tap(preview);
      await settle(tester);
      for (final key in <String>['durbun-bug-part-logs', 'durbun-bug-part-facts']) {
        await tester.dragUntilVisible(
            find.byKey(ValueKey<String>(key)), find.byKey(const ValueKey<String>('durbun-bug-list')), const Offset(0, 200));
        await settle(tester);
        await tester.tap(find.byKey(ValueKey<String>(key)));
        await settle(tester);
      }
      await tapText(tester, tr.shareSend);
      await shot(tester, '106-bug-report-text-only');
      await back(tester);
      await back(tester);
    });
    await step(tester, 'from a failed request', () async {
      await openTab(tester, tr.network);
      await openRow(tester, '/v2/vets/nearby');
      await tester.tap(find.byTooltip(tr.moreActions).first);
      await settle(tester);
      await shot(tester, '107-request-more-menu');
      await tapText(tester, tr.bugReportEllipsis);
      await shot(tester, '108-bug-report-request');
      await back(tester);
      await tester.tap(find.byTooltip(tr.share).first);
      await settle(tester);
      await shot(tester, '109-share-sheet-bug-row');
      await back(tester);
      await back(tester);
    });
    await step(tester, 'from Tools', () async {
      await openTools(tester);
      await shot(tester, '110-tools-report-card');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-tools-bug')));
      await settle(tester);
      await shot(tester, '111-bug-report-empty');
      await tapText(tester, tr.bugMinutes(5));
      await shot(tester, '112-bug-report-now-5min');
      await back(tester);
    });
    await step(tester, 'statistics', () async {
      await tapTool(tester, tr.statistics);
      await shot(tester, '113-statistics-equal-tiles');
    });
  });

  gallery('bug report large text', (tester) async {
    _fakeBugShare();
    await openPanel(tester);
    await step(tester, 'large crash report', () async {
      await openTab(tester, tr.logs);
      await openRow(tester, 'Cart is empty');
      await shot(tester, '114-text130-log-detail-crash');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-log-bug')));
      await settle(tester);
      await shot(tester, '115-text130-bug-report');
      await tester.drag(find.byKey(const ValueKey<String>('durbun-bug-list')), const Offset(0, -500));
      await settle(tester);
      await shot(tester, '116-text130-bug-report-scrolled');
    });
  }, textScale: 1.3);

  gallery('bug report text 200', (tester) async {
    _fakeBugShare();
    await openPanel(tester);
    await step(tester, 'text 200 crash report', () async {
      await openTab(tester, tr.logs);
      await openRow(tester, 'Cart is empty');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-log-bug')));
      await settle(tester);
      await shot(tester, '117-text200-bug-report');
      await tester.drag(find.byKey(const ValueKey<String>('durbun-bug-list')), const Offset(0, -700));
      await settle(tester);
      await shot(tester, '118-text200-bug-report-scrolled');
    });
  }, textScale: 2);

  gallery('bug report landscape', (tester) async {
    _fakeBugShare();
    await openPanel(tester);
    await step(tester, 'landscape crash report', () async {
      await openTab(tester, tr.logs);
      await openRow(tester, 'Cart is empty');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-log-bug')));
      await settle(tester);
      await shot(tester, '119-landscape-bug-report');
      await tester.drag(find.byKey(const ValueKey<String>('durbun-bug-list')), const Offset(0, -300));
      await settle(tester);
      await shot(tester, '120-landscape-bug-report-scrolled');
    });
  }, size: kLandscape);

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

  gallery('large text 200', (tester) async {
    await openPanel(tester);
    await shot(tester, '88-text200-network');
    await step(tester, 'large filters', () async {
      await tester.tap(find.byType(FilterButton).hitTestable().first);
      await settle(tester);
      await shot(tester, '89-text200-filters');
      await tapText(tester, tr.done);
    });
    await step(tester, 'large logs 200', () async {
      await openTab(tester, tr.logs);
      await shot(tester, '90-text200-logs');
    });
  }, textScale: 2);

  gallery('landscape logs', (tester) async {
    await openPanel(tester);
    await openTab(tester, tr.logs);
    await shot(tester, '91-landscape-logs');
  }, size: kLandscape);

  gallery('page clear', (tester) async {
    await openPanel(tester);
    await step(tester, 'network clear confirm', () async {
      await tester.tap(find.byTooltip(tr.clearRequests).first);
      await settle(tester);
      await shot(tester, '01b-network-clear-confirm');
      await tapText(tester, tr.cancel);
    });
    await step(tester, 'logs cleared', () async {
      await openTab(tester, tr.logs);
      await tester.tap(find.byTooltip(tr.clearLogs).first);
      await settle(tester);
      await shot(tester, '30b-logs-clear-confirm');
      await tapText(tester, tr.clear, last: true);
      await shot(tester, '30c-logs-cleared');
    });
  });

  gallery('host-limited panel', (tester) async {
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
    await tester.pumpWidget(patiApp(
      store: patiStore(),
      tools: const DurbunPanelTools(previousRun: false, exportSession: false, clearData: false, theme: false),
      networkBadge: false,
      logsBadge: false,
    ));
    await settle(tester);
    Durbun.showInspector();
    await settle(tester);
    await shot(tester, '93-host-no-badges');
    await openTools(tester);
    await shot(tester, '94-host-tools-limited');
  });

  gallery('export error', (tester) async {
    debugExportWriter = (name, chunks) async => throw StateError('disk full');
    addTearDown(() => debugExportWriter = null);
    await openPanel(tester);
    await step(tester, 'export fails', () async {
      await tapTool(tester, tr.exportSession);
      final send = find.text(tr.exportSend);
      await tester.ensureVisible(send);
      await tester.tap(send);
      await settle(tester);
      await shot(tester, '95-export-error');
    });
  });

  gallery('theme switch', (tester) async {
    await openPanel(tester);
    // The switch lives in Tools only.
    await tapTool(tester, tr.darkTheme);
    // Named for the theme it started in: the other one is on screen.
    await shot(tester, '92-theme-switched');
    debugResetPanelTheme();
  });

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

/// Report a bug in the gallery: files "written", a PNG "encoded" (the real
/// encoder needs the engine's own event loop) and a host that shares text
/// only, so the page shows its notice.
void _fakeBugShare() {
  debugBugTextWriter = (name, chunks) async => '/cache/durbun-export/$name';
  debugBugBytesWriter = (name, bytes) async => '/cache/durbun-export/$name';
  debugSnapshotPng = (_) async => Uint8List.fromList(const <int>[137, 80, 78, 71]);
  debugShareHandler = (method, args) async {
    if (method == 'shareFiles') throw MissingPluginException();
    return true;
  };
  addTearDown(() {
    debugBugTextWriter = null;
    debugBugBytesWriter = null;
    debugSnapshotPng = null;
    debugShareHandler = null;
  });
}

Future<void> _typeNote(WidgetTester tester) async {
  await tester.enterText(
      find.byKey(const ValueKey<String>('durbun-bug-note')),
      _lang == 'en'
          ? 'Tapped "Checkout" in the cart and the app closed. Happens every time with 3 items.'
          : 'Sepette "Ödemeye geç"e bastım, uygulama kapandı. 3 ürünle her seferinde oluyor.');
  FocusManager.instance.primaryFocus?.unfocus();
  await settle(tester);
}

/// Scrolls the bug report page until [f] can be tapped.
Future<void> _revealBug(WidgetTester tester, Finder f) async {
  for (var i = 0; i < 20 && f.hitTestable().evaluate().isEmpty; i++) {
    await tester.drag(find.byKey(const ValueKey<String>('durbun-bug-list')), const Offset(0, -160));
    await tester.pump();
  }
  await settle(tester);
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
