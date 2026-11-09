import 'dart:convert';
import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/logs_view.dart' show LogDetailPage;
import 'package:durbun/src/inspector/run_file_io.dart';
import 'package:durbun/src/inspector/run_log.dart';
import 'package:durbun/src/inspector/share_report.dart' show ShareMasker;
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// keepPreviousRun: the records (masked, bodies cut), the batching, the
/// files (rotation, a cut last line) and the read-only "Previous run" page.

const MethodChannel _shake = MethodChannel('dev.durbun/shake');

PendingBody _text(String text, {String contentType = 'application/json'}) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 30, capture: true, contentType: contentType);
}

DurbunInspectorStore _newStore() => DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;

void _login(DurbunInspectorStore s, {String id = '1', String? response, int status = 200}) {
  s
    ..ingest(buildNetRequest(
        id: id,
        ts: 1000,
        method: 'POST',
        url: 'https://api.example.com/login?access_token=abc123',
        headers: const [
          ['Authorization', 'Bearer s3cr3t-token'],
          ['Content-Type', 'application/json'],
        ],
        body: _text('{"user":"ayşe","password":"hunter2"}')))
    ..ingest(buildNetResponse(
        id: id,
        ts: 1100,
        status: status,
        headers: const [
          ['Content-Type', 'application/json']
        ],
        body: _text(response ?? '{"token":"zzz","ok":true}')));
}

Map<String, Object?> _crash({String message = 'Bad state: boom', double ts = 5000}) => buildLog(
    level: 'fatal',
    message: 'Unhandled exception',
    ts: ts,
    kind: 'crash',
    error: buildErrorInfo(type: 'StateError', message: message, stack: '#0 main (package:shop/main.dart:12)'));

/// A journal without files: the widget tests' stand-in.
class _FakeJournal extends RunJournal {
  _FakeJournal(this.records, {PreviousRunInfo? previous}) : _previous = ValueNotifier<PreviousRunInfo?>(previous);

  final List<Map<String, Object?>>? records;
  final ValueNotifier<PreviousRunInfo?> _previous;
  int flushes = 0;

  @override
  bool recording = true;

  @override
  ValueListenable<PreviousRunInfo?> get previous => _previous;

  @override
  double get startedAtMs => 1e15;

  @override
  void flushNow() => flushes++;

  @override
  Future<List<Map<String, Object?>>?> readPrevious() async => records;
}

/// What the recorder writes for a store with a login, a log and a crash.
List<Map<String, Object?>> _recorded(DurbunInspectorStore s) {
  final lines = <String>[];
  RunRecorder(s, lines.addAll, startedAtMs: 900)
    ..start()
    ..flushNow()
    ..stop();
  return decodeRunLines(lines);
}

void main() {
  group('records', () {
    test('a request: masked like an export, bodies only once it ended', () {
      final s = _newStore()
        ..ingest(buildNetRequest(id: 'p', ts: 900, method: 'GET', url: 'https://api.example.com/wait', headers: const [], body: _text('{"a":1}')));
      _login(s);
      final m = ShareMasker(true);
      final pending = runCallRecord(s.calls.first, m);
      expect(pending.containsKey('reqBody'), isFalse, reason: 'a pending request is written again when it ends');

      final r = runCallRecord(s.calls.last, m);
      expect(r['url'], 'https://api.example.com/login?access_token=••••');
      expect(r['reqH'], [
        ['Authorization', 'Bearer ••••'],
        ['Content-Type', 'application/json'],
      ]);
      expect((r['reqBody']! as Map)['data'], '{"user":"ayşe","password":"••••"}');
      expect((r['resBody']! as Map)['data'], '{"token":"••••","ok":true}');
      expect(jsonEncode(r), isNot(anyOf(contains('hunter2'), contains('s3cr3t'), contains('abc123'), contains('zzz'))));
      expect((r['status'], r['end']), (200, 1100));
      expect(m.count, greaterThan(0));
    });

    test('a body past 16 KB is cut; a secret left open at the cut is still masked', () {
      final s = _newStore();
      final filler = 'a' * (kRunBodyBytes - 30);
      _login(s, response: '{"filler":"$filler","refresh_token":"${'r' * 200}"}');
      final body = runCallRecord(s.calls.single, ShareMasker(true))['resBody']! as Map;
      expect(body['truncated'], true);
      expect(body['size'], greaterThan(kRunBodyBytes));
      final data = body['data']! as String;
      expect(data.length, lessThanOrEqualTo(kRunBodyBytes + 40));
      expect(data, isNot(contains('rrrr')));
      expect(data, endsWith('"refresh_token": "••••'));
    });

    test('a crash line keeps its error; long text is capped', () {
      final s = _newStore()
        ..ingest(_crash())
        ..ingest(buildLog(level: 'info', message: 'x' * (kRunTextChars * 2), ts: 6000));
      final crash = runLogRecord(s.logs.first);
      expect(crash['kind'], 'crash');
      expect(crash['error'], {'type': 'StateError', 'message': 'Bad state: boom', 'stack': '#0 main (package:shop/main.dart:12)'});
      expect((runLogRecord(s.logs.last)['msg']! as String).length, lessThanOrEqualTo(kRunTextChars + 1));
    });

    test('a line cut by the process ending is skipped', () {
      final lines = ['{"t":"run","v":1,"start":1}', '', 'not json', '[1,2]', '{"t":"log","seq":1,"msg":"ok"}', '{"t":"log","seq":2,"msg":"cut mid-wr'];
      expect(decodeRunLines(lines), [
        {'t': 'run', 'v': 1, 'start': 1},
        {'t': 'log', 'seq': 1, 'msg': 'ok'},
      ]);
    });
  });

  group('restoring', () {
    test('a read-only store: calls merged from their records, logs in order, crashes', () async {
      final s = _newStore()
        ..ingest(buildHello(
            app: const {'name': 'Shop', 'version': '2.4.1'}, device: const {'model': 'Pixel 8'}, session: 's', capabilities: const [], actions: const []))
        ..ingest(buildLog(level: 'info', message: 'started', ts: 900))
        ..ingest(buildNetRequest(id: 'w', ts: 950, method: 'GET', url: 'https://api.example.com/slow', headers: const []));
      final lines = <String>[];
      final recorder = RunRecorder(s, lines.addAll, startedAtMs: 800)..start();
      recorder.flushNow();
      // The slow request ends after it was first written.
      s.ingest(buildNetResponse(id: 'w', ts: 2950, status: 503, headers: const []));
      _login(s);
      s.ingest(_crash());
      recorder
        ..flushNow()
        ..stop();
      final records = decodeRunLines(lines);
      expect(records.where((r) => r['t'] == 'call' && r['id'] == 'w'), hasLength(2), reason: 'pending, then ended');

      final late = _newStore()..ingest(_crash(message: 'native SIGSEGV', ts: 7000));
      final run = await restoreRun(records,
          defaultHosts: const ['api.example.com'], lateCrashes: lateCrashesOf(late, currentStartMs: 8000, previousStartMs: 800));
      addTearDown(run.store.dispose);
      expect(run.store.readOnly, isTrue);
      expect(run.startedAtMs, 800);
      expect(run.store.hello?['app'], {'name': 'Shop', 'version': '2.4.1'});
      expect([for (final c in run.store.calls) (c.uri!.path, c.status)], [('/slow', 503), ('/login', 200)]);
      expect(run.store.calls.first.duration, const Duration(seconds: 2));
      expect(run.store.calls.last.requestBody?.data, '{"user":"ayşe","password":"••••"}');
      expect([for (final l in run.store.logs) l.message], ['started', 'Unhandled exception', 'Unhandled exception']);
      expect([for (final c in run.crashes) c.error?['message']], ['Bad state: boom', 'native SIGSEGV']);
    });

    test('late crashes: only the ones before this launch and after the previous one', () {
      final s = _newStore()
        ..ingest(_crash(ts: 100))
        ..ingest(_crash(ts: 500))
        ..ingest(_crash(ts: 2000));
      expect([for (final l in lateCrashesOf(s, currentStartMs: 1000, previousStartMs: 300)) l.ts], [500]);
      expect(lateCrashesOf(s, currentStartMs: 1000), hasLength(2));
    });

    test('nothing usable: an empty store, no throw', () async {
      final run = await restoreRun(decodeRunLines(['{"t":"call"}', '{"t":"log"}', '{"t":"?"}']));
      addTearDown(run.store.dispose);
      expect(run.store.calls.length, lessThanOrEqualTo(1));
      expect(run.crashes, isEmpty);
    });
  });

  group('recorder', () {
    testWidgets('batched at most once a second; a crash is written at once', (tester) async {
      final s = _newStore();
      final batches = <List<String>>[];
      final recorder = RunRecorder(s, (lines) => batches.add(List.of(lines)), startedAtMs: 1)..start();
      addTearDown(recorder.stop);
      expect(batches, hasLength(1), reason: 'the header');
      expect(jsonDecode(batches.single.single), {'t': 'run', 'v': 1, 'start': 1});

      for (var i = 0; i < 20; i++) {
        s.ingest(buildLog(level: 'info', message: 'line $i', ts: 1000.0 + i));
      }
      _login(s);
      await tester.pump(const Duration(milliseconds: 500));
      expect(batches, hasLength(1), reason: 'not yet');
      await tester.pump(const Duration(milliseconds: 600));
      expect(batches, hasLength(2), reason: 'one batch');
      expect(batches.last.where((l) => l.contains('"t":"log"')), hasLength(20));
      expect(batches.last.where((l) => l.contains('"t":"call"')), hasLength(1));

      s.ingest(_crash());
      expect(batches, hasLength(3), reason: 'the crash did not wait');
      expect(batches.last.single, contains('"kind":"crash"'));

      // Nothing changed: nothing written.
      await tester.pump(const Duration(seconds: 3));
      expect(batches, hasLength(3));

      // Off: nothing written; on again, the changes meanwhile follow.
      recorder.recording = false;
      s.ingest(buildLog(level: 'info', message: 'while off', ts: 9000));
      await tester.pump(const Duration(seconds: 2));
      expect(batches, hasLength(3));
      recorder.recording = true;
      s.ingest(buildLog(level: 'info', message: 'back on', ts: 9100));
      await tester.pump(const Duration(seconds: 2));
      expect(batches.last.join('\n'), allOf(contains('while off'), contains('back on')));
    });

    test('everything a session writes reads back', () {
      final s = _newStore();
      _login(s);
      s.ingest(_crash());
      final records = _recorded(s);
      expect([for (final r in records) r['t']], ['run', 'log', 'call']);
    });
  });

  group('files', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('durbun-run-test'));
    tearDown(() => dir.deleteSync(recursive: true));

    File file(String name) => File('${dir.path}/$kRunFolder/$name');

    Future<FileRunJournal> launch(DurbunInspectorStore s, {int maxBytes = kRunMaxFileBytes}) async {
      final j = FileRunJournal(s, baseDir: dir.path, maxBytes: maxBytes, interval: const Duration(milliseconds: 5))..start();
      await j.opened;
      return j;
    }

    test('this launch writes run.jsonl; the next one reads it as the previous run', () async {
      final first = _newStore();
      final j1 = await launch(first);
      expect(j1.previous.value, isNull, reason: 'a first launch has no previous run');
      expect(await j1.readPrevious(), isNull);
      _login(first);
      first.ingest(_crash());
      j1.flushNow();
      await j1.settle();
      final written = decodeRunLines(file('run.jsonl').readAsLinesSync());
      expect([for (final r in written) r['t']], ['run', 'log', 'call'], reason: 'the crash wrote the batch at once');
      expect(file('run.jsonl').readAsStringSync(), isNot(contains('hunter2')));

      // The app ended mid-write.
      file('run.jsonl').writeAsStringSync('{"t":"log","seq":99,"msg":"cut', mode: FileMode.append);

      final second = _newStore()..ingest(buildLog(level: 'info', message: 'new run', ts: 1));
      final j2 = await launch(second);
      expect(j2.previous.value, isNotNull);
      expect(j2.previous.value!.bytes, greaterThan(0));
      final previous = await j2.readPrevious();
      expect([for (final r in previous!) r['t']], ['run', 'log', 'call'], reason: 'the cut line is skipped');
      j2.flushNow();
      await j2.settle();
      expect(file('run.jsonl').readAsStringSync(), contains('new run'));
      expect(file('run.jsonl').readAsStringSync(), isNot(contains('hunter2')), reason: 'this run starts a new file');

      // A third launch drops the first run.
      final j3 = await launch(_newStore());
      final third = await j3.readPrevious();
      expect(third!.where((r) => r['msg'] == 'new run'), hasLength(1));
      expect(third.where((r) => r['t'] == 'call'), isEmpty);
    });

    test('past the size limit: run.jsonl rotates to run.1.jsonl, both read back, older parts dropped', () async {
      final s = _newStore();
      final j = await launch(s, maxBytes: 4000);
      for (var batch = 0; batch < 12; batch++) {
        for (var i = 0; i < 10; i++) {
          s.ingest(buildLog(level: 'info', message: 'batch $batch line $i ${'·' * 20}', ts: 1000.0 + batch * 10 + i));
        }
        j.flushNow();
        await j.settle();
      }
      expect(file('run.1.jsonl').existsSync(), isTrue);
      expect(file('run.jsonl').lengthSync(), lessThanOrEqualTo(4000));
      expect(file('run.1.jsonl').lengthSync(), lessThanOrEqualTo(4000));
      expect(decodeRunLines(file('run.jsonl').readAsLinesSync()).first['t'], 'run', reason: 'every file starts with the header');

      final next = await launch(_newStore());
      final records = await next.readPrevious();
      final messages = [for (final r in records!) if (r['t'] == 'log') r['msg']! as String];
      expect(messages.last, startsWith('batch 11 line 9'));
      expect(messages.first, isNot(startsWith('batch 0 ')), reason: 'only the last two parts are kept');
      final seqs = [for (final r in records) if (r['t'] == 'log') r['seq']! as int];
      expect(seqs, orderedEquals([...seqs]..sort()), reason: 'the older part first');
    });

    test('no folder to write in: quietly nothing', () async {
      final blocker = File('${dir.path}/blocker')..writeAsStringSync('');
      final s = _newStore();
      final j = FileRunJournal(s, baseDir: blocker.path)..start();
      await j.opened;
      s.ingest(buildLog(level: 'info', message: 'x', ts: 1));
      j.flushNow();
      await j.settle();
      expect(j.previous.value, isNull);
      expect(await j.readPrevious(), isNull);
    });
  });

  group('panel', () {
    setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (_) async => true));
    tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null));

    Future<void> openTools(WidgetTester tester, DurbunInspectorStore store, {bool keep = true}) async {
      tester.view.physicalSize = const Size(390, 844) * 3;
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        builder: (context, child) => DurbunInspector(store: store, keepPreviousRun: keep, child: child!),
        home: const Scaffold(body: Text('the app')),
      ));
      Durbun.showInspector();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Tools').first);
      await tester.pumpAndSettle();
    }

    Future<void> tapTool(WidgetTester tester, String name) async {
      await tester.scrollUntilVisible(find.text(name), 120, scrollable: find.byType(Scrollable).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text(name));
      await tester.pumpAndSettle();
    }

    List<Map<String, Object?>> previousRecords() {
      final s = _newStore()
        ..ingest(buildLog(level: 'info', message: 'opening cart', ts: 1000));
      _login(s, status: 500);
      s.ingest(_crash());
      return _recorded(s);
    }

    testWidgets('a crashed run: named on top, opens in one tap, read-only lists', (tester) async {
      final store = _newStore();
      final journal = _FakeJournal(previousRecords(), previous: PreviousRunInfo(savedAt: DateTime.now().subtract(const Duration(minutes: 5)), bytes: 900));
      RunJournal.register(store, journal);
      await openTools(tester, store);
      expect(find.text('5 min ago'), findsOneWidget, reason: 'when it was saved');
      await tapTool(tester, 'Previous run');

      expect(find.textContaining('Previous run · Started 1970-01-01'), findsOneWidget);
      expect(find.text('This run crashed'), findsOneWidget);
      expect(find.textContaining('Bad state: boom'), findsWidgets);
      expect(find.byTooltip('Tools'), findsNothing, reason: 'nothing to change in a saved run');

      await tester.tap(find.text('Open the crash'));
      await tester.pumpAndSettle();
      expect(find.byType(LogDetailPage), findsOneWidget);
      expect(find.textContaining('package:shop/main.dart:12'), findsWidgets);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Network').first);
      await tester.pumpAndSettle();
      expect(find.textContaining('/login'), findsOneWidget);
      expect(find.byTooltip('Pause'), findsNothing);

      await tester.tap(find.textContaining('/login'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Replay'), findsNothing);
      expect(find.text('Replay'), findsNothing);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      // Closed: back on the live panel.
      await tester.tap(find.byTooltip('Close').first);
      await tester.pumpAndSettle();
      expect(find.byTooltip('Tools'), findsOneWidget);
    });

    testWidgets('a previous run with nothing in it says so', (tester) async {
      final store = _newStore();
      RunJournal.register(store, _FakeJournal(null, previous: PreviousRunInfo(savedAt: DateTime.now(), bytes: 1)));
      await openTools(tester, store);
      await tapTool(tester, 'Previous run');
      expect(find.text('Nothing saved from the previous run'), findsOneWidget);
    });

    testWidgets('no previous run: no row', (tester) async {
      final store = _newStore();
      RunJournal.register(store, _FakeJournal(null));
      await openTools(tester, store);
      await tester.scrollUntilVisible(find.text('Export session'), 120, scrollable: find.byType(Scrollable).last);
      expect(find.text('Previous run'), findsNothing);
    });

    testWidgets('keepPreviousRun turns the writing on and off; leaving the app flushes', (tester) async {
      final store = _newStore();
      final journal = _FakeJournal(null)..recording = false;
      RunJournal.register(store, journal);
      await openTools(tester, store);
      expect(journal.recording, isTrue);

      await tester.pumpWidget(MaterialApp(
        builder: (context, child) => DurbunInspector(store: store, child: child!),
        home: const Scaffold(body: Text('the app')),
      ));
      await tester.pumpAndSettle();
      expect(journal.recording, isFalse, reason: 'off by default');

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      expect(journal.flushes, greaterThan(0));
      for (final state in [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
        tester.binding.handleAppLifecycleStateChanged(state);
      }
    });
  });
}
