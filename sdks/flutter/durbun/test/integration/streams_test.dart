// ignore_for_file: cancel_subscriptions, close_sinks
// WebSocket messages and Server-Sent Events through the dart:io capture,
// end to end: a local origin server, the SDK client, the fake desktop.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:durbun/durbun_core.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart' as http_io;

import '../support/fake_desktop.dart';

Map<String, Object?> streamConfig({bool? on = true, int cap = 65536, bool captureBodies = true}) => <String, Object?>{
  ...FakeDesktop.defaultConfig(captureBodies: captureBodies),
  if (on != null) 'captureStreams': on,
  'maxStreamMessageBytes': cap,
};

/// The origin the app talks to.
class StreamOrigin {
  late HttpServer server;

  /// Lets `/sse-held` send the rest of its events and end.
  Completer<void> release = Completer<void>();

  String get host => '127.0.0.1:${server.port}';

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      try {
        await _handle(req);
      } catch (_) {
        // Clients that go away on purpose.
      }
    });
  }

  Future<void> _handle(HttpRequest req) async {
    switch (req.uri.path) {
      case '/ws':
        final mode = req.uri.queryParameters['compress'] ?? 'off';
        final compression = switch (mode) {
          'on' => CompressionOptions.compressionDefault,
          'nct' => const CompressionOptions(serverNoContextTakeover: true, clientNoContextTakeover: true),
          _ => CompressionOptions.compressionOff,
        };
        final ws = await WebSocketTransformer.upgrade(req, compression: compression);
        final ping = int.tryParse(req.uri.queryParameters['ping'] ?? '');
        if (ping != null) ws.pingInterval = Duration(milliseconds: ping);
        ws.listen((Object? message) {
          if (message == 'bye') {
            ws.close(4000, 'done');
          } else if (message == 'big') {
            ws.add('b' * 5000);
          } else {
            ws.add(message);
          }
        });
      case '/sse':
      case '/sse-held':
        final res = req.response
          ..bufferOutput = false
          ..headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8')
          ..headers.set('cache-control', 'no-cache');
        res.write(': hello\nretry: 2500\n\n');
        res.write('event: price\nid: 1\ndata: {"sym":"DÜR","px":');
        await res.flush();
        await Future<void>.delayed(const Duration(milliseconds: 30));
        res.write('1.5}\n\n');
        await res.flush();
        if (req.uri.path == '/sse-held') await release.future;
        res.write('data: line one\r\ndata: line two\r\n\r\n');
        res.write('id: 3\ndata: ${'z' * 300}\n\n');
        await res.close();
      case '/sse-endless':
        final res = req.response
          ..bufferOutput = false
          ..headers.contentType = ContentType('text', 'event-stream');
        for (var i = 0; i < 500; i++) {
          res.write('data: tick $i\n\n');
          await res.flush();
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
        await res.close();
      case '/upgrade-other':
        // A 101 to another protocol than WebSocket.
        req.response
          ..statusCode = HttpStatus.switchingProtocols
          ..headers.set(HttpHeaders.connectionHeader, 'Upgrade')
          ..headers.set(HttpHeaders.upgradeHeader, 'x-custom/1');
        final socket = await req.response.detachSocket(writeHeaders: true);
        socket.add(<int>[1, 2, 3]);
        await socket.close();
      default:
        req.response.statusCode = 404;
        await req.response.close();
    }
  }
}

void main() {
  final origin = StreamOrigin();
  late FakeDesktop desktop;
  late DurbunClient client;
  late FakeSdkConnection conn;

  Future<void> setConfig(Map<String, Object?> config) async {
    conn.send(<String, Object?>{'type': 'config', 'config': config});
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (client.config.captureStreams != (config['captureStreams'] == true) ||
        client.config.maxStreamMessageBytes != config['maxStreamMessageBytes'] ||
        client.config.captureBodies != config['captureBodies']) {
      if (DateTime.now().isAfter(deadline)) throw TimeoutException('config not applied');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  setUpAll(() async {
    await origin.start();
    desktop = await FakeDesktop.start(appId: 'app:streams', config: streamConfig());
    client = DurbunClient.start(DurbunOptions(
      enabled: true,
      port: desktop.port,
      appId: 'com.example.streams',
      redactHeaders: const ['Authorization'],
    ));
    conn = await desktop.nextConnection();
    expect(await client.waitForConnection(const Duration(seconds: 5)), isTrue);
  });

  tearDownAll(() async {
    await client.dispose();
    await desktop.close();
    await origin.server.close(force: true);
  });

  setUp(() => setConfig(streamConfig()));

  Future<Map<String, Object?>> request(String suffix) => conn.waitFor(
    (m) => m['type'] == 'net.request' && (m['url']! as String).endsWith(suffix),
    description: 'net.request $suffix',
  );

  List<Map<String, Object?>> streamOf(String id) =>
      conn.received.where((m) => m['id'] == id && (m['type'] == 'net.ws' || m['type'] == 'net.sse')).toList();

  Future<List<Map<String, Object?>>> waitStream(String id, int count) =>
      conn.waitForCount((m) => m['id'] == id && (m['type'] == 'net.ws' || m['type'] == 'net.sse'), count);

  String? bodyText(Map<String, Object?> m) => (m['body'] as Map?)?['data'] as String?;

  test('hello announces the streams capability', () {
    expect(conn.hello!['capabilities'], contains('streams'));
  });

  group('WebSocket (dart:io)', () {
    test('handshake, text and binary both ways, close, in order', () async {
      // flutter_test opened a WebSocket before Dürbün started, so dart:io's
      // shared client predates the capture: pass one (see the README).
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=basic',
          headers: <String, Object>{'authorization': 'Bearer secret'}, customClient: HttpClient());
      final received = <Object?>[];
      final sub = ws.listen(received.add);
      ws.add('merhaba');
      ws.add(<int>[0, 1, 2, 255]);
      ws.add('dünya 🎉');
      final req = await request('/ws?case=basic');
      final id = req['id']! as String;
      expect(req['url'], 'ws://${origin.host}/ws?case=basic');
      final headers = <String, String>{for (final h in req['headers']! as List) (h as List)[0] as String: h[1] as String};
      expect(headers['upgrade'], 'websocket');
      expect(headers['authorization'], isNot(contains('secret')));
      final res = await conn.waitForNetEnd(id);
      expect(res['type'], 'net.response');
      expect(res['status'], 101);
      expect(res.containsKey('body'), isFalse);
      expect(res.containsKey('noStream'), isFalse, reason: 'its messages are reported');
      await waitStream(id, 6);
      await ws.close(1000, 'bitti');
      await sub.asFuture<void>();
      final messages = await waitStream(id, 8);
      final out = messages.where((m) => m['dir'] == 'out').toList();
      final inn = messages.where((m) => m['dir'] == 'in').toList();
      expect(out.map((m) => m['opcode']), <String>['text', 'binary', 'text', 'close']);
      expect(inn.map((m) => m['opcode']), <String>['text', 'binary', 'text', 'close']);
      expect(bodyText(out[0]), 'merhaba');
      expect((out[0]['body']! as Map)['encoding'], 'utf8');
      expect((out[1]['body']! as Map)['encoding'], 'base64');
      expect(base64Decode(bodyText(out[1])!), <int>[0, 1, 2, 255]);
      expect(out[1]['size'], 4);
      expect(bodyText(inn[2]), 'dünya 🎉');
      expect(inn[2]['size'], utf8.encode('dünya 🎉').length);
      expect(out[3]['closeCode'], 1000);
      expect(out[3]['closeReason'], 'bitti');
      expect(inn[3]['closeCode'], 1000);
      // Every stream message comes after the 101.
      final resIndex = conn.received.indexOf(res);
      expect(conn.received.indexOf(messages.first), greaterThan(resIndex));
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(conn.received.where((m) => m['type'] == 'net.error' && m['id'] == id), isEmpty);
      expect(received, <Object?>['merhaba', <int>[0, 1, 2, 255], 'dünya 🎉'], reason: 'the app got its messages untouched');
    });

    test('many messages keep the order the app saw', () async {
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=order', customClient: HttpClient());
      final got = <Object?>[];
      final all = Completer<void>();
      ws.listen((m) {
        got.add(m);
        if (got.length == 60) all.complete();
      });
      for (var i = 0; i < 60; i++) {
        ws.add('m$i');
      }
      await all.future;
      final id = (await request('/ws?case=order'))['id']! as String;
      final messages = await waitStream(id, 120);
      expect(messages.where((m) => m['dir'] == 'out').map(bodyText), <String>[for (var i = 0; i < 60; i++) 'm$i']);
      expect(messages.where((m) => m['dir'] == 'in').map(bodyText), <String>[for (var i = 0; i < 60; i++) 'm$i']);
      await ws.close();
    });

    for (final mode in ['on', 'nct']) {
      test('permessage-deflate ($mode): exact content both ways', () async {
        final ws = await WebSocket.connect('ws://${origin.host}/ws?compress=$mode', customClient: HttpClient());
        final echoes = StreamIterator<Object?>(ws);
        const text = '{"type":"chat","text":"aynı mesaj, aynı mesaj","room":"genel"}';
        for (var i = 0; i < 3; i++) {
          ws.add(text);
          expect(await echoes.moveNext(), isTrue);
          expect(echoes.current, text);
        }
        ws.add('big');
        expect(await echoes.moveNext(), isTrue);
        final req = await request('/ws?compress=$mode');
        final res = await conn.waitForNetEnd(req['id']! as String);
        final extensions = <String>[
          for (final h in res['headers']! as List)
            if (((h as List)[0] as String).toLowerCase() == 'sec-websocket-extensions') h[1] as String,
        ];
        expect(extensions.single, contains('permessage-deflate'));
        final messages = await waitStream(req['id']! as String, 8);
        for (final m in messages.take(6)) {
          expect(bodyText(m), text);
          expect(m['size'], utf8.encode(text).length);
        }
        final big = messages[7];
        expect(big['dir'], 'in');
        expect(big['size'], 5000);
        expect(bodyText(big), 'b' * 5000);
        await echoes.cancel();
        await ws.close();
        await Future<void>.delayed(const Duration(milliseconds: 100));
        expect(conn.received.where((m) => m['type'] == 'net.error' && m['id'] == req['id']), isEmpty,
            reason: 'the app stopping to read and then closing is not a broken connection');
      });
    }

    test('the payload cap cuts bodies, keeps sizes; cap 0 and bodies off send sizes only', () async {
      await setConfig(streamConfig(cap: 2));
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=cap', customClient: HttpClient());
      final echoes = StreamIterator<Object?>(ws);
      ws.add('açık mesaj');
      await echoes.moveNext();
      final id = (await request('/ws?case=cap'))['id']! as String;
      var messages = await waitStream(id, 2);
      final body = messages[0]['body']! as Map;
      expect(body['truncated'], isTrue);
      expect(body['data'], 'a', reason: 'cut at 2 bytes, the broken character dropped');
      expect(body['size'], utf8.encode('açık mesaj').length);
      expect(messages[0]['size'], utf8.encode('açık mesaj').length);

      await setConfig(streamConfig(cap: 0));
      ws.add('nothing kept');
      await echoes.moveNext();
      messages = await waitStream(id, 4);
      expect(messages[2].containsKey('body'), isFalse);
      expect(messages[2]['size'], 12);

      await setConfig(streamConfig(cap: 1000, captureBodies: false));
      ws.add('bodies off');
      await echoes.moveNext();
      messages = await waitStream(id, 6);
      expect(messages[4].containsKey('body'), isFalse);
      expect(messages[4]['size'], 10);
      await echoes.cancel();
      await ws.close();
    });

    test('an older desktop (no captureStreams) gets the 101 and no messages; a config turns them on and off', () async {
      await setConfig(streamConfig(on: null));
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=gate&compress=on', customClient: HttpClient());
      final echoes = StreamIterator<Object?>(ws);
      ws.add('before');
      await echoes.moveNext();
      final gateRequest = await request('/ws?case=gate&compress=on');
      expect(gateRequest['url'], startsWith('http://'), reason: 'reported exactly as before streams existed');
      final id = gateRequest['id']! as String;
      expect((await conn.waitForNetEnd(id))['status'], 101);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(streamOf(id), isEmpty);

      await setConfig(streamConfig());
      ws.add('during');
      await echoes.moveNext();
      final during = await waitStream(id, 2);
      expect(during.map(bodyText).toSet(), <String?>{'during'},
          reason: 'never the messages from before the change, and the compressed reply decodes '
              'when it does not refer to them');

      await setConfig(streamConfig(on: false));
      ws.add('after');
      await echoes.moveNext();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(streamOf(id), hasLength(2));
      // A stream that started is still finished after the setting went off.
      // (The paused iterator never reads the server's answer.)
      await ws.close(1000);
      await echoes.cancel();
      final closes = await conn.waitForCount((m) => m['id'] == id && m['opcode'] == 'close', 1);
      expect(closes.first['dir'], 'out');
      expect(closes.first['closeCode'], 1000);
      expect(streamOf(id).where((m) => m['opcode'] != 'close'), hasLength(2));
    });

    test('with the setting off a broken connection stays a plain 101 (no net.error)', () async {
      await setConfig(streamConfig(on: false));
      final proxy = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final sockets = <Socket>[];
      proxy.listen((downstream) async {
        final upstream = await Socket.connect(InternetAddress.loopbackIPv4, origin.server.port);
        sockets.addAll(<Socket>[downstream, upstream]);
        downstream.listen(upstream.add, onDone: upstream.destroy, onError: (Object _) {});
        upstream.listen(downstream.add, onDone: downstream.destroy, onError: (Object _) {});
      });
      final ws = await WebSocket.connect('ws://127.0.0.1:${proxy.port}/ws?case=quietbreak', customClient: HttpClient());
      final closed = ws.listen((_) {}, onError: (Object _) {}).asFuture<void>().catchError((Object _) {});
      final id = (await request('/ws?case=quietbreak'))['id']! as String;
      await conn.waitForNetEnd(id);
      for (final s in sockets) {
        s.destroy();
      }
      await closed;
      await proxy.close();
      await Future<void>.delayed(const Duration(milliseconds: 150));
      expect(conn.received.where((m) => m['id'] == id).map((m) => m['type']), <String>['net.request', 'net.response']);
    });

    test('the server closes with a code: one close frame each way', () async {
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=serverclose', customClient: HttpClient());
      final done = ws.drain<void>();
      ws.add('bye');
      await done;
      expect(ws.closeCode, 4000);
      final id = (await request('/ws?case=serverclose'))['id']! as String;
      final messages = await waitStream(id, 3);
      final closes = messages.where((m) => m['opcode'] == 'close').toList();
      expect(closes.first['dir'], 'in');
      expect(closes.first['closeCode'], 4000);
      expect(closes.first['closeReason'], 'done');
      expect(closes.last['dir'], 'out');
    });

    test('a connection that breaks after opening ends with net.error on the same id', () async {
      // A TCP proxy in front of the origin, cut without any close frame.
      final proxy = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final sockets = <Socket>[];
      proxy.listen((downstream) async {
        final upstream = await Socket.connect(InternetAddress.loopbackIPv4, origin.server.port);
        sockets.addAll(<Socket>[downstream, upstream]);
        downstream.listen(upstream.add, onDone: upstream.destroy, onError: (Object _) {});
        upstream.listen(downstream.add, onDone: downstream.destroy, onError: (Object _) {});
      });
      final ws = await WebSocket.connect('ws://127.0.0.1:${proxy.port}/ws?case=broken', customClient: HttpClient());
      final events = <Object?>[];
      final closed = ws.listen(events.add, onError: (Object _) {}).asFuture<void>().catchError((Object _) {});
      ws.add('hello');
      final id = (await request('/ws?case=broken'))['id']! as String;
      await waitStream(id, 2);
      for (final s in sockets) {
        s.destroy();
      }
      await closed;
      await proxy.close();
      final error = await conn.waitFor((m) => m['type'] == 'net.error' && m['id'] == id, description: 'net.error');
      expect(error['cancelled'], isNull);
      final response = conn.received.firstWhere((m) => m['type'] == 'net.response' && m['id'] == id);
      expect(conn.received.indexOf(error), greaterThan(conn.received.indexOf(response)));
      expect(events, <Object?>['hello'], reason: 'the echo arrived before the cut');
    });

    test('pings and pongs on the wire are reported', () async {
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=ping&ping=40', customClient: HttpClient());
      final sub = ws.listen((_) {});
      final id = (await request('/ws?case=ping&ping=40'))['id']! as String;
      final messages = await waitStream(id, 2);
      expect(messages[0]['opcode'], 'ping');
      expect(messages[0]['dir'], 'in');
      expect(messages[1]['opcode'], 'pong');
      expect(messages[1]['dir'], 'out');
      await sub.cancel();
      await ws.close();
    });

    test('a 101 the capture has no hook on says noStream (only while streams are on)', () async {
      Future<Map<String, Object?>> upgrade(String tag) async {
        final httpClient = HttpClient();
        final req = await httpClient.getUrl(Uri.parse('http://${origin.host}/upgrade-other?$tag'));
        req.headers
          ..set(HttpHeaders.connectionHeader, 'Upgrade')
          ..set(HttpHeaders.upgradeHeader, 'x-custom/1');
        final res = await req.close();
        expect(res.statusCode, 101);
        final socket = await res.detachSocket();
        expect(await socket.expand((c) => c).toList(), <int>[1, 2, 3], reason: 'the app gets its bytes');
        socket.destroy();
        httpClient.close();
        final r = await request('/upgrade-other?$tag');
        expect(r['url'], startsWith('http://'));
        return conn.waitForNetEnd(r['id']! as String);
      }

      final on = await upgrade('on');
      expect(on['status'], 101);
      expect(on['noStream'], isTrue);
      await setConfig(streamConfig(on: false));
      final off = await upgrade('off');
      expect(off.containsKey('noStream'), isFalse, reason: 'exactly as before streams existed');
    });

    test("the SDK's own connection to the desktop is never captured", () async {
      expect(
        conn.received.where((m) => m['type'] == 'net.request' && '${m['url']}'.contains(':${desktop.port}')),
        isEmpty,
      );
    });
  });

  group('Server-Sent Events', () {
    test('HttpClient: response at the headers without a body, then events, then the end', () async {
      origin.release = Completer<void>();
      final httpClient = HttpClient();
      final req = await httpClient.getUrl(Uri.parse('http://${origin.host}/sse-held'));
      final res = await req.close();
      final chunks = <List<int>>[];
      final done = res.listen(chunks.add).asFuture<void>();
      final request0 = await request('/sse-held');
      final id = request0['id']! as String;
      final response = await conn.waitForNetEnd(id);
      expect(response['type'], 'net.response');
      expect(response['status'], 200);
      expect(response.containsKey('body'), isFalse, reason: 'the event stream is never sent as a body');
      final first = (await waitStream(id, 1)).first;
      expect(first['event'], 'price');
      expect(first['eventId'], '1');
      expect(first['retry'], 2500);
      expect(bodyText(first), '{"sym":"DÜR","px":1.5}');
      origin.release.complete();
      await done;
      final messages = await waitStream(id, 4);
      expect(bodyText(messages[1]), 'line one\nline two');
      expect(messages[1].containsKey('event'), isFalse);
      expect(messages[2]['eventId'], '3');
      expect(messages[2]['size'], 300);
      expect(messages[3]['end'], isTrue);
      expect(utf8.decode(chunks.expand((c) => c).toList()), contains('line one'), reason: 'the app read every byte');
      httpClient.close();
    });

    test('package:http streamed: the app cancelling the read is net.error cancelled', () async {
      final client0 = http_io.IOClient(HttpClient());
      final res = await client0.send(http.Request('GET', Uri.parse('http://${origin.host}/sse-endless')));
      final lines = <String>[];
      late StreamSubscription<String> sub;
      final three = Completer<void>();
      sub = res.stream.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
        if (line.startsWith('data:')) lines.add(line);
        if (lines.length == 3 && !three.isCompleted) three.complete();
      });
      await three.future;
      await sub.cancel();
      final id = (await request('/sse-endless'))['id']! as String;
      final error = await conn.waitFor((m) => m['type'] == 'net.error' && m['id'] == id, description: 'net.error');
      expect(error['cancelled'], isTrue);
      final events = streamOf(id);
      expect(events.length, greaterThanOrEqualTo(3));
      expect(bodyText(events.first), 'tick 0');
      client0.close();
    });

    test('an older desktop gets the event stream the usual way, as a body at its end', () async {
      await setConfig(streamConfig(on: null));
      final httpClient = HttpClient();
      final res = await (await httpClient.getUrl(Uri.parse('http://${origin.host}/sse?case=old'))).close();
      await res.drain<void>();
      final id = (await request('/sse?case=old'))['id']! as String;
      final response = await conn.waitForNetEnd(id);
      expect(bodyText(response), contains('line one'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(streamOf(id), isEmpty);
      httpClient.close();
    });
  });

  // The in-app panel keeps its own record, apart from what goes to the
  // desktop: messages reach it whether or not the desktop records them, and
  // the desktop never gets more than its setting allows.
  group('the in-app panel', () {
    late DurbunInspectorStore store;

    setUp(() {
      store = DurbunInspectorStore(notifyDelay: Duration.zero)..attached = true;
      store.captureBodiesNow = () => client.captureBodies;
      client
        ..outgoingTap = store.ingest
        ..localStreams = store;
    });

    tearDown(() {
      client
        ..outgoingTap = null
        ..localStreams = null;
      store.dispose();
    });

    InspectorCall? panelCall(String suffix) {
      for (final c in store.calls) {
        if (c.url.endsWith(suffix)) return c;
      }
      return null;
    }

    Future<InspectorStream> panelStream(String suffix, bool Function(InspectorStream s) done) async {
      final deadline = DateTime.now().add(const Duration(seconds: 5));
      while (true) {
        final s = panelCall(suffix)?.stream;
        if (s != null && done(s)) return s;
        if (DateTime.now().isAfter(deadline)) throw TimeoutException('panel stream $suffix');
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
    }

    test('the setting off: the desktop gets a plain 101, the panel gets the messages and the close', () async {
      await setConfig(streamConfig(on: false));
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=panel-off', customClient: HttpClient());
      final echoes = StreamIterator<Object?>(ws);
      ws.add('merhaba');
      await echoes.moveNext();
      ws.add(<int>[1, 2, 3]);
      await echoes.moveNext();
      ws.add('bye');
      await echoes.moveNext();
      final req = await request('/ws?case=panel-off');
      final id = req['id']! as String;
      expect(req['url'], startsWith('http://'), reason: 'the desktop sees it as before');
      expect((await conn.waitForNetEnd(id))['status'], 101);
      final s = await panelStream('/ws?case=panel-off', (s) => s.state == StreamState.closed && s.count >= 7);
      final call = panelCall('/ws?case=panel-off')!;
      expect(call.url, startsWith('ws://'));
      expect(s.followed, isTrue);
      final m = s.messages;
      expect(m.where((x) => x.out && x.type == 'text').map((x) => x.text()), <String?>['merhaba', 'bye']);
      expect(m.where((x) => !x.out && x.type == 'binary').single.bytes(), <int>[1, 2, 3]);
      expect(s.closedBy, 'in');
      expect(s.closeCode, 4000);
      expect(s.closeReason, 'done');
      await echoes.cancel();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(streamOf(id), isEmpty, reason: 'nothing reached the desktop');
      expect(store.calls.where((c) => c.url.endsWith('/ws?case=panel-off')), hasLength(1));
    });

    test('the setting on: one entry, each message once, the same count as the desktop', () async {
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=panel-on', customClient: HttpClient());
      final echoes = StreamIterator<Object?>(ws);
      for (final text in <String>['a', 'b', 'c']) {
        ws.add(text);
        await echoes.moveNext();
      }
      final id = (await request('/ws?case=panel-on'))['id']! as String;
      await waitStream(id, 6);
      final s = await panelStream('/ws?case=panel-on', (s) => s.count >= 6);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(s.count, streamOf(id).length);
      expect(s.messages.map((m) => '${m.out ? '>' : '<'}${m.text()}'), <String>['>a', '<a', '>b', '<b', '>c', '<c']);
      expect(store.calls.where((c) => c.url.endsWith('/ws?case=panel-on')), hasLength(1));
      await echoes.cancel();
      await ws.close();
    });

    test('an older desktop: the panel gets the events and the end, the desktop the body at its end', () async {
      await setConfig(streamConfig(on: null));
      final httpClient = HttpClient();
      final res = await (await httpClient.getUrl(Uri.parse('http://${origin.host}/sse?case=panel-old'))).close();
      await res.drain<void>();
      final id = (await request('/sse?case=panel-old'))['id']! as String;
      expect(bodyText(await conn.waitForNetEnd(id)), contains('line one'));
      final s = await panelStream('/sse?case=panel-old', (s) => s.state == StreamState.closed);
      expect(s.sseEnded, isTrue);
      final m = s.messages;
      expect(m, hasLength(3));
      expect(m[0].event, 'price');
      expect(m[0].retry, 2500);
      expect(m[0].text(), '{"sym":"DÜR","px":1.5}');
      expect(m[1].text(), 'line one\nline two');
      expect(m[2].size, 300);
      expect(streamOf(id), isEmpty);
      httpClient.close();
    });

    test('bodies off: sizes only; a long message is cut at 16 KB with its true size', () async {
      await setConfig(streamConfig(on: false, captureBodies: false));
      final ws = await WebSocket.connect('ws://${origin.host}/ws?case=panel-sizes', customClient: HttpClient());
      final echoes = StreamIterator<Object?>(ws);
      ws.add('secret');
      await echoes.moveNext();
      var s = await panelStream('/ws?case=panel-sizes', (s) => s.count >= 2);
      expect(s.messages.every((m) => !m.hasPayload), isTrue);
      expect(s.messages.first.size, 6);

      await setConfig(streamConfig(on: false));
      final big = 'x' * 40000;
      ws.add(big);
      await echoes.moveNext();
      s = await panelStream('/ws?case=panel-sizes', (s) => s.count >= 4);
      final m = s.messages[2];
      expect(m.size, 40000);
      expect(m.keptBytes, DurbunInspectorStore.kDefaultStreamMessageCap);
      expect(m.truncated, isTrue);
      await echoes.cancel();
      await ws.close();
    });
  });
}
