// The panel's shell: the floating bottom bar (docked in the header on a
// short screen), the header, the theme switch, the summary tiles above the
// request list and the duration bars of its cards.
import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/filter_ui.dart' show ActiveChip;
import 'package:durbun/src/inspector/home.dart' show PanelNavBar, PanelNavRow;
import 'package:durbun/src/inspector/network_view.dart' show CallRow, durationBarFraction;
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const MethodChannel _shake = MethodChannel('dev.durbun/shake');

/// Three requests (a 200, a 500, one that failed) and an error log.
DurbunInspectorStore _store() => DurbunInspectorStore(notifyDelay: Duration.zero)
  ..ingest(buildNetRequest(id: '1', ts: 1000, method: 'GET', url: 'https://api.example.com/ok', headers: const []))
  ..ingest(buildNetResponse(id: '1', ts: 1200, status: 200, headers: const []))
  ..ingest(buildNetRequest(id: '2', ts: 1001, method: 'GET', url: 'https://api.example.com/broken', headers: const []))
  ..ingest(buildNetResponse(id: '2', ts: 1401, status: 500, headers: const []))
  ..ingest(buildNetRequest(id: '3', ts: 1002, method: 'POST', url: 'https://api.example.com/gone', headers: const []))
  ..ingest(buildNetError(id: '3', ts: 1602, error: 'SocketException: Connection refused'))
  ..ingest(buildLog(level: 'error', message: 'it broke', tag: 't', ts: 1003))
  ..ingest(buildLog(level: 'info', message: 'fine', tag: 't', ts: 1004));

Future<void> _open(WidgetTester tester, DurbunInspectorStore store, {Size size = const Size(390, 844)}) async {
  tester.view.physicalSize = size * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => DurbunInspector(store: store, child: child!),
    home: const Scaffold(body: Text('the app')),
  ));
  Durbun.showInspector();
  await tester.pumpAndSettle();
}

/// The panel's colours as the list draws them.
DurbunColors _colors(WidgetTester tester) => DurbunColors.of(tester.element(find.byType(CallRow).first));

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (_) async => true));
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null);
    debugResetPanelTheme();
  });

  group('bottom bar', () {
    testWidgets('four destinations, each opens its page; errors counted on Network and Logs', (tester) async {
      final semantics = tester.ensureSemantics();
      await _open(tester, _store());
      expect(find.byType(PanelNavBar), findsOneWidget);
      for (final label in <String>['Network', 'Logs', 'Performance', 'Tools']) {
        expect(find.byTooltip(label), findsOneWidget, reason: label);
        final size = tester.getSize(find.byTooltip(label));
        expect(size.height, greaterThanOrEqualTo(44), reason: '$label is easy to tap');
      }
      // The 500 and the failed request; the error log.
      expect(find.bySemanticsLabel(RegExp(r'^Network.*2 errors')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Logs.*1 error')), findsOneWidget);

      await tester.tap(find.byTooltip('Logs'));
      await tester.pumpAndSettle();
      expect(find.text('it broke'), findsOneWidget);
      await tester.tap(find.byTooltip('Performance'));
      await tester.pumpAndSettle();
      expect(find.text('it broke'), findsNothing);
      await tester.tap(find.byTooltip('Tools'));
      await tester.pumpAndSettle();
      expect(find.text('Export session'), findsOneWidget, reason: 'Tools is a page now');
      await tester.tap(find.byTooltip('Network'));
      await tester.pumpAndSettle();
      expect(find.textContaining('/broken'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('the last row clears the bar', (tester) async {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero);
      for (var i = 0; i < 30; i++) {
        s.ingest(buildNetRequest(id: '$i', ts: 1000.0 + i, method: 'GET', url: 'https://api.example.com/r$i', headers: const []));
        s.ingest(buildNetResponse(id: '$i', ts: 1100.0 + i, status: 200, headers: const []));
      }
      await _open(tester, s);
      await tester.drag(find.byType(CallRow).first, const Offset(0, -4000));
      await tester.pumpAndSettle();
      final last = find.textContaining('/r0', findRichText: true);
      expect(tester.getBottomLeft(last).dy, lessThan(tester.getTopLeft(find.byType(PanelNavBar)).dy),
          reason: 'scrolled to the end, the oldest request is above the bar');
    });

    testWidgets('hidden while the keyboard is open and on a pushed page', (tester) async {
      await _open(tester, _store());
      tester.view.viewInsets = const FakeViewPadding(bottom: 300 * 3);
      await tester.pumpAndSettle();
      expect(find.byType(PanelNavBar), findsNothing, reason: 'the keyboard is up');
      tester.view.resetViewInsets();
      await tester.pumpAndSettle();
      expect(find.byType(PanelNavBar), findsOneWidget);

      await tester.tap(find.textContaining('/ok', findRichText: true));
      await tester.pumpAndSettle();
      expect(find.byType(PanelNavBar).hitTestable(), findsNothing, reason: 'the detail covers it');
    });

    testWidgets('a short screen docks the destinations in the header', (tester) async {
      final semantics = tester.ensureSemantics();
      await _open(tester, _store(), size: const Size(844, 390));
      expect(find.byType(PanelNavBar), findsNothing, reason: 'no floating bar over a short list');
      expect(find.byType(PanelNavRow), findsOneWidget);
      for (final label in <String>['Network', 'Logs', 'Performance', 'Tools']) {
        final size = tester.getSize(find.byTooltip(label));
        expect(size.height, greaterThanOrEqualTo(44), reason: '$label is easy to tap');
        expect(size.width, greaterThanOrEqualTo(44), reason: '$label is easy to tap');
      }
      expect(find.bySemanticsLabel(RegExp(r'^Network.*2 errors')), findsOneWidget, reason: 'badges kept');
      final row = find.byType(PanelNavRow);
      expect(find.descendant(of: row, matching: find.text('Network')), findsOneWidget, reason: 'the active one keeps its label');
      expect(find.descendant(of: row, matching: find.text('Logs')), findsNothing, reason: 'the others are icons');
      await tester.tap(find.byTooltip('Logs'));
      await tester.pumpAndSettle();
      expect(find.text('it broke'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a saved run has Network and Logs only', (tester) async {
      final s = _store()..readOnly = true;
      await _open(tester, s);
      expect(find.byTooltip('Network'), findsOneWidget);
      expect(find.byTooltip('Logs'), findsOneWidget);
      expect(find.byTooltip('Performance'), findsNothing);
      expect(find.byTooltip('Tools'), findsNothing);
    });
  });

  group('header', () {
    testWidgets('at large text the connection state goes alone rather than cut', (tester) async {
      await _open(
          tester,
          _store()
            ..ingest(buildHello(
              app: const <String, Object?>{'name': 'Pati', 'id': 'app.pati.mobile'},
              device: const <String, Object?>{'platform': 'android', 'osVersion': '14', 'model': 'SM-A736B'},
              session: 's',
              capabilities: const <String>[],
              actions: const <Map<String, Object?>>[],
            )),
          // The test font draws every glyph a full em wide: a wide window
          // holds the whole line at the normal size.
          size: const Size(700, 900));
      expect(find.text('Android 14 · On the phone only'), findsOneWidget, reason: 'next to the OS when it fits');

      tester.view.physicalSize = const Size(390, 844) * 3;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpAndSettle();
      expect(find.text('On the phone only'), findsOneWidget, reason: 'the state alone when both do not fit');
    });

    testWidgets('Tools: the version only; the app card says the connection', (tester) async {
      await _open(tester, _store());
      await tester.tap(find.byTooltip('Tools'));
      await tester.pumpAndSettle();
      expect(find.text('Dürbün $kSdkVersion'), findsWidgets);
      expect(find.text('On the phone only'), findsOneWidget, reason: 'said once, on the app card');
      for (final tile in <String>['Statistics', 'Mac connection', 'App tools', 'Device & SDK']) {
        expect(find.text(tile), findsOneWidget, reason: tile);
      }
      expect(find.textContaining('3 requests'), findsOneWidget, reason: 'the Statistics tile says how many');
      expect(find.text('Clear captured data'), findsOneWidget);
    });
  });

  group('duration bar', () {
    test('a log scale against the slowest listed request', () {
      expect(durationBarFraction(298, 15000), closeTo(0.47, 0.02));
      expect(durationBarFraction(3400, 15000), closeTo(0.80, 0.02));
      expect(durationBarFraction(4, 15000), lessThan(0.05));
      expect(durationBarFraction(15000, 15000), 1);
      expect(durationBarFraction(20000, 15000), 1, reason: 'never past the track');
    });
  });

  group('theme switch', () {
    testWidgets('toggles from the system theme; the same choice again follows the system', (tester) async {
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      await _open(tester, _store());
      expect(_colors(tester).isDark, isFalse, reason: 'the system is light');
      await tester.tap(find.byTooltip('Switch to dark theme'));
      await tester.pumpAndSettle();
      expect(_colors(tester).isDark, isTrue);
      expect(panelThemeChoice.value, Brightness.dark);
      await tester.tap(find.byTooltip('Switch to light theme'));
      await tester.pumpAndSettle();
      expect(_colors(tester).isDark, isFalse);
      expect(panelThemeChoice.value, isNull, reason: 'light is the system theme: follow it again');

      tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
      await tester.pumpAndSettle();
      expect(_colors(tester).isDark, isTrue, reason: 'following the system');
    });
  });

  group('summary tiles', () {
    testWidgets('total, errors and average time of the listed requests', (tester) async {
      await _open(tester, _store());
      expect(find.text('3 requests'), findsOneWidget);
      expect(find.text('2 errors'), findsOneWidget);
      expect(find.text('Avg. time'), findsOneWidget);
    });

    testWidgets('Errors toggles the errors-only filter, the same one as the chip', (tester) async {
      await _open(tester, _store());
      await tester.tap(find.text('2 errors'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ActiveChip, 'Errors only'), findsOneWidget);
      expect(find.textContaining('/ok', findRichText: true), findsNothing);
      expect(find.text('2 / 3 requests'), findsOneWidget, reason: 'Total says how many are listed');
      await tester.tap(find.text('2 errors'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ActiveChip, 'Errors only'), findsNothing);
      expect(find.textContaining('/ok', findRichText: true), findsOneWidget);
    });

    testWidgets('Total opens Statistics', (tester) async {
      await _open(tester, _store());
      await tester.tap(find.text('3 requests'));
      await tester.pumpAndSettle();
      expect(find.text('Statistics'), findsWidgets);
      expect(find.byType(PanelNavBar).hitTestable(), findsNothing, reason: 'a pushed page');
    });

    testWidgets('not drawn without requests or on a short screen', (tester) async {
      await _open(tester, DurbunInspectorStore(notifyDelay: Duration.zero));
      expect(find.text('Total'), findsNothing, reason: 'no requests');
      await _open(tester, _store(), size: const Size(844, 390));
      expect(find.text('Total'), findsNothing, reason: 'landscape phone');
    });
  });
}
