import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'http_client.dart';
import 'response.dart';
import 'tracker.dart';

/// Wraps a real [HttpClientRequest]: forwards every member, copies the body
/// bytes written through `add`/`write*`/`addStream` (bounded) and reports the
/// request when it is closed.
class DurbunHttpClientRequest implements HttpClientRequest {
  DurbunHttpClientRequest(this._inner, this._tracker, this._client) {
    _tracker.headersSnapshot = () => headerPairs(_inner.headers, _tracker.recorder);
    _tracker.contentTypeSnapshot = () =>
        _inner.headers[HttpHeaders.contentTypeHeader]?.first;
  }

  final HttpClientRequest _inner;
  final RequestTracker _tracker;
  final DurbunHttpClient _client;
  Future<HttpClientResponse>? _done;

  /// The wrapped request (for diagnostics and tests).
  HttpClientRequest get inner => _inner;

  void _capture(List<int> data) {
    if (_tracker.aborted || _tracker.requestSent) return;
    try {
      _tracker.requestBody.add(data);
    } catch (_) {}
  }

  /* ───────────── HttpClientRequest ───────────── */

  @override
  bool get persistentConnection => _inner.persistentConnection;

  @override
  set persistentConnection(bool value) => _inner.persistentConnection = value;

  @override
  bool get followRedirects => _inner.followRedirects;

  @override
  set followRedirects(bool value) => _inner.followRedirects = value;

  @override
  int get maxRedirects => _inner.maxRedirects;

  @override
  set maxRedirects(int value) => _inner.maxRedirects = value;

  @override
  int get contentLength => _inner.contentLength;

  @override
  set contentLength(int value) => _inner.contentLength = value;

  @override
  bool get bufferOutput => _inner.bufferOutput;

  @override
  set bufferOutput(bool value) => _inner.bufferOutput = value;

  @override
  String get method => _inner.method;

  @override
  Uri get uri => _inner.uri;

  @override
  HttpHeaders get headers => _inner.headers;

  @override
  List<Cookie> get cookies => _inner.cookies;

  @override
  HttpConnectionInfo? get connectionInfo => _inner.connectionInfo;

  @override
  Future<HttpClientResponse> get done => _done ??= _inner.done.then(
    _wrapResponse,
    onError: (Object error, StackTrace stack) {
      _guard(() => _tracker.fail(error, cancelled: _tracker.aborted));
      Error.throwWithStackTrace(error, stack);
    },
  );

  HttpClientResponse _wrapResponse(HttpClientResponse response) {
    if (response is DurbunHttpClientResponse) return response;
    try {
      _tracker.markHeaders();
      return DurbunHttpClientResponse(
        response,
        _tracker,
        _client,
        requestMethod: _inner.method,
        requestUri: _inner.uri,
      );
    } catch (_) {
      return response;
    }
  }

  @override
  Future<HttpClientResponse> close() {
    // Throws synchronously (like dart:io) when e.g. a stream is still bound.
    _inner.close().ignore();
    _guard(_tracker.sendRequest);
    return done;
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {
    if (!_tracker.responseArrived && !_tracker.finished) {
      _tracker.markAborted();
      _guard(
        () => _tracker.fail(
          exception ?? const HttpException('Request has been aborted'),
          cancelled: true,
        ),
      );
    }
    _inner.abort(exception, stackTrace);
  }

  /* ───────────── IOSink ───────────── */

  @override
  Encoding get encoding => _inner.encoding;

  @override
  set encoding(Encoding value) => _inner.encoding = value;

  @override
  void add(List<int> data) {
    _inner.add(data);
    _capture(data);
  }

  @override
  void write(Object? object) {
    final string = '$object';
    if (string.isEmpty) return;
    // Same bytes dart:io would produce (encoding from the content-type
    // charset, ISO-8859-1 by default), written once and captured once.
    add(_inner.encoding.encode(string));
  }

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) {
    final iterator = objects.iterator;
    if (!iterator.moveNext()) return;
    if (separator.isEmpty) {
      do {
        write(iterator.current);
      } while (iterator.moveNext());
    } else {
      write(iterator.current);
      while (iterator.moveNext()) {
        write(separator);
        write(iterator.current);
      }
    }
  }

  @override
  void writeln([Object? object = '']) => write('$object\n');

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _inner.addError(error, stackTrace);

  @override
  Future<dynamic> addStream(Stream<List<int>> stream) => _inner.addStream(
    stream.map((chunk) {
      _capture(chunk);
      return chunk;
    }),
  );

  @override
  Future<dynamic> flush() => _inner.flush();

  /// Every member of the dart:io interface (Dart 3.10) is implemented above.
  /// A member added by a newer Dart SDK then fails at runtime (only if used)
  /// instead of breaking the compilation of every app using Dürbün.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw NoSuchMethodError.withInvocation(this, invocation);

  @override
  String toString() => _inner.toString();
}

void _guard(void Function() body) {
  try {
    body();
  } catch (_) {}
}
