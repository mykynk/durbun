import 'dart:async';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/flutter/metrics.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

FrameTiming frame(int index, {double buildMs = 4, double rasterMs = 5}) {
  final start = index * 16667;
  final buildUs = (buildMs * 1000).round();
  final rasterUs = (rasterMs * 1000).round();
  return FrameTiming(
    vsyncStart: start,
    buildStart: start + 100,
    buildFinish: start + 100 + buildUs,
    rasterStart: start + 200 + buildUs,
    rasterFinish: start + 200 + buildUs + rasterUs,
    rasterFinishWallTime: start + 200 + buildUs + rasterUs,
  );
}

Future<void> eventually(bool Function() condition, {Duration timeout = const Duration(seconds: 10)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  group('FrameStatsAggregator', () {
    test('smooth 60 Hz frames', () {
      final agg = FrameStatsAggregator()..add([for (var i = 0; i < 60; i++) frame(i)]);
      final s = agg.takeSample(refreshRate: 60)!;
      expect(s.frames, 60);
      expect(s.fps, 60);
      expect(s.jankyFrames, 0);
      expect(s.avgBuildMs, 4);
      expect(s.avgRasterMs, 5);
      expect(agg.takeSample(), isNull, reason: 'idle interval → no sample');
    });

    test('janky frames lower the FPS and are counted', () {
      final agg = FrameStatsAggregator()
        ..add([
          for (var i = 0; i < 30; i++) frame(i),
          for (var i = 30; i < 40; i++) frame(i, buildMs: 33.3),
          frame(40, rasterMs: 20),
        ]);
      final s = agg.takeSample(refreshRate: 60)!;
      expect(s.jankyFrames, 11);
      expect(s.fps, lessThan(60));
      expect(s.fps, greaterThan(35));
    });

    test('120 Hz display uses an 8.3 ms budget', () {
      final agg = FrameStatsAggregator()..add([for (var i = 0; i < 10; i++) frame(i, buildMs: 10)]);
      final s = agg.takeSample(refreshRate: 120)!;
      expect(s.jankyFrames, 10);
      expect(s.fps, 100);
    });
  });

  group('Durbun facade', () {
    tearDown(Durbun.dispose);

    test('calls before init are harmless no-ops', () async {
      expect(Durbun.isEnabled, isFalse);
      expect(Durbun.isConnected, isFalse);
      Durbun.log('nothing');
      Durbun.e('nothing', error: StateError('x'));
      Durbun.event('nothing', {'a': 1});
      Durbun.addAction(DurbunAction.button(id: 'x', label: 'x', onPressed: (_) => null));
      expect(await Durbun.flush(timeout: const Duration(milliseconds: 10)), isFalse);
    });

    test('disabled by default inside flutter test', () async {
      await Durbun.init();
      expect(Durbun.isEnabled, isFalse);
      var ran = false;
      await Durbun.run(() => ran = true);
      expect(ran, isTrue);
      expect(Durbun.isEnabled, isFalse);
    });

    test('run(): print capture, logs, events and zone crashes', () async {
      final desktop = await FakeDesktop.start(appId: 'app:run');
      addTearDown(desktop.close);
      final outerErrors = <Object>[];
      final finished = Completer<void>();
      // ignore: unawaited_futures
      runZonedGuarded(() async {
        await Durbun.run(() async {
          // ignore: avoid_print
          print('printed inside Durbun.run');
          Durbun.log('Kullanıcı giriş yaptı', tag: 'auth', data: {'userId': 42});
          Durbun.w('düşük pil', tag: 'device');
          Durbun.event('purchase', {'amount': 49.9});
          Timer(const Duration(milliseconds: 20), () => throw StateError('zone boom'));
        }, options: DurbunOptions(
          enabled: true,
          port: desktop.port,
          appId: 'com.example.run',
          captureNetwork: false,
          useBackgroundIsolate: false,
        ));
        finished.complete();
      }, (error, stack) => outerErrors.add(error));
      await finished.future;
      expect(Durbun.isEnabled, isTrue);
      final conn = await desktop.nextConnection();

      final printed = await conn.waitForLog('printed inside Durbun.run');
      expect(printed['tag'], 'flutter');
      expect(printed['level'], 'info');
      final auth = await conn.waitForLog('Kullanıcı giriş yaptı');
      expect(auth['data'], {'userId': 42});
      expect((await conn.waitForLog('düşük pil'))['level'], 'warn');
      expect((await conn.waitFor((m) => m['type'] == 'event'))['props'], {'amount': 49.9});

      final crash = await conn.waitFor((m) => m['type'] == 'log' && m['kind'] == 'crash');
      expect(crash['level'], 'fatal');
      expect(crash['message'], 'Unhandled exception: Bad state: zone boom');
      expect((crash['error']! as Map)['type'], 'StateError');
      expect((crash['data']! as Map)['source'], 'zone');
      await eventually(() => outerErrors.isNotEmpty);
      expect(outerErrors.single, isA<StateError>(), reason: 'forwarded to the parent zone');
      expect(Durbun.isConnected, isTrue);
      expect(Durbun.connectionState.appId, 'app:run');
    });
  });

  testWidgets('Flutter glue: actions, FlutterError, commands, dumps, metrics', (tester) async {
    late FakeDesktop desktop;
    late FakeSdkConnection conn;
    await tester.runAsync(() async {
      desktop = await FakeDesktop.start(
        appId: 'app:widgets',
        config: FakeDesktop.defaultConfig(metricsIntervalMs: 200),
      );
      await Durbun.init(DurbunOptions(
        enabled: true,
        port: desktop.port,
        appId: 'com.example.widgets',
        appName: 'Widgets',
        captureNetwork: false,
        useBackgroundIsolate: false,
      ));
      conn = await desktop.nextConnection();
      await eventually(() => Durbun.isConnected);
    });
    await tester.pumpWidget(
      const Directionality(textDirection: TextDirection.ltr, child: Center(child: Text('Merhaba Dürbün'))),
    );

    final actions = (conn.hello!['actions']! as List).cast<Map<String, Object?>>();
    expect(actions.map((a) => a['id']), containsAll(<String>[
      'flutter.debugPaint',
      'flutter.repaintRainbow',
      'flutter.slowAnimations',
      'flutter.performanceOverlay',
      'flutter.invertOversizedImages',
      'flutter.brightness',
      'flutter.platform',
      'flutter.dumpWidgetTree',
      'flutter.dumpRenderTree',
    ]));
    final brightness = actions.firstWhere((a) => a['id'] == 'flutter.brightness');
    expect(brightness['kind'], 'select');
    expect(brightness['value'], 'system');
    expect((brightness['options']! as List).map((o) => (o as Map)['value']), ['system', 'light', 'dark']);
    expect(actions.firstWhere((a) => a['id'] == 'flutter.debugPaint')['value'], isFalse);

    // FlutterError.onError → flutter-error with the rendered error box.
    FlutterError.reportError(FlutterErrorDetails(
      exception: StateError('layout exploded'),
      library: 'durbun test library',
      context: ErrorDescription('while testing the SDK'),
    ));
    expect(tester.takeException(), isA<StateError>());
    final flutterError = (await tester.runAsync(
      () => conn.waitFor((m) => m['type'] == 'log' && m['kind'] == 'flutter-error'),
    ))!;
    expect(flutterError['level'], 'error');
    expect(flutterError['tag'], 'flutter');
    expect(flutterError['message'], startsWith('══╡ EXCEPTION CAUGHT BY DURBUN TEST LIBRARY ╞'));
    expect(flutterError['message'], contains('layout exploded'));
    expect((flutterError['error']! as Map)['message'], 'Bad state: layout exploded');
    expect((flutterError['data']! as Map)['library'], 'durbun test library');

    // Commands.
    final slow = (await tester.runAsync(() => conn.command('flutter.slowAnimations', params: {'value': true})))!;
    expect(slow['ok'], isTrue);
    expect(slow['data'], {'value': true});
    expect(timeDilation, 5.0);
    await tester.runAsync(() => conn.command('flutter.slowAnimations', params: {'value': false}));
    expect(timeDilation, 1.0);

    final paintOn = (await tester.runAsync(() => conn.command('flutter.debugPaint', params: {'value': true})))!;
    expect(paintOn['data'], {'value': true});
    expect(debugPaintSizeEnabled, isTrue);
    await tester.runAsync(() => conn.command('flutter.debugPaint', params: {'value': false}));
    expect(debugPaintSizeEnabled, isFalse);

    final dump = (await tester.runAsync(() => conn.command('flutter.dumpWidgetTree')))!;
    expect(dump['ok'], isTrue);
    final widgetTree = (await tester.runAsync(
      () => conn.waitFor((m) => m['type'] == 'log' && (m['message']! as String).startsWith('Widget tree')),
    ))!;
    expect(widgetTree['message'], contains('Merhaba Dürbün'));
    final renderDump = (await tester.runAsync(() => conn.command('flutter.dumpRenderTree')))!;
    expect(renderDump['ok'], isTrue);
    final renderTree = (await tester.runAsync(
      () => conn.waitFor((m) => m['type'] == 'log' && (m['message']! as String).startsWith('Render tree')),
    ))!;
    expect(renderTree['message'], contains('RenderParagraph'));

    final bad = (await tester.runAsync(() => conn.command('flutter.platform', params: {'value': 'web'})))!;
    expect(bad['ok'], isFalse);
    expect(bad['error'], contains('Unknown option'));

    // Metrics (memory/CPU at least; frame timings need a real engine).
    final metric = (await tester.runAsync(() => conn.waitFor((m) => m['type'] == 'metric')))!;
    expect(metric['memoryMB'], greaterThan(0));

    final handler = FlutterError.onError;
    await tester.runAsync(() async {
      await Durbun.dispose();
      await desktop.close();
    });
    expect(FlutterError.onError, isNot(same(handler)), reason: 'previous handler restored');
    // The panel store batches its listeners behind a short timer; whether the
    // error above started it in the fake zone depends on timing. Drain it.
    await tester.pump(const Duration(milliseconds: 250));
  });
}
