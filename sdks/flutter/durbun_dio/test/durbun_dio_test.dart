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
}
