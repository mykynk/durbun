// The webhook request itself (dart:io): JSON, no redirects followed, the
// answer handed back, never a throw. Plain tests only: a widget test binding
// would install flutter_test's HTTP mock.
import 'dart:convert';
import 'dart:io';

import 'package:durbun/src/inspector/slack_io.dart' as io;
import 'package:flutter_test/flutter_test.dart';

void main() {
  late HttpServer server;
  late String base;
  final got = <(String, String?, Map<String, Object?>)>[];

  setUp(() async {
    got.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    base = 'http://127.0.0.1:${server.port}';
    server.listen((req) async {
      final body = await utf8.decoder.bind(req).join();
      got.add((req.uri.path, req.headers.contentType?.mimeType, jsonDecode(body) as Map<String, Object?>));
      switch (req.uri.path) {
        case '/moved':
          req.response
            ..statusCode = HttpStatus.found
            ..headers.set(HttpHeaders.locationHeader, '/hook');
        case '/refused':
          req.response
            ..statusCode = HttpStatus.badRequest
            ..write('invalid_blocks');
        case '/long':
          req.response
            ..statusCode = HttpStatus.forbidden
            ..write('x' * 500);
        default:
          req.response.write('ok');
      }
      await req.response.close();
    });
  });

  tearDown(() => server.close(force: true));

  test('posts the payload as JSON and hands back the status and the answer', () async {
    final payload = <String, Object?>{
      'text': 'GET https://a.example/x',
      'blocks': <Object?>[
        <String, Object?>{'type': 'rich_text', 'elements': <Object?>[]},
      ],
      'unfurl_links': false,
      'unfurl_media': false,
    };
    expect(await io.postToSlack('$base/hook', payload), (status: 200, answer: 'ok'));
    final (path, type, body) = got.single;
    expect((path, type), ('/hook', 'application/json'));
    expect(body, payload);

    expect(await io.postToSlack('$base/refused', payload), (status: 400, answer: 'invalid_blocks'));
    final long = await io.postToSlack('$base/long', payload);
    expect(long.status, 403);
    expect(long.answer, hasLength(200), reason: 'as much as a snack bar shows');
  });

  test('follows no redirect: the message never goes elsewhere', () async {
    final res = await io.postToSlack('$base/moved', <String, Object?>{'text': 'x'});
    expect(res.status, HttpStatus.found);
    expect(got.map((g) => g.$1), <String>['/moved']);
  });

  test('a host that does not answer is a reason, not a throw', () async {
    final unused = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = unused.port;
    await unused.close();
    final res = await io.postToSlack('http://127.0.0.1:$port/hook', <String, Object?>{'text': 'x'});
    expect(res.status, 0);
    expect(res.answer, isNotEmpty);
  });
}
