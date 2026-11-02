import 'dart:async';
import 'dart:io';

import '../mocks.dart';
import 'mock.dart';
import 'recorder.dart';
import 'request.dart';
import 'tracker.dart';

/// Recorder plus an internal zone for timers (provided by the SDK client).
abstract interface class HttpCaptureHost implements NetworkRecorder {
  /// Starts a timer outside the app's zones.
  Timer startTimer(Duration duration, void Function() callback);
}

/// Wraps a dart:io [HttpClient] (the real one or whatever a previous
/// [HttpOverrides] produced): every member is forwarded, requests are
/// reported, mock rules are applied.
class DurbunHttpClient implements HttpClient {
  DurbunHttpClient(this._inner, this._host);

  final HttpClient _inner;
  final HttpCaptureHost _host;

  /// The wrapped client.
  HttpClient get inner => _inner;

  NetworkRecorder get recorder => _host;

  Timer startInternalTimer(Duration duration, void Function() callback) =>
      _host.startTimer(duration, callback);

  /* ───────────── configuration (forwarded) ───────────── */

  @override
  Duration get idleTimeout => _inner.idleTimeout;

  @override
  set idleTimeout(Duration value) => _inner.idleTimeout = value;

  @override
  Duration? get connectionTimeout => _inner.connectionTimeout;

  @override
  set connectionTimeout(Duration? value) => _inner.connectionTimeout = value;

  @override
  int? get maxConnectionsPerHost => _inner.maxConnectionsPerHost;

  @override
  set maxConnectionsPerHost(int? value) => _inner.maxConnectionsPerHost = value;

  @override
  bool get autoUncompress => _inner.autoUncompress;

  @override
  set autoUncompress(bool value) => _inner.autoUncompress = value;

  @override
  String? get userAgent => _inner.userAgent;

  @override
  set userAgent(String? value) => _inner.userAgent = value;

  @override
  set authenticate(
    Future<bool> Function(Uri url, String scheme, String? realm)? f,
  ) => _inner.authenticate = f;

  @override
  void addCredentials(
    Uri url,
    String realm,
    HttpClientCredentials credentials,
  ) => _inner.addCredentials(url, realm, credentials);

  @override
  set connectionFactory(
    Future<ConnectionTask<Socket>> Function(
      Uri url,
      String? proxyHost,
      int? proxyPort,
    )?
    f,
  ) => _inner.connectionFactory = f;

  @override
  set findProxy(String Function(Uri url)? f) => _inner.findProxy = f;

  @override
  set authenticateProxy(
    Future<bool> Function(String host, int port, String scheme, String? realm)?
    f,
  ) => _inner.authenticateProxy = f;

  @override
  void addProxyCredentials(
    String host,
    int port,
    String realm,
    HttpClientCredentials credentials,
  ) => _inner.addProxyCredentials(host, port, realm, credentials);

  @override
  set badCertificateCallback(
    bool Function(X509Certificate cert, String host, int port)? callback,
  ) => _inner.badCertificateCallback = callback;

  @override
  set keyLog(Function(String line)? callback) => _inner.keyLog = callback;

  @override
  void close({bool force = false}) => _inner.close(force: force);

  /* ───────────── requests ───────────── */

  @override
  Future<HttpClientRequest> open(
    String method,
    String host,
    int port,
    String path,
  ) => _intercept(
    method,
    _uriForOpen(host, port, path),
    () => _inner.open(method, host, port, path),
  );

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) =>
      _intercept(method, url, () => _inner.openUrl(method, url));

  @override
  Future<HttpClientRequest> get(String host, int port, String path) =>
      _intercept(
        'GET',
        _uriForOpen(host, port, path),
        () => _inner.get(host, port, path),
      );

  @override
  Future<HttpClientRequest> getUrl(Uri url) =>
      _intercept('GET', url, () => _inner.getUrl(url));

  @override
  Future<HttpClientRequest> post(String host, int port, String path) =>
      _intercept(
        'POST',
        _uriForOpen(host, port, path),
        () => _inner.post(host, port, path),
      );

  @override
  Future<HttpClientRequest> postUrl(Uri url) =>
      _intercept('POST', url, () => _inner.postUrl(url));

  @override
  Future<HttpClientRequest> put(String host, int port, String path) =>
      _intercept(
        'PUT',
        _uriForOpen(host, port, path),
        () => _inner.put(host, port, path),
      );

  @override
  Future<HttpClientRequest> putUrl(Uri url) =>
      _intercept('PUT', url, () => _inner.putUrl(url));

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) =>
      _intercept(
        'DELETE',
        _uriForOpen(host, port, path),
        () => _inner.delete(host, port, path),
      );

  @override
  Future<HttpClientRequest> deleteUrl(Uri url) =>
      _intercept('DELETE', url, () => _inner.deleteUrl(url));

  @override
  Future<HttpClientRequest> patch(String host, int port, String path) =>
      _intercept(
        'PATCH',
        _uriForOpen(host, port, path),
        () => _inner.patch(host, port, path),
      );

  @override
  Future<HttpClientRequest> patchUrl(Uri url) =>
      _intercept('PATCH', url, () => _inner.patchUrl(url));

  @override
  Future<HttpClientRequest> head(String host, int port, String path) =>
      _intercept(
        'HEAD',
        _uriForOpen(host, port, path),
        () => _inner.head(host, port, path),
      );

  @override
  Future<HttpClientRequest> headUrl(Uri url) =>
      _intercept('HEAD', url, () => _inner.headUrl(url));

  /// Same URI dart:io builds in `HttpClient.open` (scheme http, query split
  /// at the first `?`, fragment dropped).
  static Uri? _uriForOpen(String host, int port, String path) {
    try {
      var fragmentStart = path.length;
      var queryStart = path.length;
      for (var i = path.length - 1; i >= 0; i--) {
        final char = path.codeUnitAt(i);
        if (char == 0x23) {
          fragmentStart = i;
          queryStart = i;
        } else if (char == 0x3f) {
          queryStart = i;
        }
      }
      String? query;
      var p = path;
      if (queryStart < fragmentStart) {
        query = path.substring(queryStart + 1, fragmentStart);
        p = path.substring(0, queryStart);
      }
      return Uri(scheme: 'http', host: host, port: port, path: p, query: query);
    } catch (_) {
      return null;
    }
  }

  Future<HttpClientRequest> _intercept(
    String method,
    Uri? uri,
    Future<HttpClientRequest> Function() opener,
  ) {
    bool enabled;
    try {
      enabled = uri != null && _host.networkEnabled;
    } catch (_) {
      enabled = false;
    }
    if (!enabled) return opener();
    final m = method.toUpperCase();
    final u = uri!.removeFragment();
    Future<void>? ready;
    try {
      ready = _host.mocksReady;
    } catch (_) {
      ready = null;
    }
    if (ready != null) {
      return ready.then((_) => _dispatch(m, u, opener));
    }
    return _dispatch(m, u, opener);
  }

  Future<HttpClientRequest> _dispatch(
    String method,
    Uri uri,
    Future<HttpClientRequest> Function() opener,
  ) {
    MockRule? rule;
    try {
      rule = _host.matchMock(method, uri.toString());
    } catch (_) {
      rule = null;
    }
    if (rule == null) return _openReal(method, uri, opener, null);
    final action = rule.action;
    if (action.isRespond) {
      final tracker = RequestTracker(
        _host,
        method: method,
        url: uri.toString(),
        mockRule: rule,
      );
      return Future<HttpClientRequest>.value(
        MockHttpClientRequest(
          method: method,
          uri: uri,
          rule: rule,
          tracker: tracker,
          client: this,
        ),
      );
    }
    final tracker = RequestTracker(
      _host,
      method: method,
      url: uri.toString(),
      mockRule: rule,
    );
    final delay = Duration(milliseconds: action.delayMs);
    if (action.isDelay) {
      tracker.injectedDelayUs = delay.inMicroseconds;
      return Future<void>.delayed(
        delay,
      ).then((_) => _openReal(method, uri, opener, rule, tracker: tracker));
    }
    // fail
    final ruleForError = rule;
    return Future<void>.delayed(delay).then<HttpClientRequest>((_) {
      final error = mockFailureException(
        ruleForError.action,
        uri,
        connectionTimeout: _inner.connectionTimeout,
      );
      try {
        tracker.fail(error);
      } catch (_) {}
      throw error;
    });
  }

  Future<HttpClientRequest> _openReal(
    String method,
    Uri uri,
    Future<HttpClientRequest> Function() opener,
    MockRule? rule, {
    RequestTracker? tracker,
  }) {
    RequestTracker t;
    try {
      t =
          tracker ??
          RequestTracker(_host, method: method, url: uri.toString(), mockRule: rule);
    } catch (_) {
      return opener();
    }
    final Future<HttpClientRequest> future;
    try {
      future = opener();
    } catch (e) {
      try {
        t.fail(e);
      } catch (_) {}
      rethrow;
    }
    return future.then<HttpClientRequest>(
      (request) {
        try {
          t.markOpened();
          return DurbunHttpClientRequest(request, t, this);
        } catch (_) {
          return request;
        }
      },
      onError: (Object error, StackTrace stack) {
        try {
          t.fail(error);
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
  String toString() => 'DurbunHttpClient($_inner)';
}

/// Installs [DurbunHttpClient] for every dart:io `HttpClient()` created on
/// this isolate, chaining whatever overrides were there before.
class DurbunHttpOverrides extends HttpOverrides {
  DurbunHttpOverrides(this.host, {this.previous});

  final HttpCaptureHost host;

  /// The overrides that were current when this one was installed.
  final HttpOverrides? previous;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final inner =
        previous?.createHttpClient(context) ?? super.createHttpClient(context);
    if (inner is DurbunHttpClient) return inner;
    return DurbunHttpClient(inner, host);
  }

  @override
  String findProxyFromEnvironment(Uri url, Map<String, String>? environment) {
    final prev = previous;
    if (prev != null) return prev.findProxyFromEnvironment(url, environment);
    return super.findProxyFromEnvironment(url, environment);
  }

  /// The global overrides (what the root zone sees).
  static HttpOverrides? get currentGlobal =>
      Zone.root.run(() => HttpOverrides.current);

  /// Installs (or re-installs, when the app replaced them) the overrides for
  /// [host]. Returns true when something changed.
  static bool ensureInstalled(HttpCaptureHost host) {
    final current = currentGlobal;
    if (current is DurbunHttpOverrides) {
      if (identical(current.host, host)) return false;
      HttpOverrides.global = DurbunHttpOverrides(host, previous: current.previous);
      return true;
    }
    HttpOverrides.global = DurbunHttpOverrides(host, previous: current);
    return true;
  }

  /// Removes our overrides for [host] (restoring the previous ones).
  static void uninstall(HttpCaptureHost host) {
    final current = currentGlobal;
    if (current is DurbunHttpOverrides && identical(current.host, host)) {
      HttpOverrides.global = current.previous;
    }
  }
}
