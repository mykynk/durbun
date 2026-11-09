import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/filter_ui.dart' show ActiveChip;
import 'package:durbun/src/inspector/network_model.dart';
import 'package:durbun/src/inspector/stats.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Network list orders (and a sorted list that holds still while read) and
/// the Statistics page.

const MethodChannel _shake = MethodChannel('dev.durbun/shake');

PendingBody _body(int bytes) {
  final data = Uint8List.fromList(utf8.encode('x' * bytes));
  return PendingBody(bytes: data, size: bytes, truncated: false, limit: 1 << 20, capture: true, contentType: 'text/plain');
}

DurbunInspectorStore _newStore() => DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;

void _call(DurbunInspectorStore s, String id, String path,
    {double ts = 1000, int? status, double? ms, int? size, String? error, bool cancelled = false, String method = 'GET', int? sent, String host = 'api.example.com'}) {
  s.ingest(buildNetRequest(id: id, ts: ts, method: method, url: 'https://$host$path', headers: const [], body: sent == null ? null : _body(sent)));
  if (status != null) {
    s.ingest(buildNetResponse(id: id, ts: ts + (ms ?? 0), status: status, headers: const [], body: size == null ? null : _body(size)));
  } else if (error != null) {
    s.ingest(buildNetError(id: id, ts: ts + (ms ?? 0), error: error, cancelled: cancelled));
  }
}

/// alpha 200 · bravo 500 · charlie refused · delta pending · echo 404 ·
/// foxtrot cancelled · golf timeout, in that order.
DurbunInspectorStore _mixed() {
  final s = _newStore();
  _call(s, 'a', '/alpha', ts: 1000, status: 200, ms: 300, size: 10);
  _call(s, 'b', '/bravo', ts: 2000, status: 500, ms: 50, size: 1000, method: 'post', sent: 20);
  _call(s, 'c', '/charlie', ts: 3000, error: 'SocketException: Connection refused', ms: 100, host: 'cdn.example.com');
  _call(s, 'd', '/delta', ts: 4000);
  _call(s, 'e', '/echo', ts: 5000, status: 404, ms: 2000, size: 5);
  _call(s, 'f', '/foxtrot', ts: 5500, error: 'Request cancelled', cancelled: true, ms: 500, host: 'cdn.example.com');
  _call(s, 'g', '/golf', ts: 6000, error: 'TimeoutException after 0:00:30.000000', ms: 30000);
  return s;
}

List<String> _paths(List<InspectorCall> calls) => [for (final c in calls) c.uri!.path];

Future<void> _open(WidgetTester tester, DurbunInspectorStore store, {String tab = 'Network'}) async {
  tester.view.physicalSize = const Size(390, 844) * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => DurbunInspector(store: store, child: child!),
    home: const Scaffold(body: Text('the app')),
  ));
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip(tab).first);
  await tester.pumpAndSettle();
}

Future<void> _sortBy(WidgetTester tester, String name) async {
  await tester.tap(find.byTooltip(RegExp(r'^Sort')).first);
  await tester.pumpAndSettle();
  await tester.tap(find.text(name).last);
  await tester.pumpAndSettle();
}

/// Top to bottom on screen.
List<String> _onScreen(WidgetTester tester, List<String> paths) {
  final shown = [for (final p in paths) if (find.textContaining(p).hitTestable().evaluate().isNotEmpty) p];
  shown.sort((a, b) => tester.getTopLeft(find.textContaining(a).first).dy.compareTo(tester.getTopLeft(find.textContaining(b).first).dy));
  return shown;
}

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (_) async => true));
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null));

  group('sortCalls', () {
    final calls = _mixed().calls;

    test('arrival is the list as kept; newest reverses it', () {
      expect(identical(sortCalls(calls, NetSort.arrival), calls), isTrue);
      expect(_paths(sortCalls(calls, NetSort.newest)), ['/golf', '/foxtrot', '/echo', '/delta', '/charlie', '/bravo', '/alpha']);
    });

    test('slowest: a pending request is as slow as it has waited; ties newest first', () {
      expect(_paths(sortCalls(calls, NetSort.slowest, nowMs: 4100)),
          ['/golf', '/echo', '/foxtrot', '/alpha', '/delta', '/charlie', '/bravo']);
      expect(_paths(sortCalls(calls, NetSort.slowest, nowMs: 100000)).first, '/delta', reason: 'a hung request rises to the top');
    });

    test('largest response: no size is the smallest', () {
      expect(_paths(sortCalls(calls, NetSort.largest)), ['/bravo', '/alpha', '/echo', '/golf', '/foxtrot', '/delta', '/charlie']);
    });

    test('errors first: transport, 5xx, 4xx, pending, success, cancelled', () {
      expect(_paths(sortCalls(calls, NetSort.status)), ['/golf', '/charlie', '/bravo', '/echo', '/delta', '/alpha', '/foxtrot']);
      expect([for (final c in sortCalls(calls, NetSort.status)) statusRank(c)], [0, 0, 1, 2, 3, 5, 6]);
    });

    test('a 3xx sits between pending and success; a lower status first within a rank', () {
      final s = _newStore();
      _call(s, '1', '/ok', status: 204, ms: 1);
      _call(s, '2', '/moved', status: 301, ms: 1);
      _call(s, '3', '/gone', status: 410, ms: 1);
      _call(s, '4', '/bad', status: 400, ms: 1);
      expect(_paths(sortCalls(s.calls, NetSort.status)), ['/bad', '/gone', '/moved', '/ok']);
    });
  });

  group('statistics', () {
    test('percentile by nearest rank', () {
      expect(percentile(const [], 0.5), isNull);
      expect(percentile(const [7], 0.95), 7);
      expect(percentile(const [1, 2, 3, 4], 0.5), 2);
      expect(percentile([for (var i = 1; i <= 20; i++) i.toDouble()], 0.95), 19);
      expect(percentile([for (var i = 1; i <= 100; i++) i.toDouble()], 0.95), 95);
      expect(percentile([for (var i = 1; i <= 100; i++) i.toDouble()], 0.5), 50);
      expect(percentile(const [1, 2, 3], 1), 3);
    });

    test('counts, durations over responses, bytes, hosts and methods', () {
      final s = computeNetworkStats(_mixed().calls);
      expect(s.requests, 7);
      expect((s.success, s.clientErrors, s.serverErrors), (1, 1, 1));
      expect((s.failed, s.timeouts, s.pending, s.cancelled), (2, 1, 1, 1));
      expect(s.timed, 3);
      expect(s.averageMs, closeTo(783.33, 0.01));
      expect((s.p50Ms, s.p95Ms, s.maxMs), (300, 2000, 2000));
      expect((s.bytesSent, s.bytesReceived), (20, 1015));
      expect([for (final h in s.hosts) (h.host, h.requests, h.failures)], [('api.example.com', 5, 3), ('cdn.example.com', 2, 1)]);
      expect(s.hosts.first.bytesReceived, 1015);
      expect(s.hosts.first.averageMs, closeTo(783.33, 0.01));
      expect(s.hosts.last.averageMs, isNull, reason: 'no response from it');
      expect(s.otherHosts, 0);
      expect(s.methods, [('GET', 6), ('POST', 1)]);
    });

    test('the busiest hosts, the rest counted', () {
      final store = _newStore();
      for (var i = 0; i < 12; i++) {
        _call(store, '$i', '/x', host: 'h${i.toString().padLeft(2, '0')}.io', status: 200, ms: 1);
      }
      _call(store, 'z', '/y', host: 'h11.io', status: 200, ms: 1);
      final s = computeNetworkStats(store.calls);
      expect(s.hosts.map((h) => h.host).take(3), ['h11.io', 'h00.io', 'h01.io']);
      expect(s.hosts, hasLength(10));
      expect(s.otherHosts, 2);
    });

    test('nothing yet', () {
      final s = computeNetworkStats(const []);
      expect((s.requests, s.timed, s.averageMs, s.p95Ms), (0, 0, null, null));
      expect(s.hosts, isEmpty);
    });
  });

  group('Network list order', () {
    testWidgets('the sort sheet orders the list, shows a chip, and is kept when the panel reopens', (tester) async {
      final s = _mixed();
      await _open(tester, s);
      const all = ['/alpha', '/bravo', '/charlie', '/delta', '/echo', '/foxtrot', '/golf'];
      expect(_onScreen(tester, all), all, reason: 'arrival: oldest on top');

      await tester.tap(find.byTooltip('Sort').first);
      await tester.pumpAndSettle();
      for (final name in ['Arrival order', 'Newest on top', 'Slowest first', 'Largest response first', 'Errors first']) {
        expect(find.text(name), findsOneWidget);
      }
      await tester.tap(find.text('Errors first'));
      await tester.pumpAndSettle();
      expect(_onScreen(tester, all), ['/golf', '/charlie', '/bravo', '/echo', '/delta', '/alpha', '/foxtrot']);
      expect(find.widgetWithText(ActiveChip, 'Errors first'), findsOneWidget);
      expect(find.byTooltip('Sort: Errors first'), findsOneWidget);
      expect(tester.getSize(find.byTooltip('Sort: Errors first')).height, greaterThanOrEqualTo(44));

      // Closed and opened again: the order is the store's.
      await tester.tap(find.byTooltip('Close').first);
      await tester.pumpAndSettle();
      expect(find.text('the app'), findsOneWidget);
      Durbun.showInspector();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Network').first);
      await tester.pumpAndSettle();
      expect(_onScreen(tester, all).first, '/golf');

      await _sortBy(tester, 'Largest response first');
      expect(_onScreen(tester, all).take(3), ['/bravo', '/alpha', '/echo']);

      // The chip's × goes back to arrival.
      await tester.tap(find.byType(ActiveChip).first);
      await tester.pumpAndSettle();
      expect(_onScreen(tester, all), all);
      expect(find.byType(ActiveChip), findsNothing);
    });

    testWidgets('sorted and scrolled down: the rows hold still, new requests wait behind "N new" on top', (tester) async {
      final s = _newStore();
      String path(int i) => '/req-${i.toString().padLeft(3, '0')}';
      // The newer, the slower: slowest first lists the newest on top.
      for (var i = 0; i < 40; i++) {
        _call(s, '$i', path(i), ts: 1000.0 + i, status: 200, ms: 10.0 + i);
      }
      await _open(tester, s);
      await _sortBy(tester, 'Slowest first');
      expect(find.textContaining(path(39)).hitTestable(), findsOneWidget, reason: 'the slowest on top');

      await tester.drag(find.byType(ListView).last, const Offset(0, -500));
      await tester.pumpAndSettle();
      final paths = [for (var i = 0; i < 40; i++) path(i)];
      final anchor = _onScreen(tester, paths).first;
      final before = tester.getTopLeft(find.textContaining(anchor));

      for (var i = 40; i < 43; i++) {
        _call(s, '$i', path(i), ts: 2000.0 + i, status: 200, ms: 5000);
      }
      // An older one ends now, even slower: it moves only after resuming.
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(find.textContaining(anchor)), before, reason: 'the row being read stays put');
      expect(find.text('3 new'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_upward), findsOneWidget, reason: 'they are above');

      await tester.tap(find.text('3 new'));
      await tester.pumpAndSettle();
      expect(find.text('3 new'), findsNothing);
      expect(_onScreen(tester, [for (var i = 0; i < 43; i++) path(i)]).take(4), [path(42), path(41), path(40), path(39)]);
    });

    testWidgets('arrival order still follows the bottom', (tester) async {
      final s = _newStore();
      for (var i = 0; i < 40; i++) {
        _call(s, '$i', '/r$i/', ts: 1000.0 + i, status: 200, ms: 1);
      }
      await _open(tester, s);
      expect(find.textContaining('/r39/').hitTestable(), findsOneWidget);
      _call(s, '40', '/r40/', ts: 2000, status: 200, ms: 1);
      await tester.pumpAndSettle();
      expect(find.textContaining('/r40/').hitTestable(), findsOneWidget);
    });
  });

  group('Statistics page', () {
    testWidgets('from the tools sheet: totals, durations, hosts; updates live', (tester) async {
      final s = _mixed();
      await _open(tester, s);
      await tester.tap(find.byTooltip('Tools').first);
      await tester.pumpAndSettle();
      expect(find.text('7 requests'), findsOneWidget, reason: 'the row says how many');
      await tester.tap(find.text('Statistics'));
      await tester.pumpAndSettle();
      expect(find.text('Statistics'), findsOneWidget);
      for (final label in ['Successful', 'Client errors (4xx)', 'Server errors (5xx)', 'Transport errors', 'Pending', 'Median (p50)', 'p95']) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      expect(find.text('Top 2 hosts'), findsOneWidget);
      expect(find.textContaining('api.example.com'), findsWidgets);

      _call(s, 'h', '/hotel', ts: 7000, status: 503, ms: 10);
      await tester.pump(const Duration(milliseconds: 1100));
      await tester.pumpAndSettle();
      final server = find.ancestor(of: find.text('Server errors (5xx)'), matching: find.byType(Container)).first;
      expect(find.descendant(of: server, matching: find.text('2')), findsOneWidget, reason: 'a second 5xx shows within a second');
    });

    testWidgets('no requests: says so', (tester) async {
      await _open(tester, _newStore());
      await tester.tap(find.byTooltip('Tools').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Statistics'));
      await tester.pumpAndSettle();
      expect(find.text('Successful'), findsNothing);
      expect(find.byIcon(Icons.insights_rounded), findsWidgets);
    });
  });
}
