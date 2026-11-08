/// Dürbün interceptor for Dio.
///
/// Only needed when Dio uses an adapter that bypasses dart:io (e.g.
/// `NativeAdapter` from native_dio_adapter, cupertino_http, cronet_http).
/// Dio's default `IOHttpClientAdapter` is already captured by `package:durbun`,
/// and on iOS so is every URLSession-based adapter (the plugin's native layer).
/// Add it last: the request is reported as the interceptors before it left it.
///
/// ```dart
/// final dio = Dio()..httpClientAdapter = NativeAdapter();
/// dio.interceptors.add(DurbunDioInterceptor(dio: dio)); // last
/// ```
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:durbun/durbun.dart';

import 'src/dart_io_adapter_stub.dart'
    if (dart.library.io) 'src/dart_io_adapter.dart';

/// Reports Dio requests to Dürbün and applies its mock rules
/// (`respond` → resolved without a network call, `delay` → waits, `fail` →
/// the matching [DioException]: connectionTimeout / connectionError /
/// badCertificate / unknown).
///
/// Add it as the last interceptor: headers and body are taken as the
/// interceptors before it left the request.
class DurbunDioInterceptor extends Interceptor {
  DurbunDioInterceptor({required this.dio, this.source = 'dio'});

  /// The Dio instance this interceptor is added to. While it uses the
  /// dart:io adapter (Dio's default), package:durbun's dart:io capture
  /// already reports — and mocks — its requests, so this interceptor stays
  /// out of the way (no duplicates, no double delays).
  final Dio dio;

  /// `net.request.source` shown on the desktop.
  final String source;

  static const String _callKey = 'durbun.call';

  bool get _usesDartIoAdapter => usesDartIoHttpClient(dio.httpClientAdapter);

  /// Adapters built on URLSession (native_dio_adapter's `NativeAdapter` /
  /// `CupertinoAdapter` on iOS). package:durbun's iOS layer already captures
  /// URLSession traffic and applies mocks to it, so these requests are left
  /// to it (no duplicates). On Android `NativeAdapter` uses Cronet, which the
  /// native layer does not see, so it is still reported here. Matched by name
  /// (no dependency on native_dio_adapter): in `--obfuscate` builds the names
  /// are minified, so such requests are reported by both layers rather than
  /// risk losing them.
  bool get _usesUrlSessionAdapter {
    if (!DurbunNetwork.capturesUrlSession) return false;
    final name = dio.httpClientAdapter.runtimeType.toString();
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
      final body = bodyBytesForReport(
        options.data,
        contentType,
        limit: _bodyLimit(),
      );
      return DurbunNetwork.begin(
        method: options.method,
        url: options.uri,
        headers: headers,
        body: body?.bytes,
        bodySize: body?.size,
        contentType: contentType,
        source: source,
        mockRuleId: mock?.ruleId,
      );
    } catch (_) {
      return null;
    }
  }

  /// How many body bytes are worth producing: the desktop's limit (+1 so
  /// the SDK still sees that more existed); 0 when bodies are not wanted.
  static int _bodyLimit() =>
      DurbunNetwork.captureBodies ? DurbunNetwork.maxBodyBytes + 1 : 0;

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
      final body = data is ResponseBody
          ? null
          : bodyBytesForReport(data, contentType, limit: _bodyLimit());
      var size = body?.size;
      if (size == null && data != null && data is! ResponseBody) {
        // Encoding stopped at the limit (or bodies are off): the declared
        // length is the best size there is, when the bytes on the wire are
        // the decoded ones.
        final encoding = response.headers.value('content-encoding');
        final length = int.tryParse(response.headers.value('content-length') ?? '');
        if (length != null && (encoding == null || encoding == 'identity')) {
          size = length;
        }
      }
      call.response(
        status: response.statusCode ?? 0,
        statusText: response.statusMessage,
        headers: headers,
        body: body?.bytes,
        bodySize: size,
        contentType: contentType,
      );
    } catch (_) {}
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

/// The bytes Dürbün reports for a request/response payload as Dio holds it,
/// produced only up to [limit] bytes (`size` is then null when the whole
/// size is unknown, or the exact size when it is cheap to know). Decoded
/// JSON is re-encoded straight to UTF-8 and the encoding stops at the limit;
/// byte payloads are passed as they are (the SDK copies only what it keeps).
/// Null when there is nothing to report (no data, a stream).
({List<int> bytes, int? size})? bodyBytesForReport(
  Object? data,
  String? contentType, {
  required int limit,
}) {
  if (data == null || data is Stream) return null;
  if (data is List<int>) return (bytes: data, size: data.length);
  if (data is ByteBuffer) {
    final bytes = data.asUint8List();
    return (bytes: bytes, size: bytes.length);
  }
  if (data is TypedData) {
    final bytes = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    return (bytes: bytes, size: bytes.length);
  }
  if (limit <= 0) {
    // Bodies are off: only a cheap size.
    return data is String ? (bytes: const <int>[], size: _utf8Length(data)) : null;
  }
  if (data is String) return _boundedString(data, limit);
  if (data is FormData) {
    final sb = StringBuffer('multipart/form-data (boundary ${data.boundary})\n');
    for (final f in data.fields) {
      sb.writeln('${f.key}=${f.value}');
    }
    for (final f in data.files) {
      sb.writeln('${f.key}: ${f.value.filename ?? 'file'} (${f.value.length} bytes)');
    }
    return _boundedString(sb.toString(), limit);
  }
  if (data is Map && (contentType ?? '').contains('x-www-form-urlencoded')) {
    return _boundedString(
      Transformer.urlEncodeMap(<String, dynamic>{
        for (final e in data.entries) '${e.key}': e.value,
      }),
      limit,
    );
  }
  if (data is Map || data is List) {
    final sink = _CappedBytes(limit);
    try {
      JsonUtf8Encoder(null, null, math.min(limit, 64 * 1024))
          .startChunkedConversion(sink)
        ..add(data)
        ..close();
      final bytes = sink.takeBytes();
      return (bytes: bytes, size: bytes.length);
    } on _BodyLimitReached {
      return (bytes: sink.takeBytes(), size: null);
    } catch (_) {
      // Not JSON-encodable (custom objects): fall back to its text.
    }
  }
  String text;
  try {
    text = data.toString();
  } catch (_) {
    return null;
  }
  return _boundedString(text, limit);
}

/// UTF-8 of at most about [limit] bytes of [text] (a code unit is at least
/// one byte, so `limit` code units always fill the limit).
({List<int> bytes, int? size}) _boundedString(String text, int limit) {
  if (text.length <= limit) {
    final bytes = utf8.encode(text);
    return (bytes: bytes, size: bytes.length);
  }
  var end = limit;
  // Never split a surrogate pair.
  if (end > 0 && end < text.length && (text.codeUnitAt(end - 1) & 0xFC00) == 0xD800) {
    end--;
  }
  return (bytes: utf8.encode(text.substring(0, end)), size: _utf8Length(text));
}

/// UTF-8 length of [text] without encoding it.
int _utf8Length(String text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    final c = text.codeUnitAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if ((c & 0xFC00) == 0xD800 &&
        i + 1 < text.length &&
        (text.codeUnitAt(i + 1) & 0xFC00) == 0xDC00) {
      n += 4;
      i++;
    } else {
      n += 3;
    }
  }
  return n;
}

class _BodyLimitReached implements Exception {
  const _BodyLimitReached();
}

/// Collects encoder output up to [limit] bytes, then stops the encoder.
class _CappedBytes implements Sink<List<int>> {
  _CappedBytes(this.limit);

  final int limit;
  final BytesBuilder _bytes = BytesBuilder(copy: true);

  Uint8List takeBytes() => _bytes.takeBytes();

  @override
  void add(List<int> chunk) {
    final room = limit - _bytes.length;
    if (chunk.length <= room) {
      _bytes.add(chunk);
      return;
    }
    if (room > 0) _bytes.add(chunk.sublist(0, room));
    throw const _BodyLimitReached();
  }

  @override
  void close() {}
}
