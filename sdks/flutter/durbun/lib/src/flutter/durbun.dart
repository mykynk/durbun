import 'dart:async';

import '../core/options.dart';
import '../core/types.dart';
import '../inspector/inspector.dart';
import 'backend.dart';
import 'backend_stub.dart'
    if (dart.library.io) 'backend_io.dart'
    as backend;

/// Dürbün SDK entry point.
///
/// ```dart
/// Future<void> main() async {
///   await Durbun.run(() async {
///     WidgetsFlutterBinding.ensureInitialized();
///     runApp(const MyApp());
///   });
/// }
///
/// Durbun.log('Kullanıcı giriş yaptı', tag: 'auth', data: {'userId': 42});
/// Durbun.e('Ödeme başarısız', error: e, stackTrace: st);
/// Durbun.event('purchase', {'amount': 49.9});
/// ```
///
/// Every method is safe to call at any time: before [init]/[run], in release
/// builds (where the SDK is off by default) or on the web, calls are no-ops.
abstract final class Durbun {
  static DurbunBackend _backend = backend.createDurbunBackend();

  /// Actions added with [addAction] (kept from before the start, so they are
  /// in the first hello, and while running).
  static final Map<String, DurbunAction> _actions = <String, DurbunAction>{};

  /// Runs [body] (your `main` logic) in a zone that captures `print` output
  /// and uncaught errors, after starting the SDK. Call
  /// `WidgetsFlutterBinding.ensureInitialized()` inside [body]: when a binding
  /// already exists (e.g. created before `Firebase.initializeApp()`), [body]
  /// runs without the zone (like [init]) to avoid Flutter's "Zone mismatch"
  /// error, and `print` is not captured.
  ///
  /// `HttpClient`s created inside [body] are captured even when the app sets
  /// its own `HttpOverrides.global` there.
  static Future<void> run(
    FutureOr<void> Function() body, {
    DurbunOptions options = const DurbunOptions(),
  }) => _backend.run(body, options, actions: _actions.values.toList());

  /// Starts the SDK without a zone (no `print` capture except `debugPrint`,
  /// no zone errors). Safe to call more than once.
  ///
  /// Set your own `HttpOverrides.global` (if any) before calling [init]: one
  /// set later is chained within about 2 s, and `HttpClient`s created in that
  /// window are not captured.
  static Future<void> init([DurbunOptions options = const DurbunOptions()]) =>
      _backend.init(options, actions: _actions.values.toList());

  /// Whether the SDK is running (enabled and started).
  static bool get isEnabled => _backend.isActive;

  /// Whether the desktop is connected right now.
  static bool get isConnected => _backend.connection.connected;

  /// Current connection state.
  static DurbunConnection get connectionState => _backend.connection;

  /// Connection state changes (connected / disconnected).
  static Stream<DurbunConnection> get connection => _backend.connectionChanges;

  /// Sends an app log line. [message] may be any object; maps and lists are
  /// sent as JSON so the desktop shows them as a tree.
  static void log(
    Object? message, {
    DurbunLogLevel level = DurbunLogLevel.info,
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) => _backend.log(
    level,
    message,
    tag: tag,
    data: data,
    error: error,
    stackTrace: stackTrace,
  );

  /// Verbose log.
  static void v(
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) => _backend.log(
    DurbunLogLevel.verbose,
    message,
    tag: tag,
    data: data,
    error: error,
    stackTrace: stackTrace,
  );

  /// Debug log.
  static void d(
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) => _backend.log(
    DurbunLogLevel.debug,
    message,
    tag: tag,
    data: data,
    error: error,
    stackTrace: stackTrace,
  );

  /// Info log.
  static void i(
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) => _backend.log(
    DurbunLogLevel.info,
    message,
    tag: tag,
    data: data,
    error: error,
    stackTrace: stackTrace,
  );

  /// Warning log.
  static void w(
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) => _backend.log(
    DurbunLogLevel.warn,
    message,
    tag: tag,
    data: data,
    error: error,
    stackTrace: stackTrace,
  );

  /// Error log (pass [error] and [stackTrace] to get a foldable stack trace).
  static void e(
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) => _backend.log(
    DurbunLogLevel.error,
    message,
    tag: tag,
    data: data,
    error: error,
    stackTrace: stackTrace,
  );

  /// Fatal log.
  static void f(
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) => _backend.log(
    DurbunLogLevel.fatal,
    message,
    tag: tag,
    data: data,
    error: error,
    stackTrace: stackTrace,
  );

  /// Custom analytics-like event (shown as an event row in the log stream).
  static void event(String name, [Map<String, Object?>? props]) =>
      _backend.event(name, props);

  /// Adds a control for this app on the desktop (see [DurbunAction]). Safe
  /// before [init] / [run]: the action is kept and shown once the SDK starts.
  static void addAction(DurbunAction action) {
    _actions[action.id] = action;
    _backend.addAction(action);
  }

  /// Removes a control added with [addAction].
  static void removeAction(String id) {
    _actions.remove(id);
    _backend.removeAction(id);
  }

  /// Waits until everything sent so far reached the desktop (or [timeout]).
  static Future<bool> flush({Duration timeout = const Duration(seconds: 5)}) =>
      _backend.flush(timeout);

  /// Opens the in-app inspector panel. Needs a mounted `DurbunInspector`
  /// (e.g. `MaterialApp(builder: DurbunInspector.builder)`); handy from a
  /// debug menu when the bubble is hidden.
  static void showInspector() => DurbunInspector.show();

  /// Stops the SDK and removes every hook it installed (mainly for tests).
  /// Actions added with [addAction] are forgotten too.
  static Future<void> dispose() async {
    _actions.clear();
    await _backend.dispose();
    _backend = backend.createDurbunBackend();
  }
}

/// Desktop state for the in-app inspector (not exported from the package).
Map<String, Object?>? durbunInspectorState() {
  try {
    return Durbun._backend.inspectorState();
  } catch (_) {
    return null;
  }
}

/// Reporting and mock hooks for HTTP stacks that bypass dart:io (e.g. Dio
/// with `NativeAdapter` / cupertino_http / cronet_http). Used by
/// `package:durbun_dio`; dart:io traffic needs none of this.
abstract final class DurbunNetwork {
  /// Whether dart:io `HttpClient` traffic is already captured (requests that
  /// go through dart:io must not be reported a second time).
  static bool get capturesDartIo => Durbun._backend.capturesDartIo;

  /// Whether the plugin's iOS layer already captures URLSession traffic (and
  /// applies mocks to it): adapters built on URLSession (cupertino_http,
  /// `NativeAdapter` on iOS) must not report those requests again.
  static bool get capturesUrlSession => Durbun._backend.capturesUrlSession;

  /// The desktop's body limit (`maxBodyBytes`, at most 10 MiB); 0 when the
  /// SDK is off. Adapters can stop encoding a body past it.
  static int get maxBodyBytes => Durbun._backend.maxBodyBytes;

  /// Whether the desktop wants body contents (otherwise sizes only).
  static bool get captureBodies => Durbun._backend.captureBodies;

  /// The mock rule from the desktop that applies to [method] [url], if any.
  static DurbunMockDecision? findMock(String method, Uri url) =>
      Durbun._backend.findMock(method, url);

  /// Reports a request now and returns a handle for its response/error;
  /// null when the SDK is off. Pass [mockRuleId] when a mock was applied,
  /// and [bodySize] when [body] is only the first part of a larger body.
  ///
  /// Also the way to report traffic Dürbün cannot see by itself (cronet_http
  /// or package:ok_http on Android, gRPC, your own sockets).
  static DurbunHttpCall? begin({
    required String method,
    required Uri url,
    List<List<String>> headers = const <List<String>>[],
    List<int>? body,
    String? contentType,
    String source = 'dio',
    String? mockRuleId,
    int? bodySize,
  }) => Durbun._backend.beginHttpCall(
    method: method,
    url: url,
    headers: headers,
    body: body,
    contentType: contentType,
    source: source,
    mockRuleId: mockRuleId,
    bodySize: bodySize,
  );
}
