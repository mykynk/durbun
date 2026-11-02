/// Dürbün interceptor for Dio.
///
/// Only needed when Dio uses an adapter that bypasses dart:io (e.g.
/// `NativeAdapter` from native_dio_adapter, cupertino_http, cronet_http).
/// Dio's default `IOHttpClientAdapter` is already captured by `package:durbun`,
/// and on iOS so is every URLSession-based adapter (the plugin's native layer).
///
/// ```dart
/// final dio = Dio()..httpClientAdapter = NativeAdapter();
/// dio.interceptors.add(DurbunDioInterceptor(dio: dio));
/// ```
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:durbun/durbun.dart';

/// Reports Dio requests to Dürbün and applies its mock rules
/// (`respond` → resolved without a network call, `delay` → waits, `fail` →
/// the matching [DioException]: connectionTimeout / connectionError /
/// badCertificate / unknown).
class DurbunDioInterceptor extends Interceptor {
  DurbunDioInterceptor({this.dio, this.source = 'dio'});

  /// The Dio instance this interceptor is added to. When given and it still
  /// uses the dart:io adapter, requests are left to package:durbun's dart:io
  /// capture (no duplicates).
  final Dio? dio;

  /// `net.request.source` shown on the desktop.
  final String source;

  static const String _callKey = 'durbun.call';

  bool get _usesDartIoAdapter {
    final d = dio;
    if (d == null) return false;
    final name = d.httpClientAdapter.runtimeType.toString();
    return name == 'IOHttpClientAdapter' || name == 'DefaultHttpClientAdapter';
  }

  /// Adapters built on URLSession (native_dio_adapter's `NativeAdapter` /
  /// `CupertinoAdapter` on iOS). package:durbun's iOS layer already captures
  /// URLSession traffic and applies mocks to it, so these requests are left
  /// to it (no duplicates). On Android `NativeAdapter` uses Cronet, which the
  /// native layer does not see, so it is still reported here.
  bool get _usesUrlSessionAdapter {
    final d = dio;
    if (d == null || !DurbunNetwork.capturesUrlSession) return false;
    final name = d.httpClientAdapter.runtimeType.toString();
    return name == 'NativeAdapter' || name == 'CupertinoAdapter';
  }

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    var handled = false;
    try {
      if (!Durbun.isEnabled ||
          (_usesDartIoAdapter && DurbunNetwork.capturesDartIo) ||
          _usesUrlSessionAdapter) {
        handled = true;
        handler.next(options);
        return;
      }
      final mock = DurbunNetwork.findMock(options.method, options.uri);
      final call = _begin(options, mock);
      if (mock == null) {
        if (call != null) options.extra[_callKey] = call;
        handled = true;
        handler.next(options);
        return;
      }
      if (mock.delay > Duration.zero) await Future<void>.delayed(mock.delay);
      switch (mock.type) {
        case 'delay':
          if (call != null) options.extra[_callKey] = call;
          handled = true;
          handler.next(options);
        case 'fail':
          final error = _failure(options, mock);
          call?.error(error);
          handled = true;
          handler.reject(error, true);
        default:
          final response = _mockResponse(options, mock);
          if (call != null) _reportResponse(call, response);
          handled = true;
          if (options.validateStatus(response.statusCode)) {
            handler.resolve(response, true);
          } else {
            handler.reject(
              DioException.badResponse(
                statusCode: mock.status,
                requestOptions: options,
                response: response,
              ),
              true,
            );
          }
      }
    } catch (_) {
      // Never break the app's networking because of Dürbün.
      if (!handled) handler.next(options);
    }
  }

  @override
  void onResponse(
    Response<dynamic> response,
    ResponseInterceptorHandler handler,
  ) {
    final call = response.requestOptions.extra.remove(_callKey);
    if (call is DurbunHttpCall) _reportResponse(call, response);
    handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final call = err.requestOptions.extra.remove(_callKey);
    if (call is DurbunHttpCall) {
      final response = err.response;
      if (response != null) {
        _reportResponse(call, response);
      } else {
        call.error(err, cancelled: err.type == DioExceptionType.cancel);
      }
    }
    handler.next(err);
  }

  DurbunHttpCall? _begin(RequestOptions options, DurbunMockDecision? mock) {
    try {
      final headers = <List<String>>[];
      options.headers.forEach((name, value) {
        if (value == null) return;
        if (value is Iterable) {
          for (final v in value) {
            headers.add(<String>[name, '$v']);
          }
        } else {
          headers.add(<String>[name, '$value']);
        }
      });
      final contentType = options.contentType;
      if (contentType != null &&
          !headers.any((h) => h[0].toLowerCase() == 'content-type')) {
        headers.add(<String>['content-type', contentType]);
      }
      return DurbunNetwork.begin(
        method: options.method,
        url: options.uri,
        headers: headers,
        body: _encodeBody(options.data, contentType),
        contentType: contentType,
        source: source,
        mockRuleId: mock?.ruleId,
      );
    } catch (_) {
      return null;
    }
  }

  static void _reportResponse(DurbunHttpCall call, Response<dynamic> response) {
    try {
      final headers = <List<String>>[];
      response.headers.forEach((name, values) {
        for (final v in values) {
          headers.add(<String>[name, v]);
        }
      });
      final contentType = response.headers.map['content-type']?.first;
      final data = response.data;
      call.response(
        status: response.statusCode ?? 0,
        statusText: response.statusMessage,
        headers: headers,
        body: data is ResponseBody ? null : _encodeBody(data, contentType),
        contentType: contentType,
      );
    } catch (_) {}
  }

  /// Bytes of a request/response payload as Dio holds it.
  static List<int>? _encodeBody(Object? data, String? contentType) {
    if (data == null) return null;
    if (data is String) return utf8.encode(data);
    if (data is List<int>) return data;
    if (data is FormData) {
      final sb = StringBuffer('multipart/form-data (boundary ${data.boundary})\n');
      for (final f in data.fields) {
        sb.writeln('${f.key}=${f.value}');
      }
      for (final f in data.files) {
        sb.writeln('${f.key}: ${f.value.filename ?? 'file'} (${f.value.length} bytes)');
      }
      return utf8.encode(sb.toString());
    }
    if (data is Stream) return null;
    if (data is Map || data is List) {
      if ((contentType ?? '').contains('x-www-form-urlencoded') && data is Map) {
        return utf8.encode(
          Transformer.urlEncodeMap(<String, dynamic>{
            for (final e in data.entries) '${e.key}': e.value,
          }),
        );
      }
      try {
        return utf8.encode(jsonEncode(data));
      } catch (_) {
        return utf8.encode(data.toString());
      }
    }
    return utf8.encode(data.toString());
  }

  static Response<dynamic> _mockResponse(
    RequestOptions options,
    DurbunMockDecision mock,
  ) {
    final map = <String, List<String>>{};
    for (final h in mock.headers) {
      if (h.length >= 2) (map[h[0].toLowerCase()] ??= <String>[]).add(h[1]);
    }
    final bytes = Uint8List.fromList(mock.body);
    final text = utf8.decode(bytes, allowMalformed: true);
    map.putIfAbsent('content-type', () {
      final trimmed = text.trimLeft();
      return <String>[
        trimmed.startsWith('{') || trimmed.startsWith('[')
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8',
      ];
    });
    map['x-durbun-mock'] = <String>[mock.ruleLabel];
    final contentType = map['content-type']!.first;
    final Object? data = switch (options.responseType) {
      ResponseType.bytes => bytes,
      ResponseType.stream => ResponseBody(
        Stream<Uint8List>.value(bytes),
        mock.status,
        headers: map,
      ),
      ResponseType.plain => text,
      _ => _decodeJson(text, contentType),
    };
    return Response<dynamic>(
      requestOptions: options,
      statusCode: mock.status,
      statusMessage: _reasonPhrase(mock.status),
      headers: Headers.fromMap(map),
      data: data,
      extra: <String, dynamic>{'durbun.mockRuleId': mock.ruleId},
    );
  }

  static Object? _decodeJson(String text, String contentType) {
    if (!contentType.contains('json') || text.trim().isEmpty) return text;
    try {
      return jsonDecode(text);
    } catch (_) {
      return text;
    }
  }

  static DioException _failure(RequestOptions options, DurbunMockDecision mock) {
    final message = mock.message;
    switch (mock.failure) {
      case 'timeout':
        return DioException.connectionTimeout(
          timeout: options.connectTimeout ?? mock.delay,
          requestOptions: options,
          error: message,
        );
      case 'tls':
        return DioException.badCertificate(
          requestOptions: options,
          error: message ?? 'CERTIFICATE_VERIFY_FAILED (Dürbün mock)',
        );
      case 'dns':
        return DioException.connectionError(
          requestOptions: options,
          reason: message ?? "Failed host lookup: '${options.uri.host}'",
        );
      case 'custom':
        return DioException(
          requestOptions: options,
          error: message ?? 'Simulated failure (Dürbün mock)',
          message: message ?? 'Simulated failure (Dürbün mock)',
        );
      default:
        return DioException.connectionError(
          requestOptions: options,
          reason: message ?? 'Connection refused',
        );
    }
  }

  static String _reasonPhrase(int status) => switch (status) {
    200 => 'OK',
    201 => 'Created',
    202 => 'Accepted',
    204 => 'No Content',
    301 => 'Moved Permanently',
    302 => 'Found',
    304 => 'Not Modified',
    400 => 'Bad Request',
    401 => 'Unauthorized',
    403 => 'Forbidden',
    404 => 'Not Found',
    409 => 'Conflict',
    422 => 'Unprocessable Entity',
    429 => 'Too Many Requests',
    500 => 'Internal Server Error',
    502 => 'Bad Gateway',
    503 => 'Service Unavailable',
    504 => 'Gateway Timeout',
    _ => '',
  };
}
