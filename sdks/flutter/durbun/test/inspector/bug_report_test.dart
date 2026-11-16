import 'dart:convert';
import 'dart:ui' as ui;

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/app_snapshot.dart';
import 'package:durbun/src/inspector/bug_report.dart';
import 'package:durbun/src/inspector/bug_report_view.dart';
import 'package:durbun/src/inspector/logs_view.dart' show LogRow;
import 'package:durbun/src/inspector/network_view.dart' show CallRow;
import 'package:durbun/src/inspector/perf_view.dart' show StatTile;
import 'package:durbun/src/inspector/share_sheet.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/strings.dart';
import 'package:durbun/src/inspector/theme.dart';
import 'package:durbun/src/inspector/widgets.dart' show Callout, DButton, kMinTapTarget;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../gallery/pati_seed.dart';

/// "Report a bug": the window around a moment, the caps, the report text
/// (masked and not), the share channel's fallbacks and the screen's states.

final double _now = DateTime.utc(2026, 11, 16, 11, 31, 40).millisecondsSinceEpoch.toDouble();
const int _istanbul = 180;
const String _note = 'Sepette "Ödemeye geç"e bastım,\nuygulama kapandı.';
final InspectorStrings _tr = InspectorStrings.forLanguage('tr');
final InspectorStrings _en = InspectorStrings.forLanguage('en');

/// The gallery's session, plus a 401 with a key in its query and a log line
/// with a refresh token and a bearer token, both just after the crash.
(DurbunInspectorStore, InspectorLog) _seeded() {
  final s = patiStore(now: _now, withMetrics: false);
  final crash = s.logs.firstWhere((l) => l.isCrash);
  s
    ..ingest(buildNetRequest(
        id: 'b1',
        ts: crash.ts + 1500,
        method: 'GET',
        url: 'https://api.pati.app/v2/cart?api_key=pk_live_9f2c41',
        headers: const <List<String>>[
          <String>['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4ODEyIn0.c2lnbmF0dXJl']
        ]))
    ..ingest(buildNetResponse(id: 'b1', ts: crash.ts + 1620, status: 401, headers: const <List<String>>[]))
    ..ingest(buildLog(
        level: 'warn',
        tag: 'auth',
        ts: crash.ts + 2000,
        message: 'Oturum yenileniyor: refresh_token=rt_4f1c9e7a2b, Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4ODEyIn0.c2lnbmF0dXJl'));
  return (s, crash);
}

BugReportInput _input(DurbunInspectorStore s, BugAnchor anchor, double moment,
    {bool mask = true, String note = _note, int before = 60, bool files = true}) {
  final w = bugWindow(moment, before);
  final base = bugReportInputFor(s,
      note: note, anchor: anchor, momentMs: moment, window: w, contents: collectBugContents(s, w, anchor: anchor), mask: mask);
  return BugReportInput(
    note: base.note,
    anchor: anchor,
    momentMs: moment,
    window: w,
    contents: base.contents,
    mask: mask,
    app: base.app,
    appName: base.appName,
    device: base.device,
    deviceName: base.deviceName,
    sdk: base.sdk,
    utcOffsetMinutes: _istanbul,
    fileName: files ? 'durbun-bug-pati-20261116-143140.md' : null,
    screenshotName: files ? 'durbun-bug-pati-20261116-143140.png' : null,
  );
}

const String _stack = '''
```
#0      CartController.checkout (package:pati/features/cart/cart_controller.dart:132:9)
#1      _CheckoutButton.build.<anonymous closure> (package:pati/features/cart/checkout_button.dart:27:31)
#2      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1176:21)
#3      GestureRecognizer.invokeCallback (package:flutter/src/gestures/recognizer.dart:351:24)
#4      TapGestureRecognizer.handleTapUp (package:flutter/src/gestures/tap.dart:656:11)
```''';

const String _lines = '''
14:27:40.200 I/app: Pati 3.4.0 (412) açıldı
14:27:40.240 D/cache: Önbellekten 24 hayvan okundu (12 KB)
14:27:40.570 I/auth: Kullanıcı girişi tamam (id 8812)
14:27:40.825 V/location: Konum izni zaten verilmiş
14:27:40.840 V/location: Konum izni zaten verilmiş
14:27:40.855 V/location: Konum izni zaten verilmiş
14:27:40.955 W/image: Görsel yavaş yüklendi (2,4 sn): 412-640.jpg
14:27:41.955 I/-: add_to_cart
14:27:43.735 E/vet: Randevular yüklenemedi
14:27:45.075 I/cart: Sepet güncellendi
14:27:46.475 F/-: Unhandled exception: Bad state: Cart is empty''';

final String _goldenTrMasked = '''
# Hata raporu: Pati · Galaxy A73

Not:

> Sepette "Ödemeye geç"e bastım,
> uygulama kapandı.

## Ortam

- An: 2026-11-16 14:27:46.475 (UTC+03:00) · 2026-11-16T11:27:46.475Z
- Aralık: 14:26:46 – 14:27:56
- Cihaz: SM-A736B (Galaxy A73) · Android 14
- Uygulama: Pati 3.4.0 (app.pati.mobile)
- SDK: Dürbün $kSdkVersion · Flutter · Kotlin

## O an

FATAL · Çökme

- Zaman: 2026-11-16 14:27:46.475 (UTC+03:00) · 2026-11-16T11:27:46.475Z

Mesaj:
```
Unhandled exception: Bad state: Cart is empty
```

Yığın izi:
$_stack

## 4 başarısız istek

- 14:27:43.015 DELETE https://api.pati.app/v2/cart/items/77 → 404 Not Found · 74 ms
- 14:27:43.715 GET https://api.pati.app/v2/vets/nearby?lat=41.0422&lng=29.0083&radius=3000 → 500 Internal Server Error · 3.42 s
- 14:27:44.535 GET https://api.pati.app/v2/feed?since=2026-11-16T14:00:00Z → başarısız: TimeoutException after 0:00:15.000000: Future not completed · 15.00 s
- 14:27:47.975 GET https://api.pati.app/v2/cart?api_key=•••• → 401 Unauthorized · 120 ms

## Log satırları (12)

```
$_lines
14:27:48.475 W/auth: Oturum yenileniyor: refresh_token=••••, Authorization: Bearer ••••
```

## Ekler

- durbun-bug-pati-20261116-143140.md: raporun tamamı: her satır ve isteklerin ayrıntısı
- durbun-bug-pati-20261116-143140.png: ekran görüntüsü (panel açılmadan önce)

_Gizli değerler maskeli._
''';

final String _goldenEnRaw = '''
# Bug report: Pati · Galaxy A73

Note:

> Sepette "Ödemeye geç"e bastım,
> uygulama kapandı.

## Environment

- Moment: 2026-11-16 14:27:46.475 (UTC+03:00) · 2026-11-16T11:27:46.475Z
- Window: 14:26:46 – 14:27:56
- Device: SM-A736B (Galaxy A73) · Android 14
- App: Pati 3.4.0 (app.pati.mobile)
- SDK: Dürbün $kSdkVersion · Flutter · Kotlin

## The moment

FATAL · Crash

- Time: 2026-11-16 14:27:46.475 (UTC+03:00) · 2026-11-16T11:27:46.475Z

Message:
```
Unhandled exception: Bad state: Cart is empty
```

Stack trace:
$_stack

## 4 failed requests

- 14:27:43.015 DELETE https://api.pati.app/v2/cart/items/77 → 404 Not Found · 74 ms
- 14:27:43.715 GET https://api.pati.app/v2/vets/nearby?lat=41.0422&lng=29.0083&radius=3000 → 500 Internal Server Error · 3.42 s
- 14:27:44.535 GET https://api.pati.app/v2/feed?since=2026-11-16T14:00:00Z → failed: TimeoutException after 0:00:15.000000: Future not completed · 15.00 s
- 14:27:47.975 GET https://api.pati.app/v2/cart?api_key=pk_live_9f2c41 → 401 Unauthorized · 120 ms

## Log lines (12)

```
$_lines
14:27:48.475 W/auth: Oturum yenileniyor: refresh_token=rt_4f1c9e7a2b, Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4ODEyIn0.c2lnbmF0dXJl
```

## Attachments

- durbun-bug-pati-20261116-143140.md: the whole report: every line and the requests in full
- durbun-bug-pati-20261116-143140.png: screenshot (before the panel opened)

_Unmasked: secret values as they are._
''';

/* ───────────── the screen ───────────── */

class _Shared {
  final List<(String, Map<String, Object?>)> calls = <(String, Map<String, Object?>)>[];
  final Map<String, String> texts = <String, String>{};
  final Map<String, List<int>> bytes = <String, List<int>>{};
  final List<String?> clipboard = <String?>[];
}

/// Fakes the file writers, the PNG encoder, the share channel ([files] and
/// [text] answer `shareFiles` and `share`; null throws as a host without
/// the method would) and the clipboard.
_Shared _fakeShare(WidgetTester tester, {bool? files = true, bool? text = true}) {
  final out = _Shared();
  debugBugTextWriter = (name, chunks) async {
    out.texts[name] = chunks.join();
    return '/cache/durbun-export/$name';
  };
  debugBugBytesWriter = (name, b) async {
    out.bytes[name] = b;
    return '/cache/durbun-export/$name';
  };
  debugSnapshotPng = (_) async => Uint8List.fromList(<int>[137, 80, 78, 71]);
  debugShareHandler = (method, args) async {
    out.calls.add((method, args));
    final answer = method == 'shareFiles' ? files : text;
    if (answer == null) throw MissingPluginException();
    return answer;
  };
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'Clipboard.setData') out.clipboard.add((call.arguments as Map)['text'] as String?);
    return null;
  });
  addTearDown(() {
    debugBugTextWriter = null;
    debugBugBytesWriter = null;
    debugSnapshotPng = null;
    debugShareHandler = null;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null);
  });
  return out;
}

Future<ui.Image> _picture(WidgetTester tester) async {
  // The opening owns it: setPanelOpening(store, null) lets it go.
  return (await tester.runAsync(() => createTestImage(width: 120, height: 260, cache: false)))!;
}

/// The page alone, in English, at phone size.
Future<void> _page(WidgetTester tester, DurbunInspectorStore s, BugAnchor anchor,
    {Size size = const Size(390, 844), double text = 1, TextDirection direction = TextDirection.ltr}) async {
  tester.view.physicalSize = size * 3;
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = text;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearAllTestValues);
  await tester.pumpWidget(MaterialApp(
    home: Directionality(
      textDirection: direction,
      child: Builder(
        builder: (context) => DurbunTheme.wrap(
          context,
          BugReportPage(store: s, anchor: anchor, nowMs: _now, utcOffsetMinutes: _istanbul),
        ),
      ),
    ),
  ));
  await tester.pumpAndSettle();
}

Finder _list() => find.byKey(const ValueKey<String>('durbun-bug-list'));

/// Scrolls the page until [f] can be tapped.
Future<void> _reveal(WidgetTester tester, Finder f) async {
  for (var i = 0; i < 20 && f.hitTestable().evaluate().isEmpty; i++) {
    await tester.drag(_list(), const Offset(0, -200));
    await tester.pump();
  }
  await tester.pumpAndSettle();
}

Finder _summary() => find.byKey(const ValueKey<String>('durbun-bug-summary'));

String _summaryText(WidgetTester tester) => tester.widget<Text>(_summary()).data!;

Future<void> _share(WidgetTester tester) async {
  await tester.tap(find.text('Share…'));
  await tester.pumpAndSettle();
}

/// The panel with [s] on a phone, opened.
Future<void> _panel(WidgetTester tester, DurbunInspectorStore s) async {
  tester.view.physicalSize = const Size(390, 844) * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => DurbunInspector(store: s, showHint: false, child: child!),
    home: const Scaffold(body: Text('the app')),
  ));
  await tester.pumpAndSettle();
  Durbun.showInspector();
  await tester.pumpAndSettle();
}

Future<void> _openRow(WidgetTester tester, String text) async {
  final f = find.textContaining(text, findRichText: true);
  final rows = find.byWidgetPredicate((w) => w is CallRow || w is LogRow).hitTestable();
  final list = find
      .ancestor(
          of: rows.first,
          matching: find.byWidgetPredicate((w) => w is Scrollable && axisDirectionToAxis(w.axisDirection) == Axis.vertical))
      .first;
  for (var i = 0; i < 30 && f.hitTestable().evaluate().isEmpty; i++) {
    await tester.drag(list, const Offset(0, -160));
    await tester.pump();
  }
  await tester.pumpAndSettle();
  await tester.tap(f.hitTestable().first);
  await tester.pumpAndSettle();
}

void main() {
  group('window and contents', () {
    test('60 s before the moment and 10 s after, ends included', () {
      final w = bugWindow(100000, 60);
      expect(w.fromMs, 40000);
      expect(w.toMs, 110000);
      expect(w.contains(40000) && w.contains(110000), isTrue);
      expect(w.contains(39999) || w.contains(110001), isFalse);
      expect(bugWindow(100000, 300).fromMs, -200000);
    });

    test('the window keeps lines and failed requests in it; cancelled ones stay out', () {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..ingest(buildLog(level: 'info', message: 'too early', ts: 39000))
        ..ingest(buildLog(level: 'info', message: 'in', ts: 50000))
        ..ingest(buildLog(level: 'info', message: 'just after', ts: 109000))
        ..ingest(buildLog(level: 'info', message: 'too late', ts: 111000))
        ..ingest(buildNetRequest(id: '1', ts: 60000, method: 'GET', url: 'https://a.test/ok', headers: const []))
        ..ingest(buildNetResponse(id: '1', ts: 60100, status: 200, headers: const []))
        ..ingest(buildNetRequest(id: '2', ts: 61000, method: 'GET', url: 'https://a.test/boom', headers: const []))
        ..ingest(buildNetResponse(id: '2', ts: 61100, status: 503, headers: const []))
        ..ingest(buildNetRequest(id: '3', ts: 62000, method: 'GET', url: 'https://a.test/gone', headers: const []))
        ..ingest(buildNetError(id: '3', ts: 62100, error: 'cancelled', cancelled: true))
        ..ingest(buildNetRequest(id: '4', ts: 20000, method: 'GET', url: 'https://a.test/old', headers: const []))
        ..ingest(buildNetResponse(id: '4', ts: 20100, status: 500, headers: const []));
      final c = collectBugContents(s, bugWindow(100000, 60));
      expect(c.lines.map((l) => l.message), <String>['in', 'just after']);
      expect(c.failed.map((x) => x.url), <String>['https://a.test/boom']);
      expect(c.isEmpty, isFalse);
      expect(collectBugContents(s, bugWindow(300000, 30)).isEmpty, isTrue);
    });

    test('requests to hidden hosts stay out, except the one reported', () {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero)..defaultHosts = const <String>['api.pati.app'];
      s
        ..ingest(buildNetRequest(id: '1', ts: 1000, method: 'GET', url: 'https://api.pati.app/a', headers: const []))
        ..ingest(buildNetResponse(id: '1', ts: 1100, status: 500, headers: const []))
        ..ingest(buildNetRequest(id: '2', ts: 2000, method: 'GET', url: 'https://ads.example.com/x', headers: const []))
        ..ingest(buildNetResponse(id: '2', ts: 2100, status: 500, headers: const []));
      expect(collectBugContents(s, bugWindow(3000, 60)).failed.map((c) => c.url), <String>['https://api.pati.app/a']);
      final ad = s.calls.firstWhere((c) => c.url.contains('ads'));
      expect(collectBugContents(s, bugWindow(3000, 60), anchor: BugAnchor.request(ad)).totalFailed, 2);
    });

    test('a very large window keeps the newest 500 lines and 30 requests and says what was left out', () {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero)..ingest(patiHello());
      for (var i = 0; i < 620; i++) {
        s.ingest(buildLog(level: 'info', message: 'line $i', ts: 1000.0 + i * 10));
      }
      for (var i = 0; i < 35; i++) {
        s
          ..ingest(buildNetRequest(id: 'r$i', ts: 2000.0 + i * 10, method: 'GET', url: 'https://api.pati.app/n/$i', headers: const []))
          ..ingest(buildNetResponse(id: 'r$i', ts: 2005.0 + i * 10, status: 500, headers: const []));
      }
      final moment = 8000.0;
      final w = bugWindow(moment, 60);
      final c = collectBugContents(s, w);
      expect((c.lines.length, c.totalLines), (kBugMaxLines, 620));
      expect(c.lines.first.message, 'line 120', reason: 'the oldest go first');
      expect((c.failed.length, c.totalFailed), (kBugMaxRequests, 35));
      expect(c.failed.first.url, 'https://api.pati.app/n/5');

      final input = BugReportInput(
          note: '', anchor: const BugAnchor.now(), momentMs: moment, window: w, contents: c, mask: true, utcOffsetMinutes: 0);
      final text = buildBugReportText(input.withAttachments(fileName: 'r.md'), _en);
      expect(text, contains('The last 50 of 620 lines.'));
      expect(text, contains('Every line and the failed requests in full are in the attached r.md.'));
      expect(text, contains('…and 5 older ones'));
      expect(text, contains('line 619'));
      expect(text, isNot(contains('line 569\n')));
      expect(RegExp(r'^- \d\d:\d\d', multiLine: true).allMatches(text), hasLength(30));
      // Without the file the text does not point at one.
      expect(buildBugReportText(input, _en), isNot(contains('attached')));

      final file = bugReportFile(input, _en).join();
      expect(file, contains('The oldest 120 lines were left out.'));
      expect(file, contains('line 120'));
      expect(file, isNot(contains('line 119\n')));
      expect(RegExp(r'^### \d+\. GET ', multiLine: true).allMatches(file), hasLength(30));
    });

    test('a long log line is cut in the text, whole in the file', () {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..ingest(buildLog(level: 'error', message: '${'x' * 400}\nsecond line', ts: 1000));
      final w = bugWindow(1000, 60);
      final input = BugReportInput(
          note: '', anchor: const BugAnchor.now(), momentMs: 1000, window: w, contents: collectBugContents(s, w), mask: true, utcOffsetMinutes: 0);
      final text = buildBugReportText(input, _en);
      expect(text, contains('${'x' * kBugLineChars}… …'));
      expect(text, isNot(contains('x' * (kBugLineChars + 1))));
      final file = bugReportFile(input, _en).join();
      expect(file, contains('x' * 400));
      expect(file, contains('    second line'));
    });
  });

  test('a WebSocket as the moment: its messages go into the file, masked; the share text stays short', () {
    final s = DurbunInspectorStore(notifyDelay: Duration.zero)..attached = true;
    s
      ..ingest(buildNetRequest(id: 'w', ts: 1000, method: 'GET', url: 'https://chat.pati.app/socket', headers: const <List<String>>[
        <String>['Upgrade', 'websocket'],
      ]))
      ..ingest(buildNetResponse(id: 'w', ts: 1050, status: 101, headers: const <List<String>>[
        <String>['Upgrade', 'websocket'],
      ]))
      ..streamOpened('w', kind: 'ws', ts: 1050);
    final auth = Uint8List.fromList(utf8.encode('{"type":"auth","token":"s3cr3t"}'));
    s
      ..streamWs('w', 1100, 'out', 'text', auth.length, auth, null, null)
      ..streamEnded('w', 1500, error: 'SocketException: Connection reset by peer');
    final call = s.callByKey('d:w')!;
    final w = bugWindow(1000, 60);
    final input = BugReportInput(
        note: '',
        anchor: BugAnchor.request(call),
        momentMs: 1000,
        window: w,
        contents: collectBugContents(s, w, anchor: BugAnchor.request(call)),
        mask: true,
        utcOffsetMinutes: 0);
    final file = bugReportFile(input, _en).join();
    expect(file, contains('Messages (WebSocket · broke · 1 message):'));
    expect(file, contains('#1 · +50 ms · Sent · text · 32 B\n    {"type":"auth","token":"••••"}'));
    expect(file, isNot(contains('s3cr3t')));
    final text = buildBugReportText(input, _en);
    expect(text, isNot(contains('Messages (WebSocket')));
    expect(text, isNot(contains('s3cr3t')));
  });

  group('report text', () {
    test('golden: a crash with its window, masked (Turkish)', () {
      final (s, crash) = _seeded();
      expect(buildBugReportText(_input(s, BugAnchor.log(crash), crash.ts), _tr), _goldenTrMasked);
    });

    test('golden: the same moment unmasked (English)', () {
      final (s, crash) = _seeded();
      expect(buildBugReportText(_input(s, BugAnchor.log(crash), crash.ts, mask: false), _en), _goldenEnRaw);
    });

    test('masked, the attached file holds no secret either', () {
      final (s, crash) = _seeded();
      final masked = bugReportFile(_input(s, BugAnchor.log(crash), crash.ts), _en).join();
      for (final secret in <String>['pk_live_9f2c41', 'rt_4f1c9e7a2b', 'c2lnbmF0dXJl', 'pati_sid=4f1c9e7a', 'Qm9uY3VrUGFtdWtMdW5h']) {
        expect(masked, isNot(contains(secret)), reason: secret);
      }
      expect(masked, contains('## Failed requests in full'));
      expect(masked, contains('### 4. GET /v2/cart'));
      expect(masked, contains('    #0      VetRepository.appointments'), reason: 'every line with its stack');
      final raw = bugReportFile(_input(s, BugAnchor.log(crash), crash.ts, mask: false), _en).join();
      expect(raw, contains('pk_live_9f2c41'));
      expect(raw, contains('rt_4f1c9e7a2b'));
    });

    test('a request moment leads with the request report', () {
      final (s, _) = _seeded();
      final call = s.calls.firstWhere((c) => c.status == 500);
      final text = buildBugReportText(_input(s, BugAnchor.request(call), call.ts), _en);
      expect(text, contains('## The moment\n\nGET https://api.pati.app/v2/vets/nearby'));
      expect(text, contains('Authorization: Bearer ••••'));
      expect(text, isNot(contains('curl ')), reason: 'cURL only in the file');
      expect(bugReportFile(_input(s, BugAnchor.request(call), call.ts), _en).join(), contains('curl '));
    });

    test('nothing in the window: the note and the facts still go', () {
      final (s, _) = _seeded();
      final input = _input(s, const BugAnchor.now(), _now + 10 * 60 * 1000, note: 'Ekran dondu.', files: false);
      expect(input.contents.isEmpty, isTrue);
      final text = buildBugReportText(input, _tr);
      expect(text, startsWith('# Hata raporu: Pati · Galaxy A73\n\nNot:\n\n> Ekran dondu.\n\n## Ortam\n'));
      expect(text, contains('- Cihaz: SM-A736B (Galaxy A73) · Android 14'));
      expect(text, contains('Aralıkta başarısız istek yok.'));
      expect(text, contains('Aralıkta log satırı yok.'));
      expect(text, isNot(contains('## O an')));
      expect(text, isNot(contains('## Ekler')));
    });

    test('names: the subject, the file stem, the device people know', () {
      final (s, crash) = _seeded();
      final input = _input(s, BugAnchor.log(crash), crash.ts);
      expect(bugSubject(input, _en), 'Bug report: Pati · Galaxy A73');
      expect(bugFileStem('Pati Pro!', DateTime(2026, 11, 16, 14, 31, 40)), 'durbun-bug-pati-pro-20261116-143140');
      expect(bugFileStem(null, DateTime(2026, 1, 2, 3, 4, 5)), 'durbun-bug-20260102-030405');
      expect(deviceShortName(<String, Object?>{'model': 'iPhone17,1', 'name': 'iPhone 16 Pro'}), 'iPhone 16 Pro');
      expect(deviceShortName(<String, Object?>{'model': 'Galaxy A73', 'name': 'SM-A736B'}), 'Galaxy A73');
      expect(sdkLabel(null), 'Dürbün $kSdkVersion');
    });
  });

  group('share channel', () {
    tearDown(() => debugShareHandler = null);

    test('files go in one sheet with the text', () async {
      final calls = <(String, Map<String, Object?>)>[];
      debugShareHandler = (m, a) async {
        calls.add((m, a));
        return true;
      };
      final out = await shareFilesNatively(text: 'full', textOnly: 'short', subject: 's', paths: <String>['/a.md', '/b.png'], mimes: <String>['text/markdown', 'image/png']);
      expect(out, FilesShareOutcome.files);
      expect(calls.single.$1, 'shareFiles');
      expect(calls.single.$2, <String, Object?>{
        'text': 'full',
        'subject': 's',
        'paths': <String>['/a.md', '/b.png'],
        'mimes': <String>['text/markdown', 'image/png'],
      });
    });

    test('a host without shareFiles: the text alone', () async {
      final calls = <String>[];
      debugShareHandler = (m, a) async {
        calls.add('$m:${a['text']}');
        if (m == 'shareFiles') throw MissingPluginException();
        return true;
      };
      expect(await shareFilesNatively(text: 'full', textOnly: 'short', paths: <String>['/a.md']), FilesShareOutcome.textOnly);
      expect(calls, <String>['shareFiles:full', 'share:short']);
    });

    test('files refused: the text alone; nothing opens: failed; never throws', () async {
      debugShareHandler = (m, a) async => m == 'share';
      expect(await shareFilesNatively(text: 't', paths: <String>['/a.md']), FilesShareOutcome.textOnly);
      debugShareHandler = (m, a) async => false;
      expect(await shareFilesNatively(text: 't', paths: <String>['/a.md']), FilesShareOutcome.failed);
      debugShareHandler = (m, a) async => throw PlatformException(code: 'boom');
      expect(await shareFilesNatively(text: 't', paths: <String>['/a.md']), FilesShareOutcome.failed);
    });

    test('no files: only the text is asked for', () async {
      final calls = <String>[];
      debugShareHandler = (m, a) async {
        calls.add(m);
        return true;
      };
      expect(await shareFilesNatively(text: 't'), FilesShareOutcome.textOnly);
      expect(calls, <String>['share']);
    });

    test('no plugin at all (the real channel in a test): failed, no throw', () async {
      expect(await shareFilesNatively(text: 't', paths: <String>['/a.md']), FilesShareOutcome.failed);
    });
  });

  group('screen', () {
    testWidgets('a crash: the moment, the counts, the screenshot and one main action', (tester) async {
      final (s, crash) = _seeded();
      setPanelOpening(s, PanelOpening(_now, await _picture(tester)));
      addTearDown(() => setPanelOpening(s, null));
      await _page(tester, s, BugAnchor.log(crash));

      expect(find.text('Report a bug'), findsOneWidget);
      expect(find.text('Crash'), findsOneWidget);
      expect(find.text('Unhandled exception: Bad state: Cart is empty'), findsOneWidget);
      expect(find.text('What happened?'), findsOneWidget);
      expect(_summaryText(tester), '12 log lines · 4 failed requests · screenshot');
      expect(find.textContaining('14:26:46 – 14:27:56', findRichText: true), findsOneWidget);
      await _reveal(tester, find.text('Mask secret values'));
      expect(find.text('Device and app facts'), findsOneWidget);
      expect(find.textContaining('1 crash · 1 error'), findsOneWidget);
      // One primary action: Share…; Copy is the outlined one beside it.
      expect(find.text('Share…'), findsOneWidget);
      expect(find.text('Copy'), findsOneWidget);
    });

    testWidgets('leaving the screenshot out: the summary says so and the PNG stays home', (tester) async {
      final (s, crash) = _seeded();
      final out = _fakeShare(tester);
      setPanelOpening(s, PanelOpening(_now, await _picture(tester)));
      addTearDown(() => setPanelOpening(s, null));
      await _page(tester, s, BugAnchor.log(crash));

      await tester.tap(find.text('Leave the screenshot out'));
      await tester.pumpAndSettle();
      expect(_summaryText(tester), '12 log lines · 4 failed requests');
      expect(find.text('Not in the report'), findsOneWidget);
      expect(find.text('Put it back'), findsOneWidget);

      await _share(tester);
      final (method, args) = out.calls.single;
      expect(method, 'shareFiles');
      expect((args['paths']! as List).single, endsWith('.md'));
      expect(args['mimes'], <String>['text/markdown']);
      expect(out.bytes, isEmpty);
      expect(args['text'], isNot(contains('.png')));

      await tester.tap(find.text('Put it back'));
      await tester.pumpAndSettle();
      expect(_summaryText(tester), endsWith('· screenshot'));
    });

    testWidgets('share: the text, the Markdown file and the PNG in one sheet', (tester) async {
      final (s, crash) = _seeded();
      final out = _fakeShare(tester);
      setPanelOpening(s, PanelOpening(_now, await _picture(tester)));
      addTearDown(() => setPanelOpening(s, null));
      await _page(tester, s, BugAnchor.log(crash));
      await tester.enterText(find.byKey(const ValueKey<String>('durbun-bug-note')), 'Checkout crashed');
      await tester.pumpAndSettle();

      await _share(tester);
      final (method, args) = out.calls.single;
      expect(method, 'shareFiles');
      final paths = (args['paths']! as List).cast<String>();
      expect(paths, hasLength(2));
      expect(paths.first, matches(RegExp(r'/durbun-bug-pati-\d{8}-\d{6}\.md$')));
      expect(paths.last, matches(RegExp(r'/durbun-bug-pati-\d{8}-\d{6}\.png$')));
      expect(args['mimes'], <String>['text/markdown', 'image/png']);
      expect(args['subject'], 'Bug report: Pati · Galaxy A73');
      final text = args['text']! as String;
      expect(text, contains('> Checkout crashed'));
      expect(text, contains('## Attachments'));
      expect(text, isNot(contains('rt_4f1c9e7a2b')));
      expect(out.texts.values.single, contains('## Failed requests in full'));
      expect(out.bytes.values.single, <int>[137, 80, 78, 71]);
      expect(find.byType(Callout), findsNothing, reason: 'nothing to say when it opened');
    });

    testWidgets('a host that only shares text: the text goes and the page says the files did not', (tester) async {
      final (s, crash) = _seeded();
      final out = _fakeShare(tester, files: null);
      await _page(tester, s, BugAnchor.log(crash));
      await _share(tester);
      expect(out.calls.map((c) => c.$1), <String>['shareFiles', 'share']);
      expect(out.calls.last.$2['text'], isNot(contains('## Attachments')), reason: 'no file to point at');
      expect(find.text('The files could not be attached; the report was shared as text.'), findsOneWidget);
    });

    testWidgets('nothing opens: the report is copied and the page stays with the note', (tester) async {
      final (s, crash) = _seeded();
      final out = _fakeShare(tester, files: false, text: false);
      await _page(tester, s, BugAnchor.log(crash));
      await tester.enterText(find.byKey(const ValueKey<String>('durbun-bug-note')), 'Keep me');
      await _share(tester);
      expect(out.clipboard.single, contains('> Keep me'));
      expect(find.text('Sharing did not open; the report was copied'), findsOneWidget);
      expect(find.text('Keep me'), findsOneWidget);
      expect(find.text('Share…'), findsOneWidget, reason: 'ready to try again');
    });

    testWidgets('no screenshot: said plainly, not as an error', (tester) async {
      final (s, crash) = _seeded();
      await _page(tester, s, BugAnchor.log(crash));
      expect(find.text('No screenshot'), findsOneWidget);
      expect(find.text('No screenshot could be taken this time. The report goes without one.'), findsOneWidget);
      expect(find.text('Leave the screenshot out'), findsNothing);
      expect(_summaryText(tester), '12 log lines · 4 failed requests');
    });

    testWidgets('an empty window: says so, still sendable; a wider window fills it', (tester) async {
      final (s, _) = _seeded();
      final out = _fakeShare(tester);
      // 4 min 30 s after the session began: its lines are 4 to 5 min old.
      final later = _now + 30000;
      tester.view.physicalSize = const Size(390, 844) * 3;
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
          home: Builder(
              builder: (context) => DurbunTheme.wrap(context, BugReportPage(store: s, nowMs: later, utcOffsetMinutes: _istanbul)))));
      await tester.pumpAndSettle();
      expect(find.text('When the panel opened'), findsOneWidget);
      expect(find.text('Nothing captured in this window'), findsOneWidget);
      expect(_summaryText(tester), '0 log lines · 0 failed requests');

      await tester.tap(find.text('5 min'));
      await tester.pumpAndSettle();
      expect(find.text('Nothing captured in this window'), findsNothing);
      expect(_summaryText(tester), '12 log lines · 4 failed requests');

      await tester.tap(find.text('30 s'));
      await tester.pumpAndSettle();
      await _share(tester);
      expect(out.calls.single.$1, 'shareFiles', reason: 'the facts file still goes');
      expect(out.calls.single.$2['text'], contains('No log lines in the window.'));
    });

    testWidgets('the masking switch is the panel’s one: off here is off on the next share', (tester) async {
      final (s, crash) = _seeded();
      final out = _fakeShare(tester);
      await _page(tester, s, BugAnchor.log(crash));
      expect(shareOptionsOf(s).mask, isTrue);
      await _reveal(tester, find.text('Mask secret values'));
      await tester.tap(find.text('Mask secret values'));
      await tester.pumpAndSettle();
      expect(shareOptionsOf(s).mask, isFalse);
      await _share(tester);
      expect(out.calls.single.$2['text'], contains('rt_4f1c9e7a2b'));
      expect(out.calls.single.$2['text'], contains('_Unmasked: secret values as they are._'));
    });

    testWidgets('the note waits for the next visit until it is sent', (tester) async {
      final (s, crash) = _seeded();
      _fakeShare(tester);
      await _page(tester, s, BugAnchor.log(crash));
      await tester.enterText(find.byKey(const ValueKey<String>('durbun-bug-note')), 'Half written');
      await tester.pumpWidget(const SizedBox());
      await _page(tester, s, BugAnchor.log(crash));
      expect(find.text('Half written'), findsOneWidget);
      await _share(tester);
      await tester.pumpWidget(const SizedBox());
      await _page(tester, s, BugAnchor.log(crash));
      expect(find.text('Half written'), findsNothing);
    });

    testWidgets('text scale 2.0, landscape and right-to-left lay out without overflow', (tester) async {
      final (s, crash) = _seeded();
      setPanelOpening(s, PanelOpening(_now, await _picture(tester)));
      addTearDown(() => setPanelOpening(s, null));
      for (final (size, text, dir) in <(Size, double, TextDirection)>[
        (const Size(390, 844), 2.0, TextDirection.ltr),
        (const Size(844, 390), 1.3, TextDirection.ltr),
        (const Size(320, 640), 1.0, TextDirection.rtl),
      ]) {
        final errors = <String>[];
        final previous = FlutterError.onError;
        FlutterError.onError = (d) => errors.add(d.toString());
        await _page(tester, s, BugAnchor.log(crash), size: size, text: text, direction: dir);
        FlutterError.onError = previous;
        expect(errors, isEmpty, reason: '$size × $text $dir');
        final list = _list();
        for (var i = 0; i < 12; i++) {
          await tester.drag(list, const Offset(0, -300));
          await tester.pump();
        }
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: '$size × $text $dir scrolled');
        // The buttons stay at least 44 pt tall.
        expect(tester.getSize(find.text('Share…').hitTestable()).height, greaterThan(0));
        for (final b in find.byType(DButton).evaluate()) {
          expect((b.renderObject! as RenderBox).size.height, greaterThanOrEqualTo(kMinTapTarget));
        }
      }
    });
  });

  group('entry points', () {
    testWidgets('Tools: a card opens the report about the panel’s opening', (tester) async {
      final s = patiStore(withMetrics: false);
      await _panel(tester, s);
      await tester.tap(find.byTooltip('Tools').first);
      await tester.pumpAndSettle();
      expect(find.text('Report a bug'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey<String>('durbun-tools-bug')));
      await tester.pumpAndSettle();
      expect(find.text('When the panel opened'), findsOneWidget);
      expect(panelOpeningOf(s), isNotNull, reason: 'kept while the panel is open');
    });

    testWidgets('a crash detail has the bug button; an info line does not', (tester) async {
      final s = patiStore(withMetrics: false);
      await _panel(tester, s);
      await tester.tap(find.byTooltip('Logs').first);
      await tester.pumpAndSettle();
      await _openRow(tester, 'Sepet güncellendi');
      expect(find.byKey(const ValueKey<String>('durbun-log-bug')), findsNothing);
      await tester.pageBack();
      await tester.pumpAndSettle();
      await _openRow(tester, 'Cart is empty');
      await tester.tap(find.byKey(const ValueKey<String>('durbun-log-bug')));
      await tester.pumpAndSettle();
      expect(find.text('Crash'), findsOneWidget);
      expect(find.text('What happened?'), findsOneWidget);
    });

    testWidgets('a failed request: in its more menu and on its share sheet', (tester) async {
      final s = patiStore(withMetrics: false);
      await _panel(tester, s);
      await _openRow(tester, '/v2/vets/nearby');
      await tester.tap(find.byTooltip('More actions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Report a bug…'));
      await tester.pumpAndSettle();
      expect(find.text('Failed request'), findsOneWidget);
      expect(find.textContaining('GET /v2/vets/nearby → 500'), findsWidgets);
      await tester.pageBack();
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Share').first);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey<String>('durbun-share-bug')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey<String>('durbun-share-bug')));
      await tester.pumpAndSettle();
      expect(find.text('Failed request'), findsOneWidget);
      expect(find.byType(BottomSheet), findsNothing, reason: 'the share sheet made way');
    });

    testWidgets('a successful request offers no report', (tester) async {
      final s = patiStore(withMetrics: false);
      await _panel(tester, s);
      await _openRow(tester, '/v2/pets/412');
      await tester.tap(find.byTooltip('More actions'));
      await tester.pumpAndSettle();
      expect(find.text('Report a bug…'), findsNothing);
    });
  });

  testWidgets('Statistics: tiles of a row are equally tall', (tester) async {
    final s = patiStore(withMetrics: false);
    await _panel(tester, s);
    await tester.tap(find.byTooltip('Tools').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Statistics'));
    await tester.pumpAndSettle();
    final server = tester.getSize(find.ancestor(of: find.text('Server errors (5xx)'), matching: find.byType(StatTile)));
    final transport = tester.getSize(find.ancestor(of: find.text('Transport errors'), matching: find.byType(StatTile)));
    expect(find.text('1 timed out'), findsOneWidget);
    expect(server.height, transport.height);
    expect(server.width, transport.width);
  });
}
