import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/print_capture.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/filter_ui.dart' show ActiveChip;
import 'package:durbun/src/inspector/logs_view.dart';
import 'package:durbun/src/inspector/network_model.dart';
import 'package:durbun/src/inspector/print_lines.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/text_match.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const MethodChannel _shake = MethodChannel('dev.durbun/shake');

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Future<void> _open(WidgetTester tester, DurbunInspectorStore store, {String tab = 'Logs'}) async {
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => DurbunInspector(store: store, child: child!),
    home: const Scaffold(body: Text('the app')),
  ));
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip(tab).first);
  await tester.pumpAndSettle();
}

DurbunInspectorStore _manyLogs(int n) {
  final s = DurbunInspectorStore(notifyDelay: Duration.zero);
  for (var i = 0; i < n; i++) {
    s.ingest(buildLog(level: i.isEven ? 'info' : 'warn', message: i.isEven ? 'alpha $i' : 'beta $i', tag: 'demo', ts: 1000.0 + i));
  }
  return s;
}

List<String> _lines(Iterable<PrintEntry> e) => [for (final x in e) '${x.level}|${x.tag}|${x.message}'];

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (_) async => true));
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null));

  group('live list: filters apply while it is frozen', () {
    testWidgets('scrolled up, then searched: rows that no longer match leave the list', (tester) async {
      await _phone(tester);
      final store = _manyLogs(80);
      await _open(tester, store);
      // Scrolling up freezes the list (the "↓ N new" state).
      await tester.drag(find.byType(ListView).last, const Offset(0, 600));
      await tester.pumpAndSettle();
      store.ingest(buildLog(level: 'info', message: 'alpha new', tag: 'demo', ts: 5000));
      await tester.pumpAndSettle();
      expect(find.text('1 new'), findsOneWidget, reason: 'frozen: the new line waits behind the pill');

      await tester.enterText(find.byType(TextField), 'beta');
      await tester.pumpAndSettle();
      expect(find.textContaining('alpha'), findsNothing, reason: 'the search reaches the frozen list');
      expect(find.textContaining('beta'), findsWidgets);
    });

    testWidgets('paused, then filtered: the filter still applies', (tester) async {
      await _phone(tester);
      final store = _manyLogs(6);
      await _open(tester, store);
      await tester.tap(find.byTooltip('Pause'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Level ▾'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Warning+').last);
      await tester.pumpAndSettle();
      expect(find.textContaining('alpha'), findsNothing);
      expect(find.textContaining('beta'), findsNWidgets(3));
      store.ingest(buildLog(level: 'warn', message: 'beta later', tag: 'demo', ts: 9000));
      await tester.pumpAndSettle();
      expect(find.text('beta later'), findsNothing, reason: 'paused: new lines are held');
    });
  });

  group('print lines reach the panel without a desktop', () {
    test('auto mode: a line is kept locally even while the desktop copy waits for a config', () {
      final local = <String>[], desktop = <String>[];
      final capture = PrintCapture(mode: DurbunPrintCapture.auto, sink: (l, _) => desktop.add(l), local: (l, _) => local.add(l));
      capture.onLine('hello');
      expect(local, ['hello']);
      expect(desktop, isEmpty, reason: 'the desktop path is unchanged');
      capture.onConfig(const SdkConfig(captureBodies: true, maxBodyBytes: 1024, metricsIntervalMs: 1000, deviceLogsAvailable: true));
      capture.onLine('again');
      expect(local, ['hello', 'again']);
      expect(desktop, isEmpty, reason: 'the desktop reads logcat itself');
    });

    test('never mode keeps nothing; Flutter error boxes are not doubled', () {
      final local = <String>[];
      PrintCapture(mode: DurbunPrintCapture.never, sink: (_, __) {}, local: (l, _) => local.add(l)).onLine('x');
      PrintCapture(mode: DurbunPrintCapture.always, sink: (_, __) {}, local: (l, _) => local.add(l), dropFlutterErrorBoxes: true)
          .onLine('Another exception was thrown: boom');
      expect(local, isEmpty);
    });

    test('a line also sent to the desktop is in the store once', () {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero);
      store.ingestPrint('once', 1);
      store.withoutTap(() => store.ingest(buildLog(level: 'info', message: 'once', tag: 'flutter', ts: 1)));
      store.ingest(buildLog(level: 'info', message: 'app log', ts: 2));
      expect(store.logs.map((l) => l.message), ['once', 'app log']);
    });

    group('fed by the SDK', () {
      tearDown(Durbun.dispose);

      test('debugPrint lines show in the store while no desktop ever connects', () async {
        final store = DurbunInspectorStore(notifyDelay: Duration.zero);
        DurbunInspectorStore.instance = store;
        final unused = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
        final deadPort = unused.port;
        await unused.close();
        await Durbun.init(DurbunOptions(enabled: true, port: deadPort, listenForUsb: false, useBackgroundIsolate: false, metrics: false));
        debugPrint('💡 [Cart] sepet açıldı');
        expect(store.logs.where((l) => l.message == 'sepet açıldı'), hasLength(1));
        final l = store.logs.singleWhere((l) => l.message == 'sepet açıldı');
        expect((l.level, l.tag), ('info', 'Cart'));
      });
    });
  });

  group('logger PrettyPrinter boxes become one entry', () {
    test('level from the emoji, tag from [Tag], stack and time sections kept apart', () {
      final out = <PrintEntry>[];
      final a = PrintLineAssembler(out.add);
      for (final l in <String>[
        '┌───────────────────────────────',
        '│ #0   AppLogger.d (package:app/core/logger.dart:21:13)',
        '│ #1   AuthRepo.refresh (package:app/auth/repo.dart:88:7)',
        '├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
        '│ 10:42:07.123 (+0:00:03.456789)',
        '├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
        '│ 🐛 [Auth] token yenilendi',
        '│ 🐛 süre: 120 ms',
        '└───────────────────────────────',
      ]) {
        a.add(l, 1);
      }
      expect(out, hasLength(1));
      final e = out.single;
      expect(e.level, 'debug');
      expect(e.tag, 'Auth');
      expect(e.message, 'token yenilendi\nsüre: 120 ms');
      expect(e.stack, contains('#1   AuthRepo.refresh'));
      expect(e.error, isNull, reason: 'the time line is not an error');
    });

    test('every level emoji, the error section, ANSI colours, a box printed at once', () {
      final out = <PrintEntry>[];
      final a = PrintLineAssembler(out.add);
      a.add('┌──\n│ 💡 bilgi\n└──', 1);
      a.add('\x1B[38;5;208m┌──\x1B[0m', 1);
      a.add('\x1B[38;5;208m│ ⚠️ [Net] yavaş yanıt\x1B[0m', 1);
      a.add('\x1B[38;5;208m└──\x1B[0m', 1);
      a.add('┌──\n│ SocketException: refused\n├┄┄\n│ ⛔ istek düştü\n└──', 1);
      a.add('┌──\n│ 👾 çöktü\n└──', 1);
      a.add('┌──\n│ sadece renk\n└──'.replaceAll('│', '\x1B[38;5;196m│'), 1);
      expect(_lines(out), [
        'info|flutter|bilgi',
        'warn|Net|yavaş yanıt',
        'error|flutter|istek düştü',
        'fatal|flutter|çöktü',
        'error|flutter|sadece renk',
      ]);
      expect(out[2].error, 'SocketException: refused');
    });

    test('plain lines: [Tag] [LEVEL] message (easy_logger) and a bare [LEVEL]', () {
      final out = <PrintEntry>[];
      final a = PrintLineAssembler(out.add);
      a.add('[🌎 Easy Localization] [DEBUG] Localization initialized', 1);
      a.add('[WARNING] disk dolmak üzere', 1);
      a.add('[Auth] giriş yapıldı', 1);
      expect(_lines(out), ['debug|🌎 Easy Localization|Localization initialized', 'warn|flutter|disk dolmak üzere', 'info|Auth|giriş yapıldı']);
    });

    test('pretty-printed JSON keeps its indent', () {
      final out = <PrintEntry>[];
      final a = PrintLineAssembler(out.add);
      a.add('┌──\n│ 💡 [Network] {\n│ 💡   "status": "success",\n│ 💡   "data": [\n│ 💡     1\n│ 💡   ]\n│ 💡 }\n└──', 1);
      expect(out.single.message, '{\n  "status": "success",\n  "data": [\n    1\n  ]\n}');
    });

    test('a box that never closes is emitted by the next plain line or the timer', () async {
      final out = <PrintEntry>[];
      final a = PrintLineAssembler(out.add, flushDelay: const Duration(milliseconds: 10));
      a.add('┌──', 1);
      a.add('│ 💡 yarım', 1);
      a.add('[GoRouter] going to /home', 2);
      expect(_lines(out), ['info|flutter|yarım', 'info|GoRouter|going to /home']);
      a.add('┌──', 3);
      a.add('│ ⚠️ zaman aşımı', 3);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(_lines(out).last, 'warn|flutter|zaman aşımı');
    });

    test('the store shows a box as one row', () {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero);
      for (final l in ['┌──', '│ #0 main (x.dart:1)', '├┄┄', '│ ⛔ [Pay] ödeme reddedildi', '└──']) {
        store.ingestPrint(l, 10);
      }
      final log = store.logs.single;
      expect((log.level, log.tag, log.message), ('error', 'Pay', 'ödeme reddedildi'));
      expect(log.error?['stack'], '#0 main (x.dart:1)');
      expect(log.isError, isTrue);
    });
  });

  group('search: no crash on İ, Turkish letters, percent-encoding, every word marked', () {
    test('highlighting after İ (two units when lower-cased) stays in range', () {
      const text = 'İİİ GİRİŞ başarısız: İstanbul';
      final span = highlightTerms(text, [foldText('istanbul'), foldText('giris')], const TextStyle(), const Color(0xFFFFFF00));
      final marked = [for (final s in span.children!.cast<TextSpan>()) if (s.style?.backgroundColor != null) s.text];
      expect(marked, ['GİRİŞ', 'İstanbul']);
      expect(span.toPlainText(), text);
    });

    test('ş ı ğ ü ö ç and case never decide a match', () {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..ingest(buildLog(level: 'info', message: 'Şifre DEĞİŞTİRİLDİ', ts: 1));
      final l = store.logs.single;
      for (final q in ['sifre degistirildi', 'ŞİFRE', 'değiştirildi', '"sifre degis"']) {
        expect(logMatches(l, LogFilters(), parseQuery(q)), isTrue, reason: q);
      }
      expect(logMatches(l, LogFilters(), parseQuery('-sifre')), isFalse);
    });

    test('an endpoint is found in a percent-encoded URL, and by several words', () {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..ingest(buildNetRequest(id: '1', ts: 1, method: 'GET', url: 'https://api.example.com/v2/%C5%9Fubeler/ara?q=%C3%A7ar%C5%9F%C4%B1', headers: const []));
      final c = store.calls.single;
      for (final q in ['şubeler', 'subeler', '/v2/subeler', 'carsi', 'path:/subeler', 'subeler ara', 'host:API.example']) {
        expect(callMatchesQuery(c, parseQuery(q)), isTrue, reason: q);
      }
      expect(callMatchesQuery(c, parseQuery('subeler -ara')), isFalse);
      expect(freeTerms(parseQuery('subeler -ara status:2xx ara')), ['subeler', 'ara']);
    });

    testWidgets('every search word is marked in a row', (tester) async {
      await _phone(tester);
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..ingest(buildLog(level: 'info', message: 'Sepet açıldı, ürün eklendi', ts: 1));
      await _open(tester, store);
      await tester.enterText(find.byType(TextField), 'sepet urun');
      await tester.pumpAndSettle();
      final rich = tester.widgetList<RichText>(find.byType(RichText)).firstWhere((r) => r.text.toPlainText().contains('Sepet açıldı'));
      final marked = <String>[];
      rich.text.visitChildren((s) {
        if (s is TextSpan && s.style?.backgroundColor != null) marked.add(s.text!);
        return true;
      });
      expect(marked, ['Sepet', 'ürün']);
    });
  });

  group('a logged HTML page (one huge line) does not freeze the panel', () {
    final huge = '      "html": "<!DOCTYPE html>${'<p style=\\"mso-x\\">sözleşme</p>' * 12000}"';

    test('the phone keeps the start of the message and says how much is cut', () {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..ingestPrint('┌──', 1)
        ..ingestPrint('│ 💡 $huge', 1)
        ..ingestPrint('└──', 1)
        ..ingest(buildLog(level: 'info', message: huge, ts: 2));
      for (final l in store.logs) {
        expect(l.message.length, InspectorLog.maxMessageChars);
        expect(l.cutChars, greaterThan(0));
        // The print box trims the line's indent; the SDK log keeps it.
        expect([huge.length, huge.trim().length], contains(l.message.length + l.cutChars));
      }
    });

    test('a row shows a few lines and a few hundred characters', () {
      expect(rowPreview('a\nb\nc'), 'a\nb\nc');
      expect(rowPreview('1\n2\n3\n4\n5\n6'), '1\n2\n3\n4…');
      expect(rowPreview('x' * 5000).length, 601);
      final parts = textChunks('${'y' * 2500}\n${'z' * 10}');
      expect(parts.join(), '${'y' * 2500}\n${'z' * 10}');
      expect(parts.every((p) => p.length <= 2000), isTrue);
    });

    testWidgets('typing in the search lays out only the preview', (tester) async {
      await _phone(tester);
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)..ingest(buildLog(level: 'info', message: huge, tag: 'Network', ts: 1));
      await _open(tester, store);
      await tester.enterText(find.byType(TextField), 's');
      await tester.pumpAndSettle();
      final row = tester.widgetList<RichText>(find.byType(RichText)).firstWhere((r) => r.text.toPlainText().contains('DOCTYPE'));
      expect(row.text.toPlainText().length, lessThanOrEqualTo(601));
      await tester.tap(find.textContaining('DOCTYPE'));
      await tester.pumpAndSettle();
      expect(find.textContaining('not kept on the phone'), findsOneWidget);
    });
  });

  group('toolbars', () {
    testWidgets('the search has a clear button; the help list adds a query word', (tester) async {
      await _phone(tester);
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..ingest(buildNetRequest(id: '1', ts: 1, method: 'GET', url: 'https://a.io/users', headers: const []))
        ..ingest(buildNetResponse(id: '1', ts: 2, status: 404, headers: const []))
        ..ingest(buildNetRequest(id: '2', ts: 3, method: 'GET', url: 'https://a.io/orders', headers: const []))
        ..ingest(buildNetResponse(id: '2', ts: 4, status: 200, headers: const []));
      await _open(tester, store, tab: 'Network');
      expect(find.byTooltip('Clear search'), findsNothing);
      await tester.tap(find.byTooltip('Search words'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('status:4xx'));
      await tester.pumpAndSettle();
      expect(find.text('/orders'), findsNothing);
      expect(find.text('/users'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(find.text('/orders'), findsOneWidget);
    });

    testWidgets('nothing matches: "Clear filters" brings everything back', (tester) async {
      await _phone(tester);
      final store = _manyLogs(4);
      await _open(tester, store);
      await tester.tap(find.text('Errors only'));
      await tester.enterText(find.byType(TextField), 'nothing-like-this');
      await tester.pumpAndSettle();
      expect(find.text('Nothing matches the filter'), findsOneWidget);
      await tester.tap(find.text('Clear filters'));
      await tester.pumpAndSettle();
      expect(find.textContaining('alpha'), findsWidgets);
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
    });

    testWidgets('logs: the filter sheet sets the source and the request switch; active filters show first with an ×', (tester) async {
      await _phone(tester);
      final store = _manyLogs(2)
        ..ingest(buildNetRequest(id: '1', ts: 1000.5, method: 'GET', url: 'https://a.io/ping', headers: const []));
      await _open(tester, store);
      expect(find.textContaining('a.io/ping'), findsOneWidget);
      await tester.tap(find.text('Filters'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(find.text('Show requests in the stream'), 120,
          scrollable: find.descendant(of: find.byType(BottomSheet), matching: find.byType(Scrollable)).first);
      await tester.tap(find.text('Show requests in the stream'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(find.textContaining('a.io/ping'), findsNothing);
      expect(find.widgetWithText(ActiveChip, 'Requests hidden'), findsOneWidget);
      expect(tester.getTopLeft(find.widgetWithText(ActiveChip, 'Requests hidden')).dx,
          lessThan(tester.getTopRight(find.text('Level ▾')).dx + 30),
          reason: 'active chips come right after the Filters button and the level menu, before the quick toggles');
      // Its start is on screen (checked above); the test font is wide.
      await tester.tapAt(tester.getTopLeft(find.widgetWithText(ActiveChip, 'Requests hidden')) + const Offset(12, 15));
      await tester.pumpAndSettle();
      expect(find.textContaining('a.io/ping'), findsOneWidget);
    });
  });
}
