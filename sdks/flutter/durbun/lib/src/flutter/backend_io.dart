// The real backend (Android, iOS, macOS, …): pure-Dart core + Flutter glue.
import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show WidgetsBinding;

import '../core/body.dart';
import '../core/client.dart';
import '../core/env/environment.dart';
import '../core/http/http_client.dart';
import '../core/http/tracker.dart';
import '../core/mocks.dart';
import '../core/options.dart';
import '../core/print_capture.dart';
import '../core/protocol.dart';
import '../core/types.dart';
import 'backend.dart';
import 'commands.dart';
import 'error_hooks.dart';
import 'metrics.dart';
import 'native_bridge.dart';

DurbunBackend createDurbunBackend() => IoDurbunBackend();

/// Whether the SDK should run for [options] (see [DurbunOptions.enabled]):
/// an explicit `enabled` wins; otherwise debug/profile builds are on, release
/// builds only with `--dart-define=DURBUN=true` (and `DURBUN=false` turns it
/// off everywhere). Never on inside `flutter test` unless `enabled: true`.
/// The native layer of the plugin follows this decision.
bool resolveDurbunEnabled(
  DurbunOptions options, {
  bool releaseMode = kReleaseMode,
  bool defineGiven = kDurbunDefineGiven,
  bool defineValue = kDurbunDefine,
  bool? inFlutterTest,
}) =>
    options.enabled ??
    (durbunEnabledByDefault(
          releaseMode: releaseMode,
          defineGiven: defineGiven,
          defineValue: defineValue,
        ) &&
        !(inFlutterTest ?? isFlutterTestEnvironment));

class IoDurbunBackend implements DurbunBackend {
  DurbunClient? _client;
  DurbunOptions? _options;
  FlutterErrorHooks? _errors;
  FlutterMetrics? _metrics;
  PrintCapture? _printCapture;
  Timer? _guardian;
  DebugPrintCallback? _originalDebugPrint;
  DebugPrintCallback? _ourDebugPrint;
  NativeBridge? _native;

  /// Bumped by every [dispose]: a store-guard answer that arrives after a
  /// dispose (or a newer one) must not start the SDK any more.
  int _epoch = 0;

  /// Test hook: builds the bridge to the plugin's native layer.
  static NativeBridge Function(DurbunClient client)? debugNativeBridgeFactory;

  /// Test hooks for the store-install guard: the guard itself, and whether
  /// init/run ask it before starting anything (null: release builds on
  /// Android and iOS, the plugin's platforms).
  static StoreGuard? debugStoreGuard;
  static bool? debugAskStoreGuardFirst;

  static StoreGuard get _storeGuard => debugStoreGuard ?? StoreGuard.instance;

  /// Debug and profile builds can never be store installs; other platforms
  /// have no native side to ask.
  static bool get _askStoreGuardFirst =>
      debugAskStoreGuardFirst ??
      (kReleaseMode && (Platform.isAndroid || Platform.isIOS));

  DurbunClient? get client => _client;

  /// The plugin's native layer, when it attached.
  NativeBridge? get nativeBridge => _native;

  @override
  bool get isActive => _client != null && !_client!.isDisposed;

  @override
  Future<void> init(DurbunOptions options) {
    if (isActive || !resolveDurbunEnabled(options)) return Future<void>.value();
    if (!_askStoreGuardFirst) {
      // Synchronous, so calls right after an un-awaited init() are captured.
      _setUp(options, zoneCapturesPrint: false);
      return Future<void>.value();
    }
    final epoch = _epoch;
    return _storeGuardAllows().then((allowed) {
      if (!allowed || epoch != _epoch) return;
      // Not awaited before runApp: HttpClients made since then stay unwrapped.
      final appWasFirst = _widgetTreeMounted();
      _setUp(options, zoneCapturesPrint: false);
      if (appWasFirst) _tellLateStart();
    });
  }

  static bool _widgetTreeMounted() {
    try {
      return WidgetsBinding.instance.rootElement != null;
    } catch (_) {
      return false; // no binding yet
    }
  }

  /// Says on the desktop why traffic from the first screen may be missing.
  void _tellLateStart() {
    _client?.log(
      DurbunLogLevel.warn,
      lateStartNotice(_storeGuard.languageCode),
      tag: 'durbun',
    );
  }

  /// Release builds: false when nothing may start (a store install, or no
  /// answer from the plugin); the guard then prints its one line.
  Future<bool> _storeGuardAllows() async {
    final guard = _storeGuard;
    final check = await guard.check();
    if (check == StoreCheck.notStore) return true;
    guard.announce(check);
    return false;
  }

  /// Starts everything once; later calls are no-ops while running.
  void _setUp(DurbunOptions options, {required bool zoneCapturesPrint}) {
    if (isActive || !resolveDurbunEnabled(options)) return;
    try {
      // The first hello waits (≤ 3 s) for the native layer, so its
      // capabilities, actions and app version are in it.
      final nativeReady = Completer<void>();
      final client = DurbunClient.start(
        options,
        sdkPlatform: 'flutter',
        extraCapabilities: const <String>[SdkCapability.metrics],
        helloGate: nativeReady.future,
      );
      _client = client;
      _options = options;
      client.runInternal(() {
        final bridge = _native =
            (debugNativeBridgeFactory ?? NativeBridge.new)(client);
        unawaited(
          bridge.start(options).whenComplete(() {
            // Turned off before the gate opens, so the held-back hello never
            // goes out (debug and profile builds get here without the guard).
            if (bridge.refusedStoreInstall) _turnOffForStoreInstall(client);
            if (!nativeReady.isCompleted) nativeReady.complete();
          }),
        );
      });
      client.runInternal(() {
        final capture = _printCapture = PrintCapture(
          mode: options.capturePrint,
          dropFlutterErrorBoxes: options.captureErrors,
          sink: (line, ts) =>
              client.log(DurbunLogLevel.info, line, tag: 'flutter', ts: ts),
        );
        client.addConfigListener(capture.onConfig);
        if (client.configKnown) capture.onConfig(client.config);
        if (!zoneCapturesPrint &&
            options.capturePrint != DurbunPrintCapture.never) {
          _hookDebugPrint();
        }
        if (options.captureErrors) {
          _errors = FlutterErrorHooks(client)..install();
        }
        FlutterCommands(client).register();
        if (options.metrics) {
          _metrics = FlutterMetrics(client)..start();
        }
        _guardian = client.startPeriodicTimer(
          const Duration(seconds: 2),
          _checkHooks,
        );
      });
    } catch (_) {
      // Never break the app because of the SDK.
    }
  }

  /// The native side refused to start: this app was installed from a store.
  void _turnOffForStoreInstall(DurbunClient client) {
    if (!identical(_client, client)) return;
    _storeGuard.announce(StoreCheck.store);
    unawaited(dispose());
  }

  /// Re-chains hooks the app may have replaced after we installed ours
  /// (HttpOverrides.global, FlutterError.onError, PlatformDispatcher.onError)
  /// and attaches frame timings once the binding exists.
  void _checkHooks() {
    final client = _client;
    if (client == null || client.isDisposed) return;
    try {
      if (_options?.captureNetwork ?? false) {
        DurbunHttpOverrides.ensureInstalled(client);
      }
      _errors?.ensureInstalled();
      _metrics?.ensureAttached();
    } catch (_) {}
  }

  void _hookDebugPrint() {
    final original = debugPrint;
    _originalDebugPrint = original;
    void hooked(String? message, {int? wrapWidth}) {
      if (message != null) _onPrint(message);
      original(message, wrapWidth: wrapWidth);
    }

    _ourDebugPrint = hooked;
    debugPrint = hooked;
  }

  void _onPrint(String line) {
    try {
      _printCapture?.onLine(line);
    } catch (_) {}
  }

  @override
  Future<void> run(FutureOr<void> Function() body, DurbunOptions options) {
    if (!resolveDurbunEnabled(options)) return Future<void>.sync(body);
    if (!_askStoreGuardFirst) return _run(body, options);
    // Release build: nothing starts before the guard answered (one call to
    // the plugin; the app body waits for it).
    final epoch = _epoch;
    return _storeGuardAllows().then(
      (allowed) => allowed && epoch == _epoch
          ? _run(body, options)
          : Future<void>.sync(body),
    );
  }

  Future<void> _run(FutureOr<void> Function() body, DurbunOptions options) {
    _setUp(options, zoneCapturesPrint: true);
    final client = _client;
    if (client == null) return Future<void>.sync(body);
    // init() may have hooked debugPrint; the zone captures it from now on.
    if (_ourDebugPrint != null && identical(debugPrint, _ourDebugPrint)) {
      debugPrint = _originalDebugPrint ?? debugPrintThrottled;
      _ourDebugPrint = null;
    }

    final done = Completer<void>();
    runZonedGuarded<void>(
      () {
        Future<void> guardedBody() async {
          try {
            if (options.waitForDesktop > Duration.zero) {
              await client.waitForConnection(options.waitForDesktop);
            }
            await body();
          } finally {
            // The app may have replaced our hooks in main(); re-chain now.
            client.runInternal(_checkHooks);
            if (!done.isCompleted) done.complete();
          }
        }

        unawaited(guardedBody());
      },
      (error, stack) {
        final errors = _errors;
        if (errors != null) {
          errors.reportUncaught(error, stack, source: 'zone');
        }
        // Forward to the parent zone: keeps the default console output and
        // any outer handler (and PlatformDispatcher.onError in Flutter).
        Error.throwWithStackTrace(error, stack);
      },
      zoneSpecification: ZoneSpecification(
        print: (self, parent, zone, line) {
          _onPrint(line);
          parent.print(zone, line);
        },
      ),
    );
    return done.future;
  }

  @override
  void log(
    DurbunLogLevel level,
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) {
    _client?.log(
      level,
      message,
      tag: tag,
      data: data,
      error: error,
      stackTrace: stackTrace,
    );
  }

  @override
  void event(String name, Map<String, Object?>? props) =>
      _client?.event(name, props);

  @override
  DurbunConnection get connection =>
      _client?.connection ?? DurbunConnection.disconnected;

  @override
  Stream<DurbunConnection> get connectionChanges =>
      _client?.connectionChanges ?? const Stream<DurbunConnection>.empty();

  @override
  void addAction(DurbunAction action) => _client?.addAction(action);

  @override
  void removeAction(String id) => _client?.removeAction(id);

  @override
  Future<bool> flush(Duration timeout) =>
      _client?.flush(timeout) ?? Future<bool>.value(false);

  @override
  Future<void> dispose() async {
    // Also while the store guard is still being asked (release builds): its
    // answer then starts nothing, so no SDK is left running unreachable.
    _epoch++;
    final client = _client;
    if (client == null) return;
    _client = null;
    _options = null;
    _guardian?.cancel();
    _guardian = null;
    // Closed first (synchronously marked disposed): nothing more reaches the
    // desktop, and a hello still held back by the gate never goes out.
    final closing = client.dispose();
    _metrics?.dispose();
    _metrics = null;
    _errors?.dispose();
    _errors = null;
    if (_ourDebugPrint != null && identical(debugPrint, _ourDebugPrint)) {
      debugPrint = _originalDebugPrint ?? debugPrintThrottled;
    }
    _ourDebugPrint = null;
    _originalDebugPrint = null;
    _printCapture = null;
    final native = _native;
    _native = null;
    if (native != null) await native.stop();
    await closing;
  }

  /* ───────────── adapters outside dart:io (package:durbun_dio) ───────────── */

  @override
  bool get capturesDartIo => isActive && (_options?.captureNetwork ?? false);

  @override
  bool get capturesUrlSession =>
      isActive && (_native?.info?.capturesUrlSession ?? false);

  @override
  DurbunMockDecision? findMock(String method, Uri url) {
    final client = _client;
    if (client == null || client.isDisposed || !client.networkEnabled) {
      return null;
    }
    try {
      final rule = client.matchMock(method.toUpperCase(), url.removeFragment().toString());
      return rule == null ? null : mockDecisionFor(rule);
    } catch (_) {
      return null;
    }
  }

  @override
  DurbunHttpCall? beginHttpCall({
    required String method,
    required Uri url,
    required List<List<String>> headers,
    List<int>? body,
    String? contentType,
    required String source,
    String? mockRuleId,
  }) {
    final client = _client;
    if (client == null || client.isDisposed || !client.networkEnabled) {
      return null;
    }
    try {
      MockRule? rule;
      if (mockRuleId != null) {
        for (final r in client.mocks) {
          if (r.id == mockRuleId) rule = r;
        }
      }
      final tracker = RequestTracker(
        client,
        method: method.toUpperCase(),
        url: url.removeFragment().toString(),
        mockRule: rule,
        source: source,
      );
      final redacted = _redact(client, headers);
      tracker.headersSnapshot = () => redacted;
      tracker.contentTypeSnapshot = () => contentType;
      if (body != null && body.isNotEmpty) tracker.requestBody.add(body);
      tracker.markOpened();
      tracker.sendRequest();
      return _TrackedCall(client, tracker);
    } catch (_) {
      return null;
    }
  }
}

List<List<String>> _redact(DurbunClient client, List<List<String>> headers) => [
  for (final h in headers)
    if (h.length >= 2)
      <String>[h[0], client.isRedactedHeader(h[0].toLowerCase()) ? kRedactedValue : h[1]],
];

/// Converts a rule into the platform-agnostic decision used by adapters.
DurbunMockDecision mockDecisionFor(MockRule rule) {
  final action = rule.action;
  List<int> body = const <int>[];
  final raw = action.body;
  if (raw != null && raw.isNotEmpty) {
    if (action.bodyEncoding == 'base64') {
      try {
        body = base64Decode(raw.replaceAll(RegExp(r'\s+'), ''));
      } catch (_) {
        body = utf8.encode(raw);
      }
    } else {
      body = utf8.encode(raw);
    }
  }
  return DurbunMockDecision(
    ruleId: rule.id,
    ruleLabel: rule.label,
    type: action.type,
    status: action.status,
    headers: action.headers,
    body: body,
    delay: Duration(milliseconds: action.delayMs),
    failure: action.error,
    message: action.message,
  );
}

class _TrackedCall implements DurbunHttpCall {
  _TrackedCall(this._client, this._tracker);

  final DurbunClient _client;
  final RequestTracker _tracker;

  @override
  String get id => _tracker.id;

  @override
  void response({
    required int status,
    String? statusText,
    List<List<String>> headers = const <List<String>>[],
    List<int>? body,
    String? contentType,
  }) {
    try {
      final capture = BodyCapture(
        limit: _client.maxBodyBytes,
        enabled: _client.captureBodies,
      );
      if (body != null) capture.add(body);
      _tracker.complete(
        status: status,
        statusText: statusText,
        headers: _redact(_client, headers),
        body: capture.toPending(contentType: contentType),
      );
    } catch (_) {}
  }

  @override
  void error(Object error, {bool cancelled = false}) {
    try {
      _tracker.fail(error, cancelled: cancelled);
    } catch (_) {}
  }
}
