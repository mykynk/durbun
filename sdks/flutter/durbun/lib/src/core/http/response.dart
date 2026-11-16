import 'dart:async';
import 'dart:io';

import '../body.dart';
import '../streams/sse_parser.dart';
import '../streams/stream_host.dart';
import '../streams/stream_reporter.dart';
import '../streams/ws_socket.dart';
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
///
/// Two long-lived kinds are reported as streams instead, while the desktop
/// takes stream messages (`config.captureStreams`):
/// - `text/event-stream`: the response is reported as soon as its headers
///   arrive, without a body; the bytes the app reads are parsed into
///   `net.sse` events, its end is `net.sse {end}`, a failure `net.error`, the
///   app stopping to read `net.error {cancelled}` (decided when the headers
///   arrive: a stream reported the usual way stays so);
/// - a 101 WebSocket upgrade: the socket [detachSocket] returns is teed and
///   its frames become `net.ws` messages from the moment the desktop takes
///   them (the tee is always there, so a setting turned on later applies to
///   open connections too).
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
    if (_startEventStream()) return;
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

  /// [detachSocket] tees this 101's socket: its frames are reported.
  bool _framesFollowed = false;

  /// Set while this is a `text/event-stream` reported as a stream.
  StreamReporter? _sse;
  SseParser? _sseParser;

  /// An event stream reported the usual way (the desktop does not take
  /// stream messages), followed for the in-app panel alone.
  StreamReporter? _localSse;
  SseParser? _localSseParser;

  /// Reports an event stream's headers now; false when this response is
  /// reported the usual way.
  bool _startEventStream() {
    try {
      final contentType = _inner.headers[HttpHeaders.contentTypeHeader]?.first;
      if (!isEventStreamContentType(contentType) || _compressedEncoding() != null) return false;
      final reporter = StreamReporter(_tracker.recorder, _tracker.id, mockRuleId: _tracker.mockRule?.id);
      // Only while the desktop takes stream messages; otherwise the response
      // is reported as it always was (with its body, at its end).
      if (!reporter.sending) {
        _followForPanel();
        return false;
      }
      reporter.markStarted();
      _finished = true;
      _sse = reporter;
      _sseParser = SseParser(reporter.sseEvent);
      _tracker.complete(
        status: _inner.statusCode,
        statusText: _inner.reasonPhrase,
        headers: headerPairs(_inner.headers, _tracker.recorder),
        remoteAddress: remoteAddressOf(_inner.connectionInfo),
        protocol: 'HTTP/1.1',
      );
      reporter.announce('sse');
      return true;
    } catch (_) {
      return false;
    }
  }

  /// While the in-app panel records: the event stream the desktop gets the
  /// usual way is parsed for the panel too (the desktop's copy is unchanged).
  void _followForPanel() {
    try {
      final local = StreamReporter(_tracker.recorder, _tracker.id, mockRuleId: _tracker.mockRule?.id, localOnly: true);
      if (local.localSink == null) return;
      _localSse = local;
      _localSseParser = SseParser(local.sseEvent);
      local.announce(
        'sse',
        status: _inner.statusCode,
        statusText: _inner.reasonPhrase,
        headers: headerPairs(_inner.headers, _tracker.recorder),
      );
    } catch (_) {
      _localSse = null;
      _localSseParser = null;
    }
  }

  /// The panel's copy of the event stream ends with the response.
  void _endLocalEventStream({Object? error, bool incomplete = false}) {
    final sse = _localSse;
    if (sse == null) return;
    _localSse = null;
    try {
      _localSseParser?.close();
      if (error != null) {
        sse.fail(error);
      } else if (incomplete) {
        sse.fail(const HttpException('The app stopped reading the event stream'), cancelled: true);
      } else {
        sse.sseEnd();
      }
    } catch (_) {}
  }

  /// The app aborted the request while reading the event stream.
  void appCancelled() {
    final sse = _sse;
    if (sse == null) return;
    try {
      _sseParser?.close();
      sse.fail(const HttpException('The app stopped reading the event stream'), cancelled: true);
    } catch (_) {}
  }

  void _sseChunk(List<int> chunk) {
    final parser = _sseParser;
    final sse = _sse;
    if (parser == null || sse == null || sse.ended) return;
    parser
      ..keepBytes = sse.wanted ? sse.cap : 0
      ..add(chunk);
  }

  StreamSubscription<List<int>> _listenEventStream(
    void Function(List<int> event)? onData,
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  ) {
    final sse = _sse!;
    // Cancelled in the controller's onCancel.
    // ignore: cancel_subscriptions
    StreamSubscription<List<int>>? source;
    var done = false;
    void guard(void Function() body) {
      try {
        body();
      } catch (_) {}
    }

    late final StreamController<List<int>> out;
    out = StreamController<List<int>>(
      sync: true,
      onListen: () {
        source = _inner.listen(
          (chunk) {
            guard(() => _sseChunk(chunk));
            out.add(chunk);
          },
          onError: (Object error, StackTrace stack) {
            guard(() {
              _sseParser?.close();
              sse.fail(error);
            });
            out.addError(error, stack);
          },
          onDone: () {
            done = true;
            guard(() {
              _sseParser?.close();
              sse.sseEnd();
            });
            out.close();
          },
        );
      },
      onPause: () => source?.pause(),
      onResume: () => source?.resume(),
      onCancel: () {
        final s = source;
        source = null;
        if (!done) {
          guard(() {
            _sseParser?.close();
            sse.fail(const HttpException('The app stopped reading the event stream'), cancelled: true);
          });
        }
        return s?.cancel();
      },
    );
    return out.stream.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  }

  /// The wrapped response (for diagnostics and tests).
  HttpClientResponse get inner => _inner;

  void _captureChunk(List<int> chunk) {
    if (_finished) return;
    try {
      _capture.add(chunk);
    } catch (_) {}
    final local = _localSse;
    if (local == null) return;
    try {
      _localSseParser!
        ..keepBytes = local.cap
        ..add(chunk);
    } catch (_) {}
  }

  void _finish({Object? error, bool incomplete = false, bool bodyUnread = false}) {
    if (_finished) return;
    _finished = true;
    _unconsumedTimer?.cancel();
    _endLocalEventStream(error: error, incomplete: incomplete || bodyUnread);
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
        noStream: _noStream(),
      );
    } catch (_) {}
  }

  /// A 101 whose frames are not followed (another protocol than WebSocket,
  /// or a capture host without stream support), while the desktop takes
  /// stream messages: it keeps the entry a plain response.
  bool _noStream() {
    if (_inner.statusCode != HttpStatus.switchingProtocols || _framesFollowed) return false;
    final r = _tracker.recorder;
    if (r is! StreamCaptureHost) return _tracker.recorder.networkEnabled;
    try {
      return (r as StreamCaptureHost).captureStreams;
    } catch (_) {
      return false;
    }
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
    if (!_listened && _sse != null) {
      _listened = true;
      return _listenEventStream(onData, onError, onDone, cancelOnError);
    }
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
    final capture = _webSocketCapture();
    _framesFollowed = capture != null && _tracker.recorder is StreamCaptureHost;
    _finish();
    if (capture != null) {
      try {
        final u = Uri.parse(_tracker.url);
        capture.reporter.announce('ws',
            url: u.scheme == 'http' || u.scheme == 'https' ? u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws').toString() : null);
      } catch (_) {}
    }
    final socket = _inner.detachSocket();
    if (capture == null) return socket;
    return socket.then<Socket>((s) {
      try {
        return WsSocketTee(s, capture);
      } catch (_) {
        return s;
      }
    });
  }

  /// A capture for the socket of a successful WebSocket upgrade, or null.
  WsCapture? _webSocketCapture() {
    try {
      if (_inner.statusCode != HttpStatus.switchingProtocols) return null;
      final upgrade = _inner.headers.value(HttpHeaders.upgradeHeader);
      if (upgrade == null || upgrade.trim().toLowerCase() != 'websocket') return null;
      final reporter = StreamReporter(_tracker.recorder, _tracker.id, mockRuleId: _tracker.mockRule?.id);
      if (!_tracker.recorder.networkEnabled) return null;
      return WsCapture(reporter, extensions: _inner.headers.value('sec-websocket-extensions'));
    } catch (_) {
      return null;
    }
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
