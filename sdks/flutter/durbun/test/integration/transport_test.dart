import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:durbun/durbun_core.dart';
import 'package:durbun/src/core/protocol.dart' show buildMetric;
import 'package:durbun/src/core/transport/transport_core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

DurbunOptions testOptions(
  int port, {
  required bool isolate,
  int maxBufferedMessages = 5000,
  bool captureNetwork = false,
}) => DurbunOptions(
  enabled: true,
  port: port,
  appId: 'com.example.durbun_test',
  appName: 'Dürbün Test',
  appVersion: '1.2.3',
  captureNetwork: captureNetwork,
  maxBufferedMessages: maxBufferedMessages,
  useBackgroundIsolate: isolate,
);

Future<void> eventually(bool Function() condition, {Duration timeout = const Duration(seconds: 10)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  for (final isolate in [true, false]) {
    final mode = isolate ? 'background isolate' : 'same isolate';

    group('transport ($mode)', () {
      DurbunClient? client;
      FakeDesktop? desktop;

      tearDown(() async {
        await client?.dispose();
        client = null;
        await desktop?.close();
        desktop = null;
      });

      test('hello → welcome handshake', () async {
        final d = desktop = await FakeDesktop.start(appId: 'app:7');
        final c = client = DurbunClient.start(
          testOptions(d.port, isolate: isolate, captureNetwork: true),
        );
        expect(c.usesBackgroundIsolate, isolate);
        final conn = await d.nextConnection();
        expect(await c.waitForConnection(const Duration(seconds: 5)), isTrue);

        final hello = conn.hello!;
        expect(hello['type'], 'hello');
        expect(hello['protocol'], 1);
        expect(hello['sdk'], {
          'name': 'durbun-flutter',
          'version': kSdkVersion,
          'platform': 'flutter',
          // No plugin here: only the Dart layer feeds the session.
          'layers': ['dart'],
        });
        final app = hello['app']! as Map<String, Object?>;
        expect(app['id'], 'com.example.durbun_test');
        expect(app['name'], 'Dürbün Test');
        expect(app['version'], '1.2.3');
        expect(app['pid'], pid);
        expect(app['debug'], isTrue);
        final device = hello['device']! as Map<String, Object?>;
        expect(device['platform'], Platform.isAndroid ? 'android' : (Platform.isIOS ? 'ios' : 'other'));
        expect(hello['session'], matches(RegExp(r'^[0-9a-f]{16}$')));
        expect(hello['capabilities'], containsAll(<String>['logs', 'events', 'commands', 'network', 'mocks', 'crash']));
        expect(hello['ts'], isA<num>());

        expect(c.connection.connected, isTrue);
        expect(c.connection.appId, 'app:7');
        expect(c.connection.server, 'durbun/0.1.0-test');
        expect(c.connection.via, 'tcp 127.0.0.1:${d.port}');
        expect(conn.invalidLines, isEmpty);
      });

      test('logs of every level, events, data and errors arrive in order', () async {
        final d = desktop = await FakeDesktop.start();
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        final conn = await d.nextConnection();
        StackTrace? stack;
        Object? error;
        try {
          throw const FormatException('Unexpected character (at character 1)');
        } catch (e, st) {
          error = e;
          stack = st;
        }
        for (final level in DurbunLogLevel.values) {
          c.log(level, 'level ${level.wireName}', tag: 'auth');
        }
        c.log(DurbunLogLevel.info, 'Kullanıcı giriş yaptı', tag: 'auth', data: {'userId': 42, 'roles': ['admin']});
        c.log(DurbunLogLevel.error, 'Ödeme başarısız', error: error, stackTrace: stack);
        c.log(DurbunLogLevel.debug, {'json': true, 'n': 1});
        c.event('purchase', {'amount': 49.9, 'currency': 'TRY'});

        final event = await conn.waitFor((m) => m['type'] == 'event');
        expect(event['name'], 'purchase');
        expect(event['props'], {'amount': 49.9, 'currency': 'TRY'});

        final logs = conn.ofType('log');
        expect(logs.take(6).map((m) => m['level']), ['verbose', 'debug', 'info', 'warn', 'error', 'fatal']);
        expect(logs.take(6).map((m) => m['tag']).toSet(), {'auth'});
        expect(logs[6]['message'], 'Kullanıcı giriş yaptı');
        expect(logs[6]['data'], {'userId': 42, 'roles': ['admin']});
        final err = logs[7]['error']! as Map<String, Object?>;
        expect(err['type'], 'FormatException');
        expect(err['message'], contains('Unexpected character'));
        expect(err['stack'], contains('transport_test.dart'));
        expect(logs[8]['message'], '{"json":true,"n":1}');
        for (final m in conn.received) {
          if (m['type'] == 'log') expect(m['ts'], isA<num>());
        }
      });

      test('ping → pong; invalid lines and unknown messages are ignored', () async {
        final d = desktop = await FakeDesktop.start();
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        final conn = await d.nextConnection();
        await c.waitForConnection(const Duration(seconds: 5));
        conn.sendRaw('this is not json\n{"no":"type"}\n[1,2,3]\n{"type":"teleport"}\n');
        conn.send({'type': 'ping', 'ts': 123});
        final pong = await conn.waitFor((m) => m['type'] == 'pong');
        expect(pong['ts'], isA<num>());
        c.log(DurbunLogLevel.info, 'still alive');
        await conn.waitForLog('still alive');
        expect(c.isConnected, isTrue);
      });

      test('commands: actions round-trip, unknown and failing commands', () async {
        final d = desktop = await FakeDesktop.start();
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        var flag = false;
        var theme = 'system';
        c.addActions([
          DurbunAction.toggle(
            id: 'test.flag',
            label: 'Flag',
            group: 'test',
            value: () => flag,
            onChanged: (v) => flag = v,
          ),
          DurbunAction.select(
            id: 'test.theme',
            label: 'Theme',
            options: const [DurbunActionOption('system', 'System'), DurbunActionOption('dark', 'Dark')],
            value: () => theme,
            onChanged: (v) => theme = v,
          ),
          DurbunAction.button(id: 'test.echo', label: 'Echo', onPressed: (params) => {'echo': params}),
          DurbunAction.button(id: 'test.boom', label: 'Boom', onPressed: (_) => throw StateError('kaboom')),
        ]);
        c.registerCommand('hidden.sum', (p) => (p['a']! as num) + (p['b']! as num));
        final conn = await d.nextConnection();
        final actions = (conn.hello!['actions']! as List).cast<Map<String, Object?>>();
        expect(actions.map((a) => a['id']), ['test.flag', 'test.theme', 'test.echo', 'test.boom']);
        expect(actions.first, {'id': 'test.flag', 'kind': 'toggle', 'label': 'Flag', 'group': 'test', 'value': false});

        final echo = await conn.command('test.echo', params: {'x': 1, 's': 'ğ'});
        expect(echo['ok'], isTrue);
        expect(echo['data'], {'echo': {'x': 1, 's': 'ğ'}});

        final toggled = await conn.command('test.flag', params: {'value': true});
        expect(toggled, containsPair('data', {'value': true}));
        expect(flag, isTrue);
        final update = await conn.waitFor((m) => m['type'] == 'actions');
        final updated = (update['actions']! as List).cast<Map<String, Object?>>();
        expect(updated.firstWhere((a) => a['id'] == 'test.flag')['value'], isTrue);

        final selected = await conn.command('test.theme', params: {'value': 'DARK'});
        expect(selected['data'], {'value': 'dark'});

        final sum = await conn.command('hidden.sum', params: {'a': 2, 'b': 3});
        expect(sum['data'], 5);

        final unknown = await conn.command('flutter.nope');
        expect(unknown['ok'], isFalse);
        expect(unknown['error'], 'Unknown command: flutter.nope');

        final boom = await conn.command('test.boom');
        expect(boom['ok'], isFalse);
        expect(boom['error'], contains('kaboom'));
      });

      test('messages in the same chunk as the welcome are not lost', () async {
        final d = desktop = await FakeDesktop.start(autoWelcome: false);
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        c.registerCommand('test.ping', (_) => 'pong');
        final conn = await d.nextConnection();
        conn.sendRaw(
          '${jsonEncode({'type': 'welcome', 'protocol': 1, 'server': 'durbun/test', 'appId': 'app:9', 'config': FakeDesktop.defaultConfig(), 'mocks': <Object?>[]})}\n'
          '${jsonEncode({'type': 'command', 'id': 'same-chunk', 'name': 'test.ping'})}\n',
        );
        final result = await conn.waitFor((m) => m['type'] == 'command.result');
        expect(result, {'type': 'command.result', 'id': 'same-chunk', 'ok': true, 'data': 'pong'});
        expect(c.connection.appId, 'app:9');
      });

      test('mocks and config messages update the client', () async {
        final d = desktop = await FakeDesktop.start(
          mocks: [
            {
              'id': 'm1',
              'enabled': true,
              'method': 'GET',
              'url': '/users',
              'match': 'contains',
              'action': {'type': 'respond', 'status': 200},
              'createdAt': 1,
            },
          ],
        );
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        final conn = await d.nextConnection();
        await c.waitForConnection(const Duration(seconds: 5));
        expect(c.mocks.map((r) => r.id), ['m1']);
        expect(c.configKnown, isTrue);
        conn.send({
          'type': 'mocks',
          'rules': [
            {
              'id': 'm2',
              'enabled': true,
              'method': '*',
              'url': '*/slow/*',
              'match': 'glob',
              'action': {'type': 'delay', 'delayMs': 100},
              'createdAt': 2,
            },
          ],
        });
        conn.send({
          'type': 'config',
          'config': {'captureBodies': false, 'maxBodyBytes': 2048, 'metricsIntervalMs': 500, 'deviceLogsAvailable': true},
        });
        await eventually(() => c.mocks.length == 1 && c.mocks.first.id == 'm2');
        await eventually(() => c.config.maxBodyBytes == 2048);
        expect(c.config.captureBodies, isFalse);
        expect(c.config.deviceLogsAvailable, isTrue);
        expect(c.config.metricsIntervalMs, 500);
      });

      test('buffers while the desktop is down, then flushes in order', () async {
        final port = await freePort();
        final c = client = DurbunClient.start(testOptions(port, isolate: isolate));
        for (var i = 1; i <= 5; i++) {
          c.log(DurbunLogLevel.info, 'offline $i');
        }
        c.metric(buildMetric(memoryMB: 1)); // volatile: dropped while offline
        await Future<void>.delayed(const Duration(milliseconds: 300));
        expect(c.isConnected, isFalse);
        final d = desktop = await FakeDesktop.start(port: port);
        final conn = await d.nextConnection(timeout: const Duration(seconds: 15));
        final logs = await conn.waitForCount((m) => m['type'] == 'log', 5);
        expect(logs.map((m) => m['message']), ['offline 1', 'offline 2', 'offline 3', 'offline 4', 'offline 5']);
        expect(conn.ofType('metric'), isEmpty);
        await c.waitForConnection(const Duration(seconds: 5));
        c.metric(buildMetric(memoryMB: 12.5));
        final metric = await conn.waitFor((m) => m['type'] == 'metric');
        expect(metric['memoryMB'], 12.5);
      });

      test('ring buffer keeps the newest messages and reports the drop', () async {
        final port = await freePort();
        final c = client = DurbunClient.start(
          testOptions(port, isolate: isolate, maxBufferedMessages: 5),
        );
        for (var i = 1; i <= 12; i++) {
          c.log(DurbunLogLevel.info, 'm$i');
        }
        await Future<void>.delayed(const Duration(milliseconds: 200));
        final d = desktop = await FakeDesktop.start(port: port);
        final conn = await d.nextConnection(timeout: const Duration(seconds: 15));
        final logs = await conn.waitForCount((m) => m['type'] == 'log', 6);
        expect(logs.take(5).map((m) => m['message']), ['m8', 'm9', 'm10', 'm11', 'm12']);
        final warn = logs[5];
        expect(warn['level'], 'warn');
        expect(warn['tag'], 'durbun');
        expect(warn['message'], contains('dropped 7 messages while the desktop was unreachable'));
        expect(warn['data'], {'dropped': 7});
      });

      test('reconnects after the desktop drops the link (same session)', () async {
        final d = desktop = await FakeDesktop.start();
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        final first = await d.nextConnection();
        await c.waitForConnection(const Duration(seconds: 5));
        final changes = <bool>[];
        final sub = c.connectionChanges.listen((s) => changes.add(s.connected));
        first.destroy();
        await eventually(() => !c.isConnected);
        c.log(DurbunLogLevel.warn, 'logged while reconnecting');
        final second = await d.onConnection.first.timeout(const Duration(seconds: 10));
        expect(identical(first, second), isFalse);
        expect(second.hello!['session'], first.hello!['session']);
        await second.waitForLog('logged while reconnecting');
        await eventually(() => c.isConnected);
        await sub.cancel();
        expect(changes, containsAllInOrder(<bool>[false, true]));
      });

      test('flush() waits until queued messages reached the desktop', () async {
        final d = desktop = await FakeDesktop.start();
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        await c.waitForConnection(const Duration(seconds: 5));
        for (var i = 0; i < 300; i++) {
          c.log(DurbunLogLevel.debug, 'burst $i', data: {'i': i});
        }
        expect(await c.flush(const Duration(seconds: 5)), isTrue);
        final conn = await d.nextConnection();
        await conn.waitForCount((m) => m['type'] == 'log', 300);
      });

      test('dispose closes the link and turns the API into no-ops', () async {
        final d = desktop = await FakeDesktop.start();
        final c = client = DurbunClient.start(testOptions(d.port, isolate: isolate));
        final conn = await d.nextConnection();
        await c.waitForConnection(const Duration(seconds: 5));
        await c.dispose();
        await conn.done.timeout(const Duration(seconds: 5));
        expect(c.isConnected, isFalse);
        expect(DurbunClient.current, isNull);
        c.log(DurbunLogLevel.info, 'ignored'); // must not throw
      });
    });
  }

  group('on-device listener (iOS usbmux path)', () {
    DurbunClient? client;
    FakeDesktop? desktop;
    ServerSocket? blocker;

    tearDown(() async {
      await client?.dispose();
      client = null;
      await desktop?.close();
      desktop = null;
      await blocker?.close();
      blocker = null;
    });

    test('first free port is used; the desktop connects; extras are refused', () async {
      final d = desktop = await FakeDesktop.start();
      final busy = blocker = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final freeOne = await freePort();
      final c = client = DurbunClient.start(
        testOptions(0, isolate: true),
        transportConfig: TransportConfig(
          endpoints: const [],
          listenPorts: [busy.port, freeOne],
        ),
      );
      // Give the engine a moment to bind.
      FakeSdkConnection? conn;
      final deadline = DateTime.now().add(const Duration(seconds: 10));
      while (conn == null) {
        try {
          conn = await d.connectTo(freeOne);
        } on SocketException {
          if (DateTime.now().isAfter(deadline)) rethrow;
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
      }
      await conn.waitFor((m) => m['type'] == 'hello');
      expect(await c.waitForConnection(const Duration(seconds: 5)), isTrue);
      expect(c.connection.via, 'usbmux 127.0.0.1:$freeOne');

      final extra = await d.connectTo(freeOne);
      await extra.done.timeout(const Duration(seconds: 5));
      expect(extra.hello, isNull);

      c.log(DurbunLogLevel.info, 'over usb');
      await conn.waitForLog('over usb');
    });
  });
}
