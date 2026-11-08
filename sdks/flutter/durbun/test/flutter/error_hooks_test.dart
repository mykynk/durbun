// FlutterErrorHooks: the app's PlatformDispatcher.onError runs in the app's
// zone, and only the zone → platform double report of one error is dropped.
import 'dart:async';
import 'dart:ui' as ui;

import 'package:durbun/durbun_core.dart';
import 'package:durbun/src/flutter/error_hooks.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

class _Boom implements Exception {
  const _Boom();

  @override
  String toString() => 'Boom';
}

void main() {
  late DurbunClient client;
  late List<Map<String, Object?>> sent;

  setUp(() async {
    sent = <Map<String, Object?>>[];
    // No desktop: the tap sees every outgoing message.
    client = DurbunClient.start(
      DurbunOptions(
        enabled: true,
        port: await freePort(),
        appId: 'com.example.errors',
        captureNetwork: false,
        useBackgroundIsolate: false,
      ),
    );
    client.outgoingTap = sent.add;
  });

  tearDown(() => client.dispose());

  List<Map<String, Object?>> crashes() =>
      sent.where((m) => m['type'] == 'log' && m['kind'] == 'crash').toList();

  test('a repeated constant error is reported every time', () {
    final hooks = FlutterErrorHooks(client);
    for (var i = 0; i < 3; i++) {
      hooks.reportUncaught(const _Boom(), StackTrace.current, source: 'zone');
    }
    expect(crashes(), hasLength(3));
    // init() mode: only the platform handler sees them.
    final other = StateError('again');
    hooks.reportUncaught(other, StackTrace.current, source: 'platform');
    hooks.reportUncaught(other, StackTrace.current, source: 'platform');
    expect(crashes(), hasLength(5));
    hooks.dispose();
  });

  test('the zone report forwarded to the platform handler counts once', () {
    final hooks = FlutterErrorHooks(client);
    final error = StateError('once');
    final stack = StackTrace.current;
    hooks.reportUncaught(error, stack, source: 'zone');
    hooks.reportUncaught(error, stack, source: 'platform');
    expect(crashes(), hasLength(1));
    expect((crashes().single['data']! as Map)['source'], 'zone');
    hooks.dispose();
  });

  test("onError is set from the app's zone, so dart:ui runs the app's handler there", () {
    // dart:ui runs PlatformDispatcher.onError in the zone that was current
    // when it was set: that must be the app's zone, never the SDK's internal
    // zone (which swallows errors).
    final dispatcher = ui.PlatformDispatcher.instance;
    final original = dispatcher.onError;
    addTearDown(() => dispatcher.onError = original);
    final setInAppZone = <ui.ErrorCallback?>[];
    final appZone = Zone.current.fork(
      specification: ZoneSpecification(
        run: <R>(Zone self, ZoneDelegate parent, Zone zone, R Function() f) {
          final before = dispatcher.onError;
          final result = parent.run(zone, f);
          if (!identical(dispatcher.onError, before)) setInAppZone.add(dispatcher.onError);
          return result;
        },
      ),
    );
    bool appHandler(Object error, StackTrace stack) => true;
    dispatcher.onError = appHandler;

    final hooks = FlutterErrorHooks(client, appZone: appZone);
    // Installed from the SDK's internal zone, as the backend's setup and its
    // 2 s re-check do.
    client.runInternal(hooks.install);
    expect(setInAppZone, hasLength(1));
    final ours = dispatcher.onError!;
    expect(identical(setInAppZone.single, ours), isTrue);

    // The app replaces it (e.g. Crashlytics after Firebase.initializeApp):
    // re-chained from the app zone again.
    bool crashlytics(Object error, StackTrace stack) => true;
    dispatcher.onError = crashlytics;
    client.runInternal(hooks.ensureInstalled);
    expect(setInAppZone, hasLength(2));
    expect(dispatcher.onError!(StateError('chained'), StackTrace.current), isTrue);
    expect(crashes().single['message'], 'Unhandled exception: Bad state: chained');

    hooks.dispose();
    expect(setInAppZone, hasLength(3), reason: 'restored from the app zone too');
    expect(identical(dispatcher.onError, crashlytics), isTrue);
  });
}
