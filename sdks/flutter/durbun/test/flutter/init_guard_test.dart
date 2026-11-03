// Release builds ask the store guard before anything starts, so init() and
// run() finish one platform round trip later. What that means for the app's
// first screen, and for a dispose() that lands while the guard is asked.
// Own file: runApp() mounts a widget tree that stays for the whole isolate.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/http/http_client.dart'
    show DurbunHttpClient, DurbunHttpOverrides;
import 'package:durbun/src/flutter/backend_io.dart';
import 'package:durbun/src/flutter/native_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

const MethodChannel _channel = MethodChannel(kDurbunNativeChannel);

TestDefaultBinaryMessenger get _messenger =>
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final desktops = <FakeDesktop>[];

  Future<FakeDesktop> newDesktop() async {
    final desktop = await FakeDesktop.start(appId: 'app:init-guard');
    desktops.add(desktop);
    return desktop;
  }

  /// A fresh guard each time (a guard keeps its first answer).
  void useNewGuard() {
    IoDurbunBackend.debugStoreGuard = StoreGuard(
      channel: _channel,
      printLine: (_) {},
      languageCode: () => 'en',
    );
  }

  setUp(() {
    IoDurbunBackend.debugNativeBridgeFactory = (client) =>
        NativeBridge(client, channel: _channel, platformSupported: true);
    // As in a release build on Android / iOS.
    IoDurbunBackend.debugAskStoreGuardFirst = true;
    useNewGuard();
    _messenger.setMockMethodCallHandler(_channel, (call) async {
      if (call.method == 'guard') {
        // One platform-channel round trip, as during a real app start.
        await Future<void>.delayed(const Duration(milliseconds: 5));
        return jsonEncode(<String, Object?>{'platform': 'android', 'storeInstall': false});
      }
      if (call.method == 'start') {
        return jsonEncode(<String, Object?>{
          'attached': true,
          'platform': 'android',
          'capabilities': <String>['logs'],
        });
      }
      return null;
    });
  });

  tearDown(() async {
    await Durbun.dispose();
    IoDurbunBackend.debugNativeBridgeFactory = null;
    IoDurbunBackend.debugAskStoreGuardFirst = null;
    IoDurbunBackend.debugStoreGuard = null;
    _messenger.setMockMethodCallHandler(_channel, null);
    for (final d in desktops) {
      await d.close();
    }
    desktops.clear();
  });

  DurbunOptions options(FakeDesktop desktop) => DurbunOptions(
    enabled: true,
    port: desktop.port,
    appId: 'com.example.initguard',
    metrics: false,
    useBackgroundIsolate: false,
  );

  /// An HttpClient made in the event-loop turn in which runApp() builds the
  /// first screen (where a first Dio request creates Dio's cached client).
  Future<HttpClient> clientOfTheFirstScreen() {
    final made = Completer<HttpClient>();
    Timer.run(() => made.complete(HttpClient()));
    return made.future;
  }

  /// What runApp() does outside tests: the tree is attached in the next
  /// event-loop turn (the test binding's own runApp needs testWidgets).
  void runAppAsInAnApp(Widget app) {
    final binding = WidgetsBinding.instance;
    Timer.run(() => binding.attachRootWidget(binding.wrapWithDefaultView(app)));
  }

  bool isLateStartWarning(Map<String, Object?> m) =>
      m['type'] == 'log' && m['tag'] == 'durbun' && m['message'] == kLateStartNoticeEn;

  test('release build: init() must be awaited before runApp, and the desktop says so when it was not', () async {
    // Awaited (the README pattern): the first screen's client is captured.
    expect(WidgetsBinding.instance.rootElement, isNull);
    var desktop = await newDesktop();
    await Durbun.init(options(desktop));
    expect(Durbun.isEnabled, isTrue);
    expect(await clientOfTheFirstScreen(), isA<DurbunHttpClient>());
    var conn = await desktop.nextConnection();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(conn.received.where(isLateStartWarning), isEmpty);
    await Durbun.dispose();

    // Not awaited: runApp builds the first screen while the guard is asked.
    useNewGuard();
    desktop = await newDesktop();
    unawaited(Durbun.init(options(desktop)));
    runAppAsInAnApp(const SizedBox());
    final early = await clientOfTheFirstScreen();
    expect(WidgetsBinding.instance.rootElement, isNotNull);
    expect(early, isNot(isA<DurbunHttpClient>()), reason: 'made before the guard answered');
    conn = await desktop.nextConnection();
    final warning = await conn.waitFor(isLateStartWarning);
    expect(warning['level'], 'warn');
    expect(HttpClient(), isA<DurbunHttpClient>(), reason: 'clients made from now on are captured');
  });

  test('the late-start warning follows the device language', () {
    expect(lateStartNotice('tr'), kLateStartNoticeTr);
    expect(lateStartNotice('TR'), kLateStartNoticeTr);
    expect(lateStartNotice('en'), kLateStartNoticeEn);
    expect(lateStartNotice('de'), kLateStartNoticeEn);
    expect(kLateStartNoticeTr, contains('await Durbun.init();'));
    expect(kLateStartNoticeEn, contains('await Durbun.init();'));
  });

  test('dispose() while the release guard is asked: nothing starts afterwards', () async {
    final desktop = await newDesktop();
    unawaited(Durbun.init(options(desktop)));
    await Durbun.dispose(); // e.g. the app turns Dürbün off right away
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(Durbun.isEnabled, isFalse);
    expect(desktop.connections, isEmpty, reason: 'no orphaned SDK connects');
    expect(HttpOverrides.current, isNot(isA<DurbunHttpOverrides>()));
    expect(HttpClient(), isNot(isA<DurbunHttpClient>()));
  });

  test('run() whose guard answers after a dispose() runs the app without the SDK', () async {
    final desktop = await newDesktop();
    var ran = false;
    final running = Durbun.run(() {
      ran = true;
    }, options: options(desktop));
    await Durbun.dispose();
    await running;
    expect(ran, isTrue, reason: 'the app itself runs as usual');
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(Durbun.isEnabled, isFalse);
    expect(desktop.connections, isEmpty);
    expect(HttpOverrides.current, isNot(isA<DurbunHttpOverrides>()));
  });
}
