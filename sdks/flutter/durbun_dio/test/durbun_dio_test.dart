import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:durbun/durbun.dart';
import 'package:durbun_dio/durbun_dio.dart';
import 'package:flutter_test/flutter_test.dart';

// The fake desktop lives in the durbun package's test support folder.
import '../../durbun/test/support/fake_desktop.dart';

/// Stands in for a native adapter (cupertino_http / cronet): never uses dart:io.
class FakeNativeAdapter implements HttpClientAdapter {
  int calls = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    calls++;
    if (requestStream != null) await requestStream.drain<void>();
    switch (options.uri.path) {
      case '/users':
        return ResponseBody.fromString(
          jsonEncode({
            'users': [
              {'id': 1, 'name': 'Ada'},
            ],
          }),
          200,
          headers: {
            Headers.contentTypeHeader: ['application/json; charset=utf-8'],
          },
        );
      case '/big':
        final json = jsonEncode({'items': List.generate(2000, (i) => {'id': i, 'name': 'Ürün $i'})});
        return ResponseBody.fromString(json, 200, headers: {
          Headers.contentTypeHeader: ['application/json; charset=utf-8'],
          Headers.contentLengthHeader: ['${utf8.encode(json).length}'],
        });
      case '/raw':
        // Whitespace and key order as the server sent them.
        return ResponseBody.fromString('{ "b" : 2,\n  "a": 1 }', 200, headers: {
          Headers.contentTypeHeader: ['application/json'],
        });
      case '/secret':
        final auth = options.headers['authorization'];
        if (auth == 'Bearer fresh') {
          return ResponseBody.fromString('{"ok":true}', 200, headers: {
            Headers.contentTypeHeader: ['application/json'],
          });
        }
        return ResponseBody.fromString('{"error":"expired"}', 401, headers: {
          Headers.contentTypeHeader: ['application/json'],
        });
      case '/broken':
        final controller = StreamController<Uint8List>();
        controller
          ..add(Uint8List.fromList(utf8.encode('{"part":')))
          ..addError(const SocketException('Connection reset (native)'));
        unawaited(controller.close());
        return ResponseBody(controller.stream, 200, headers: {
          Headers.contentTypeHeader: ['application/json'],
        });
      case '/slow':
        final controller = StreamController<Uint8List>();
        controller.add(Uint8List.fromList(utf8.encode('{"items":[')));
        return ResponseBody(controller.stream, 200, headers: {
          Headers.contentTypeHeader: ['application/json'],
        });
      case '/events':
        return ResponseBody(
          Stream<Uint8List>.fromIterable(<Uint8List>[
            Uint8List.fromList(utf8.encode(': hi\nevent: tick\nid: 1\ndata: bi')),
            Uint8List.fromList(utf8.encode('r\n\ndata: iki\n\n')),
          ]),
          200,
          headers: {
            Headers.contentTypeHeader: ['text/event-stream'],
          },
        );
      case '/missing':
        return ResponseBody.fromString('{"error":"nope"}', 404, headers: {
          Headers.contentTypeHeader: ['application/json'],
        });
      default:
        throw const SocketException('Connection refused (native)');
    }
  }

  @override
  void close({bool force = false}) {}
}

/// Named like native_dio_adapter's URLSession-based adapter on iOS.
class NativeAdapter extends FakeNativeAdapter {}

/// The dart:io adapter under another class name, as an app subclass or an
/// `--obfuscate` build (minified class names) presents it.
class RenamedIoAdapter extends IOHttpClientAdapter {}

void main() {
  late FakeDesktop desktop;
  late FakeSdkConnection conn;

  setUpAll(() async {
    desktop = await FakeDesktop.start(appId: 'app:dio');
    await Durbun.init(DurbunOptions(
      enabled: true,
      port: desktop.port,
      appId: 'com.example.dio',
      useBackgroundIsolate: false,
    ));
    conn = await desktop.nextConnection();
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (!Durbun.isConnected && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  });

  tearDownAll(() async {
    await Durbun.dispose();
    await desktop.close();
  });

  Future<(Map<String, Object?>, Map<String, Object?>)> net(String suffix) async {
    final req = await conn.waitFor(
      (m) => m['type'] == 'net.request' && (m['url']! as String).endsWith(suffix),
    );
    return (req, await conn.waitForNetEnd(req['id']! as String));
  }

  Future<void> setMocks(List<Map<String, Object?>> rules) async {
    conn.send({'type': 'mocks', 'rules': rules});
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }

  /// Every row for a URL ending in [suffix]: (request, end) in send order.
  Future<List<(Map<String, Object?>, Map<String, Object?>)>> rows(String suffix, int count) async {
    final reqs = await conn.waitForCount(
      (m) => m['type'] == 'net.request' && (m['url']! as String).endsWith(suffix),
      count,
    );
    return [for (final r in reqs) (r, await conn.waitForNetEnd(r['id']! as String))];
  }

  /// The usual token refresh: on a 401, set a fresh token and send the same
  /// request again, answering the first call with the second's response.
  Interceptor refresher(Dio dio) => InterceptorsWrapper(
    onError: (err, handler) async {
      if (err.response?.statusCode == 401) {
        final options = err.requestOptions..headers['authorization'] = 'Bearer fresh';
        handler.resolve(await dio.fetch<Object?>(options));
        return;
      }
      handler.next(err);
    },
  );

  Dio wrappedDio(FakeNativeAdapter adapter) =>
      Dio(BaseOptions(baseUrl: 'https://api.example.com'))
        ..httpClientAdapter = DurbunDioAdapter(adapter);

  Dio nativeDio(FakeNativeAdapter adapter) {
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'))
      ..httpClientAdapter = adapter;
    dio.interceptors.add(DurbunDioInterceptor(dio: dio));
    return dio;
  }

  test('requests through a native adapter are reported with bodies', () async {
    final adapter = FakeNativeAdapter();
    final dio = nativeDio(adapter);
    final res = await dio.post<Map<String, dynamic>>(
      '/users',
      data: {'name': 'Yusuf', 'city': 'İzmir'},
      options: Options(headers: {'X-Trace': 'abc'}),
    );
    expect(res.data!['users'], isNotEmpty);
    final (req, end) = await net('/users');
    expect(req['method'], 'POST');
    expect(req['source'], 'dio');
    expect((req['body']! as Map)['data'], '{"name":"Yusuf","city":"İzmir"}');
    expect(end['status'], 200);
    expect((end['body']! as Map)['data'], contains('"Ada"'));
  });

  test('4xx (badResponse) is reported as a response, transport errors as net.error', () async {
    final dio = nativeDio(FakeNativeAdapter());
    await expectLater(dio.get<Object?>('/missing'), throwsA(isA<DioException>()));
    final (_, notFound) = await net('/missing');
    expect(notFound['type'], 'net.response');
    expect(notFound['status'], 404);
    await expectLater(dio.get<Object?>('/down'), throwsA(isA<DioException>()));
    final (_, down) = await net('/down');
    expect(down['type'], 'net.error');
    expect(down['error'], contains('Connection refused (native)'));
  });

  test('mock rules: respond without calling the adapter, fail with DioException', () async {
    await setMocks([
      {
        'id': 'mock-profile',
        'enabled': true,
        'method': 'GET',
        'url': '/profile',
        'match': 'contains',
        'action': {'type': 'respond', 'status': 200, 'body': '{"name":"Mock Ada"}'},
        'createdAt': 1,
      },
      {
        'id': 'mock-timeout',
        'enabled': true,
        'method': '*',
        'url': '/pay',
        'match': 'contains',
        'action': {'type': 'fail', 'error': 'timeout', 'delayMs': 50},
        'createdAt': 2,
      },
    ]);
    final adapter = FakeNativeAdapter();
    final dio = nativeDio(adapter);
    final profile = await dio.get<Map<String, dynamic>>('/profile');
    expect(profile.data, {'name': 'Mock Ada'});
    expect(profile.headers.value('x-durbun-mock'), 'mock-profile');
    expect(adapter.calls, 0);
    final (_, mocked) = await net('/profile');
    expect(mocked['mocked'], isTrue);
    expect(mocked['mockRuleId'], 'mock-profile');

    await expectLater(
      dio.post<Object?>('/pay'),
      throwsA(isA<DioException>().having((e) => e.type, 'type', DioExceptionType.connectionTimeout)),
    );
    final (_, failed) = await net('/pay');
    expect(failed['type'], 'net.error');
    expect(failed['mocked'], isTrue);
    await setMocks(const []);
  });

  test('a "tls" mock fails with a badCertificate DioException', () async {
    await setMocks([
      {
        'id': 'mock-tls',
        'enabled': true,
        'method': '*',
        'url': '/secure',
        'match': 'contains',
        'action': {'type': 'fail', 'error': 'tls'},
        'createdAt': 1,
      },
    ]);
    final adapter = FakeNativeAdapter();
    final dio = nativeDio(adapter);
    await expectLater(
      dio.get<Object?>('/secure'),
      throwsA(isA<DioException>()
          .having((e) => e.type, 'type', DioExceptionType.badCertificate)
          .having((e) => '${e.error}', 'error', contains('CERTIFICATE_VERIFY_FAILED'))),
    );
    expect(adapter.calls, 0);
    final (_, failed) = await net('/secure');
    expect(failed['type'], 'net.error');
    expect(failed['mocked'], isTrue);
    await setMocks(const []);
  });

  test('a rule limited to a GraphQL operation reads the body Dio will send', () async {
    await setMocks([
      {
        'id': 'mock-get-user',
        'enabled': true,
        'method': 'POST',
        'url': '/users',
        'match': 'contains',
        'when': {
          'graphql': {'operationName': 'GetUser', 'operationType': 'query'},
        },
        'action': {'type': 'respond', 'status': 200, 'body': '{"mocked":"GetUser"}'},
        'createdAt': 1,
      },
    ]);
    for (final dio in [nativeDio(FakeNativeAdapter()), wrappedDio(FakeNativeAdapter())]) {
      final adapter = (dio.httpClientAdapter is DurbunDioAdapter
          ? (dio.httpClientAdapter as DurbunDioAdapter).inner
          : dio.httpClientAdapter) as FakeNativeAdapter;
      // A map (JSON-encoded by Dio), a string and UTF-8 bytes all name the operation.
      final asMap = await dio.post<Map<String, dynamic>>(
        '/users',
        data: {'operationName': 'GetUser', 'query': 'query GetUser { me { id } }'},
      );
      expect(asMap.data, {'mocked': 'GetUser'});
      final asString = await dio.post<Map<String, dynamic>>(
        '/users',
        data: '{"query":"query GetUser { me { id } }"}',
        options: Options(contentType: 'application/json'),
      );
      expect(asString.data, {'mocked': 'GetUser'});
      final asBytes = await dio.post<Map<String, dynamic>>(
        '/users',
        data: Uint8List.fromList(utf8.encode('{"operationName":"GetUser","query":"query GetUser { a }"}')),
        options: Options(contentType: 'application/json'),
      );
      expect(asBytes.data, {'mocked': 'GetUser'});
      expect(adapter.calls, 0);

      // Another operation, and a body that cannot be read (a stream), go to the adapter.
      final other = await dio.post<Map<String, dynamic>>(
        '/users',
        data: {'query': 'mutation GetUser { a }'},
      );
      expect(other.data!['users'], isNotEmpty);
      final bytes = utf8.encode('{"operationName":"GetUser"}');
      final streamed = await dio.post<Map<String, dynamic>>(
        '/users',
        data: Stream<List<int>>.fromIterable([bytes]),
        options: Options(contentType: 'application/json', headers: {'content-length': bytes.length}),
      );
      expect(streamed.data!['users'], isNotEmpty);
      expect(adapter.calls, 2);
    }
    await setMocks(const []);
  });

  test('Dio with the default dart:io adapter is not reported twice', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) => req.response
      ..headers.contentType = ContentType.json
      ..write('{"ok":true}')
      ..close());
    final dio = Dio()..httpClientAdapter = IOHttpClientAdapter();
    dio.interceptors.add(DurbunDioInterceptor(dio: dio));
    final res = await dio.get<Map<String, dynamic>>('http://127.0.0.1:${server.port}/io-path');
    expect(res.data, {'ok': true});
    final (req, end) = await net('/io-path');
    expect(req['source'], 'dart:io');
    expect(end['status'], 200);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(
      conn.ofType('net.request').where((m) => (m['url']! as String).endsWith('/io-path')),
      hasLength(1),
    );
    await server.close(force: true);
  });

  test('the dart:io adapter is recognized by type, not by its class name', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) => req.response
      ..headers.contentType = ContentType.json
      ..write('{"ok":true}')
      ..close());
    final dio = Dio()..httpClientAdapter = RenamedIoAdapter();
    dio.interceptors.add(DurbunDioInterceptor(dio: dio));
    await dio.get<Map<String, dynamic>>('http://127.0.0.1:${server.port}/renamed-io');
    final (req, _) = await net('/renamed-io');
    expect(req['source'], 'dart:io');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(
      conn.ofType('net.request').where((m) => (m['url']! as String).endsWith('/renamed-io')),
      hasLength(1),
    );
    await server.close(force: true);
  });

  test('a NativeAdapter is still reported when no native layer captures URLSession', () async {
    // On iOS with the plugin, DurbunNetwork.capturesUrlSession is true and the
    // native layer reports these requests instead; here (no plugin) it is false.
    expect(DurbunNetwork.capturesUrlSession, isFalse);
    final adapter = NativeAdapter();
    final res = await nativeDio(adapter).get<Map<String, dynamic>>('/users?via=native');
    expect(res.data!['users'], isNotEmpty);
    final (req, end) = await net('/users?via=native');
    expect(req['source'], 'dio');
    expect(end['status'], 200);
  });

  test('large decoded bodies are encoded only up to the desktop limit', () async {
    conn.send({'type': 'config', 'config': FakeDesktop.defaultConfig(maxBodyBytes: 1000)});
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (DurbunNetwork.maxBodyBytes != 1000 && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    addTearDown(() => conn.send({'type': 'config', 'config': FakeDesktop.defaultConfig()}));
    final res = await nativeDio(FakeNativeAdapter()).post<Map<String, dynamic>>(
      '/big',
      data: {'filter': 'x' * 5000},
    );
    expect((res.data!['items'] as List), hasLength(2000), reason: 'the app gets everything');
    final (req, end) = await net('/big');
    final reqBody = req['body']! as Map;
    expect(reqBody['truncated'], isTrue);
    expect((reqBody['data']! as String).length, 1000);
    final body = end['body']! as Map;
    expect(body['truncated'], isTrue);
    expect((body['data']! as String).length, lessThanOrEqualTo(1000));
    final declared = int.parse(res.headers.value(Headers.contentLengthHeader)!);
    expect(body['size'], declared, reason: 'the size comes from content-length');
  });

  test('interceptor: a request answered by another interceptor still ends', () async {
    final adapter = FakeNativeAdapter();
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'))..httpClientAdapter = adapter;
    dio.interceptors
      ..add(refresher(dio))
      ..add(DurbunDioInterceptor(dio: dio));
    final res = await dio.get<Map<String, dynamic>>(
      '/secret?via=interceptor',
      options: Options(headers: {'authorization': 'Bearer old'}),
    );
    expect(res.data, {'ok': true});
    final both = await rows('/secret?via=interceptor', 2);
    final (_, first) = both[0];
    expect(first['type'], 'net.error');
    expect(first['error'], contains('DurbunDioAdapter'));
    final (_, second) = both[1];
    expect(second['status'], 200);
  });

  group('DurbunDioAdapter', () {
    test('a token refresh shows both requests, each with its own ending', () async {
      final adapter = FakeNativeAdapter();
      final dio = wrappedDio(adapter);
      dio.interceptors.add(refresher(dio));
      final res = await dio.get<Map<String, dynamic>>(
        '/secret?via=adapter',
        options: Options(headers: {'authorization': 'Bearer old'}),
      );
      expect(res.data, {'ok': true});
      expect(adapter.calls, 2);
      final both = await rows('/secret?via=adapter', 2);
      final (firstReq, first) = both[0];
      expect(first['type'], 'net.response');
      expect(first['status'], 401);
      expect((first['body']! as Map)['data'], '{"error":"expired"}');
      expect(firstReq['headers'], anyElement(equals(['authorization', 'Bearer old'])));
      final (secondReq, second) = both[1];
      expect(second['status'], 200);
      expect(secondReq['headers'], anyElement(equals(['authorization', 'Bearer fresh'])));
    });

    test('the body is the bytes the adapter delivered, with their size', () async {
      final dio = wrappedDio(FakeNativeAdapter());
      final res = await dio.get<Map<String, dynamic>>('/raw');
      expect(res.data, {'b': 2, 'a': 1});
      final (req, end) = await net('/raw');
      expect(req['source'], 'dio');
      const wire = '{ "b" : 2,\n  "a": 1 }';
      final body = end['body']! as Map;
      expect(body['data'], wire);
      expect(body['size'], utf8.encode(wire).length);
    });

    test('an interceptor on the same Dio does not report twice', () async {
      final dio = wrappedDio(FakeNativeAdapter());
      dio.interceptors.add(DurbunDioInterceptor(dio: dio));
      await dio.get<Map<String, dynamic>>('/users?via=both');
      await net('/users?via=both');
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(
        conn.ofType('net.request').where((m) => (m['url']! as String).endsWith('/users?via=both')),
        hasLength(1),
      );
    });

    test('an error status whose body Dio drops still ends', () async {
      final dio = wrappedDio(FakeNativeAdapter());
      await expectLater(
        dio.get<Object?>('/missing?drop=1', options: Options(receiveDataWhenStatusError: false)),
        throwsA(isA<DioException>()),
      );
      final (_, end) = await net('/missing?drop=1');
      expect(end['type'], 'net.response');
      expect(end['status'], 404);
    });

    test('transport errors, broken bodies and cancels end the row', () async {
      final dio = wrappedDio(FakeNativeAdapter());
      await expectLater(dio.get<Object?>('/down?via=adapter'), throwsA(isA<DioException>()));
      final (_, down) = await net('/down?via=adapter');
      expect(down['type'], 'net.error');
      expect(down['error'], contains('Connection refused (native)'));

      await expectLater(dio.get<Object?>('/broken'), throwsA(isA<DioException>()));
      final (_, broken) = await net('/broken');
      expect(broken['type'], 'net.error');
      expect(broken['error'], contains('Connection reset (native)'));

      final token = CancelToken();
      final pending = dio.get<Object?>('/slow', cancelToken: token);
      await conn.waitFor((m) => m['type'] == 'net.request' && (m['url']! as String).endsWith('/slow'));
      token.cancel();
      await expectLater(pending, throwsA(isA<DioException>()));
      final (_, slow) = await net('/slow');
      expect(slow['type'], 'net.error');
      expect(slow['cancelled'], isTrue);
    });

    test('mock rules: respond without calling the adapter, fail with DioException', () async {
      await setMocks([
        {
          'id': 'mock-adapter',
          'enabled': true,
          'method': 'GET',
          'url': '/adapter-profile',
          'match': 'contains',
          'action': {'type': 'respond', 'status': 200, 'body': '{"name":"Mock Ada"}'},
          'createdAt': 1,
        },
        {
          'id': 'mock-adapter-missing',
          'enabled': true,
          'method': 'GET',
          'url': '/adapter-gone',
          'match': 'contains',
          'action': {'type': 'respond', 'status': 404, 'body': '{"error":"gone"}'},
          'createdAt': 2,
        },
        {
          'id': 'mock-adapter-dns',
          'enabled': true,
          'method': '*',
          'url': '/adapter-pay',
          'match': 'contains',
          'action': {'type': 'fail', 'error': 'dns'},
          'createdAt': 3,
        },
      ]);
      final adapter = FakeNativeAdapter();
      final dio = wrappedDio(adapter);
      final profile = await dio.get<Map<String, dynamic>>('/adapter-profile');
      expect(profile.data, {'name': 'Mock Ada'});
      expect(profile.headers.value('x-durbun-mock'), 'mock-adapter');
      final (_, mocked) = await net('/adapter-profile');
      expect(mocked['mocked'], isTrue);
      expect(mocked['mockRuleId'], 'mock-adapter');

      await expectLater(
        dio.get<Object?>('/adapter-gone'),
        throwsA(isA<DioException>().having((e) => e.response?.statusCode, 'status', 404)),
      );
      final (_, gone) = await net('/adapter-gone');
      expect(gone['status'], 404);

      await expectLater(
        dio.post<Object?>('/adapter-pay'),
        throwsA(isA<DioException>().having((e) => e.type, 'type', DioExceptionType.connectionError)),
      );
      final (_, failed) = await net('/adapter-pay');
      expect(failed['type'], 'net.error');
      expect(failed['mocked'], isTrue);
      expect(adapter.calls, 0);
      await setMocks(const []);
    });

    test('bodies stop at the desktop limit while the app gets everything', () async {
      conn.send({'type': 'config', 'config': FakeDesktop.defaultConfig(maxBodyBytes: 1000)});
      final deadline = DateTime.now().add(const Duration(seconds: 5));
      while (DurbunNetwork.maxBodyBytes != 1000 && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      addTearDown(() => conn.send({'type': 'config', 'config': FakeDesktop.defaultConfig()}));
      final res = await wrappedDio(FakeNativeAdapter()).get<Map<String, dynamic>>('/big?via=adapter');
      expect((res.data!['items'] as List), hasLength(2000));
      final (_, end) = await net('/big?via=adapter');
      final body = end['body']! as Map;
      expect(body['truncated'], isTrue);
      expect((body['data']! as String).length, lessThanOrEqualTo(1000));
      expect(body['size'], int.parse(res.headers.value(Headers.contentLengthHeader)!));
    });
  });

  group('bodyBytesForReport', () {
    test('JSON stops at the limit; the size is only known when it fit', () {
      final big = {'items': List.generate(5000, (i) => {'id': i})};
      final cut = bodyBytesForReport(big, 'application/json', limit: 1001)!;
      expect(cut.bytes, hasLength(1001));
      expect(cut.size, isNull);
      expect(utf8.decode(cut.bytes), startsWith('{"items":[{"id":0}'));
      final small = bodyBytesForReport({'a': 'ğ'}, 'application/json', limit: 1001)!;
      expect(utf8.decode(small.bytes), '{"a":"ğ"}');
      expect(small.size, small.bytes.length);
    });

    test('strings, bytes, typed data, form data and disabled bodies', () {
      final text = bodyBytesForReport('ğ' * 3000, 'text/plain', limit: 1001)!;
      expect(text.bytes.length, lessThanOrEqualTo(2002));
      expect(text.size, 6000);
      final bytes = Uint8List.fromList([1, 2, 3]);
      expect(identical(bodyBytesForReport(bytes, null, limit: 10)!.bytes, bytes), isTrue);
      final floats = Float32List.fromList([1, 2]);
      expect(bodyBytesForReport(floats, null, limit: 10)!.bytes, hasLength(8));
      final form = bodyBytesForReport(FormData.fromMap({'k': 'v'}), null, limit: 1001)!;
      expect(utf8.decode(form.bytes), contains('k=v'));
      expect(bodyBytesForReport(Stream<List<int>>.empty(), null, limit: 10), isNull);
      // Bodies off: no encoding, sizes only where they are cheap.
      expect(bodyBytesForReport({'a': 1}, 'application/json', limit: 0), isNull);
      expect(bodyBytesForReport('abc', 'text/plain', limit: 0)!.size, 3);
      expect(
        utf8.decode(bodyBytesForReport({'a': 1, 'b': 'x y'}, 'application/x-www-form-urlencoded', limit: 100)!.bytes),
        'a=1&b=x+y',
      );
    });
  });

  group('Server-Sent Events', () {
    Future<void> streams(bool? on) async {
      conn.send(<String, Object?>{
        'type': 'config',
        'config': <String, Object?>{
          ...FakeDesktop.defaultConfig(),
          if (on != null) 'captureStreams': on,
          'maxStreamMessageBytes': 1024,
        },
      });
      final deadline = DateTime.now().add(const Duration(seconds: 5));
      while (DurbunNetwork.capturesStreams != (on == true)) {
        if (DateTime.now().isAfter(deadline)) throw TimeoutException('config not applied');
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
    }

    setUp(() => streams(true));
    tearDown(() => streams(null));

    Future<String> read(Dio dio, String path) async {
      final res = await dio.get<ResponseBody>(path, options: Options(responseType: ResponseType.stream));
      return utf8.decode(await res.data!.stream.expand((c) => c).toList());
    }

    for (final via in ['adapter', 'interceptor']) {
      test('$via: the response at its headers, one message per event, the end', () async {
        final dio = via == 'adapter' ? wrappedDio(FakeNativeAdapter()) : nativeDio(FakeNativeAdapter());
        final text = await read(dio, '/events?via=$via');
        expect(text, contains('data: iki'), reason: 'the app reads every byte');
        final req = await conn.waitFor((m) => m['type'] == 'net.request' && '${m['url']}'.endsWith('/events?via=$via'));
        final id = req['id']! as String;
        final messages = await conn.waitForCount((m) => m['id'] == id, 5);
        expect(messages.map((m) => m['type']), <String>['net.request', 'net.response', 'net.sse', 'net.sse', 'net.sse']);
        expect(messages[1].containsKey('body'), isFalse);
        expect(messages[2]['event'], 'tick');
        expect((messages[2]['body']! as Map)['data'], 'bir');
        expect((messages[3]['body']! as Map)['data'], 'iki');
        expect(messages[4]['end'], isTrue);
      });
    }

    test('a desktop without stream messages gets the body as before', () async {
      await streams(null);
      await read(wrappedDio(FakeNativeAdapter()), '/events?via=old');
      final (req, end) = await net('/events?via=old');
      expect((end['body']! as Map)['data'], contains('data: iki'));
      expect(conn.received.where((m) => m['type'] == 'net.sse' && m['id'] == req['id']), isEmpty);
    });
  });
}
