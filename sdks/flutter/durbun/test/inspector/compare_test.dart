import 'dart:convert';
import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/compare_model.dart';
import 'package:durbun/src/inspector/compare_view.dart' show CompareCallsPage, ComparePickerPage;
import 'package:durbun/src/inspector/replay_io.dart' show replayHeaders;
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Rebuilds A and B from the ops (every diff must be lossless).
(List<String>, List<String>) _replay(List<DiffOp> ops) => (
      [for (final o in ops) if (o.type != DiffOpType.add) o.text],
      [for (final o in ops) if (o.type != DiffOpType.remove) o.text],
    );

void _lossless(DiffResult r, List<String> a, List<String> b) {
  final (ra, rb) = _replay(r.ops);
  expect(ra, a);
  expect(rb, b);
}

int _lcsLength(List<String> a, List<String> b) {
  final dp = List.generate(a.length + 1, (_) => List<int>.filled(b.length + 1, 0));
  for (var i = a.length - 1; i >= 0; i--) {
    for (var j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : (dp[i + 1][j] > dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

List<String> _types(DiffResult r) => [for (final o in r.ops) o.type.name];

PendingBody _pending(String text) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: 'application/json');
}

/// The same cases as the desktop's `diff.test.ts`.
void main() {
  group('splitLines', () {
    test('normalizes newlines and ignores one trailing newline', () {
      expect(splitLines('a\r\nb\nc\n'), ['a', 'b', 'c']);
      expect(splitLines(''), isEmpty);
      expect(splitLines('\n'), ['']);
    });
  });

  group('diffLines', () {
    test('identical inputs are equal', () {
      final r = diffLines(['a', 'b'], ['a', 'b']);
      expect(_types(r), ['equal', 'equal']);
      expect((r.added, r.removed, r.equal, r.approximate, r.truncated), (0, 0, 2, false, false));
    });

    test('a single changed line in the middle', () {
      final a = ['{', '  "id": 1,', '  "name": "Pamuk",', '  "age": 2', '}'];
      final b = ['{', '  "id": 1,', '  "name": "Boncuk",', '  "age": 2', '}'];
      final r = diffLines(a, b);
      expect([for (final o in r.ops) if (o.type != DiffOpType.equal) '${o.type.name}:${o.text.trim()}'], ['remove:"name": "Pamuk",', 'add:"name": "Boncuk",']);
      _lossless(r, a, b);
    });

    test('insertions and deletions at both ends and empty sides', () {
      expect(_types(diffLines([], ['x', 'y'])), ['add', 'add']);
      expect(_types(diffLines(['x'], [])), ['remove']);
      expect(_types(diffLines(['b', 'c'], ['a', 'b', 'c', 'd'])), ['add', 'equal', 'equal', 'add']);
    });

    test('a minimal (LCS) diff on interleaved changes', () {
      final a = 'a b c a b b a'.split(' ');
      final b = 'c b a b a c'.split(' ');
      final r = diffLines(a, b);
      _lossless(r, a, b);
      expect(r.equal, _lcsLength(a, b));
    });

    test('line numbers for every op', () {
      final r = diffLines(['x', 'y', 'z'], ['x', 'q', 'z']);
      expect([for (final o in r.ops) '${o.type.name} ${o.text} ${o.a} ${o.b}'], ['equal x 0 0', 'remove y 1 null', 'add q null 1', 'equal z 2 2']);
    });

    test('big inputs split at unique anchor lines instead of a huge DP table', () {
      final a = <String>[], b = <String>[];
      for (var i = 0; i < 3000; i++) {
        a.add('  "item$i": $i,');
        b.add(i % 500 == 0 ? '  "item$i": ${i + 1},' : '  "item$i": $i,');
      }
      final r = diffLines(a, b, maxCells: 10000);
      _lossless(r, a, b);
      expect((r.removed, r.added, r.approximate), (6, 6, false));
    });

    test('a block replacement (approximate) when nothing anchors a huge middle', () {
      final a = List.generate(400, (i) => i.isOdd ? 'x' : 'y');
      final b = List.generate(400, (i) => i % 3 != 0 ? 'x' : 'z');
      final r = diffLines(a, b, maxCells: 1000);
      expect(r.approximate, isTrue);
      _lossless(r, a, b);
    });

    test('inputs longer than maxLines are cut', () {
      final r = diffLines(['1', '2', '3'], ['1', '2', '4'], maxLines: 2);
      expect(r.truncated, isTrue);
      expect(r.ops.every((o) => o.type == DiffOpType.equal), isTrue);
    });
  });

  group('collapsing (one column on the phone)', () {
    test('long unchanged runs are hidden, three lines of context kept', () {
      final a = List.generate(30, (i) => 'l$i');
      final b = List.of(a)..[15] = 'changed';
      final rows = collapseUnchanged(diffLines(a, b).ops);
      expect(rows.first.hidden, 12);
      expect(rows.last.hidden, 11);
      expect(rows.where((r) => r.op != null), hasLength(8), reason: '3 + removed + added + 3');
      final open = collapseUnchanged(diffLines(a, b).ops, expanded: {rows.first.from});
      expect(open.first.op, isNotNull, reason: 'tapping the fold shows its lines');
    });

    test('a single hidden line is not folded', () {
      final rows = collapseUnchanged(diffLines(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], ['X', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'Y']).ops);
      expect(rows.every((r) => r.op != null), isTrue);
    });
  });

  group('headers and bodies', () {
    test('headers: case-insensitive union, A order then B-only', () {
      final rows = diffHeaders(
        [['Content-Type', 'application/json'], ['X-Trace', '1'], ['Accept', '*/*']],
        [['content-type', 'application/json'], ['X-Trace', '2'], ['Authorization', '••••']],
      );
      expect([for (final r in rows) '${r.name}:${r.state.name}'], ['Content-Type:same', 'X-Trace:changed', 'Accept:onlyA', 'Authorization:onlyB']);
    });

    test('JSON bodies: pretty lines, keys sorted on request, binary and empty told apart', () {
      final x = InspectorBody(encoding: 'utf8', data: '{"b":1,"a":{"d":2,"c":3}}', size: 25);
      expect(bodyLines(x, 'application/json').lines, ['{', '  "a": {', '    "c": 3,', '    "d": 2', '  },', '  "b": 1', '}']);
      expect(bodyLines(x, 'application/json', sortKeys: false).lines.take(2), ['{', '  "b": 1,']);
      expect(bodyLines(InspectorBody(encoding: 'utf8', data: 'not json', size: 8), 'text/plain').kind, BodyKind.text);
      expect(bodyLines(InspectorBody(encoding: 'base64', data: 'AAE=', size: 2), null).kind, BodyKind.binary);
      expect(bodyLines(null, null).kind, BodyKind.none);
    });
  });

  test('replay sends the captured headers once (no second gzip, no added User-Agent)', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final got = <String, List<String>>{};
    server.listen((r) async {
      for (final n in ['accept-encoding', 'user-agent', 'x-a', 'authorization']) {
        final v = r.headers[n];
        if (v != null) got[n] = v;
      }
      r.response.statusCode = 204;
      await r.response.close();
    });
    // flutter_test swaps HttpClient for a fake; this one goes to the server.
    await HttpOverrides.runWithHttpOverrides(() async {
      final client = HttpClient();
      addTearDown(client.close);
      final req = await client.getUrl(Uri.parse('http://127.0.0.1:${server.port}/x'));
      replayHeaders(req.headers, const [['Accept-Encoding', 'gzip'], ['X-A', '1'], ['X-A', '2'], ['Authorization', '••••']]);
      await (await req.close()).drain<void>();
    }, _RealHttp());
    expect(got['accept-encoding'], ['gzip']);
    expect(got.containsKey('user-agent'), isFalse, reason: 'the original request had none');
    expect(got['x-a']!.join(', '), '1, 2', reason: 'both values sent (the server may fold them)');
    expect(got.containsKey('authorization'), isFalse);
  });

  group('screens', () {
    setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('dev.durbun/shake'), (_) async => true));

    DurbunInspectorStore twoOrders() => DurbunInspectorStore(notifyDelay: Duration.zero)
      ..bodyResolver = wireBodyFromPending
      ..ingest(buildNetRequest(id: '1', ts: 1000, method: 'GET', url: 'https://api.example.com/v1/orders?page=1', headers: const [['Accept', 'application/json']]))
      ..ingest(buildNetResponse(id: '1', ts: 1100, status: 200, headers: const [['Content-Type', 'application/json']], body: _pending('{"items":[{"id":1,"name":"Pamuk"}],"total":1}')))
      ..ingest(buildNetRequest(id: '2', ts: 2000, method: 'POST', url: 'https://api.example.com/v1/login', headers: const []))
      ..ingest(buildNetRequest(id: '3', ts: 3000, method: 'GET', url: 'https://api.example.com/v1/orders?page=2', headers: const [['Accept', 'application/json']]))
      ..ingest(buildNetResponse(id: '3', ts: 3400, status: 500, headers: const [['Content-Type', 'application/json'], ['Retry-After', '5']], body: _pending('{"items":[{"id":1,"name":"Boncuk"}],"total":1}')));

    testWidgets('detail → Compare… → the same endpoint first → body diff, headers, general, swap', (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final store = twoOrders();
      await tester.pumpWidget(MaterialApp(builder: (c, child) => DurbunInspector(store: store, child: child!), home: const Scaffold(body: Text('app'))));
      Durbun.showInspector();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Network').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('/v1/orders?page=2'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('More actions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Compare…'));
      await tester.pumpAndSettle();

      expect(find.text('Same endpoint · 1'), findsOneWidget);
      expect(find.text('Other requests · 1'), findsOneWidget);
      expect(tester.getTopLeft(find.text('Same endpoint · 1')).dy, lessThan(tester.getTopLeft(find.text('Other requests · 1')).dy));
      await tester.tap(find.textContaining('/v1/orders?page=1').last);
      await tester.pumpAndSettle();

      expect(find.text('Compare requests'), findsOneWidget);
      expect(find.text('+1'), findsOneWidget);
      expect(find.text('−1'), findsOneWidget);
      expect(find.textContaining('"name": "Pamuk"'), findsOneWidget);
      expect(find.textContaining('"name": "Boncuk"'), findsOneWidget);

      await tester.tap(find.text('Headers'));
      await tester.pumpAndSettle();
      expect(find.text('Retry-After'), findsOneWidget);
      expect(find.text('Accept'), findsNothing, reason: 'only changes by default');

      await tester.tap(find.text('General'));
      await tester.pumpAndSettle();
      // In the summary at the top and in the Status field.
      expect(find.text('500 Internal Server Error'), findsNWidgets(2));
      expect(find.text('200 OK'), findsNWidgets(2));
      final bBefore = tester.getTopLeft(find.text('200 OK').first).dy;
      await tester.tap(find.byTooltip('Swap'));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(find.text('200 OK').first).dy, lessThan(bBefore), reason: 'B (the 200) becomes A, at the top');
    });

    for (final (name, size, scale) in <(String, Size, double)>[('320x568', const Size(320, 568), 1.0), ('text x2', const Size(390, 844), 2.0), ('landscape', const Size(844, 390), 1.0)]) {
      testWidgets('no overflow: $name', (tester) async {
        tester.view.physicalSize = size * 2;
        tester.view.devicePixelRatio = 2;
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearAllTestValues);
        final store = twoOrders();
        await tester.pumpWidget(MaterialApp(home: ComparePickerPage(base: store.calls.last, store: store)));
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining('page=1').last);
        await tester.pumpAndSettle();
        for (final tab in ['Headers', 'General', 'Request body', 'Response body']) {
          await tester.tap(find.text(tab));
          await tester.pumpAndSettle();
        }
      });
    }

    testWidgets('identical bodies say so', (tester) async {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)
        ..bodyResolver = wireBodyFromPending
        ..ingest(buildNetRequest(id: '1', ts: 1, method: 'GET', url: 'https://a.io/x', headers: const []))
        ..ingest(buildNetResponse(id: '1', ts: 2, status: 200, headers: const [], body: _pending('{"a":1,"b":2}')))
        ..ingest(buildNetRequest(id: '2', ts: 3, method: 'GET', url: 'https://a.io/x', headers: const []))
        ..ingest(buildNetResponse(id: '2', ts: 4, status: 200, headers: const [], body: _pending('{"b":2,"a":1}')));
      await tester.pumpWidget(MaterialApp(home: CompareCallsPage(a: store.calls[0], b: store.calls[1])));
      await tester.pumpAndSettle();
      expect(find.text('Bodies are identical'), findsOneWidget, reason: 'sorted keys make key order irrelevant');
      await tester.tap(find.text('Sort JSON keys'));
      await tester.pumpAndSettle();
      expect(find.text('Bodies are identical'), findsNothing);
    });
  });
}

class _RealHttp extends HttpOverrides {}
