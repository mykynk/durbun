// Durbun.run without a widgets binding in this file (flutter_test would
// install its mock HttpOverrides): HTTP overrides the app sets inside the
// zone, an already existing binding, actions added before the start.
import 'dart:async';
import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:durbun/durbun_core.dart' show DurbunHttpClient;
import 'package:durbun/src/flutter/backend_io.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_desktop.dart';

class _UserAgentOverrides extends HttpOverrides {
  _UserAgentOverrides(this.agent);
  final String agent;

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context)..userAgent = agent;
}

void main() {
  late FakeDesktop desktop;
  late HttpServer origin;
  final bindingExists = IoDurbunBackend.debugBindingExists;

  DurbunOptions options({bool network = true}) => DurbunOptions(
    enabled: true,
    port: desktop.port,
    appId: 'com.example.run',
    captureNetwork: network,
    metrics: false,
    inspector: false,
    useBackgroundIsolate: false,
  );

  setUp(() async {
    IoDurbunBackend.debugBindingExists = () => false;
    desktop = await FakeDesktop.start(appId: 'app:run');
    origin = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    origin.listen((req) async {
      req.response.write('ok ${req.headers.value('user-agent')}');
      await req.response.close();
    });
  });

  tearDown(() async {
    await Durbun.dispose();
    HttpOverrides.global = null;
    IoDurbunBackend.debugBindingExists = bindingExists;
    await desktop.close();
    await origin.close(force: true);
  });

  test('HttpOverrides.global set inside run is captured from the first client on', () async {
    HttpClient? first;
    String? body;
    await Durbun.run(() async {
      // The app's own overrides, set in main() before any request (and long
      // before Dürbün's 2 s re-check could chain them).
      HttpOverrides.global = _UserAgentOverrides('zone-agent/1.0');
      final client = first = HttpClient();
      final res = await (await client.getUrl(Uri.parse('http://127.0.0.1:${origin.port}/zone'))).close();
      body = await res.transform(const SystemEncoding().decoder).join();
      client.close();
    }, options: options());
    expect(first, isA<DurbunHttpClient>());
    expect((first! as DurbunHttpClient).inner.userAgent, 'zone-agent/1.0',
        reason: "the app's overrides created the inner client");
    expect(body, 'ok zone-agent/1.0');
    final conn = await desktop.nextConnection();
    final req = await conn.waitFor((m) => m['type'] == 'net.request' && (m['url']! as String).endsWith('/zone'));
    final agent = [
      for (final h in req['headers']! as List)
        if (((h as List)[0] as String).toLowerCase() == 'user-agent') h[1],
    ];
    expect(agent, <Object?>['zone-agent/1.0']);
    expect((await conn.waitForNetEnd(req['id']! as String))['status'], 200);
  });

  test('an existing binding: no zone (no "Zone mismatch"), debugPrint is captured', () async {
    IoDurbunBackend.debugBindingExists = () => true;
    final outer = Zone.current;
    Zone? inner;
    await Durbun.run(() {
      inner = Zone.current;
      debugPrint('printed through debugPrint');
    }, options: options(network: false));
    expect(identical(inner, outer), isTrue, reason: 'runApp must run in the binding zone');
    final conn = await desktop.nextConnection();
    final line = await conn.waitForLog('printed through debugPrint');
    expect(line['tag'], 'flutter');
  });

  test('actions added before the start are in the first hello', () async {
    Durbun.addAction(DurbunAction.button(id: 'app.early', label: 'Early', onPressed: (_) => null));
    Durbun.addAction(DurbunAction.button(id: 'app.removed', label: 'Gone', onPressed: (_) => null));
    Durbun.removeAction('app.removed');
    await Durbun.init(options(network: false));
    final conn = await desktop.nextConnection();
    final ids = [for (final a in conn.hello!['actions']! as List) (a as Map)['id']];
    expect(ids, contains('app.early'));
    expect(ids, isNot(contains('app.removed')));
    expect((await conn.command('app.early'))['ok'], isTrue);
  });
}
