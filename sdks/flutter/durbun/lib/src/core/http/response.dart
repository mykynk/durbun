import 'dart:async';
import 'dart:io';

import '../body.dart';
import 'http_client.dart';
import 'tracker.dart';

/// Tuning knobs (exposed for tests).
abstract final class DurbunHttpTuning {
  /// A response whose body is never listened to is reported (without body,
  /// ending when its headers arrived) after this delay. Until then the
  /// capture stays armed: a body read late is still reported in full.
  static Duration unconsumedResponseDelay = const Duration(seconds: 60);
}

/// Wraps a real [HttpClientResponse]: the body stream is teed into a bounded
/// capture buffer while the app consumes it untouched (same chunk objects,
/// same pause/resume/cancel semantics). Reported when the body ends, fails,
/// is cancelled, detached, redirected or never listened to.
class DurbunHttpClientResponse extends Stream<List<int>>
    implements HttpClientResponse {
  DurbunHttpClientResponse(
    this._inner,
    this._tracker,
    this._client, {
    required this.requestMethod,
    required this.requestUri,
  }) : _capture = BodyCapture(
         limit: _tracker.recorder.maxBodyBytes,
         enabled: _tracker.recorder.captureBodies,
       ) {
    // A body nobody reads is still reported; bodyless responses (HEAD, 204,
    // 304, content-length: 0) are often never listened to, so report them
    // almost immediately.
    final bodyless =
        requestMethod == 'HEAD' ||
        _inner.statusCode == HttpStatus.noContent ||
        _inner.statusCode == HttpStatus.notModified ||
        _inner.contentLength == 0;
    _unconsumedTimer = _client.startInternalTimer(
      bodyless
          ? const Duration(milliseconds: 100)
          : DurbunHttpTuning.unconsumedResponseDelay,
      () {
        if (!_listened) _finish(bodyUnread: true);
      },
    );
  }

  final HttpClientResponse _inner;
  final RequestTracker _tracker;
  final DurbunHttpClient _client;
  final String requestMethod;
  final Uri requestUri;
  final BodyCapture _capture;
  Timer? _unconsumedTimer;
  bool _listened = false;
  bool _finished = false;

  /// The wrapped response (for diagnostics and tests).
  HttpClientResponse get inner => _inner;

  void _captureChunk(List<int> chunk) {
    if (_finished) return;
    try {
      _capture.add(chunk);
    } catch (_) {}
  }

  void _finish({Object? error, bool incomplete = false, bool bodyUnread = false}) {
    if (_finished) return;
    _finished = true;
    _unconsumedTimer?.cancel();
    try {
      final contentType = _inner.headers[HttpHeaders.contentTypeHeader]?.first;
      final body = _capture.toPending(
        contentType: contentType,
        contentEncoding: _compressedEncoding(),
        incomplete: incomplete,
      );
      _tracker.complete(
        status: _inner.statusCode,
        statusText: _inner.reasonPhrase,
        headers: headerPairs(_inner.headers, _tracker.recorder),
        body: body,
        remoteAddress: remoteAddressOf(_inner.connectionInfo),
        protocol: 'HTTP/1.1',
        thenError: error,
        bodyUnread: bodyUnread,
      );
    } catch (_) {}
  }

  /// Non-null when the bytes the app receives are still compressed.
  String? _compressedEncoding() {
    if (_inner.compressionState ==
        HttpClientResponseCompressionState.decompressed) {
      return null;
    }
    final ce = _inner.headers[HttpHeaders.contentEncodingHeader]?.join(',');
    if (ce == null) return null;
    final lower = ce.trim().toLowerCase();
    if (lower.isEmpty || lower == 'identity') return null;
    return lower;
  }

  /* ───────────── Stream ───────────── */

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    if (_listened || _finished) {
      return _inner.listen(
        onData,
        onError: onError,
        onDone: onDone,
        cancelOnError: cancelOnError,
      );
    }
    final tee = _TeeSubscription(this, onData, onError, onDone);
    tee._source = _inner.listen(
      tee._handleData,
      onError: tee._handleError,
      onDone: tee._handleDone,
      cancelOnError: cancelOnError,
    );
    _listened = true;
    _unconsumedTimer?.cancel();
    return tee;
  }

  /* ───────────── HttpClientResponse ───────────── */

  @override
  int get statusCode => _inner.statusCode;

  @override
  String get reasonPhrase => _inner.reasonPhrase;

  @override
  int get contentLength => _inner.contentLength;

  @override
  HttpClientResponseCompressionState get compressionState =>
      _inner.compressionState;

  @override
  bool get persistentConnection => _inner.persistentConnection;

  @override
  bool get isRedirect => _inner.isRedirect;

  @override
  List<RedirectInfo> get redirects => _inner.redirects;

  @override
  HttpHeaders get headers => _inner.headers;

  @override
  List<Cookie> get cookies => _inner.cookies;

  @override
  X509Certificate? get certificate => _inner.certificate;

  @override
  HttpConnectionInfo? get connectionInfo => _inner.connectionInfo;

  @override
  Future<Socket> detachSocket() {
    // e.g. WebSocket upgrade (101): report the handshake response now.
    _finish();
    return _inner.detachSocket();
  }

  @override
  Future<HttpClientResponse> redirect([
    String? method,
    Uri? url,
    bool? followLoops,
  ]) {
    _finish();
    RequestTracker? hop;
    try {
      final newMethod =
          method ??
          ((statusCode == HttpStatus.seeOther && requestMethod == 'POST')
              ? 'GET'
              : requestMethod);
      var target = url;
      if (target == null) {
        final location = _inner.headers[HttpHeaders.locationHeader]?.first;
        if (location != null) target = Uri.parse(location);
      }
      if (target != null && _tracker.recorder.networkEnabled) {
        final resolved = requestUri.resolveUri(target);
        final previousHeaders = _tracker.headersSnapshot;
        hop = RequestTracker(
          _tracker.recorder,
          method: newMethod.toUpperCase(),
          url: resolved.toString(),
        )..headersSnapshot = previousHeaders;
        hop.markOpened();
        hop.sendRequest();
      }
    } catch (_) {
      hop = null;
    }
    final hopTracker = hop;
    return _inner.redirect(method, url, followLoops).then(
      (response) {
        if (hopTracker == null || response is DurbunHttpClientResponse) {
          return response;
        }
        hopTracker.markHeaders();
        return DurbunHttpClientResponse(
          response,
          hopTracker,
          _client,
          requestMethod: response.redirects.isNotEmpty
              ? response.redirects.last.method
              : hopTracker.method,
          requestUri: Uri.parse(hopTracker.url),
        );
      },
      onError: (Object error, StackTrace stack) {
        try {
          hopTracker?.fail(error);
        } catch (_) {}
        Error.throwWithStackTrace(error, stack);
      },
    );
  }

  /// Every member of the dart:io interface (Dart 3.10) is implemented above.
  /// A member added by a newer Dart SDK then fails at runtime (only if used)
  /// instead of breaking the compilation of every app using Dürbün.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw NoSuchMethodError.withInvocation(this, invocation);

  @override
  String toString() => _inner.toString();
}

/// Subscription proxy: our handlers stay registered on the source so the
/// capture survives `onData`/`onError`/`onDone` replacement and `asFuture`.
class _TeeSubscription implements StreamSubscription<List<int>> {
  _TeeSubscription(this._owner, this._onData, this._onError, this._onDone);

  final DurbunHttpClientResponse _owner;
  late final StreamSubscription<List<int>> _source;
  void Function(List<int> data)? _onData;
  Function? _onError;
  void Function()? _onDone;

  void _handleData(List<int> data) {
    _owner._captureChunk(data);
    final handler = _onData;
    if (handler != null) handler(data);
  }

  void _handleError(Object error, StackTrace stack) {
    _owner._finish(error: error, incomplete: true);
    final handler = _onError;
    if (handler == null) {
      Zone.current.handleUncaughtError(error, stack);
    } else if (handler is void Function(Object, StackTrace)) {
      handler(error, stack);
    } else if (handler is void Function(Object)) {
      handler(error);
    } else {
      // ignore: avoid_dynamic_calls
      (handler as dynamic)(error, stack);
    }
  }

  void _handleDone() {
    _owner._finish();
    final handler = _onDone;
    if (handler != null) handler();
  }

  @override
  void onData(void Function(List<int> data)? handleData) => _onData = handleData;

  @override
  void onError(Function? handleError) => _onError = handleError;

  @override
  void onDone(void Function()? handleDone) => _onDone = handleDone;

  @override
  void pause([Future<void>? resumeSignal]) => _source.pause(resumeSignal);

  @override
  void resume() => _source.resume();

  @override
  bool get isPaused => _source.isPaused;

  @override
  Future<void> cancel() {
    final future = _source.cancel();
    // The app stopped reading: report what arrived so far.
    _owner._finish(incomplete: true);
    return future;
  }

  @override
  Future<E> asFuture<E>([E? futureValue]) {
    // Same contract as dart:async's implementation.
    final E resultValue;
    if (futureValue == null) {
      if (null is! E) throw ArgumentError.notNull('futureValue');
      resultValue = futureValue as E;
    } else {
      resultValue = futureValue;
    }
    final completer = Completer<E>();
    _onDone = () => completer.complete(resultValue);
    _onError = (Object error, StackTrace stack) {
      _source.cancel().whenComplete(() => completer.completeError(error, stack));
    };
    return completer.future;
  }
}
