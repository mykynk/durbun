import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/export_sheet.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Tools → Export session: the listed requests (or all), as a file through
/// the native share sheet, the clipboard when that does not open.

const MethodChannel _shake = MethodChannel('dev.durbun/shake');
const MethodChannel _native = MethodChannel('dev.durbun/native');

PendingBody _text(String text) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 30, capture: true, contentType: 'application/json');
}

DurbunInspectorStore _store({String bigBody = ''}) {
  final s = DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;
  s
    ..ingest(buildHello(
        app: const {'name': 'Shop', 'version': '2.4.1', 'id': 'com.example.shop'},
        device: const {'model': 'Pixel 8', 'os': 'Android 15'},
        session: 's1',
        capabilities: const [],
        actions: const []))
    ..ingest(buildNetRequest(
        id: '1',
        ts: 1000,
        method: 'POST',
        url: 'https://api.example.com/v1/login?token=abc123',
        headers: const [
          ['Content-Type', 'application/json']
        ],
        body: _text('{"password":"hunter2"}')))
    ..ingest(buildNetResponse(
        id: '1',
        ts: 1100,
        status: 200,
        headers: const [
          ['Content-Type', 'application/json']
        ],
        body: _text(bigBody.isEmpty ? '{"ok":true}' : '{"data":"$bigBody"}')))
    ..ingest(buildNetRequest(id: '2', ts: 2000, method: 'GET', url: 'https://api.example.com/v1/feed', headers: const []))
    ..ingest(buildNetResponse(id: '2', ts: 2050, status: 200, headers: const []));
  return s;
}

class _Captured {
  final List<String> names = <String>[];
  final List<String> files = <String>[];
  final List<Map<Object?, Object?>> shares = <Map<Object?, Object?>>[];
  final List<String?> clipboard = <String?>[];
}

/// Fakes the writer, the native share sheet ([shares] answers it) and the
/// clipboard.
_Captured _fake(WidgetTester tester, {bool shares = true, bool writes = true}) {
  final out = _Captured();
  debugExportWriter = (name, chunks) async {
    out.names.add(name);
    out.files.add(chunks.join());
    return writes ? '/cache/durbun-export/$name' : null;
  };
  addTearDown(() => debugExportWriter = null);
  final messenger = tester.binding.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(_native, (call) async {
    if (call.method == 'shareFile') {
      out.shares.add(call.arguments as Map<Object?, Object?>);
      return shares;
    }
    return null;
  });
  messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'Clipboard.setData') out.clipboard.add((call.arguments as Map)['text'] as String?);
    return null;
  });
  addTearDown(() {
    messenger.setMockMethodCallHandler(_native, null);
    messenger.setMockMethodCallHandler(SystemChannels.platform, null);
  });
  return out;
}

Future<void> _open(WidgetTester tester, DurbunInspectorStore store, {Size size = const Size(390, 844), double text = 1}) async {
  tester.view.physicalSize = size * 3;
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = text;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearAllTestValues);
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => DurbunInspector(store: store, child: child!),
    home: const Scaffold(body: Text('the app')),
  ));
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Network').first);
  await tester.pumpAndSettle();
}

Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Tools').first);
  await tester.pumpAndSettle();
  // The tools list builds lazily: scroll it to the row.
  await tester.scrollUntilVisible(find.text('Export session'), 120, scrollable: find.byType(Scrollable).last);
  await tester.pumpAndSettle();
  await tester.tap(find.text('Export session'));
  await tester.pumpAndSettle();
}

Future<void> _export(WidgetTester tester) async {
  await tester.ensureVisible(find.text('Export…'));
  await tester.tap(find.text('Export…'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (_) async => true));
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null));

  testWidgets('the listed requests as a masked HAR file, through the share sheet', (tester) async {
    final out = _fake(tester);
    await _open(tester, _store());
    await tester.enterText(find.byType(TextField).first, 'login');
    await tester.pumpAndSettle();

    await _openSheet(tester);
    expect(find.text('Listed 1'), findsOneWidget, reason: 'the search lists one');
    expect(find.text('All 2'), findsOneWidget);
    await tester.tap(find.text('HAR (.har)'));
    await tester.pumpAndSettle();
    expect(find.text('Opens in Chrome DevTools, Charles, Proxyman and HAR viewers.'), findsOneWidget);
    await _export(tester);

    expect(out.names.single, matches(RegExp(r'^durbun-shop-\d{8}-\d{6}\.har$')));
    expect(out.shares.single, {'path': '/cache/durbun-export/${out.names.single}', 'mime': 'application/json', 'subject': 'Dürbün · Shop · 1 request'});
    final har = jsonDecode(out.files.single) as Map<String, Object?>;
    final entries = (har['log']! as Map)['entries']! as List;
    expect(entries, hasLength(1), reason: 'only what the search lists');
    expect(out.files.single, isNot(contains('hunter2')));
    expect(out.files.single, isNot(contains('abc123')));
    expect(find.text('Export session'), findsNothing, reason: 'the sheet closed');
    expect(out.clipboard, isEmpty);

    // Opened again: HAR is still picked; All exports everything.
    await _openSheet(tester);
    await tester.tap(find.text('All 2'));
    await tester.pumpAndSettle();
    await _export(tester);
    expect(out.names.last, endsWith('.har'));
    expect(((jsonDecode(out.files.last) as Map)['log'] as Map)['entries'], hasLength(2));
    expect(out.shares.last['subject'], 'Dürbün · Shop · 2 requests');
  });

  testWidgets('no share sheet: a small report goes to the clipboard, and says so', (tester) async {
    final out = _fake(tester, shares: false);
    await _open(tester, _store());
    await _openSheet(tester);
    // Masking off, for once.
    await tester.tap(find.byType(Switch).first);
    await tester.pumpAndSettle();
    await _export(tester);
    expect(out.names.single, endsWith('.md'));
    expect(out.clipboard.single, startsWith('# Dürbün · Network session'));
    expect(out.clipboard.single, contains('hunter2'), reason: 'masking was turned off');
    expect(find.text('Sharing did not open; the export was copied'), findsOneWidget);
  });

  testWidgets('no file and too large to copy: said in the sheet; bodies off makes it fit', (tester) async {
    final out = _fake(tester, shares: false, writes: false);
    await _open(tester, _store(bigBody: 'x' * (600 * 1024)));
    await _openSheet(tester);
    await tester.tap(find.text('HAR (.har)'));
    await tester.pumpAndSettle();
    await _export(tester);
    expect(out.clipboard, isEmpty);
    expect(find.textContaining('too large to copy'), findsOneWidget);
    expect(find.text('Export session'), findsOneWidget, reason: 'the sheet stays open');

    await tester.ensureVisible(find.byType(Switch).last);
    await tester.tap(find.byType(Switch).last);
    await tester.pumpAndSettle();
    expect(find.textContaining('too large to copy'), findsNothing, reason: 'a changed option clears it');
    await _export(tester);
    expect(out.clipboard.single, isNot(contains('xxxxxxxx')));
    expect(find.text('Sharing did not open; the export was copied'), findsOneWidget);
  });

  testWidgets('no requests: the button is off', (tester) async {
    _fake(tester);
    await _open(tester, DurbunInspectorStore(notifyDelay: Duration.zero));
    await _openSheet(tester);
    expect(find.text('No requests to export'), findsOneWidget);
    await _export(tester);
    expect(find.text('Export session'), findsOneWidget);
  });

  testWidgets('an error while making it never escapes', (tester) async {
    debugExportWriter = (name, chunks) async => throw StateError('disk on fire');
    addTearDown(() => debugExportWriter = null);
    await _open(tester, _store());
    await _openSheet(tester);
    await _export(tester);
    expect(tester.takeException(), isNull);
    expect(find.text('The export could not be made. Try again.'), findsOneWidget);
  });

  for (final (name, size, text) in <(String, Size, double)>[
    ('small phone 320x568', const Size(320, 568), 1.0),
    ('landscape 844x390', const Size(844, 390), 1.0),
    ('text x2 on 390x844', const Size(390, 844), 2.0),
  ]) {
    testWidgets('sheet fits: $name', (tester) async {
      final out = _fake(tester);
      await _open(tester, _store(), size: size, text: text);
      await _openSheet(tester);
      await _export(tester);
      expect(out.shares, hasLength(1), reason: 'the button is reachable');
    });
  }
}
