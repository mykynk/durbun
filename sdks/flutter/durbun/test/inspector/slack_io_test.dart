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

  /// Requests that are not JSON: path, content type, Authorization, bytes.
  final raw = <(String, String?, String?, List<int>)>[];

  setUp(() async {
    got.clear();
    raw.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    base = 'http://127.0.0.1:${server.port}';
    server.listen((req) async {
      final bytes = <int>[for (final chunk in await req.toList()) ...chunk];
      final type = req.headers.contentType?.mimeType;
      if (type == 'application/json') {
        got.add((req.uri.path, type, jsonDecode(utf8.decode(bytes)) as Map<String, Object?>));
      } else {
        raw.add((req.uri.path, type, req.headers.value(HttpHeaders.authorizationHeader), bytes));
      }
      switch (req.uri.path) {
        case '/moved':
          req.response
            ..statusCode = HttpStatus.found
            ..headers.set(HttpHeaders.locationHeader, '/hook');
        case '/refused':
          req.response
            ..statusCode = HttpStatus.badRequest
            ..write('invalid_blocks');
        case '/api':
          req.response.write('{"ok":true,"upload_url":"https://files.slack.com/upload/v1/ABC"}');
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

  test('a Slack API call: the key in the Authorization header, the form url-encoded, the JSON answer back', () async {
    final res = await io.postSlackForm('$base/api', 'xoxb-1234-5678', <String, String>{'filename': 'a b.png', 'length': '4'});
    expect(res.status, 200);
    expect(jsonDecode(res.answer), containsPair('upload_url', 'https://files.slack.com/upload/v1/ABC'));
    final (path, type, auth, bytes) = raw.single;
    expect((path, type, auth), ('/api', 'application/x-www-form-urlencoded', 'Bearer xoxb-1234-5678'));
    expect(Uri.splitQueryString(utf8.decode(bytes)), <String, String>{'filename': 'a b.png', 'length': '4'});

    final moved = await io.postSlackForm('$base/moved', 'xoxb-1234-5678', const <String, String>{});
    expect(moved.status, HttpStatus.found, reason: 'no redirect followed with the key');
  });

  test('the upload: the bytes as they are, without the key, no redirects', () async {
    final res = await io.postSlackBytes('$base/upload', <int>[137, 80, 78, 71]);
    expect(res, (status: 200, answer: 'ok'));
    final (path, type, auth, bytes) = raw.single;
    expect((path, type, auth), ('/upload', 'application/octet-stream', null));
    expect(bytes, <int>[137, 80, 78, 71]);
    expect((await io.postSlackBytes('$base/moved', <int>[1])).status, HttpStatus.found);
  });
}
