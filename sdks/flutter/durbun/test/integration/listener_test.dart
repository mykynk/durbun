// The on-device listener (iOS usbmux path) and when it may accept the desktop.
import 'dart:io';

import 'package:durbun/src/core/transport/transport_core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

void main() {
  FakeDesktop? desktop;

  tearDown(() async {
    await desktop?.close();
    desktop = null;
  });

  test('binds only once the hello is known, so an early desktop is not dropped', () async {
    // The hello reaches a background engine a moment after it started (and
    // the Flutter glue may hold it back). A desktop connecting in between used
    // to be accepted and closed without a hello (the usbmux test in
    // transport_test.dart failed about once in a hundred runs).
    final port = await freePort();
    final core = TransportCore(
      TransportConfig(endpoints: const [], listenPorts: [port]),
      (_) {},
    );
    core.start();
    addTearDown(core.stop);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await expectLater(
      Socket.connect(InternetAddress.loopbackIPv4, port),
      throwsA(isA<SocketException>()),
    );

    core.setHello(<String, Object?>{'type': 'hello', 'protocol': 1, 'session': 'early'});
    final d = desktop = await FakeDesktop.start();
    FakeSdkConnection? conn;
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    while (conn == null) {
      try {
        conn = await d.connectTo(port);
      } on SocketException {
        if (DateTime.now().isAfter(deadline)) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    }
    final hello = await conn.waitFor((m) => m['type'] == 'hello');
    expect(hello['session'], 'early');
  });
}
