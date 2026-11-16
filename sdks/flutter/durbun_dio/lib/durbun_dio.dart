/// Dürbün reporting for Dio.
///
/// Only needed when Dio uses an adapter that bypasses dart:io (e.g.
/// `NativeAdapter` from native_dio_adapter, cupertino_http, cronet_http).
/// Dio's default `IOHttpClientAdapter` is already captured by `package:durbun`,
/// and on iOS so is every URLSession-based adapter (the plugin's native layer).
///
/// Recommended: wrap the adapter. Every request that reaches the network is
/// reported (retries too), with the response bytes as the adapter delivered
/// them and the time until the last byte:
///
/// ```dart
/// final dio = Dio()..httpClientAdapter = DurbunDioAdapter(NativeAdapter());
/// ```
///
/// Server-Sent Events (`text/event-stream` with `ResponseType.stream`) are
/// reported as a stream: the response as soon as its headers arrive, then
/// one message per event while Dio's stream is read.
///
/// The older interceptor still works; add it last:
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

/// Wraps a Dio [HttpClientAdapter] and reports every request it sends to
/// Dürbün; applies the desktop's mock rules (`respond` → answered without a
/// network call, `delay` → waits, `fail` → the matching [DioException]).
///
/// Unlike [DurbunDioInterceptor] it sits where the request leaves the app,
/// so what other interceptors do does not matter:
/// - every request that reaches the network gets its own row and every row
///   ends (retries after a token refresh included);
/// - the request headers are the final ones (after every interceptor);
/// - the response body is the bytes the adapter delivered (not Dio's decoded
///   data encoded again), and its size is the number of those bytes;
/// - the duration runs until the last byte, before Dio's JSON decoding.
///
/// ```dart
/// final dio = Dio()..httpClientAdapter = DurbunDioAdapter(NativeAdapter());
/// ```
///
/// A [DurbunDioInterceptor] on the same Dio stays out of the way, so it is
/// safe to keep one while switching.
class DurbunDioAdapter implements HttpClientAdapter {
  /// Reports every request [inner] makes; [source] names the client on the
  /// desktop and in the panel.
  DurbunDioAdapter(this.inner, {this.source = 'dio'});

  /// The adapter that does the network work (`NativeAdapter`, …).
  final HttpClientAdapter inner;

  /// `net.request.source` shown on the desktop.
  final String source;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    _Report? report;
    DurbunMockDecision? mock;
    try {
      if (Durbun.isEnabled && !_leftToOtherLayers(inner)) {
        mock = DurbunNetwork.findMock(options.method, options.uri);
        final call = _beginCall(options, mock, source);
        if (call != null) report = _Report(call);
      }
    } catch (_) {
      // Never break the app's networking because of Dürbün.
    }
    final r = report;
    if (r != null && cancelFuture != null) {
      unawaited(
        cancelFuture.then(
          (_) => r.error(const _Cancelled(), cancelled: true),
          onError: (Object _) {},
        ),
      );
    }
    if (mock != null) {
      if (mock.delay > Duration.zero) await Future<void>.delayed(mock.delay);
      if (mock.type == 'fail') {
        final error = _mockFailure(options, mock);
        r?.error(error);
        throw error;
      }
      if (mock.type != 'delay') {
        final headers = _mockHeaders(mock);
        final bytes = Uint8List.fromList(mock.body);
        r?.done(
          status: mock.status,
          statusText: _reasonPhrase(mock.status),
          headers: headers,
          body: bytes,
          size: bytes.length,
        );
        return ResponseBody.fromBytes(
          bytes,
          mock.status,
          statusMessage: _reasonPhrase(mock.status),
          headers: headers,
        )..extra = <String, dynamic>{'durbun.mockRuleId': mock.ruleId};
      }
    }
    final ResponseBody body;
    try {
      body = await inner.fetch(options, requestStream, cancelFuture);
    } catch (e) {
      r?.error(e, cancelled: e is DioException && e.type == DioExceptionType.cancel);
      rethrow;
    }
    if (r != null) {
      try {
        _watchBody(body, options, r);
      } catch (_) {
        r.done(status: body.statusCode, statusText: body.statusMessage, headers: body.headers);
      }
    }
    return body;
  }

  @override
  void close({bool force = false}) => inner.close(force: force);
}

/// Reports the response once its body has been read to the end (the bytes
/// are kept up to the body limit while they stream through to Dio).
void _watchBody(ResponseBody body, RequestOptions options, _Report report) {
  final declared = int.tryParse(_header(body.headers, 'content-length') ?? '');
  final encoding = _header(body.headers, 'content-encoding');
  // The declared length counts the bytes on the wire; it matches what the
  // adapter delivers only when nothing was decompressed.
  final declaredSize =
      declared != null && declared >= 0 && (encoding == null || encoding == 'identity')
          ? declared
          : null;
  final willRead = options.validateStatus(body.statusCode) ||
      options.receiveDataWhenStatusError == true;
  if (willRead && _isEventStream(body.headers)) {
    final events = report.eventStream(body);
    if (events != null) {
      body.stream = events.tap(body.stream);
      return;
    }
  }
  if (!willRead) {
    // Dio drops the body of this error status without reading it.
    report.done(
      status: body.statusCode,
      statusText: body.statusMessage,
      headers: body.headers,
      size: declaredSize,
    );
    return;
  }
  final limit = _bodyLimit();
  final kept = BytesBuilder();
  var size = 0;
  body.stream = _tap(
    body.stream,
    onData: (chunk) {
      size += chunk.length;
      final room = limit - kept.length;
      if (room <= 0) return;
      kept.add(chunk.length <= room ? chunk : Uint8List.sublistView(chunk, 0, room));
    },
    onDone: () => report.done(
      status: body.statusCode,
      statusText: body.statusMessage,
      headers: body.headers,
      body: kept.takeBytes(),
      size: size,
    ),
    onError: (Object e) => report.error(e),
    onCancel: () => report.error(const _NotReadToTheEnd()),
  );
}

/// [source] passed through unchanged, with a callback for each event and
/// for a reader that stops before the end. Listens only when Dio listens and
/// follows its pauses (no extra buffering).
Stream<Uint8List> _tap(
  Stream<Uint8List> source, {
  required void Function(Uint8List chunk) onData,
  required void Function() onDone,
  required void Function(Object error) onError,
  required void Function() onCancel,
}) {
  StreamSubscription<Uint8List>? sub;
  var finished = false;
  late final StreamController<Uint8List> out;
  void safe(void Function() f) {
    try {
      f();
    } catch (_) {}
  }

  out = StreamController<Uint8List>(
    sync: true,
    onListen: () {
      sub = source.listen(
        (chunk) {
          safe(() => onData(chunk));
          out.add(chunk);
        },
        onError: (Object e, StackTrace st) {
          safe(() => onError(e));
          out.addError(e, st);
        },
        onDone: () {
          finished = true;
          safe(onDone);
          out.close();
        },
      );
    },
    onPause: () => sub?.pause(),
    onResume: () => sub?.resume(),
    onCancel: () {
      final s = sub;
      sub = null;
      if (!finished) safe(onCancel);
      return s?.cancel();
    },
  );
  return out.stream;
}

/// One request's report: ends exactly once.
class _Report {
  _Report(this.call);

  final DurbunHttpCall call;
  bool _ended = false;

  /// Set once an event stream's headers were reported.
  DurbunEventStreamCall? _events;

  /// Reports [body]'s headers as an event stream; null when the desktop
  /// does not take stream messages (report the body as usual then).
  DurbunEventStreamCall? eventStream(ResponseBody body) {
    if (_ended) return null;
    try {
      final events = call.eventStream(
        status: body.statusCode,
        statusText: body.statusMessage,
        headers: _pairs(body.headers),
      );
      if (events != null) {
        _ended = true;
        _events = events;
      }
      return events;
    } catch (_) {
      return null;
    }
  }

  void done({
    required int status,
    String? statusText,
    required Map<String, List<String>> headers,
    List<int>? body,
    int? size,
  }) {
    if (_ended) return;
    _ended = true;
    try {
      call.response(
        status: status,
        statusText: statusText,
        headers: _pairs(headers),
        body: body,
        bodySize: size,
        contentType: _header(headers, 'content-type'),
      );
    } catch (_) {}
  }

  void error(Object error, {bool cancelled = false}) {
    final events = _events;
    if (events != null) {
      // A cancel token fired while the event stream was read.
      _events = null;
      try {
        events.error(error, cancelled: cancelled);
      } catch (_) {}
      return;
    }
    if (_ended) return;
    _ended = true;
    try {
      call.error(error, cancelled: cancelled);
    } catch (_) {}
  }
}

class _Cancelled {
  const _Cancelled();

  @override
  String toString() => 'The request was cancelled';
}

class _NotReadToTheEnd {
  const _NotReadToTheEnd();

  @override
  String toString() =>
      'The response body was not read to the end (receive timeout, cancel, '
      'or the app stopped reading it)';
}

class _HandledElsewhere {
  const _HandledElsewhere();

  @override
  String toString() =>
      'Another interceptor handled this response before Dürbün saw it and '
      'sent the request again. Use DurbunDioAdapter to see every response.';
}

List<List<String>> _pairs(Map<String, List<String>> headers) => <List<String>>[
  for (final e in headers.entries)
    for (final v in e.value) <String>[e.key, v],
];

/// Whether the response is `text/event-stream`.
bool _isEventStream(Map<String, List<String>> headers) {
  final type = _header(headers, 'content-type');
  if (type == null) return false;
  return type.split(';').first.trim().toLowerCase() == 'text/event-stream';
}

/// Value of header [name] (any case), first one.
String? _header(Map<String, List<String>> headers, String name) {
  for (final e in headers.entries) {
    if (e.key.toLowerCase() == name && e.value.isNotEmpty) return e.value.first;
  }
  return null;
}

/// Adapters whose traffic another Dürbün layer already reports (and mocks):
/// dart:io (package:durbun) and, on iOS with the plugin, URLSession-based
/// ones. Matched by name for the latter (no dependency on
/// native_dio_adapter): in `--obfuscate` builds the names are minified, so
/// such requests are reported by both layers rather than risk losing them.
bool _leftToOtherLayers(HttpClientAdapter adapter) {
  if (usesDartIoHttpClient(adapter) && DurbunNetwork.capturesDartIo) return true;
  if (!DurbunNetwork.capturesUrlSession) return false;
  final name = adapter.runtimeType.toString();
  return name == 'NativeAdapter' || name == 'CupertinoAdapter';
}

/// Reports Dio requests to Dürbün and applies its mock rules
/// (`respond` → resolved without a network call, `delay` → waits, `fail` →
/// the matching [DioException]: connectionTimeout / connectionError /
/// badCertificate / unknown).
///
/// Add it as the last interceptor: headers and body are taken as the
/// interceptors before it left the request.
///
/// It only sees what reaches it. When an interceptor before it answers an
/// error itself (the usual token refresh: `handler.resolve(await
/// dio.fetch(err.requestOptions))`), the first row ends when the request is
/// sent again, with a note instead of the response it never saw; the body
/// shown is Dio's decoded data encoded again. [DurbunDioAdapter] has none of
/// these limits and is the recommended setup.
class DurbunDioInterceptor extends Interceptor {
  /// An interceptor for [dio]; add it as the last one
  /// (`dio.interceptors.add(DurbunDioInterceptor(dio: dio))`).
  DurbunDioInterceptor({required this.dio, this.source = 'dio'});

  /// The Dio instance this interceptor is added to. While it uses the
  /// dart:io adapter (Dio's default), package:durbun's dart:io capture
  /// already reports — and mocks — its requests, so this interceptor stays
  /// out of the way (no duplicates, no double delays). The same holds for a
  /// [DurbunDioAdapter].
  final Dio dio;

  /// `net.request.source` shown on the desktop.
  final String source;

  static const String _callKey = 'durbun.call';

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    var handled = false;
    try {
      // The same options sent again (a retry from another interceptor):
      // the earlier row ends here instead of staying open.
      final earlier = options.extra.remove(_callKey);
      if (earlier is DurbunHttpCall) {
        earlier.error(const _HandledElsewhere());
      }
      final adapter = dio.httpClientAdapter;
      if (!Durbun.isEnabled ||
          adapter is DurbunDioAdapter ||
          _leftToOtherLayers(adapter)) {
        handled = true;
        handler.next(options);
        return;
      }
      final mock = DurbunNetwork.findMock(options.method, options.uri);
      final call = _beginCall(options, mock, source);
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
          final error = _mockFailure(options, mock);
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
    if (call is DurbunHttpCall) {
      final data = response.data;
      final events = data is ResponseBody && _isEventStream(data.headers)
          ? _eventStream(call, data)
          : null;
      if (events != null) {
        data as ResponseBody;
        data.stream = events.tap(data.stream);
      } else {
        _reportResponse(call, response);
      }
    }
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

  static DurbunEventStreamCall? _eventStream(DurbunHttpCall call, ResponseBody body) {
    try {
      return call.eventStream(
        status: body.statusCode,
        statusText: body.statusMessage,
        headers: _pairs(body.headers),
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
    final map = _mockHeaders(mock);
    final bytes = Uint8List.fromList(mock.body);
    final text = utf8.decode(bytes, allowMalformed: true);
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
}

/// Starts the report for [options] as it leaves (headers, body up to the
/// limit). Null when the SDK is off or anything goes wrong.
DurbunHttpCall? _beginCall(
  RequestOptions options,
  DurbunMockDecision? mock,
  String source,
) {
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
int _bodyLimit() =>
    DurbunNetwork.captureBodies ? DurbunNetwork.maxBodyBytes + 1 : 0;

/// The mock's headers (lower-case names), with a content type guessed from
/// the body when the rule has none, and `x-durbun-mock`.
Map<String, List<String>> _mockHeaders(DurbunMockDecision mock) {
  final map = <String, List<String>>{};
  for (final h in mock.headers) {
    if (h.length >= 2) (map[h[0].toLowerCase()] ??= <String>[]).add(h[1]);
  }
  map.putIfAbsent('content-type', () {
    final trimmed = utf8.decode(mock.body, allowMalformed: true).trimLeft();
    return <String>[
      trimmed.startsWith('{') || trimmed.startsWith('[')
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8',
    ];
  });
  map['x-durbun-mock'] = <String>[mock.ruleLabel];
  return map;
}

DioException _mockFailure(RequestOptions options, DurbunMockDecision mock) {
  final message = mock.message;
  switch (mock.failure) {
    case 'timeout':
      return DioException.connectionTimeout(
        timeout: options.connectTimeout ?? mock.delay,
        requestOptions: options,
        error: message,
      );
    case 'tls':
      // Same as DioException.badCertificate, which only exists from dio 5.5.0 (this package allows 5.4).
      return DioException(
        requestOptions: options,
        type: DioExceptionType.badCertificate,
        error: message ?? 'CERTIFICATE_VERIFY_FAILED (Dürbün mock)',
        message: 'The certificate of the response is not approved.',
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

String _reasonPhrase(int status) => switch (status) {
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
