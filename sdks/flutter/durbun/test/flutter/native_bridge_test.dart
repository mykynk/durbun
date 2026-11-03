// Enablement rules and the bridge to the plugin's native layer (the platform
// side is simulated through the test binary messenger).
import 'dart:async';
import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart' show durbunEnabledByDefault;
import 'package:durbun/src/flutter/backend_io.dart';
import 'package:durbun/src/flutter/native_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

const MethodChannel _channel = MethodChannel(kDurbunNativeChannel);
const StandardMethodCodec _codec = StandardMethodCodec();

TestDefaultBinaryMessenger get _messenger =>
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

Future<void> eventually(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 10),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('condition not met');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

/// A call from the native side to Dart; returns the decoded reply.
Future<Object?> nativeCall(String method, [Object? arguments]) {
  final completer = Completer<Object?>();
  unawaited(
    _messenger.handlePlatformMessage(
      kDurbunNativeChannel,
      _codec.encodeMethodCall(MethodCall(method, arguments)),
      (data) => completer.complete(
        data == null ? null : _codec.decodeEnvelope(data),
      ),
    ),
  );
  return completer.future;
}

Map<String, Object?> _json(Object? arguments) =>
    (jsonDecode(arguments! as String) as Map).cast<String, Object?>();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('enablement', () {
    bool resolve({
      bool? enabled,
      bool release = false,
      bool defineGiven = false,
      bool define = false,
      bool inTest = false,
    }) => resolveDurbunEnabled(
      DurbunOptions(enabled: enabled),
      releaseMode: release,
      defineGiven: defineGiven,
      defineValue: define,
      inFlutterTest: inTest,
    );

    test('debug and profile builds are on', () {
      expect(resolve(), isTrue);
    });

    test('release builds are off without --dart-define=DURBUN=true', () {
      expect(resolve(release: true), isFalse);
      expect(resolve(release: true, defineGiven: true, define: true), isTrue);
    });

    test('DURBUN=false turns debug builds off too', () {
      expect(resolve(defineGiven: true, define: false), isFalse);
    });

    test('an explicit enabled option wins', () {
      expect(resolve(enabled: true, release: true), isTrue);
      expect(resolve(enabled: false), isFalse);
      expect(
        resolve(enabled: false, release: true, defineGiven: true, define: true),
        isFalse,
      );
    });

    test('off inside flutter test unless enabled: true', () {
      expect(resolve(inTest: true), isFalse);
      expect(resolve(inTest: true, enabled: true), isTrue);
    });

    test('the defaults mirror this build (debug, no define)', () {
      expect(durbunEnabledByDefault(), isTrue);
      expect(resolveDurbunEnabled(const DurbunOptions()), isFalse,
          reason: 'flutter test');
    });
  });

  group('native layer', () {
    late FakeDesktop desktop;
    final calls = <MethodCall>[];
    Object? Function(MethodCall call)? startReply;
    var startDelay = Duration.zero;

    Map<String, Object?> attachedReply() => <String, Object?>{
      'attached': true,
      'platform': 'android',
      'sdk': <String, Object?>{'name': 'durbun-android', 'version': '0.1.0'},
      'capabilities': <String>['logs', 'network', 'mocks', 'crash', 'commands'],
      'actions': <Map<String, Object?>>[
        <String, Object?>{
          'id': 'android.dumpThreads',
          'kind': 'button',
          'label': 'Dump threads',
          'labelKey': 'android.dumpThreads',
          'group': 'android',
        },
      ],
      'commands': <String>['android.gc'],
      'app': <String, Object?>{'name': 'Pati', 'version': '2.3.0', 'build': '230'},
      'urlSession': false,
    };

    Future<FakeSdkConnection> startSdk({List<String> redact = const <String>[]}) async {
      await Durbun.init(
        DurbunOptions(
          enabled: true,
          port: desktop.port,
          appId: 'com.example.native',
          captureNetwork: false,
          metrics: false,
          useBackgroundIsolate: false,
          redactHeaders: redact,
        ),
      );
      return desktop.nextConnection();
    }

    setUp(() async {
      desktop = await FakeDesktop.start(appId: 'app:native');
      calls.clear();
      startReply = (_) => jsonEncode(attachedReply());
      startDelay = Duration.zero;
      IoDurbunBackend.debugNativeBridgeFactory = (client) =>
          NativeBridge(client, channel: _channel, platformSupported: true);
      _messenger.setMockMethodCallHandler(_channel, (call) async {
        calls.add(call);
        if (call.method == 'start') {
          if (startDelay > Duration.zero) await Future<void>.delayed(startDelay);
          return startReply?.call(call);
        }
        return null;
      });
    });

    tearDown(() async {
      await Durbun.dispose();
      IoDurbunBackend.debugNativeBridgeFactory = null;
      _messenger.setMockMethodCallHandler(_channel, null);
      await desktop.close();
    });

    test('hello carries the native capabilities, actions and app version', () async {
      final conn = await startSdk(redact: const <String>['Authorization']);
      final hello = conn.hello!;
      expect(
        (hello['capabilities']! as List),
        containsAll(<String>['logs', 'events', 'commands', 'crash', 'network', 'mocks']),
      );
      final actionIds = [for (final a in hello['actions']! as List) (a as Map)['id']];
      expect(actionIds, containsAll(<String>['flutter.debugPaint', 'android.dumpThreads']));
      final app = hello['app']! as Map;
      expect(app['version'], '2.3.0');
      expect(app['build'], '230');
      expect(app['name'], 'Pati');
      expect((hello['sdk']! as Map)['name'], 'durbun-flutter');
      expect((hello['sdk']! as Map)['layers'], <String>['dart', 'android']);
      expect(DurbunNetwork.capturesUrlSession, isFalse, reason: 'Android reply');

      final start = _json(calls.firstWhere((c) => c.method == 'start').arguments);
      expect(start['session'], hello['session']);
      expect((start['options']! as Map)['redactHeaders'], <String>['Authorization']);
      expect((start['options']! as Map)['captureErrors'], isTrue);

      // After the welcome the native side learns the connection, config and hello.
      await eventually(
        () => calls.any((c) => c.method == 'state' && _json(c.arguments)['connected'] == true),
      );
      final state = _json(calls.lastWhere((c) => c.method == 'state').arguments);
      expect(state['via'], startsWith('tcp 127.0.0.1:'));
      expect(state['appId'], 'app:native');
      expect((state['hello']! as Map)['session'], hello['session']);
      // The hello a native crash report presents carries the same layers.
      expect(((state['hello']! as Map)['sdk']! as Map)['layers'], <String>['dart', 'android']);
      expect((state['config']! as Map)['maxBodyBytes'], 1048576);
    });

    test('a native layer that answers after 2 s still makes the first hello', () async {
      // The server keeps the first hello of a connection: a late native layer
      // would stay out of the session (layers, app version) until a reconnect.
      startDelay = const Duration(seconds: 2);
      final conn = await startSdk();
      expect((conn.hello!['sdk']! as Map)['layers'], <String>['dart', 'android']);
      expect((conn.hello!['app']! as Map)['version'], '2.3.0');
    });

    test('mock rules end with the connection, on the native side too', () async {
      desktop.mocks = <Map<String, Object?>>[
        <String, Object?>{
          'id': 'm1',
          'enabled': true,
          'method': 'GET',
          'url': '/users',
          'match': 'contains',
          'action': <String, Object?>{'type': 'respond', 'status': 200},
          'createdAt': 1,
        },
      ];
      final conn = await startSdk();
      bool pushed(MethodCall c, {required bool connected, required bool withRules}) {
        if (c.method != 'state') return false;
        final state = _json(c.arguments);
        return state['connected'] == connected && (state['mocks']! as List).isNotEmpty == withRules;
      }

      await eventually(() => calls.any((c) => pushed(c, connected: true, withRules: true)));
      final before = calls.length;
      conn.destroy();
      // Whoever answered the hello is not authenticated: once it is gone, the
      // native layer (OkHttp / URLSession) must stop applying its rules too.
      await eventually(
        () => calls.skip(before).any((c) => pushed(c, connected: false, withRules: false)),
      );
    });

    test('native messages go out on the Dart connection', () async {
      final conn = await startSdk();
      await nativeCall('events', <String>[
        '{"type":"log","ts":1700000000000,"level":"fatal","tag":"crash",'
            '"message":"FATAL EXCEPTION in thread \\"main\\": boom","kind":"crash"}',
        '{"type":"net.request","id":"okhttp-1","ts":1700000000001,"method":"GET",'
            '"url":"https://api.example.com/a","headers":[],"source":"okhttp"}',
        'garbage\nwith a newline',
        '',
      ]);
      final crash = await conn.waitFor((m) => m['type'] == 'log' && m['kind'] == 'crash');
      expect(crash['message'], 'FATAL EXCEPTION in thread "main": boom');
      final request = await conn.waitFor((m) => m['type'] == 'net.request');
      expect(request['source'], 'okhttp');
      expect(await nativeCall('flush'), isTrue);
    });

    test('desktop commands for native tools are forwarded to the native side', () async {
      final conn = await startSdk();
      conn.send(<String, Object?>{
        'type': 'command',
        'id': 'c1',
        'name': 'android.dumpThreads',
        'params': <String, Object?>{},
      });
      conn.send(<String, Object?>{'type': 'command', 'id': 'c2', 'name': 'android.gc'});
      await eventually(() => calls.where((c) => c.method == 'command').length == 2);
      final forwarded = calls.where((c) => c.method == 'command').map((c) => _json(c.arguments)).toList();
      expect(forwarded.map((c) => c['id']), <String>['c1', 'c2']);
      expect(forwarded.first['name'], 'android.dumpThreads');
      // The native side answers with its own command.result line.
      await nativeCall('events', <String>['{"type":"command.result","id":"c1","ok":true,"data":{"threads":12}}']);
      final result = await conn.waitFor((m) => m['type'] == 'command.result' && m['id'] == 'c1');
      expect(result['data'], <String, Object?>{'threads': 12});
      // Commands nobody knows are still answered by Dart.
      expect((await conn.command('nope.nothing'))['ok'], isFalse);
    });

    test('native action changes are merged into the action list', () async {
      final conn = await startSdk();
      await eventually(() => Durbun.isConnected);
      await nativeCall(
        'actions',
        jsonEncode(<Map<String, Object?>>[
          <String, Object?>{'id': 'android.dumpThreads', 'kind': 'button', 'label': 'Dump threads', 'group': 'android'},
          <String, Object?>{'id': 'app.native', 'kind': 'button', 'label': 'From Kotlin', 'group': 'app'},
        ]),
      );
      final update = await conn.waitFor(
        (m) => m['type'] == 'actions' && (m['actions']! as List).any((a) => (a as Map)['id'] == 'app.native'),
      );
      final ids = [for (final a in update['actions']! as List) (a as Map)['id']];
      expect(ids, containsAll(<String>['flutter.debugPaint', 'android.dumpThreads', 'app.native']));
      conn.send(<String, Object?>{'type': 'command', 'id': 'c3', 'name': 'app.native'});
      await eventually(() => calls.any((c) => c.method == 'command' && _json(c.arguments)['id'] == 'c3'));
    });

    test('missing plugin: hello is sent without waiting and has no native parts', () async {
      _messenger.setMockMethodCallHandler(_channel, null); // → MissingPluginException
      final watch = Stopwatch()..start();
      final conn = await startSdk();
      expect(watch.elapsed, lessThan(const Duration(seconds: 1)));
      final actionIds = [for (final a in conn.hello!['actions']! as List) (a as Map)['id']];
      expect(actionIds, isNot(contains('android.dumpThreads')));
      expect((conn.hello!['app']! as Map)['version'], isNull);
      expect((conn.hello!['sdk']! as Map)['layers'], <String>['dart']);
      expect(Durbun.isEnabled, isTrue);
      Durbun.i('still works');
      await conn.waitForLog('still works');
    });

    test('iOS: URLSession capture is announced to adapters such as durbun_dio', () async {
      startReply = (_) => jsonEncode(<String, Object?>{
        ...attachedReply(),
        'platform': 'ios',
        'urlSession': true,
      });
      final conn = await startSdk();
      expect((conn.hello!['sdk']! as Map)['layers'], <String>['dart', 'ios']);
      expect(DurbunNetwork.capturesUrlSession, isTrue);
      await Durbun.dispose();
      expect(DurbunNetwork.capturesUrlSession, isFalse);
    });

    test('a declined start (another engine owns it) keeps the SDK Dart-only', () async {
      startReply = (_) => jsonEncode(<String, Object?>{
        'attached': false,
        'platform': 'android',
        'reason': 'another Flutter engine in this process already runs Dürbün',
      });
      final conn = await startSdk();
      await eventually(() => Durbun.isConnected);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(calls.map((c) => c.method), <String>['start']);
      final actionIds = [for (final a in conn.hello!['actions']! as List) (a as Map)['id']];
      expect(actionIds, isNot(contains('android.dumpThreads')));
      expect((conn.hello!['sdk']! as Map)['layers'], <String>['dart']);
    });

    test('a native platform outside SdkLayer is not reported as a layer', () async {
      startReply = (_) => jsonEncode(<String, Object?>{...attachedReply(), 'platform': 'macos'});
      final conn = await startSdk();
      expect((conn.hello!['sdk']! as Map)['layers'], <String>['dart']);
    });

    test('dispose stops the native side', () async {
      await startSdk();
      await Durbun.dispose();
      expect(calls.map((c) => c.method), contains('stop'));
    });
  });

  group('store-install guard', () {
    late FakeDesktop desktop;
    final calls = <MethodCall>[];
    final lines = <String>[];
    Object? guardReply;
    Object? startReply;

    DurbunOptions options() => DurbunOptions(
      enabled: true,
      port: desktop.port,
      appId: 'com.example.guard',
      captureNetwork: false,
      metrics: false,
      useBackgroundIsolate: false,
    );

    setUp(() async {
      desktop = await FakeDesktop.start(appId: 'app:guard');
      calls.clear();
      lines.clear();
      guardReply = jsonEncode(<String, Object?>{
        'platform': 'android',
        'storeInstall': true,
        'installer': 'com.android.vending',
      });
      startReply = jsonEncode(<String, Object?>{
        'attached': true,
        'platform': 'android',
        'capabilities': <String>['logs'],
      });
      IoDurbunBackend.debugNativeBridgeFactory = (client) =>
          NativeBridge(client, channel: _channel, platformSupported: true);
      // As in a release build on Android / iOS.
      IoDurbunBackend.debugAskStoreGuardFirst = true;
      IoDurbunBackend.debugStoreGuard = StoreGuard(
        channel: _channel,
        printLine: lines.add,
        languageCode: () => 'tr',
      );
      _messenger.setMockMethodCallHandler(_channel, (call) async {
        calls.add(call);
        if (call.method == 'guard') return guardReply;
        if (call.method == 'start') return startReply;
        return null;
      });
    });

    tearDown(() async {
      await Durbun.dispose();
      IoDurbunBackend.debugNativeBridgeFactory = null;
      IoDurbunBackend.debugAskStoreGuardFirst = null;
      IoDurbunBackend.debugStoreGuard = null;
      _messenger.setMockMethodCallHandler(_channel, null);
      await desktop.close();
    });

    Future<void> expectNothingReachedTheDesktop() async {
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(desktop.connections, isEmpty);
    }

    test('release build installed from a store: nothing starts, one line says why', () async {
      await Durbun.init(options());
      var ran = false;
      await Durbun.run(() {
        ran = true;
      }, options: options());
      expect(ran, isTrue, reason: 'the app itself runs as usual');
      expect(Durbun.isEnabled, isFalse);
      expect(calls.map((c) => c.method), <String>['guard'], reason: 'asked once, before anything');
      expect(lines, <String>[kStoreInstallNoticeTr]);
      await expectNothingReachedTheDesktop();
    });

    test('release build from Firebase, TestFlight or adb starts once the guard answered', () async {
      guardReply = jsonEncode(<String, Object?>{'platform': 'android', 'storeInstall': false});
      await Durbun.init(options());
      final conn = await desktop.nextConnection();
      expect(conn.hello, isNotNull);
      expect(Durbun.isEnabled, isTrue);
      expect(calls.map((c) => c.method).take(2), <String>['guard', 'start']);
      expect(lines, isEmpty);
    });

    test('release build without an answer from the plugin stays off and says so', () async {
      _messenger.setMockMethodCallHandler(_channel, null); // → MissingPluginException
      await Durbun.init(options());
      expect(Durbun.isEnabled, isFalse);
      expect(lines, <String>[kStoreCheckFailedNoticeTr]);
      await expectNothingReachedTheDesktop();
    });

    test('debug/profile: a native start that reports a store install turns everything off', () async {
      IoDurbunBackend.debugAskStoreGuardFirst = false;
      startReply = jsonEncode(<String, Object?>{
        'attached': false,
        'platform': 'ios',
        'storeInstall': true,
        'reason': 'the app was installed from the App Store',
      });
      await Durbun.init(options());
      await eventually(() => !Durbun.isEnabled);
      expect(calls.map((c) => c.method), <String>['start'], reason: 'debug builds do not ask first');
      expect(lines, <String>[kStoreInstallNoticeTr]);
      await expectNothingReachedTheDesktop();
    });

    test('the line follows the device language', () {
      expect(storeGuardNotice(StoreCheck.store, 'tr'), kStoreInstallNoticeTr);
      expect(storeGuardNotice(StoreCheck.store, 'en'), kStoreInstallNoticeEn);
      expect(storeGuardNotice(StoreCheck.store, 'de'), kStoreInstallNoticeEn);
      expect(storeGuardNotice(StoreCheck.unknown, 'tr'), kStoreCheckFailedNoticeTr);
      expect(storeGuardNotice(StoreCheck.unknown, 'en'), kStoreCheckFailedNoticeEn);
      expect(
        kStoreInstallNoticeTr,
        'Dürbün kendini kapattı: uygulama mağazadan kurulmuş (Dürbün mağaza sürümlerinde çalışmaz).',
      );
      expect(
        kStoreInstallNoticeEn,
        'Dürbün turned itself off: this app was installed from the store (Dürbün never runs in store builds).',
      );
    });
  });

  group('NativeStartInfo', () {
    test('parses the reply and rejects garbage', () {
      expect(NativeStartInfo.parse(null), isNull);
      expect(NativeStartInfo.parse('not json'), isNull);
      expect(NativeStartInfo.parse('{"attached":false}'), isNull);
      final info = NativeStartInfo.parse(
        '{"attached":true,"platform":"ios","capabilities":["network"],'
        '"actions":[{"id":"ios.appearance","kind":"select"},{"kind":"no id"}],'
        '"urlSession":true}',
      )!;
      expect(info.platform, 'ios');
      expect(info.actions.map((a) => a['id']), <String>['ios.appearance']);
      expect(info.capturesUrlSession, isTrue);
      expect(info.commands, isEmpty);
    });
  });
}
