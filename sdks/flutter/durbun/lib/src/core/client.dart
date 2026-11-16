/// The pure-Dart SDK client: owns the transport, builds `hello`, exposes the
/// logging/event/metric API, keeps config + mock rules from the desktop,
/// answers commands and records dart:io HTTP traffic.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:math' as math;

import 'connection_report.dart';
import 'env/environment.dart';
import 'http/http_client.dart';
import 'json_safe.dart';
import 'mocks.dart';
import 'options.dart';
import 'protocol.dart';
import 'streams/stream_host.dart';
import 'transport/transport.dart';
import 'types.dart';

/// Max characters of one log message / error text (frames are ≤ 16 MiB).
const int kMaxMessageChars = 1024 * 1024;
const int _maxStackChars = 256 * 1024;

/// Runs a desktop command (a [DurbunAction] or a built-in tool) with its
/// parameters; the result goes back to the desktop.
typedef DurbunCommandHandler =
    FutureOr<Object?> Function(Map<String, Object?> params);

/// The SDK's connection to the Dürbün desktop for pure Dart programs (no
/// Flutter): logs, events, dart:io HTTP capture, mock rules and commands.
/// Flutter apps use `Durbun.run` / `Durbun.init`, which create one of these.
///
/// ```dart
/// final client = DurbunClient.start(const DurbunOptions(enabled: true));
/// client.log(DurbunLogLevel.info, 'Job started', tag: 'cron');
/// await client.flush(const Duration(seconds: 2));
/// await client.dispose();
/// ```
class DurbunClient implements HttpCaptureHost, StreamCaptureHost, LocalStreamHost {
  DurbunClient._({
    required this.options,
    required this.sdkPlatform,
    required this.app,
    required this.device,
    required this.extraCapabilities,
    required Zone zone,
  }) : _zone = zone,
       session = _randomId(),
       _redacted = {for (final h in options.redactHeaders) h.toLowerCase()};

  static DurbunClient? _current;

  /// The running client on this isolate, if any.
  static DurbunClient? get current => _current;

  /// Starts the SDK on this isolate (synchronous; the connection is made in
  /// the background). Returns the already running client if there is one.
  ///
  /// [extraCapabilities] are advertised on top of logs/events/commands and the
  /// option-driven ones (the Flutter glue adds `metrics`).
  ///
  /// [helloGate]: when given, the first `hello` is held back until it
  /// completes (at most [kHelloGateTimeout]) so information that arrives
  /// asynchronously — the native layer's capabilities, actions and app
  /// version from the Flutter plugin — is already in it.
  static DurbunClient start(
    DurbunOptions options, {
    String sdkPlatform = 'flutter',
    List<String> extraCapabilities = const <String>[],
    TransportConfig? transportConfig,
    Future<void>? helloGate,
  }) {
    final existing = _current;
    if (existing != null && !existing._disposed) return existing;

    late final DurbunClient client;
    final zone = Zone.root.fork(
      specification: ZoneSpecification(
        handleUncaughtError: (self, parent, zone, error, stack) {
          // Internal errors must never reach the app.
          _diagnostic('internal error: $error');
        },
      ),
    );
    zone.run(() {
      final app = detectApp(
        idOverride: options.appId,
        nameOverride: options.appName,
        versionOverride: options.appVersion,
      );
      final device = detectDevice();
      client = DurbunClient._(
        options: options,
        sdkPlatform: sdkPlatform,
        app: app,
        device: device,
        extraCapabilities: extraCapabilities,
        zone: zone,
      );
      _current = client;
      client._start(transportConfig, helloGate);
    });
    return client;
  }

  /// Longest time the first `hello` waits for [start]'s `helloGate`: as long
  /// as the Flutter glue waits for the plugin's native start, so a slow native
  /// layer still makes it into the session (the server keeps the first hello
  /// of a connection).
  static const Duration kHelloGateTimeout = Duration(seconds: 3);

  /// The options this client was started with.
  final DurbunOptions options;

  /// `hello.sdk.platform` (`flutter` unless [start] was given another).
  final String sdkPlatform;

  /// The app as detected at start (id, name, version), options applied.
  final DetectedApp app;

  /// The device as detected at start.
  final DetectedDevice device;

  /// Capabilities announced on top of the client's own (e.g. `metrics`).
  final List<String> extraCapabilities;

  /// Random id for this app launch (`hello.session`).
  final String session;

  final Zone _zone;
  final Set<String> _redacted;
  late final Transport _transport;

  late SdkConfig _config = _appConfig(options);
  bool _configKnown = false;
  List<MockRule> _mocks = const <MockRule>[];
  String? _appId;
  bool _disposed = false;
  bool _everConnected = false;
  /// Handshakes in flight (a peer accepted TCP, the welcome is awaited).
  int _handshakes = 0;
  Completer<void>? _mocksReady;
  int _netSeq = 0;

  /// False while the first hello is held back (see `helloGate`).
  bool _helloReleased = true;

  /// Raw `mocks` JSON from the desktop (forwarded to the native layer as is).
  Object? _rawMocks;
  NativePart? _native;
  final List<void Function()> _stateListeners = <void Function()>[];

  DurbunConnection _connection = DurbunConnection.disconnected;
  final StreamController<DurbunConnection> _connectionController =
      StreamController<DurbunConnection>.broadcast(sync: false);
  final List<void Function(SdkConfig config)> _configListeners =
      <void Function(SdkConfig config)>[];
  final Map<String, DurbunAction> _actions = <String, DurbunAction>{};
  final Map<String, DurbunCommandHandler> _commands =
      <String, DurbunCommandHandler>{};

  /// Native actions run from the in-app panel, by command id: their
  /// `command.result` is answered here instead of going to the desktop.
  final Map<String, Completer<Map<String, Object?>>> _localCommands =
      <String, Completer<Map<String, Object?>>>{};
  int _localSeq = 0;

  /* connection diagnostics (see ConnectionReport) */
  late final String? _buildHost = resolveDesktopHost(options.host);
  String? _panelHost;
  int _endpointGeneration = 0;
  List<ConnectAttempt> _attempts = const <ConnectAttempt>[];
  int _failedRounds = 0;
  bool _trying = false;
  bool _consoleHinted = false;
  final Stopwatch _sinceStart = Stopwatch();
  final List<void Function()> _reportListeners = <void Function()>[];

  /// After this long without a first connection, debug builds print once
  /// why (see [connectionHintForConsole]).
  static const Duration kConsoleHintAfter = Duration(seconds: 10);

  /// The config used until the desktop sends its own: the protocol
  /// defaults with [DurbunOptions.maxBodyBytes] / [DurbunOptions.captureBodies].
  static SdkConfig _appConfig(DurbunOptions options) {
    const d = SdkConfig.defaults;
    final limit = options.maxBodyBytes;
    return SdkConfig(
      captureBodies: options.captureBodies ?? d.captureBodies,
      maxBodyBytes: limit == null
          ? d.maxBodyBytes
          : math.max(0, math.min(limit, kMaxBodyBytesCeiling)),
      metricsIntervalMs: d.metricsIntervalMs,
      deviceLogsAvailable: d.deviceLogsAvailable,
    );
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  void _start(TransportConfig? override, Future<void>? helloGate) {
    _sinceStart.start();
    final config = override ?? _transportConfig();
    _transport = Transport.start(
      config,
      _onTransportEvent,
      useIsolate: options.useBackgroundIsolate,
      zone: _zone,
    );
    if (helloGate == null) {
      _transport.setHello(_buildHello());
    } else {
      _helloReleased = false;
      helloGate
          .timeout(kHelloGateTimeout, onTimeout: () {})
          .catchError((Object _) {})
          .whenComplete(_releaseHello);
    }
    if (options.captureNetwork) DurbunHttpOverrides.ensureInstalled(this);
  }

  void _releaseHello() {
    if (_helloReleased || _disposed) return;
    _helloReleased = true;
    _refreshHello();
  }

  void _refreshHello() {
    if (_disposed || !_helloReleased) return;
    _transport.setHello(_buildHello());
    _notifyState();
  }

  /// The Wi-Fi endpoint in use: the panel's address, else the build's.
  TransportEndpoint? _lanEndpoint() {
    final host = _panelHost ?? _buildHost;
    if (host == null) return null;
    final (h, p) = splitHostPort(host, options.port);
    if (h.isEmpty || (h == '127.0.0.1' && p == options.port)) return null;
    return TransportEndpoint(h, p, connectTimeoutMs: 3000);
  }

  List<TransportEndpoint> _endpoints() {
    final lan = _lanEndpoint();
    return <TransportEndpoint>[
      TransportEndpoint('127.0.0.1', options.port, connectTimeoutMs: 1500),
      if (lan != null) lan,
      // Fallback when adb reverse is not set up: the emulator's alias for the
      // host loopback.
      if (device.isAndroidEmulator)
        TransportEndpoint('10.0.2.2', options.port, connectTimeoutMs: 1500),
    ];
  }

  TransportConfig _transportConfig() {
    return TransportConfig(
      endpoints: _endpoints(),
      listenPorts: device.isIosPhysical && options.listenForUsb
          ? deviceListenPorts()
          : const <int>[],
      maxBufferedMessages: math.max(1, options.maxBufferedMessages),
    );
  }

  /// Whether [dispose] ran; a disposed client ignores every call.
  bool get isDisposed => _disposed;

  /// Waits until everything logged so far was handed to the desktop's socket
  /// (useful before a CLI program exits). False on timeout / no connection.
  Future<bool> flush([Duration timeout = const Duration(seconds: 5)]) {
    if (_disposed) return Future<bool>.value(false);
    return _transport.flush(timeout);
  }

  /// Stops the SDK: closes the connection, removes the HTTP overrides.
  Future<void> dispose({Duration flushTimeout = Duration.zero}) async {
    if (_disposed) return;
    if (flushTimeout > Duration.zero && _connection.connected) {
      await flush(flushTimeout);
    }
    _disposed = true;
    DurbunHttpOverrides.uninstall(this);
    _resolveMocksReady();
    _configListeners.clear();
    _stateListeners.clear();
    _reportListeners.clear();
    for (final c in _localCommands.values) {
      if (!c.isCompleted) c.completeError(StateError('Dürbün stopped'));
    }
    _localCommands.clear();
    _native = null;
    if (identical(_current, this)) _current = null;
    await _transport.close();
    _setConnection(DurbunConnection.disconnected);
    await _connectionController.close();
  }

  /* ───────────────────────────── state ───────────────────────────── */

  /// The current connection to the desktop.
  DurbunConnection get connection => _connection;

  /// Every change of [connection] (connected, disconnected).
  Stream<DurbunConnection> get connectionChanges => _connectionController.stream;

  /// Whether the desktop is connected right now.
  bool get isConnected => _connection.connected;

  /// Config from the desktop (defaults until the first welcome).
  SdkConfig get config => _config;

  /// Whether a welcome/config was received at least once.
  bool get configKnown => _configKnown;

  /// Mock rules of the connected desktop (empty while disconnected).
  List<MockRule> get mocks => _mocks;

  /// Server-assigned app session id (null until connected once).
  String? get appSessionId => _appId;

  /// Whether the transport engine runs on a background isolate.
  bool get usesBackgroundIsolate => _transport.isBackground;

  /// Calls [listener] each time the desktop sends new settings.
  void addConfigListener(void Function(SdkConfig config) listener) =>
      _configListeners.add(listener);

  /// Stops calling a listener added with [addConfigListener].
  void removeConfigListener(void Function(SdkConfig config) listener) =>
      _configListeners.remove(listener);

  /// Waits for a connection (or [timeout]); true when connected.
  Future<bool> waitForConnection(Duration timeout) async {
    if (_connection.connected) return true;
    if (_disposed || timeout <= Duration.zero) return false;
    try {
      await connectionChanges
          .firstWhere((c) => c.connected)
          .timeout(timeout);
      return true;
    } catch (_) {
      return _connection.connected;
    }
  }

  /* ───────────────────────────── desktop address & diagnostics ───────────────────────────── */

  /// The address built into the app (`DurbunOptions.host`,
  /// `--dart-define=DURBUN_HOST`, environment), if any.
  String? get buildHost => _buildHost;

  /// The address set at run time with [setDesktopHost], if any.
  String? get panelHost => _panelHost;

  /// Uses [host] (`192.168.1.20` or `192.168.1.20:9751`) as the Wi-Fi
  /// address instead of the build's, and tries it at once; null goes back
  /// to the build's address. A link through the old Wi-Fi address is
  /// closed; the USB link (adb reverse, usbmux) stays.
  void setDesktopHost(String? host) {
    if (_disposed) return;
    final value = host == null || host.trim().isEmpty ? null : host.trim();
    if (value == _panelHost) {
      // Same address again (the panel's Connect): try it now.
      if (!_connection.connected) retryConnectNow();
      return;
    }
    _panelHost = value;
    _endpointGeneration++;
    _attempts = const <ConnectAttempt>[];
    _failedRounds = 0;
    _trying = !_connection.connected || _lanEndpoint() != null;
    try {
      _transport.setEndpoints(_endpoints());
    } catch (_) {}
    _notifyReport();
  }

  /// The app went to the background (true) or came back (false). In the
  /// background no connection attempts are made; back in the foreground
  /// the next one starts at once. An open connection is not touched.
  void setAppInBackground(bool background) {
    if (_disposed) return;
    try {
      _transport.setBackground(background);
    } catch (_) {}
  }

  /// Tries to reach the desktop now instead of after the current wait.
  void retryConnectNow() {
    if (_disposed) return;
    try {
      _transport.retryNow();
    } catch (_) {}
  }

  /// Why the app is (not) connected, for the in-app panel.
  ConnectionReport get connectionReport {
    final lan = _lanEndpoint();
    final connected = _connection.connected;
    return ConnectionReport(
      connected: connected,
      via: _connection.via,
      attempts: connected ? const <ConnectAttempt>[] : _attempts,
      failedRounds: connected ? 0 : _failedRounds,
      trying: !connected && _trying,
      lanEndpoint: lan?.toString(),
      lanFromPanel: _panelHost != null,
      buildHost: _buildHost,
      issue: connected || _attempts.isEmpty
          ? null
          : diagnoseConnection(
              attempts: _attempts,
              platform: device.platform,
              isPhysical: device.isPhysical ?? true,
              lanEndpoint: lan?.toString(),
            ),
      everConnected: _everConnected,
      listensForUsb: device.isIosPhysical && options.listenForUsb,
    );
  }

  /// Called when [connectionReport] changes.
  void addReportListener(void Function() listener) => _reportListeners.add(listener);

  /// Stops calling a listener added with [addReportListener].
  void removeReportListener(void Function() listener) => _reportListeners.remove(listener);

  void _notifyReport() {
    for (final l in List<void Function()>.of(_reportListeners)) {
      try {
        l();
      } catch (_) {}
    }
  }

  void _onRoundFailed(List<Object?> event) {
    final generation = event.length > 2 ? event[2] : null;
    if (generation is int && generation != _endpointGeneration) return;
    final raw = event.length > 1 ? event[1] : null;
    _attempts = <ConnectAttempt>[
      if (raw is List)
        for (final a in raw)
          if (a is List && a.length >= 2) ConnectAttempt('${a[0]}', '${a[1]}', a.length > 2 ? '${a[2]}' : ''),
    ];
    _failedRounds++;
    _trying = false;
    _notifyReport();
    if (!_consoleHinted && !_everConnected && kDurbunDebugMode && _sinceStart.elapsed >= kConsoleHintAfter) {
      _consoleHinted = true;
      final text = connectionHintForConsole(connectionReport, port: options.port);
      _diagnostic(text);
      try {
        // Root zone: shown in the `flutter run` console, not captured as an app log.
        Zone.root.print(text);
      } catch (_) {}
    }
  }

  /// Runs [body] in the SDK's internal zone (errors are swallowed).
  R runInternal<R>(R Function() body) => _zone.run(body);

  @override
  Timer startTimer(Duration duration, void Function() callback) =>
      _zone.run(() => Timer(duration, () {
        try {
          callback();
        } catch (_) {}
      }));

  /// Periodic timer in the internal zone.
  Timer startPeriodicTimer(Duration period, void Function() callback) =>
      _zone.run(() => Timer.periodic(period, (_) {
        try {
          callback();
        } catch (_) {}
      }));

  /* ───────────────────────────── sending ───────────────────────────── */

  /// Sees every outgoing message (Dart and native-encoded lines) before the
  /// transport: the in-app inspector keeps its own copy. Must not throw or
  /// mutate the message.
  void Function(Map<String, Object?> message)? outgoingTap;

  void _send(Map<String, Object?> message, {bool volatile = false}) {
    if (_disposed) return;
    final tap = outgoingTap;
    if (tap != null) {
      try {
        tap(message);
      } catch (_) {}
    }
    try {
      _transport.send(message, volatile: volatile);
    } catch (_) {}
  }

  /// Sends an app log (`SdkLog`). Never throws.
  void log(
    DurbunLogLevel level,
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
    String? kind,
    double? ts,
  }) {
    if (_disposed) return;
    try {
      sendLog(
        level: level,
        message: stringifyMessage(message),
        tag: tag,
        data: data,
        error: errorInfo(error, stackTrace),
        kind: kind,
        ts: ts,
      );
    } catch (_) {}
  }

  /// Lower-level variant of [log] taking a ready `ErrorInfo` map.
  void sendLog({
    required DurbunLogLevel level,
    required String message,
    String? tag,
    Object? data,
    Map<String, Object?>? error,
    String? kind,
    double? ts,
  }) {
    if (_disposed) return;
    try {
      _send(
        buildLog(
          ts: ts,
          level: level.wireName,
          message: capString(message, kMaxMessageChars),
          tag: tag,
          data: data == null ? null : toJsonSafe(data),
          error: error,
          kind: kind,
        ),
      );
    } catch (_) {}
  }

  /// Sends a custom event (`SdkEvent`). Never throws.
  void event(String name, [Map<String, Object?>? props]) {
    if (_disposed) return;
    try {
      final safe = props == null ? null : toJsonSafe(props);
      _send(
        buildEvent(
          name: name,
          props: safe is Map<String, Object?> ? safe : null,
        ),
      );
    } catch (_) {}
  }

  /// Sends a metric sample. While disconnected only [outgoingTap] (the
  /// in-app inspector) sees it: nothing waits for the desktop.
  void metric(Map<String, Object?> metricMessage) {
    if (_disposed) return;
    if (_connection.connected) {
      _send(metricMessage, volatile: true);
      return;
    }
    final tap = outgoingTap;
    if (tap == null) return;
    try {
      tap(metricMessage);
    } catch (_) {}
  }

  /// `ErrorInfo` for an error object / stack trace (null when both absent).
  static Map<String, Object?>? errorInfo(Object? error, StackTrace? stackTrace) {
    if (error == null && stackTrace == null) return null;
    var stack = stackTrace;
    if (stack == null && error is Error) stack = error.stackTrace;
    String? text;
    if (error != null) {
      try {
        text = error.toString();
      } catch (_) {
        text = error.runtimeType.toString();
      }
    }
    return buildErrorInfo(
      type: error?.runtimeType.toString(),
      message: text == null ? null : capString(text, 64 * 1024),
      stack: stack == null ? null : capString(stack.toString(), _maxStackChars),
    );
  }

  /* ───────────────────────────── actions / commands ───────────────────────────── */

  /// Adds (or replaces) an action shown on the desktop.
  void addAction(DurbunAction action) => addActions(<DurbunAction>[action]);

  /// Adds several actions with a single hello/actions refresh.
  void addActions(Iterable<DurbunAction> actions) {
    for (final action in actions) {
      _actions[action.id] = action;
    }
    publishActions();
  }

  /// Removes the action with [id] and tells the desktop.
  void removeAction(String id) {
    if (_actions.remove(id) != null) publishActions();
  }

  /// Runs an action from the in-app panel: the app's own ([addAction]) or
  /// the native layer's. Returns the action's result data (for toggles and
  /// selects `{value: …}`); throws when it fails or a native one does not
  /// answer within 9 s. The desktop sees the new values, not the call.
  Future<Object?> runAction(String id, [Map<String, Object?> params = const <String, Object?>{}]) async {
    if (_disposed) throw StateError('Dürbün is stopped');
    final action = _actions[id];
    if (action != null) {
      final result = await Future<Object?>.sync(() => action.invoke(params)).timeout(const Duration(seconds: 9));
      if (action.kind != DurbunActionKind.button) publishActions();
      return result;
    }
    final native = _native;
    if (native == null || !native.handles(id)) throw ArgumentError('Unknown action: $id');
    final commandId = 'panel-${++_localSeq}';
    final completer = _localCommands[commandId] = Completer<Map<String, Object?>>();
    try {
      native.forwardCommand(<String, Object?>{'type': 'command', 'id': commandId, 'name': id, 'params': params});
      final result = await completer.future.timeout(const Duration(seconds: 9));
      if (result['ok'] != true) throw StateError('${result['error'] ?? 'failed'}');
      return result['data'];
    } finally {
      _localCommands.remove(commandId);
    }
  }

  /// A native `command.result` for an action run from the panel: answered
  /// here, never sent to the desktop.
  bool _takeLocalResult(String jsonLine) {
    if (_localCommands.isEmpty || !jsonLine.contains('command.result')) return false;
    try {
      final decoded = jsonDecode(jsonLine);
      if (decoded is! Map || decoded['type'] != 'command.result') return false;
      final completer = _localCommands[decoded['id']];
      if (completer == null) return false;
      if (!completer.isCompleted) completer.complete(decoded.cast<String, Object?>());
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Registers a command that is not shown as an action.
  void registerCommand(String name, DurbunCommandHandler handler) =>
      _commands[name] = handler;

  /// The registered actions as the desktop receives them (`hello.actions`).
  List<Map<String, Object?>> describeActions() => <Map<String, Object?>>[
    for (final a in _actions.values) a.describe(),
    ...?_native?.actions,
  ];

  /// Re-sends action descriptors (current values) and refreshes the hello.
  void publishActions() {
    if (_disposed) return;
    _refreshHello();
    if (_connection.connected && _helloReleased) {
      _send(buildActionsUpdate(describeActions()));
    }
  }

  Future<void> _handleCommand(Map<String, Object?> message) async {
    final id = message['id']?.toString();
    if (id == null) return;
    final name = message['name']?.toString() ?? '';
    final rawParams = message['params'];
    final params = rawParams is Map
        ? <String, Object?>{
            for (final e in rawParams.entries) e.key.toString(): e.value,
          }
        : <String, Object?>{};
    final action = _actions[name];
    final handler = _commands[name];
    final native = _native;
    if (action == null && handler == null && native != null &&
        native.handles(name)) {
      // The native layer answers with its own `command.result` (same id).
      try {
        native.forwardCommand(message);
      } catch (e) {
        _send(buildCommandResult(id: id, ok: false, error: '$e'));
      }
      return;
    }
    if (action == null && handler == null) {
      _send(
        buildCommandResult(id: id, ok: false, error: 'Unknown command: $name'),
      );
      return;
    }
    try {
      final result = await Future<Object?>.sync(
        () => action != null ? action.invoke(params) : handler!(params),
      ).timeout(const Duration(seconds: 9));
      _send(buildCommandResult(id: id, ok: true, data: toJsonSafe(result)));
      if (action != null && action.kind != DurbunActionKind.button) {
        publishActions();
      }
    } catch (e) {
      _send(
        buildCommandResult(
          id: id,
          ok: false,
          error: capString(e.toString(), 4000),
        ),
      );
    }
  }

  /* ───────────────────────────── transport events ───────────────────────────── */

  void _onTransportEvent(List<Object?> event) {
    if (_disposed || event.isEmpty) return;
    switch (event[0]) {
      case TransportEvents.handshake:
        _handshakes++;
      case TransportEvents.handshakeFailed:
        if (_handshakes > 0) _handshakes--;
        if (_handshakes == 0) _resolveMocksReady();
      case TransportEvents.connected:
        final welcome = event[1];
        _attempts = const <ConnectAttempt>[];
        _failedRounds = 0;
        _trying = false;
        _applyWelcome(
          welcome is Map ? welcome.cast<String, Object?>() : const {},
          event.length > 2 ? event[2]?.toString() : null,
        );
        _notifyReport();
      case TransportEvents.roundFailed:
        _onRoundFailed(event);
      case TransportEvents.disconnected:
        _handshakes = 0;
        if (_connection.connected) {
          _diagnostic('disconnected (${event.length > 1 ? event[1] : ''})');
        }
        // Mock rules hold only while the peer that pushed them is connected:
        // whoever answered the hello is not authenticated yet. The desktop
        // sends them again in its next welcome; the native layer learns it
        // from the state push below.
        _mocks = const <MockRule>[];
        _rawMocks = null;
        _setConnection(DurbunConnection.disconnected);
        _notifyState();
        _notifyReport();
      case TransportEvents.message:
        final message = event[1];
        if (message is Map) _onServerMessage(message.cast<String, Object?>());
      case TransportEvents.diag:
        _diagnostic(event.length > 1 ? '${event[1]}' : '');
    }
  }

  void _applyWelcome(Map<String, Object?> json, String? via) {
    final welcome = ServerWelcome.fromJson(json);
    _appId = welcome.appId.isEmpty ? null : welcome.appId;
    _mocks = welcome.mocks;
    _rawMocks = json['mocks'];
    _everConnected = true;
    _handshakes = 0;
    _setConfig(welcome.config);
    _setConnection(
      DurbunConnection(
        connected: true,
        via: via,
        appId: _appId,
        server: welcome.server,
      ),
    );
    _resolveMocksReady();
    _diagnostic('connected to ${welcome.server} via $via');
    _notifyState();
  }

  void _onServerMessage(Map<String, Object?> message) {
    switch (message['type']) {
      case 'mocks':
        _mocks = MockRule.listFromJson(message['rules']);
        _rawMocks = message['rules'];
        _notifyState();
      case 'config':
        _setConfig(SdkConfig.fromJson(message['config'], fallback: _config));
        _notifyState();
      case 'command':
        unawaited(_handleCommand(message));
      case 'welcome':
        _applyWelcome(message, _connection.via);
    }
  }

  void _setConfig(SdkConfig desktop) {
    // `captureBodies: false` in the options holds whatever the desktop says.
    final config = options.captureBodies == false && desktop.captureBodies
        ? desktop.copyWith(captureBodies: false)
        : desktop;
    _config = config;
    _configKnown = true;
    for (final l in List<void Function(SdkConfig)>.of(_configListeners)) {
      try {
        l(config);
      } catch (_) {}
    }
  }

  void _setConnection(DurbunConnection connection) {
    final changed = connection.connected != _connection.connected ||
        connection.via != _connection.via ||
        connection.appId != _connection.appId;
    _connection = connection;
    if (changed && !_connectionController.isClosed) {
      _connectionController.add(connection);
    }
  }

  void _resolveMocksReady() {
    final c = _mocksReady;
    _mocksReady = null;
    if (c != null && !c.isCompleted) c.complete();
  }

  /* ───────────────────────────── native layer (Flutter plugin) ───────────────────────────── */

  /// Joins the native layer (Kotlin / Swift core hosted by the Flutter
  /// plugin) to this session: its capabilities, actions and app info go into
  /// `hello`, its commands are forwarded to it. Replaces a previous part.
  void attachNative(NativePart part) {
    if (_disposed) return;
    _native = part;
    _refreshHello();
    if (_connection.connected && _helloReleased) {
      _send(buildActionsUpdate(describeActions()));
    }
  }

  /// The native layer's action list changed (values or entries).
  void updateNativeActions(List<Map<String, Object?>> actions) {
    final native = _native;
    if (native == null || _disposed) return;
    _native = native.withActions(actions);
    publishActions();
  }

  /// Whether a native layer is attached.
  bool get hasNative => _native != null;

  /// Sends a message the native layer already encoded as one JSON object
  /// (no trailing newline). It shares this client's buffer and connection.
  void sendEncoded(String jsonLine) {
    if (_disposed || jsonLine.isEmpty) return;
    if (_takeLocalResult(jsonLine)) return;
    _send(<String, Object?>{kEncodedLineKey: jsonLine});
  }

  /// Called whenever connection, config, mocks or hello change.
  void addStateListener(void Function() listener) =>
      _stateListeners.add(listener);

  /// Stops calling a listener added with [addStateListener].
  void removeStateListener(void Function() listener) =>
      _stateListeners.remove(listener);

  /// Current desktop state as one JSON-like map (for the native layer):
  /// `{connected, via, appId, config, mocks, hello}`.
  Map<String, Object?> describeState() => <String, Object?>{
    'connected': _connection.connected,
    'via': _connection.via,
    'appId': _appId,
    'config': _config.toJson(),
    'mocks': _rawMocks ?? const <Object?>[],
    // Without `ts`, so an unchanged state encodes identically.
    'hello': _buildHello()..remove('ts'),
  };

  void _notifyState() {
    for (final l in List<void Function()>.of(_stateListeners)) {
      try {
        l();
      } catch (_) {}
    }
  }

  /* ───────────────────────────── HttpCaptureHost ───────────────────────────── */

  @override
  bool get networkEnabled => !_disposed && options.captureNetwork;

  @override
  bool get captureBodies => _config.captureBodies;

  @override
  int get maxBodyBytes => _config.maxBodyBytes;

  @override
  bool isRedactedHeader(String lowerCaseName) =>
      _redacted.contains(lowerCaseName);

  @override
  MockRule? matchMock(String method, String url) {
    if (_mocks.isEmpty) return null;
    return findMockRule(_mocks, method, url, app.id);
  }

  /// Requests wait only while a peer has accepted the connection and the
  /// welcome (with its mock rules) is on its way. Without a desktop — no
  /// listener, hello still held back, nothing accepted yet — they never wait;
  /// `DurbunOptions.waitForDesktop` is the explicit way to wait longer.
  @override
  Future<void>? get mocksReady {
    if (_everConnected || _disposed || _handshakes == 0) return null;
    final completer = _mocksReady ??= Completer<void>();
    return completer.future.timeout(
      const Duration(milliseconds: 800),
      onTimeout: () {},
    );
  }

  @override
  String nextRequestId() => '${++_netSeq}';

  /* ───────────────────────────── StreamCaptureHost ───────────────────────────── */

  @override
  bool get captureStreams => networkEnabled && _config.captureStreams;

  @override
  int get streamMessageCap => _config.streamMessageCap;

  @override
  bool get streamsWanted => networkEnabled && (_config.captureStreams || !_configKnown);

  @override
  void sendNetMessage(Map<String, Object?> message) => _send(message);

  /// The in-app panel's own record of stream messages (set by the Flutter
  /// layer while the panel is on); messages the desktop does not take go
  /// there instead of [outgoingTap].
  @override
  LocalStreamSink? localStreams;

  /* ───────────────────────────── hello ───────────────────────────── */

  List<String> _capabilities() => <String>[
    SdkCapability.logs,
    SdkCapability.events,
    SdkCapability.commands,
    if (options.captureNetwork) SdkCapability.network,
    if (options.captureNetwork) SdkCapability.mocks,
    if (options.captureNetwork) SdkCapability.streams,
    if (options.captureErrors) SdkCapability.crash,
    for (final c in extraCapabilities)
      if (c != SdkCapability.metrics || options.metrics) c,
    ...?_native?.capabilities,
  ];

  Map<String, Object?> _appJson() {
    final json = app.toJson(pid: pid, debug: kDurbunDebugMode);
    final native = _native?.app;
    if (native == null) return json;
    // The native layer reads the package manager / bundle, which is more
    // accurate than what pure Dart can detect; explicit options still win.
    void take(String key, bool overridden) {
      final value = native[key];
      if (!overridden && value is String && value.isNotEmpty) json[key] = value;
    }

    take('name', options.appName != null);
    take('version', options.appVersion != null);
    take('build', false);
    return json;
  }

  Map<String, Object?> _buildHello() => buildHello(
    app: _appJson(),
    device: device.toJson(),
    session: session,
    capabilities: _capabilities().toSet().toList(),
    actions: describeActions(),
    platform: sdkPlatform,
    layers: _layers(),
  );

  /// `hello.sdk.layers`: Dart, plus the plugin's native core while attached.
  List<String> _layers() => <String>[
    SdkLayer.dart,
    if (_native?.platform case final native?
        when native == SdkLayer.android || native == SdkLayer.ios)
      native,
  ];

  /// The hello message as it is sent (for diagnostics and tests).
  Map<String, Object?> debugHello() => _buildHello();

  static String _randomId() {
    math.Random random;
    try {
      random = math.Random.secure();
    } catch (_) {
      random = math.Random();
    }
    final sb = StringBuffer();
    for (var i = 0; i < 16; i++) {
      sb.write(random.nextInt(16).toRadixString(16));
    }
    return sb.toString();
  }

  /// SDK-internal diagnostics (debug level: IDE / DevTools console only).
  static void diagnostic(String message) => _diagnostic(message);

  static void _diagnostic(String message) {
    // dart:developer log: visible in the IDE / DevTools console, never in the
    // device log stream (so it cannot echo back into Dürbün as noise).
    try {
      developer.log(message, name: 'durbun');
    } catch (_) {}
  }
}

/// What the native layer (Kotlin / Swift core inside the Flutter plugin)
/// contributes to the Dart session.
class NativePart {
  NativePart({
    required this.platform,
    this.capabilities = const <String>[],
    this.actions = const <Map<String, Object?>>[],
    this.commands = const <String>{},
    this.app,
    required this.forwardCommand,
  });

  /// `android` | `ios`.
  final String platform;
  final List<String> capabilities;
  final List<Map<String, Object?>> actions;

  /// Command names the native layer answers besides its action ids.
  final Set<String> commands;

  /// Native app info (`name`, `version`, `build`), when known.
  final Map<String, Object?>? app;

  /// Hands a desktop `command` message to the native layer, which answers
  /// with its own `command.result`.
  final void Function(Map<String, Object?> command) forwardCommand;

  bool handles(String name) =>
      commands.contains(name) || actions.any((a) => a['id'] == name);

  NativePart withActions(List<Map<String, Object?>> next) => NativePart(
    platform: platform,
    capabilities: capabilities,
    actions: next,
    commands: commands,
    app: app,
    forwardCommand: forwardCommand,
  );
}
