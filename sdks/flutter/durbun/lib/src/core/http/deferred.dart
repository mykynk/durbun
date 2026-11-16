/// dart:io requests whose mock rule depends on the body (a rule limited to a
/// GraphQL operation): the decision is made once the body is written.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../mocks.dart';
import 'headers.dart';
import 'http_client.dart';

/// Returned by `openUrl` while a mock rule for the URL depends on the body.
/// Headers and body are collected like a real request would take them; at
/// `close()` (or as soon as the body grows past the matching bound, then the
/// body counts as unknown) the rule is chosen and [open] gives the request
/// that decision leads to: a mocked one, a real one, or a failure. Everything
/// written so far is replayed into it, and the app's later calls go to it.
/// Nothing is sent to the network before the decision.
class DeferredHttpClientRequest implements HttpClientRequest {
  DeferredHttpClientRequest({
    required this.method,
    required this.uri,
    required DurbunHttpClient client,
    required MockRule? Function(String? contentType, String? Function() body)
    decide,
    required Future<HttpClientRequest> Function(MockRule? rule) open,
  }) : _decide = decide,
       _open = open,
       _headers = DurbunHttpHeaders(
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
    // An error the decision leads to (a `fail` rule) may arrive before the app
    // listens; it still gets it from close() / done.
    _response.future.ignore();
  }

  @override
  final String method;

  @override
  final Uri uri;

  final MockRule? Function(String? contentType, String? Function() body)
  _decide;
  final Future<HttpClientRequest> Function(MockRule? rule) _open;
  final DurbunHttpHeaders _headers;
  final Completer<HttpClientResponse> _response =
      Completer<HttpClientResponse>();

  /// Body chunks written before the target request exists.
  final List<List<int>> _chunks = <List<int>>[];
  int _size = 0;
  bool _decided = false;
  bool _closeRequested = false;
  bool _aborted = false;
  bool _streaming = false;
  HttpClientRequest? _target;

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
  int get contentLength => _target?.contentLength ?? _headers.contentLength;

  @override
  set contentLength(int value) {
    final target = _target;
    if (target != null) {
      target.contentLength = value;
    } else {
      _headers.contentLength = value;
    }
  }

  @override
  HttpHeaders get headers => _target?.headers ?? _headers;

  @override
  HttpConnectionInfo? get connectionInfo => _target?.connectionInfo;

  @override
  Future<HttpClientResponse> get done => _response.future;

  @override
  Encoding get encoding {
    final charset = headers.contentType?.charset;
    return (charset == null ? null : Encoding.getByName(charset)) ?? latin1;
  }

  @override
  set encoding(Encoding value) =>
      throw StateError('IOSink encoding is not mutable');

  void _checkWritable() {
    if (_closeRequested) throw StateError('StreamSink is closed');
    if (_streaming) throw StateError('StreamSink is bound to a stream');
  }

  void _write(List<int> data) {
    if (_aborted || data.isEmpty) return;
    final target = _target;
    if (target != null) {
      target.add(data);
      return;
    }
    _chunks.add(List<int>.of(data));
    _size += data.length;
    // Past the bound the body cannot name the operation: decide now and keep
    // the rest flowing to whatever that decision opens.
    if (!_decided && _size > kMockGraphqlMaxBodyBytes) _decideNow(known: false);
  }

  @override
  void add(List<int> data) {
    _checkWritable();
    _write(data);
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
    final target = _target;
    if (target != null) {
      target.addError(error, stackTrace);
      return;
    }
    _fail(error, stackTrace ?? StackTrace.current);
  }

  @override
  Future<dynamic> addStream(Stream<List<int>> stream) {
    _checkWritable();
    _streaming = true;
    final completer = Completer<void>();
    stream.listen(
      _write,
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
    final target = _target;
    if (target != null) return target.flush();
    return Future<dynamic>.value(this);
  }

  @override
  Future<HttpClientResponse> close() {
    if (_streaming) throw StateError('StreamSink is bound to a stream');
    if (!_closeRequested && !_aborted) {
      _closeRequested = true;
      final target = _target;
      if (target != null) {
        _pipe(target.close());
      } else if (!_decided) {
        _decideNow(known: true);
      }
    }
    return done;
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {
    if (_response.isCompleted) return;
    _aborted = true;
    final target = _target;
    if (target != null) {
      target.abort(exception, stackTrace);
      return;
    }
    _chunks.clear();
    _response.completeError(
      exception ?? const HttpException('Request has been aborted'),
      stackTrace ?? StackTrace.empty,
    );
  }

  void _fail(Object error, StackTrace stack) {
    if (_response.isCompleted) return;
    _chunks.clear();
    _response.completeError(error, stack);
  }

  void _pipe(Future<HttpClientResponse> response) {
    response.then(
      (r) {
        if (!_response.isCompleted) _response.complete(r);
      },
      onError: (Object e, StackTrace st) {
        if (!_response.isCompleted) _response.completeError(e, st);
      },
    );
  }

  /// The body as the matcher reads it: text only when the whole body was
  /// collected, is within the bound and is UTF-8.
  String? _bodyText() {
    if (_size == 0) return null;
    final all = <int>[for (final c in _chunks) ...c];
    return mockBodyText(all);
  }

  void _decideNow({required bool known}) {
    _decided = true;
    MockRule? rule;
    try {
      rule = _decide(
        _headers[HttpHeaders.contentTypeHeader]?.first,
        known ? _bodyText : () => null,
      );
    } catch (_) {
      rule = null;
    }
    Future<HttpClientRequest> opening;
    try {
      opening = _open(rule);
    } catch (e, st) {
      opening = Future<HttpClientRequest>.error(e, st);
    }
    opening.then(_attach, onError: _fail);
  }

  /// The decision's request: takes the settings, headers and body written so
  /// far, then the app's later calls.
  void _attach(HttpClientRequest target) {
    if (_aborted || _response.isCompleted) {
      try {
        target.abort();
      } catch (_) {}
      return;
    }
    try {
      target
        ..persistentConnection = persistentConnection
        ..followRedirects = followRedirects
        ..maxRedirects = maxRedirects
        ..bufferOutput = bufferOutput;
      target.cookies.addAll(cookies);
      _copyHeaders(_headers, target.headers);
      if (_headers.contentLength >= 0) {
        target.contentLength = _headers.contentLength;
      }
      _target = target;
      for (final chunk in _chunks) {
        target.add(chunk);
      }
      _chunks.clear();
      if (_closeRequested) _pipe(target.close());
    } catch (e, st) {
      try {
        target.abort(e, st);
      } catch (_) {}
      _fail(e, st);
    }
  }

  /// Set by the target request itself (from its URI and its body).
  static const Set<String> _managed = <String>{
    HttpHeaders.hostHeader,
    HttpHeaders.contentLengthHeader,
    HttpHeaders.transferEncodingHeader,
  };

  /// Defaults a request starts with that the app may have removed.
  static const Set<String> _defaults = <String>{
    HttpHeaders.userAgentHeader,
    HttpHeaders.acceptEncodingHeader,
  };

  /// The app's headers onto [to]: a default the app removed is removed there
  /// too; the host, length and transfer encoding stay the target's business
  /// (the length is copied separately, only when the app set one).
  static void _copyHeaders(DurbunHttpHeaders from, HttpHeaders to) {
    final ours = <String>{};
    from.forEach((name, _) => ours.add(name.toLowerCase()));
    for (final name in _defaults) {
      if (!ours.contains(name)) to.removeAll(name);
    }
    from.forEach((name, values) {
      if (_managed.contains(name.toLowerCase())) return;
      to.set(name, values, preserveHeaderCase: true);
    });
    if (from.chunkedTransferEncoding) to.chunkedTransferEncoding = true;
  }

  /// Every member of the dart:io interface is implemented above; a member
  /// added by a newer Dart SDK fails at runtime only if used.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw NoSuchMethodError.withInvocation(this, invocation);
}
