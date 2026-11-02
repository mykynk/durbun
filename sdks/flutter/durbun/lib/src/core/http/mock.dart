/// Mocked dart:io requests: `respond` rules get a synthesized request /
/// response pair that never touches the network; `fail` rules raise the
/// platform's natural exceptions.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../body.dart';
import '../mocks.dart';
import '../protocol.dart';
import 'headers.dart';
import 'http_client.dart';
import 'recorder.dart';
import 'tracker.dart';

/// Exception a `fail` rule raises (what dart:io itself would throw).
Exception mockFailureException(
  MockAction action,
  Uri uri, {
  Duration? connectionTimeout,
}) {
  final host = uri.host;
  final port = uri.hasPort ? uri.port : (uri.isScheme('https') ? 443 : 80);
  final address = InternetAddress.tryParse(host);
  final darwin = Platform.isIOS || Platform.isMacOS;
  final custom = action.message;
  switch (action.error) {
    case 'timeout':
      if (connectionTimeout != null) {
        return SocketException(
          'HTTP connection timed out after $connectionTimeout, '
          'host: $host, port: $port',
        );
      }
      return SocketException(
        'Connection timed out',
        osError: OSError(custom ?? 'Connection timed out', darwin ? 60 : 110),
        address: address,
        port: port,
      );
    case 'dns':
      return SocketException(
        "Failed host lookup: '$host'",
        osError: OSError(
          custom ??
              (darwin
                  ? 'nodename nor servname provided, or not known'
                  : 'No address associated with hostname'),
          darwin ? 8 : 7,
        ),
      );
    case 'tls':
      return HandshakeException(
        'Handshake error in client',
        OSError(
          custom ??
              'CERTIFICATE_VERIFY_FAILED: unable to get local issuer '
                  'certificate(handshake.cc:393)',
          0,
        ),
      );
    case 'custom':
      return HttpException(custom ?? 'Simulated failure (Dürbün mock)', uri: uri);
    case 'connection':
    default:
      return SocketException(
        'Connection refused',
        osError: OSError(custom ?? 'Connection refused', darwin ? 61 : 111),
        address: address,
        port: port,
      );
  }
}

/// Request object returned for `respond` rules. Collects headers and body like
/// a real request (so they are reported), then answers locally.
class MockHttpClientRequest implements HttpClientRequest {
  MockHttpClientRequest({
    required this.method,
    required this.uri,
    required this.rule,
    required this.tracker,
    required this.client,
  }) : _headers = DurbunHttpHeaders(
         defaultPort: uri.isScheme('https') ? 443 : 80,
       ) {
    _headers.host = uri.host;
    if (uri.hasPort) _headers.port = uri.port;
    final userAgent = client.userAgent;
    if (userAgent != null) {
      _headers.set(HttpHeaders.userAgentHeader, userAgent);
    }
    if (client.autoUncompress) {
      _headers.set(HttpHeaders.acceptEncodingHeader, 'gzip');
    }
    if (method == 'GET' || method == 'HEAD') _headers.contentLength = 0;
    tracker.markOpened();
    tracker.headersSnapshot = () => _reportHeaders();
    tracker.contentTypeSnapshot = () =>
        _headers[HttpHeaders.contentTypeHeader]?.first;
  }

  @override
  final String method;

  @override
  final Uri uri;

  final MockRule rule;
  final RequestTracker tracker;
  final DurbunHttpClient client;
  final DurbunHttpHeaders _headers;
  final Completer<HttpClientResponse> _response = Completer<HttpClientResponse>();
  bool _closed = false;
  bool _aborted = false;
  bool _streaming = false;

  @override
  bool persistentConnection = true;

  @override
  bool followRedirects = true;

  @override
  int maxRedirects = 5;

  @override
  bool bufferOutput = true;

  @override
  final List<Cookie> cookies = <Cookie>[];

  @override
  int get contentLength => _headers.contentLength;

  @override
  set contentLength(int value) => _headers.contentLength = value;

  @override
  HttpHeaders get headers => _headers;

  @override
  HttpConnectionInfo? get connectionInfo => null;

  @override
  Future<HttpClientResponse> get done => _response.future;

  HeaderPairs _reportHeaders() {
    final pairs = <List<String>>[];
    _headers.forEach((name, values) {
      final redact = tracker.recorder.isRedactedHeader(name.toLowerCase());
      for (final v in values) {
        pairs.add(<String>[name, redact ? kRedactedValue : v]);
      }
    });
    if (cookies.isNotEmpty && _headers[HttpHeaders.cookieHeader] == null) {
      final redact = tracker.recorder.isRedactedHeader(HttpHeaders.cookieHeader);
      pairs.add(<String>[
        HttpHeaders.cookieHeader,
        redact
            ? kRedactedValue
            : cookies.map((c) => '${c.name}=${c.value}').join('; '),
      ]);
    }
    return pairs;
  }

  void _checkWritable() {
    if (_closed) throw StateError('StreamSink is closed');
    if (_streaming) throw StateError('StreamSink is bound to a stream');
  }

  @override
  Encoding get encoding {
    final charset = _headers.contentType?.charset;
    return (charset == null ? null : Encoding.getByName(charset)) ?? latin1;
  }

  @override
  set encoding(Encoding value) =>
      throw StateError('IOSink encoding is not mutable');

  @override
  void add(List<int> data) {
    _checkWritable();
    if (_aborted || data.isEmpty) return;
    tracker.requestBody.add(data);
  }

  @override
  void write(Object? object) {
    final string = '$object';
    if (string.isEmpty) return;
    add(encoding.encode(string));
  }

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) {
    var first = true;
    for (final o in objects) {
      if (!first && separator.isNotEmpty) write(separator);
      first = false;
      write(o);
    }
  }

  @override
  void writeln([Object? object = '']) => write('$object\n');

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  void addError(Object error, [StackTrace? stackTrace]) {
    _checkWritable();
    _fail(error, stackTrace ?? StackTrace.current);
  }

  @override
  Future<dynamic> addStream(Stream<List<int>> stream) {
    _checkWritable();
    _streaming = true;
    final completer = Completer<void>();
    stream.listen(
      (chunk) {
        if (!_aborted && chunk.isNotEmpty) tracker.requestBody.add(chunk);
      },
      onError: (Object e, StackTrace st) {
        _streaming = false;
        _fail(e, st);
        if (!completer.isCompleted) completer.completeError(e, st);
      },
      onDone: () {
        _streaming = false;
        if (!completer.isCompleted) completer.complete();
      },
      cancelOnError: true,
    );
    return completer.future;
  }

  @override
  Future<dynamic> flush() {
    if (_streaming) throw StateError('StreamSink is bound to a stream');
    return Future<dynamic>.value(this);
  }

  @override
  Future<HttpClientResponse> close() {
    if (_streaming) throw StateError('StreamSink is bound to a stream');
    if (!_closed && !_aborted) {
      _closed = true;
      try {
        tracker.sendRequest();
      } catch (_) {}
      _headers.freeze();
      unawaited(_respond());
    }
    return done;
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {
    if (_response.isCompleted) return;
    _aborted = true;
    final error = exception ?? const HttpException('Request has been aborted');
    tracker.markAborted();
    try {
      tracker.fail(error, cancelled: true);
    } catch (_) {}
    _response.completeError(error, stackTrace ?? StackTrace.empty);
  }

  void _fail(Object error, StackTrace stack) {
    if (_response.isCompleted) return;
    try {
      tracker.fail(error);
    } catch (_) {}
    _response.completeError(error, stack);
  }

  Future<void> _respond() async {
    final action = rule.action;
    if (action.delayMs > 0) {
      await Future<void>.delayed(Duration(milliseconds: action.delayMs));
    }
    if (_response.isCompleted) return; // aborted during the delay
    final MockHttpClientResponse response;
    try {
      response = MockHttpClientResponse.fromRule(
        rule,
        requestMethod: method,
        requestUri: uri,
        client: client,
      );
    } catch (e, st) {
      _fail(e, st);
      return;
    }
    tracker.markHeaders();
    try {
      tracker.complete(
        status: response.statusCode,
        statusText: response.reasonPhrase,
        headers: _redactedPairs(response.headers),
        body: response.pendingBody(tracker.recorder),
      );
    } catch (_) {}
    final location = response.headers[HttpHeaders.locationHeader]?.first;
    if (followRedirects && response.isRedirect && location != null) {
      // Follow like dart:io does for GET/HEAD (and POST + 303), through the
      // wrapped client so the next hop is reported (and may be mocked too).
      if (maxRedirects <= 0) {
        _response.completeError(
          RedirectException('Redirect limit exceeded', const <RedirectInfo>[]),
        );
        return;
      }
      try {
        final newMethod =
            (response.statusCode == HttpStatus.seeOther && method == 'POST')
            ? 'GET'
            : method;
        final target = uri.resolve(location);
        final next = await client.openUrl(newMethod, target);
        next
          ..followRedirects = followRedirects
          ..maxRedirects = maxRedirects - 1;
        final sameHost = target.host == uri.host;
        _headers.forEach((name, values) {
          final lower = name.toLowerCase();
          if (const {'host', 'content-length', 'transfer-encoding'}.contains(lower)) {
            return;
          }
          if (!sameHost &&
              const {'authorization', 'www-authenticate', 'cookie', 'cookie2'}
                  .contains(lower)) {
            return;
          }
          if (next.headers[name] == null) {
            for (final v in values) {
              next.headers.add(name, v, preserveHeaderCase: true);
            }
          }
        });
        _response.complete(await next.close());
      } catch (e, st) {
        if (!_response.isCompleted) _response.completeError(e, st);
      }
      return;
    }
    _response.complete(response);
  }

  HeaderPairs _redactedPairs(DurbunHttpHeaders h) {
    final out = <List<String>>[];
    h.forEach((name, values) {
      final redact = tracker.recorder.isRedactedHeader(name.toLowerCase());
      for (final v in values) {
        out.add(<String>[name, redact ? kRedactedValue : v]);
      }
    });
    return out;
  }

  /// Every member of the dart:io interface (Dart 3.10) is implemented above.
  /// A member added by a newer Dart SDK then fails at runtime (only if used)
  /// instead of breaking the compilation of every app using Dürbün.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw NoSuchMethodError.withInvocation(this, invocation);

  @override
  String toString() => 'MockHttpClientRequest($method $uri, rule ${rule.id})';
}

/// Response synthesized from a `respond` rule.
class MockHttpClientResponse extends Stream<List<int>>
    implements HttpClientResponse {
  MockHttpClientResponse._({
    required this.statusCode,
    required this.headers,
    required Uint8List body,
    required this.compressionState,
    required this.requestMethod,
    required this.requestUri,
    required this.client,
    required this.ruleId,
  }) : _body = body;

  factory MockHttpClientResponse.fromRule(
    MockRule rule, {
    required String requestMethod,
    required Uri requestUri,
    required DurbunHttpClient client,
  }) {
    final action = rule.action;
    var bytes = _decodeBody(action.body, action.bodyEncoding);
    final headers = DurbunHttpHeaders();
    for (final pair in action.headers) {
      try {
        headers.add(pair[0], pair[1], preserveHeaderCase: true);
      } catch (_) {}
    }
    if (headers[HttpHeaders.contentTypeHeader] == null && bytes.isNotEmpty) {
      headers.set(
        HttpHeaders.contentTypeHeader,
        _guessContentType(bytes, action.bodyEncoding),
      );
    }
    var compression = HttpClientResponseCompressionState.notCompressed;
    final encoding = headers[HttpHeaders.contentEncodingHeader]?.first
        .toLowerCase();
    if (encoding == 'gzip') {
      if (client.autoUncompress) {
        final decoded = tryDecompress(bytes, 'gzip');
        if (decoded != null) {
          bytes = decoded;
          compression = HttpClientResponseCompressionState.decompressed;
        }
      } else {
        compression = HttpClientResponseCompressionState.compressed;
      }
    }
    if (headers[HttpHeaders.contentLengthHeader] == null) {
      headers.contentLength = compression ==
              HttpClientResponseCompressionState.decompressed
          ? (_decodeBody(action.body, action.bodyEncoding).length)
          : bytes.length;
    }
    headers.set('x-durbun-mock', rule.label);
    headers.freeze();
    return MockHttpClientResponse._(
      statusCode: action.status,
      headers: headers,
      body: requestMethod == 'HEAD' ? Uint8List(0) : bytes,
      compressionState: compression,
      requestMethod: requestMethod,
      requestUri: requestUri,
      client: client,
      ruleId: rule.id,
    );
  }

  @override
  final int statusCode;

  @override
  final DurbunHttpHeaders headers;

  @override
  final HttpClientResponseCompressionState compressionState;

  final String requestMethod;
  final Uri requestUri;
  final DurbunHttpClient client;
  final String ruleId;
  final Uint8List _body;
  List<Cookie>? _cookies;

  /// Body as the app will receive it.
  Uint8List get bodyBytes => _body;

  PendingBody? pendingBody(NetworkRecorder recorder) {
    if (_body.isEmpty) return null;
    final capture = BodyCapture(
      limit: recorder.maxBodyBytes,
      enabled: recorder.captureBodies,
    )..add(_body);
    return capture.toPending(
      contentType: headers[HttpHeaders.contentTypeHeader]?.first,
      contentEncoding:
          compressionState == HttpClientResponseCompressionState.compressed
          ? 'gzip'
          : null,
    );
  }

  @override
  String get reasonPhrase => reasonPhraseFor(statusCode);

  @override
  int get contentLength => headers.contentLength;

  @override
  bool get persistentConnection => headers.persistentConnection;

  @override
  bool get isRedirect {
    if (requestMethod == 'GET' || requestMethod == 'HEAD') {
      return statusCode == HttpStatus.movedPermanently ||
          statusCode == HttpStatus.permanentRedirect ||
          statusCode == HttpStatus.found ||
          statusCode == HttpStatus.seeOther ||
          statusCode == HttpStatus.temporaryRedirect;
    } else if (requestMethod == 'POST') {
      return statusCode == HttpStatus.seeOther;
    }
    return false;
  }

  @override
  List<RedirectInfo> get redirects => const <RedirectInfo>[];

  @override
  Future<HttpClientResponse> redirect([
    String? method,
    Uri? url,
    bool? followLoops,
  ]) async {
    final newMethod =
        method ??
        ((statusCode == HttpStatus.seeOther && requestMethod == 'POST')
            ? 'GET'
            : requestMethod);
    var target = url;
    if (target == null) {
      final location = headers.value(HttpHeaders.locationHeader);
      if (location == null) {
        throw RedirectException(
          'Server response has no Location header for redirect',
          redirects,
        );
      }
      target = Uri.parse(location);
    }
    final resolved = requestUri.resolveUri(target);
    if (followLoops != true && resolved == requestUri) {
      throw RedirectException('Redirect loop detected', redirects);
    }
    final request = await client.openUrl(newMethod, resolved);
    return request.close();
  }

  @override
  List<Cookie> get cookies {
    final existing = _cookies;
    if (existing != null) return existing;
    final out = <Cookie>[];
    for (final value in headers[HttpHeaders.setCookieHeader] ?? const <String>[]) {
      try {
        out.add(Cookie.fromSetCookieValue(value));
      } catch (_) {}
    }
    return _cookies = out;
  }

  @override
  X509Certificate? get certificate => null;

  @override
  HttpConnectionInfo? get connectionInfo => null;

  @override
  Future<Socket> detachSocket() => Future<Socket>.error(
    const HttpException('Dürbün: a mocked response has no socket to detach'),
  );

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    const chunkSize = 64 * 1024;
    final chunks = <Uint8List>[
      for (var i = 0; i < _body.length; i += chunkSize)
        Uint8List.sublistView(
          _body,
          i,
          i + chunkSize > _body.length ? _body.length : i + chunkSize,
        ),
    ];
    return Stream<Uint8List>.fromIterable(chunks).listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  static Uint8List _decodeBody(String? body, String encoding) {
    if (body == null || body.isEmpty) return Uint8List(0);
    if (encoding == 'base64') {
      try {
        return base64Decode(body.replaceAll(RegExp(r'\s+'), ''));
      } catch (_) {
        // Not valid base64: send the text as-is.
      }
    }
    return utf8.encode(body);
  }

  static String _guessContentType(Uint8List bytes, String encoding) {
    if (encoding == 'base64' && !looksLikeText(bytes)) {
      return 'application/octet-stream';
    }
    final text = utf8.decode(bytes, allowMalformed: true).trimLeft();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        jsonDecode(text);
        return 'application/json; charset=utf-8';
      } catch (_) {}
    }
    if (text.startsWith('<')) {
      return text.toLowerCase().startsWith('<!doctype html') ||
              text.toLowerCase().startsWith('<html')
          ? 'text/html; charset=utf-8'
          : 'application/xml; charset=utf-8';
    }
    return 'text/plain; charset=utf-8';
  }

  /// Every member of the dart:io interface (Dart 3.10) is implemented above.
  /// A member added by a newer Dart SDK then fails at runtime (only if used)
  /// instead of breaking the compilation of every app using Dürbün.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw NoSuchMethodError.withInvocation(this, invocation);

  @override
  String toString() => 'MockHttpClientResponse($statusCode, rule $ruleId)';
}

/// Standard reason phrases (dart:io uses the same table).
String reasonPhraseFor(int status) => switch (status) {
  100 => 'Continue',
  101 => 'Switching Protocols',
  200 => 'OK',
  201 => 'Created',
  202 => 'Accepted',
  203 => 'Non-Authoritative Information',
  204 => 'No Content',
  205 => 'Reset Content',
  206 => 'Partial Content',
  300 => 'Multiple Choices',
  301 => 'Moved Permanently',
  302 => 'Found',
  303 => 'See Other',
  304 => 'Not Modified',
  305 => 'Use Proxy',
  307 => 'Temporary Redirect',
  308 => 'Permanent Redirect',
  400 => 'Bad Request',
  401 => 'Unauthorized',
  402 => 'Payment Required',
  403 => 'Forbidden',
  404 => 'Not Found',
  405 => 'Method Not Allowed',
  406 => 'Not Acceptable',
  407 => 'Proxy Authentication Required',
  408 => 'Request Time-out',
  409 => 'Conflict',
  410 => 'Gone',
  411 => 'Length Required',
  412 => 'Precondition Failed',
  413 => 'Request Entity Too Large',
  414 => 'Request-URI Too Long',
  415 => 'Unsupported Media Type',
  416 => 'Requested range not satisfiable',
  417 => 'Expectation Failed',
  418 => "I'm a teapot",
  422 => 'Unprocessable Entity',
  423 => 'Locked',
  424 => 'Failed Dependency',
  425 => 'Too Early',
  426 => 'Upgrade Required',
  428 => 'Precondition Required',
  429 => 'Too Many Requests',
  431 => 'Request Header Fields Too Large',
  451 => 'Unavailable For Legal Reasons',
  500 => 'Internal Server Error',
  501 => 'Not Implemented',
  502 => 'Bad Gateway',
  503 => 'Service Unavailable',
  504 => 'Gateway Time-out',
  505 => 'Http Version not supported',
  _ => 'Status $status',
};
