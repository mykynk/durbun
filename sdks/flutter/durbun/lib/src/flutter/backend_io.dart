// The real backend (Android, iOS, macOS, …): pure-Dart core + Flutter glue.
import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpOverrides;

import 'package:flutter/foundation.dart';

import '../core/body.dart';
import '../core/client.dart';
import '../core/connection_report.dart';
import '../core/env/environment.dart';
import '../core/http/http_client.dart';
import '../core/http/tracker.dart';
import '../core/mocks.dart';
import '../core/options.dart';
import '../core/print_capture.dart';
import '../core/protocol.dart';
import '../core/streams/stream_calls.dart';
import '../core/types.dart';
import '../inspector/inspector.dart' show inspectorPanelBuilder;
import '../inspector/panel.dart' show InspectorPanelHost;
import '../inspector/panel_prefs_io.dart';
import '../inspector/share_report.dart' show setExtraSecretNames;
import '../inspector/store.dart';
import 'backend.dart';
import 'commands.dart';
import 'error_hooks.dart';
import 'isolate_link.dart';
import 'lifecycle.dart';
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

/// Why [resolveDurbunEnabled] said no for [options].
DurbunOffReason durbunOffReason(
  DurbunOptions options, {
  bool releaseMode = kReleaseMode,
  bool defineGiven = kDurbunDefineGiven,
  bool defineValue = kDurbunDefine,
}) {
  if (options.enabled == false) return DurbunOffReason.option;
  if (defineGiven && !defineValue) return DurbunOffReason.define;
  if (releaseMode && !defineGiven) return DurbunOffReason.release;
  return DurbunOffReason.flutterTest;
}

/// The panel's kept Mac address (see [DurbunBackend.setDesktopHost]).
const String kDesktopHostPref = 'desktop-host';

class _Changes extends ChangeNotifier {
  void ping() => notifyListeners();
}

class IoDurbunBackend implements DurbunBackend {
  /// Shared by every backend (`Durbun.dispose` replaces the backend; the
  /// panel keeps listening).
  static final _Changes _changes = _Changes();

  DurbunStartState _startState = DurbunStartState.notStarted;

  /// Receives logs, events and HTTP from the app's other isolates.
  IsolateHub? _isolates;
  DurbunOffReason? _offReason;
  DurbunClient? _client;
  DurbunOptions? _options;
  FlutterErrorHooks? _errors;
  FlutterMetrics? _metrics;
  AppLifecycleWatcher? _lifecycle;
  PrintCapture? _printCapture;
  Timer? _guardian;
  DebugPrintCallback? _originalDebugPrint;
  DebugPrintCallback? _ourDebugPrint;
  NativeBridge? _native;

  /// Test hook: builds the bridge to the plugin's native layer.
  static NativeBridge Function(DurbunClient client)? debugNativeBridgeFactory;

  DurbunClient? get client => _client;

  /// The plugin's native layer, when it attached.
  NativeBridge? get nativeBridge => _native;

  @override
  bool get isActive => _client != null && !_client!.isDisposed;

  @override
  Future<void> init(
    DurbunOptions options, {
    List<DurbunAction> actions = const <DurbunAction>[],
  }) async {
    _setUp(options, zoneCapturesPrint: false, actions: actions);
  }

  /// Starts everything once; later calls are no-ops while running.
  ///
  /// The caller's zone is the app's: `PlatformDispatcher.onError` (which
  /// dart:ui runs in the zone it was set in) is installed from there, so the
  /// app's own handler (Crashlytics, Sentry …) never runs in Dürbün's
  /// error-swallowing internal zone.
  void _setUp(
    DurbunOptions options, {
    required bool zoneCapturesPrint,
    List<DurbunAction> actions = const <DurbunAction>[],
  }) {
    if (isActive) return;
    if (!resolveDurbunEnabled(options)) {
      _markOff(options);
      return;
    }
    final appZone = Zone.current;
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
      _isolates = IsolateHub(client);
      _startState = options.inspector ? DurbunStartState.running : DurbunStartState.inspectorOff;
      _offReason = null;
      client
        ..addReportListener(_changes.ping)
        ..addStateListener(_changes.ping);
      _loadSavedHost(client);
      // Actions added before the start (the hello is still held back, so they
      // are in the first one).
      if (actions.isNotEmpty) client.runInternal(() => client.addActions(actions));
      if (options.inspector) {
        final store = DurbunInspectorStore.instance
          ..bodyResolver = wireBodyFromPending
          ..helloProvider = (() => client.isDisposed ? null : client.describeState()['hello'] as Map<String, Object?>?)
          ..slackWebhook = resolveSlackWebhook(options.slackWebhook)
          ..attached = true;
        setExtraSecretNames(options.secretNames);
        inspectorPanelBuilder ??= (store, onClose) => InspectorPanelHost(store: store, onClose: onClose);
        client
          ..outgoingTap = store.ingest
          ..localStreams = store;
        store.captureBodiesNow = () => !client.isDisposed && client.captureBodies;
      }
      client.runInternal(() {
        final bridge = _native =
            (debugNativeBridgeFactory ?? NativeBridge.new)(client);
        unawaited(
          bridge.start(options).whenComplete(() {
            if (!nativeReady.isCompleted) nativeReady.complete();
          }),
        );
      });
      client.runInternal(() {
        final store =
            options.inspector ? DurbunInspectorStore.instance : null;
        void send(String line, double ts) =>
            client.log(DurbunLogLevel.info, line, tag: 'flutter', ts: ts);
        final capture = _printCapture = PrintCapture(
          mode: options.capturePrint,
          dropFlutterErrorBoxes: options.captureErrors,
          // The panel takes every line locally; the desktop copy is unchanged.
          local: store?.ingestPrint,
          sink: store == null
              ? send
              : (line, ts) => store.withoutTap(() => send(line, ts)),
        );
        client.addConfigListener(capture.onConfig);
        if (client.configKnown) capture.onConfig(client.config);
        if (!zoneCapturesPrint &&
            options.capturePrint != DurbunPrintCapture.never) {
          _hookDebugPrint();
        }
        if (options.captureErrors) {
          _errors = FlutterErrorHooks(client, appZone: appZone)..install();
        }
        FlutterCommands(client).register();
        if (options.metrics) {
          _metrics = FlutterMetrics(client, local: options.inspector)..start();
        }
        _lifecycle = AppLifecycleWatcher(client, logChanges: options.captureLifecycle)
          ..ensureAttached();
        _guardian = client.startPeriodicTimer(
          const Duration(seconds: 2),
          _checkHooks,
        );
      });
    } catch (_) {
      // Never break the app because of the SDK.
    }
  }

  void _markOff(DurbunOptions options) {
    if (isActive) return;
    _startState = DurbunStartState.off;
    _offReason = durbunOffReason(options);
    _changes.ping();
  }

  /// A Mac address entered in the panel on an earlier launch wins over the
  /// build's.
  void _loadSavedHost(DurbunClient client) {
    unawaited(() async {
      try {
        final saved = await readPanelPref(kDesktopHostPref);
        if (saved == null || client.isDisposed || !identical(_client, client)) return;
        final address = checkDesktopAddress(saved).address;
        if (address != null) client.runInternal(() => client.setDesktopHost(address));
      } catch (_) {}
    }());
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
      _lifecycle?.ensureAttached();
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

  /// Test hook: whether a Flutter binding exists (debug builds track it).
  static bool Function() debugBindingExists = () =>
      BindingBase.debugBindingType() != null;

  @override
  Future<void> run(
    FutureOr<void> Function() body,
    DurbunOptions options, {
    List<DurbunAction> actions = const <DurbunAction>[],
  }) {
    if (!resolveDurbunEnabled(options)) {
      _markOff(options);
      return Future<void>.sync(body);
    }
    // A binding created before run() (e.g. ensureInitialized() for
    // Firebase.initializeApp) belongs to the outer zone: running runApp in a
    // new zone would print Flutter's "Zone mismatch" error on every launch.
    // Then run like init(): no zone, debugPrint hooked.
    var bindingExists = false;
    try {
      bindingExists = debugBindingExists();
    } catch (_) {}
    _setUp(options, zoneCapturesPrint: !bindingExists, actions: actions);
    final client = _client;
    if (client == null) return Future<void>.sync(body);
    if (bindingExists) {
      DurbunClient.diagnostic(
        'Durbun.run: a Flutter binding already exists, so the body runs '
        'without the Dürbün zone (avoids "Zone mismatch"). print() is not '
        'captured, only debugPrint; uncaught errors arrive through '
        'PlatformDispatcher.onError. To capture print, call '
        'WidgetsFlutterBinding.ensureInitialized() inside Durbun.run.',
      );
      if (_ourDebugPrint == null &&
          options.capturePrint != DurbunPrintCapture.never) {
        _hookDebugPrint();
      }
      return _runBody(body, options, client);
    }
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
            await _runBody(body, options, client);
          } finally {
            if (!done.isCompleted) done.complete();
          }
        }

        if (options.captureNetwork) {
          // Every HttpClient created in the zone asks the global overrides
          // at creation time, so an HttpOverrides.global the app sets in its
          // main() is captured from its first client on.
          HttpOverrides.runWithHttpOverrides<void>(
            () => unawaited(guardedBody()),
            DurbunZoneHttpOverrides(client),
          );
        } else {
          unawaited(guardedBody());
        }
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

  Future<void> _runBody(
    FutureOr<void> Function() body,
    DurbunOptions options,
    DurbunClient client,
  ) async {
    try {
      if (options.waitForDesktop > Duration.zero) {
        await client.waitForConnection(options.waitForDesktop);
      }
      await body();
    } finally {
      // The app may have replaced our hooks in main(); re-chain now.
      client.runInternal(_checkHooks);
    }
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
    final client = _client;
    if (client != null) {
      client.log(
        level,
        message,
        tag: tag,
        data: data,
        error: error,
        stackTrace: stackTrace,
      );
    } else if (_startState == DurbunStartState.notStarted) {
      // Another isolate (compute, Isolate.run, a background engine): the
      // SDK of the main isolate, if one runs, takes it.
      forwardLog(level, message, tag, data, error, stackTrace);
    }
  }

  @override
  void event(String name, Map<String, Object?>? props) {
    final client = _client;
    if (client != null) {
      client.event(name, props);
    } else if (_startState == DurbunStartState.notStarted) {
      forwardEvent(name, props);
    }
  }

  @override
  Future<bool> attachIsolate() async {
    if (_client != null) return isActive && _client!.networkEnabled;
    if (_startState != DurbunStartState.notStarted) return false;
    return attachThisIsolate();
  }

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
  Map<String, Object?>? inspectorState() {
    final client = _client;
    if (client == null || client.isDisposed) return null;
    try {
      return client.describeState();
    } catch (_) {
      return null;
    }
  }

  @override
  DurbunStartState get startState => _startState;

  @override
  DurbunOffReason? get offReason => _offReason;

  @override
  bool get inFlutterTest => isFlutterTestEnvironment;

  @override
  ConnectionReport? get connectionReport {
    final client = _client;
    if (client == null || client.isDisposed) return null;
    try {
      return client.connectionReport;
    } catch (_) {
      return null;
    }
  }

  @override
  Listenable get changes => _changes;

  @override
  Future<void> setDesktopHost(String? address) async {
    final client = _client;
    if (client == null || client.isDisposed) return;
    client.runInternal(() => client.setDesktopHost(address));
    await writePanelPref(kDesktopHostPref, address);
  }

  @override
  List<Map<String, Object?>> get actions {
    final client = _client;
    if (client == null || client.isDisposed) return const <Map<String, Object?>>[];
    try {
      return client.describeActions();
    } catch (_) {
      return const <Map<String, Object?>>[];
    }
  }

  @override
  Future<Object?> runAction(String id, Map<String, Object?> params) {
    final client = _client;
    if (client == null || client.isDisposed) {
      return Future<Object?>.error(StateError('Dürbün is not running'));
    }
    return client.runAction(id, params);
  }

  @override
  Future<void> dispose() async {
    final client = _client;
    if (client == null) return;
    client
      ..removeReportListener(_changes.ping)
      ..removeStateListener(_changes.ping);
    _guardian?.cancel();
    _guardian = null;
    _isolates?.dispose();
    _isolates = null;
    final native = _native;
    _native = null;
    if (native != null) await native.stop();
    _metrics?.dispose();
    _metrics = null;
    _lifecycle?.dispose();
    _lifecycle = null;
    _errors?.dispose();
    _errors = null;
    if (_ourDebugPrint != null && identical(debugPrint, _ourDebugPrint)) {
      debugPrint = _originalDebugPrint ?? debugPrintThrottled;
    }
    _ourDebugPrint = null;
    _originalDebugPrint = null;
    _printCapture = null;
    client.outgoingTap = null;
    DurbunInspectorStore.existing
      ?..attached = false
      ..helloProvider = null;
    _client = null;
    _options = null;
    _startState = DurbunStartState.notStarted;
    await client.dispose();
    _changes.ping();
  }

  /* ───────────── adapters outside dart:io (package:durbun_dio) ───────────── */

  @override
  bool get capturesDartIo => isActive && (_options?.captureNetwork ?? false);

  @override
  bool get capturesUrlSession =>
      isActive && (_native?.info?.capturesUrlSession ?? false);

  @override
  int get maxBodyBytes {
    final client = _client;
    if (client == null || client.isDisposed || !client.networkEnabled) return 0;
    return client.maxBodyBytes;
  }

  @override
  bool get captureBodies {
    final client = _client;
    return client != null && !client.isDisposed && client.captureBodies;
  }

  @override
  DurbunMockDecision? findMock(
    String method,
    Uri url, {
    String? contentType,
    String? Function()? body,
  }) {
    final client = _client;
    if (client == null || client.isDisposed || !client.networkEnabled) {
      return null;
    }
    try {
      final rule = client.matchMockRequest(
        method.toUpperCase(),
        url.removeFragment().toString(),
        contentType: contentType,
        body: body,
      );
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
    int? bodySize,
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
      if (bodySize != null) tracker.requestBody.reportSize(bodySize);
      tracker.markOpened();
      tracker.sendRequest();
      return _TrackedCall(client, tracker);
    } catch (_) {
      return null;
    }
  }

  @override
  bool get capturesStreams {
    final client = _client;
    return client != null && !client.isDisposed && client.captureStreams;
  }

  @override
  DurbunWebSocketCall? beginWebSocket({
    required Uri url,
    required List<List<String>> headers,
    required String source,
  }) {
    final client = _client;
    if (client == null || client.isDisposed || !client.networkEnabled) return null;
    try {
      return WebSocketCall.start(
        client,
        url: url,
        headers: headers,
        source: source,
        redact: (h) => _redact(client, h),
      );
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
    int? bodySize,
  }) {
    try {
      final capture = BodyCapture(
        limit: _client.maxBodyBytes,
        enabled: _client.captureBodies,
      );
      if (body != null) capture.add(body);
      if (bodySize != null) capture.reportSize(bodySize);
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

  @override
  DurbunEventStreamCall? eventStream({
    required int status,
    String? statusText,
    List<List<String>> headers = const <List<String>>[],
  }) {
    try {
      return EventStreamCall.start(
        _tracker,
        status: status,
        statusText: statusText,
        headers: _redact(_client, headers),
      );
    } catch (_) {
      return null;
    }
  }
}
