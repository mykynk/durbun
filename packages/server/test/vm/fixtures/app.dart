// Fixture for packages/server/test/vm/integration.test.ts.
//
// A small Dart program that behaves like a debug app: a local HTTP server and client traffic (GET/POST
// with JSON bodies, a 404, a connection failure), dart:developer logs at several levels (with error and
// stack trace, and a message longer than the VM's 128-char preview), stdout/stderr output, and — to
// exercise the Flutter paths without Flutter — a few `ext.flutter.*` service extensions and
// `Flutter.Frame` / `Flutter.Error` / `Flutter.Navigation` events with the exact payload shapes of
// package:flutter 3.38. Exits by itself after `--seconds` (default 25).
import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';

bool debugPaint = false;
double timeDilation = 1.0;

void registerFlutterLikeExtensions() {
  // Same contract as BindingBase.registerBoolServiceExtension.
  developer.registerExtension('ext.flutter.debugPaint', (method, params) async {
    if (params.containsKey('enabled')) {
      debugPaint = params['enabled'] == 'true';
      developer.postEvent('Flutter.ServiceExtensionStateChanged', {
        'extension': 'ext.flutter.debugPaint',
        'value': debugPaint ? 'true' : 'false',
      });
    }
    return developer.ServiceExtensionResponse.result(jsonEncode({
      'enabled': debugPaint ? 'true' : 'false',
      'type': '_extensionType',
      'method': method,
    }));
  });
  // Same contract as registerNumericServiceExtension (timeDilation).
  developer.registerExtension('ext.flutter.timeDilation', (method, params) async {
    if (params.containsKey('timeDilation')) {
      timeDilation = double.parse(params['timeDilation']!);
      developer.postEvent('Flutter.ServiceExtensionStateChanged', {
        'extension': 'ext.flutter.timeDilation',
        'value': timeDilation.toString(),
      });
    }
    return developer.ServiceExtensionResponse.result(jsonEncode({
      'timeDilation': timeDilation.toString(),
      'type': '_extensionType',
      'method': method,
    }));
  });
  // Same contract as WidgetsBinding's debugDumpApp: the dump is returned, not printed.
  developer.registerExtension('ext.flutter.debugDumpApp', (method, params) async {
    const dump = 'DurbunFixtureApp\n'
        '└MaterialApp\n'
        ' └Scaffold\n'
        '  └Text("Merhaba Dürbün")';
    return developer.ServiceExtensionResponse.result(jsonEncode({
      'data': dump,
      'type': '_extensionType',
      'method': method,
    }));
  });
}

Future<void> main(List<String> args) async {
  final seconds = args.contains('--seconds') ? int.parse(args[args.indexOf('--seconds') + 1]) : 25;

  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    final body = await utf8.decoder.bind(req).join();
    final res = req.response;
    if (req.uri.path == '/api/missing') {
      res.statusCode = HttpStatus.notFound;
      res.headers.contentType = ContentType.json;
      res.write(jsonEncode({'error': 'not found'}));
    } else if (req.uri.path == '/api/login') {
      res.headers.contentType = ContentType.json;
      final creds = jsonDecode(body) as Map<String, dynamic>;
      res.write(jsonEncode({'token': 'tok-123', 'user': creds['user']}));
    } else {
      res.headers.contentType = ContentType.json;
      res.headers.set('x-request-path', req.uri.path);
      res.write(jsonEncode({
        'users': [
          {'id': 1, 'name': 'Ayşe'},
          {'id': 2, 'name': 'Mehmet'},
        ],
        'page': req.uri.queryParameters['page'],
      }));
    }
    await res.close();
  });
  final closed = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final deadPort = closed.port;
  await closed.close();

  registerFlutterLikeExtensions();
  stdout.writeln('fixture ready on port ${server.port}');

  var tick = 0;
  var frameNumber = 0;
  var frameStart = 1000000000; // engine clock, µs

  // Flutter.Frame batches every 100 ms (6 frames ≈ 60 Hz), one janky frame per batch.
  final frames = Timer.periodic(const Duration(milliseconds: 100), (_) {
    for (var i = 0; i < 6; i++) {
      final janky = i == 0;
      developer.postEvent('Flutter.Frame', {
        'number': frameNumber++,
        'startTime': frameStart,
        'elapsed': janky ? 30000 : 9000,
        'build': janky ? 24000 : 4000,
        'raster': janky ? 5000 : 3000,
        'vsyncOverhead': 500,
      });
      frameStart += 16667;
    }
  });

  final work = Timer.periodic(const Duration(milliseconds: 500), (_) async {
    tick++;
    developer.log('tick $tick', name: 'fixture.tick', level: 800);
    developer.log('debug detail $tick', name: 'fixture.debug', level: 500);
    if (tick % 2 == 1) {
      developer.log('${'long payload ' * 20}end $tick', name: 'fixture.long', level: 900);
      try {
        throw FormatException('bad input $tick');
      } catch (e, st) {
        developer.log('parse failed $tick', name: 'fixture.error', level: 1000, error: e, stackTrace: st);
      }
      developer.log('plain log without level $tick');
    }
    stdout.write('partial ');
    print('printed line $tick');
    stderr.writeln('stderr line $tick');
    if (tick % 6 == 3) {
      developer.postEvent('Flutter.Navigation', {
        'route': {
          'description': 'MaterialPageRoute<void>(RouteSettings("/details", null), animation: null)',
          'settings': {'name': '/details'},
        },
      });
      developer.postEvent('Flutter.Error', {
        'description': 'Exception caught by widgets library',
        'errorsSinceReload': 0,
        'renderedErrorText': '══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞════════════════\n'
            'The following assertion was thrown building Fixture:\n'
            'Fixture error $tick\n'
            '═════════════════════════════════════════════════════',
      });
    }

    final client = HttpClient();
    try {
      final get = await client.getUrl(Uri.parse('http://127.0.0.1:${server.port}/api/users?page=$tick'));
      get.headers.set('accept', 'application/json');
      await (await get.close()).drain<void>();

      final post = await client.postUrl(Uri.parse('http://127.0.0.1:${server.port}/api/login'));
      post.headers.contentType = ContentType.json;
      post.write(jsonEncode({'user': 'yusuf', 'tick': tick}));
      await (await post.close()).transform(utf8.decoder).join();

      if (tick % 3 == 0) {
        final missing = await client.getUrl(Uri.parse('http://127.0.0.1:${server.port}/api/missing'));
        await (await missing.close()).drain<void>();
      }
      if (tick % 4 == 0) {
        try {
          final dead = await client.getUrl(Uri.parse('http://127.0.0.1:$deadPort/unreachable'));
          await (await dead.close()).drain<void>();
        } catch (_) {
          // expected: connection refused
        }
      }
    } finally {
      client.close();
    }
  });

  await Future<void>.delayed(Duration(seconds: seconds));
  frames.cancel();
  work.cancel();
  await server.close(force: true);
  exit(0);
}
