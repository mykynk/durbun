// Bridge to the native layer of the plugin (Kotlin core on Android, Swift core
// on iOS). Dart owns the only desktop connection; the native side is started
// from here (no native init call in the app), sends its encoded messages back
// over the channel and follows the desktop state (config, mocks) pushed from
// here. When the plugin is not registered (pure-Dart use, other platforms,
// unit tests) every call fails with MissingPluginException and the SDK simply
// runs without the native layer.
//
// The app's own device-log lines (Android logcat, iOS os_log / Logger / NSLog)
// come apart from the other native messages (`deviceLogs`): the in-app panel
// shows every one of them, and the desktop gets them only when it cannot read
// the device's logs itself (Wi-Fi without adb / idevicesyslog), the same rule
// `capturePrint` applies to print().
import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

import '../core/client.dart';
import '../core/options.dart';
import '../core/protocol.dart' show SdkConfig;
import '../core/types.dart' show DurbunPrintCapture;
import '../inspector/store.dart' show DurbunInspectorStore;

/// Method channel shared with `DurbunFlutterPlugin` (Android + iOS).
const String kDurbunNativeChannel = 'dev.durbun/native';

/// How long the first hello waits for the plugin's `start` reply (see
/// `DurbunClient.kHelloGateTimeout`). A later reply is still taken: the
/// native layer then joins the running session.
const Duration kNativeReplyTimeout = Duration(seconds: 3);

/// What the native layer reported when it started.
class NativeStartInfo {
  const NativeStartInfo({
    required this.platform,
    required this.capabilities,
    required this.actions,
    required this.commands,
    required this.app,
    required this.capturesUrlSession,
    this.deviceLogs,
  });

  final String platform;
  final List<String> capabilities;
  final List<Map<String, Object?>> actions;
  final Set<String> commands;
  final Map<String, Object?>? app;
  final bool capturesUrlSession;

  /// Where the native layer reads the app's own device-log lines from:
  /// `logcat`, `os_log`, or null (none: iOS 13/14, or `capturePrint: never`).
  final String? deviceLogs;

  /// Parses the `start` reply; null when the native side did not attach.
  static NativeStartInfo? parse(Object? reply) {
    final json = _decodeMap(reply);
    if (json == null || json['attached'] != true) return null;
    return NativeStartInfo(
      platform: json['platform']?.toString() ?? 'native',
      capabilities: <String>[
        for (final c in _list(json['capabilities'])) c.toString(),
      ],
      actions: _actionList(json['actions']),
      commands: <String>{for (final c in _list(json['commands'])) c.toString()},
      app: _map(json['app']),
      capturesUrlSession: json['urlSession'] == true,
      deviceLogs: json['deviceLogs'] is String ? json['deviceLogs'] as String : null,
    );
  }
}

class NativeBridge {
  NativeBridge(
    this._client, {
    MethodChannel? channel,
    bool? platformSupported,
    this.replyTimeout = kNativeReplyTimeout,
  }) : _channel =
           channel ??
           const MethodChannel(
             kDurbunNativeChannel,
             StandardMethodCodec(),
             EarlyBinaryMessenger(),
           ),
       _platformSupported =
           platformSupported ?? (Platform.isAndroid || Platform.isIOS);

  final DurbunClient _client;
  final MethodChannel _channel;
  final bool _platformSupported;

  /// How long [start] waits before it completes without the reply.
  final Duration replyTimeout;

  NativeStartInfo? _info;
  bool _stopped = false;
  bool _statePushScheduled = false;
  String? _lastState;

  /// `capturePrint`: it governs the app's own device-log lines too.
  DurbunPrintCapture _consoleMode = DurbunPrintCapture.auto;

  /// Device-log lines that arrived before the desktop said whether it reads
  /// the device's logs itself; sent or dropped once it does.
  final List<String> _pendingDeviceLogs = <String>[];

  /// Bound of the lines held for the desktop's answer (a start-up burst
  /// replays the whole logcat buffer of the app).
  static const int maxPendingDeviceLogs = 1000;

  /// The panel store whose [DurbunInspectorStore.panelOpen] is followed.
  DurbunInspectorStore? _panelStore;

  /// Info from the native side once it attached (null otherwise).
  NativeStartInfo? get info => _info;

  bool get isAttached => _info != null && !_stopped;

  /// The in-app panel's store while the SDK feeds it (`inspector: true`).
  DurbunInspectorStore? get _panel {
    final store = DurbunInspectorStore.existing;
    return store != null && store.attached ? store : null;
  }

  /// Whether the desktop gets the app's device-log lines: true / false, or
  /// null while unknown (no welcome yet, `auto`).
  bool? get _desktopWantsDeviceLogs => switch (_consoleMode) {
    DurbunPrintCapture.never => false,
    DurbunPrintCapture.always => true,
    DurbunPrintCapture.auto =>
      _client.configKnown ? !_client.config.deviceLogsAvailable : null,
  };

  /// `state.deviceLogs` for the native side: read the lines at all (panel or
  /// desktop), read them often (panel open, or a desktop that needs them),
  /// and whether they reach the desktop (for its one-time note).
  Map<String, Object?> _deviceLogsState() {
    final desktop = _desktopWantsDeviceLogs == true;
    final panel = _panel;
    final read =
        _consoleMode != DurbunPrintCapture.never && (panel != null || desktop);
    return <String, Object?>{
      'read': read,
      'fast': read && (desktop || (panel?.panelOpen.value ?? false)),
      'desktop': desktop,
    };
  }

  /// Starts the native layer for this session. Completes (never throws) once
  /// it attached, declined or turned out to be missing — or after
  /// [replyTimeout]. A reply that comes later is still applied: the native
  /// side is running by then (logs, OkHttp / URLSession capture, crash
  /// handler), so its handler stays and it joins the session late.
  Future<void> start(DurbunOptions options) {
    if (!_platformSupported || _stopped) return Future<void>.value();
    _consoleMode = options.capturePrint;
    final replied = Completer<void>();
    void done() {
      if (!replied.isCompleted) replied.complete();
    }

    try {
      // Native messages sent while no handler listens (after a hot restart,
      // or after stop()) are dropped without a console warning each.
      ui.channelBuffers.allowOverflow(kDurbunNativeChannel, true);
    } catch (_) {}
    try {
      _channel.setMethodCallHandler(_onNativeCall);
      final args = jsonEncode(<String, Object?>{
        'session': _client.session,
        'options': <String, Object?>{
          'captureErrors': options.captureErrors,
          'captureNetwork': options.captureNetwork,
          'redactHeaders': options.redactHeaders,
          'maxBufferedMessages': options.maxBufferedMessages,
          'capturePrint': options.capturePrint.name,
        },
        'state': _client.describeState(),
      });
      unawaited(
        _channel
            .invokeMethod<Object?>('start', args)
            .then(_onStartReply, onError: _onStartError)
            .whenComplete(done),
      );
    } catch (e) {
      _onStartError(e);
      done();
    }
    return replied.future.timeout(
      replyTimeout,
      onTimeout: () => _diagnostic(
        'native layer did not answer within ${replyTimeout.inMilliseconds} ms; '
        'it joins the session when it does',
      ),
    );
  }

  void _onStartReply(Object? reply) {
    try {
      final info = NativeStartInfo.parse(reply);
      if (_stopped) {
        // Dart stopped while the native side was starting: stop it too.
        if (info != null) _invoke('stop', null);
        return;
      }
      if (info == null) {
        _diagnostic('native layer did not attach: ${_decodeMap(reply)?['reason'] ?? 'unknown reason'}');
        _safeClearHandler();
        return;
      }
      _info = info;
      _client.attachNative(
        NativePart(
          platform: info.platform,
          capabilities: info.capabilities,
          actions: info.actions,
          commands: info.commands,
          app: info.app,
          forwardCommand: _forwardCommand,
        ),
      );
      final panel = _panel;
      if (panel != null) {
        panel.nativeDeviceLogs = info.deviceLogs ??
            (_consoleMode == DurbunPrintCapture.never ? 'off' : null);
        _panelStore = panel;
        panel.panelOpen.addListener(_scheduleStatePush);
      }
      _client.addConfigListener(_onConfig);
      _client.addStateListener(_scheduleStatePush);
      _scheduleStatePush();
    } catch (e) {
      _diagnostic('native layer could not attach: $e');
    }
  }

  void _onStartError(Object error) {
    if (error is! MissingPluginException) {
      // MissingPluginException: plugin not registered (pure Dart, desktop
      // platforms, tests) — nothing worth a diagnostic.
      _diagnostic('native layer unavailable: $error');
    }
    _safeClearHandler();
  }

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _client.removeStateListener(_scheduleStatePush);
    _client.removeConfigListener(_onConfig);
    _panelStore?.panelOpen.removeListener(_scheduleStatePush);
    _panelStore = null;
    _pendingDeviceLogs.clear();
    final wasAttached = _info != null;
    _info = null;
    _safeClearHandler();
    if (!wasAttached) return;
    try {
      await _channel
          .invokeMethod<Object?>('stop')
          .timeout(const Duration(seconds: 2));
    } catch (_) {}
  }

  void _safeClearHandler() {
    try {
      _channel.setMethodCallHandler(null);
    } catch (_) {}
  }

  /// The payload of a native → Dart call, or null when it belongs to an older
  /// session (sent before a hot restart and delivered to the new isolate).
  /// The plugin sends `{session, <key>: payload}`; a bare payload (older
  /// plugin) is taken as is.
  Object? _payload(Object? arguments, String key) {
    if (arguments is Map) {
      final session = arguments['session'];
      if (session is String && session != _client.session) return null;
      return arguments[key];
    }
    return arguments;
  }

  /// Native → Dart calls.
  Future<Object?> _onNativeCall(MethodCall call) async {
    if (_stopped) return null;
    try {
      switch (call.method) {
        case 'events':
          final lines = _payload(call.arguments, 'lines');
          if (lines is List) {
            for (final line in lines) {
              if (line is String) _client.sendEncoded(line);
            }
          }
          return null;
        case 'deviceLogs':
          final lines = _payload(call.arguments, 'lines');
          if (lines is List) _onDeviceLogs(lines);
          return null;
        case 'actions':
          final actions = _payload(call.arguments, 'actions');
          if (actions == null) return null;
          _client.updateNativeActions(_actionList(_decode(actions)));
          return null;
        case 'flush':
          // Native asks before its process may die (crash on a background
          // thread): true once everything reached the desktop's socket.
          return await _client.flush(const Duration(milliseconds: 1500));
      }
    } catch (e) {
      _diagnostic('native call ${call.method} failed: $e');
    }
    return null;
  }

  /// The app's own logcat / os_log lines: every one to the panel, to the
  /// desktop only when it cannot read the device's logs (held until it says).
  void _onDeviceLogs(List<Object?> lines) {
    final panel = _panel;
    final desktop = _desktopWantsDeviceLogs;
    for (final line in lines) {
      if (line is! String || line.isEmpty) continue;
      panel?.ingestDeviceLog(line);
      if (desktop == true) {
        _sendDeviceLog(line, panel);
      } else if (desktop == null) {
        _pendingDeviceLogs.add(line);
      }
    }
    final extra = _pendingDeviceLogs.length - maxPendingDeviceLogs;
    if (extra > 0) _pendingDeviceLogs.removeRange(0, extra);
  }

  /// The panel already has the line: its desktop copy must not count twice.
  void _sendDeviceLog(String line, DurbunInspectorStore? panel) {
    if (panel == null) {
      _client.sendEncoded(line);
    } else {
      panel.withoutTap(() => _client.sendEncoded(line));
    }
  }

  void _onConfig(SdkConfig config) {
    if (_pendingDeviceLogs.isEmpty) return;
    final pending = List<String>.of(_pendingDeviceLogs);
    _pendingDeviceLogs.clear();
    if (_desktopWantsDeviceLogs != true) return;
    final panel = _panel;
    for (final line in pending) {
      _sendDeviceLog(line, panel);
    }
  }

  void _scheduleStatePush() {
    if (_statePushScheduled || _stopped) return;
    _statePushScheduled = true;
    scheduleMicrotask(() {
      _statePushScheduled = false;
      if (_stopped || _info == null) return;
      final state = jsonEncode(<String, Object?>{
        ..._client.describeState(),
        'deviceLogs': _deviceLogsState(),
      });
      if (state == _lastState) return;
      _lastState = state;
      _invoke('state', state);
    });
  }

  void _forwardCommand(Map<String, Object?> command) =>
      _invoke('command', jsonEncode(command));

  void _invoke(String method, Object? args) {
    try {
      unawaited(
        _channel.invokeMethod<Object?>(method, args).catchError((Object e) {
          _diagnostic('native $method failed: $e');
          return null;
        }),
      );
    } catch (e) {
      _diagnostic('native $method failed: $e');
    }
  }

  static void _diagnostic(String message) => DurbunClient.diagnostic(message);
}

/// A [BinaryMessenger] that talks to the engine through `dart:ui` directly, so
/// the native layer can be started before `WidgetsFlutterBinding` exists
/// (`Durbun.run` starts the SDK before the app body creates its binding).
/// Handlers are registered on `ui.channelBuffers`, exactly like the default
/// messenger does, so it keeps working after the binding is created.
class EarlyBinaryMessenger extends BinaryMessenger {
  const EarlyBinaryMessenger();

  @override
  Future<void> handlePlatformMessage(
    String channel,
    ByteData? data,
    ui.PlatformMessageResponseCallback? callback,
  ) async {
    callback?.call(null);
  }

  @override
  Future<ByteData?> send(String channel, ByteData? message) {
    final completer = Completer<ByteData?>();
    try {
      ui.PlatformDispatcher.instance.sendPlatformMessage(channel, message, (
        reply,
      ) {
        if (!completer.isCompleted) completer.complete(reply);
      });
    } catch (e) {
      if (!completer.isCompleted) completer.complete(null);
    }
    return completer.future;
  }

  @override
  void setMessageHandler(String channel, MessageHandler? handler) {
    if (handler == null) {
      ui.channelBuffers.clearListener(channel);
      return;
    }
    ui.channelBuffers.setListener(channel, (data, callback) async {
      ByteData? response;
      try {
        response = await handler(data);
      } catch (_) {
        response = null;
      } finally {
        callback(response);
      }
    });
  }
}

Object? _decode(Object? value) {
  if (value is String) {
    try {
      return jsonDecode(value);
    } catch (_) {
      return null;
    }
  }
  return value;
}

Map<String, Object?>? _decodeMap(Object? value) => _map(_decode(value));

Map<String, Object?>? _map(Object? value) => value is Map
    ? <String, Object?>{for (final e in value.entries) e.key.toString(): e.value}
    : null;

List<Object?> _list(Object? value) => value is List ? value : const <Object?>[];

List<Map<String, Object?>> _actionList(Object? value) => <Map<String, Object?>>[
  for (final a in _list(value))
    if (_map(a) case final m? when m['id'] is String) m,
];
