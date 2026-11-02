// Bridge to the native layer of the plugin (Kotlin core on Android, Swift core
// on iOS). Dart owns the only desktop connection; the native side is started
// from here (no native init call in the app), sends its encoded messages back
// over the channel and follows the desktop state (config, mocks) pushed from
// here. When the plugin is not registered (pure-Dart use, other platforms,
// unit tests) every call fails with MissingPluginException and the SDK simply
// runs without the native layer.
import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

import '../core/client.dart';
import '../core/options.dart';

/// Method channel shared with `DurbunFlutterPlugin` (Android + iOS).
const String kDurbunNativeChannel = 'dev.durbun/native';

/// What the native layer reported when it started.
class NativeStartInfo {
  const NativeStartInfo({
    required this.platform,
    required this.capabilities,
    required this.actions,
    required this.commands,
    required this.app,
    required this.capturesUrlSession,
  });

  final String platform;
  final List<String> capabilities;
  final List<Map<String, Object?>> actions;
  final Set<String> commands;
  final Map<String, Object?>? app;
  final bool capturesUrlSession;

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
    );
  }
}

class NativeBridge {
  NativeBridge(
    this._client, {
    MethodChannel? channel,
    bool? platformSupported,
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

  NativeStartInfo? _info;
  bool _stopped = false;
  bool _statePushScheduled = false;
  String? _lastState;

  /// Info from the native side once it attached (null otherwise).
  NativeStartInfo? get info => _info;

  bool get isAttached => _info != null && !_stopped;

  /// Starts the native layer for this session. Completes (never throws) once
  /// it attached, declined or turned out to be missing.
  Future<void> start(DurbunOptions options) async {
    if (!_platformSupported || _stopped) return;
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
      final reply = await _channel
          .invokeMethod<Object?>('start', args)
          .timeout(const Duration(seconds: 3));
      if (_stopped) return;
      final info = NativeStartInfo.parse(reply);
      if (info == null) {
        _diagnostic('native layer did not attach: ${_decodeMap(reply)?['reason'] ?? 'unknown reason'}');
        _channel.setMethodCallHandler(null);
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
      _client.addStateListener(_scheduleStatePush);
      _scheduleStatePush();
    } on MissingPluginException {
      // Plugin not registered (pure Dart, desktop platforms, tests).
      _safeClearHandler();
    } catch (e) {
      _diagnostic('native layer unavailable: $e');
      _safeClearHandler();
    }
  }

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _client.removeStateListener(_scheduleStatePush);
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

  /// Native → Dart calls.
  Future<Object?> _onNativeCall(MethodCall call) async {
    if (_stopped) return null;
    try {
      switch (call.method) {
        case 'events':
          final lines = call.arguments;
          if (lines is List) {
            for (final line in lines) {
              if (line is String) _client.sendEncoded(line);
            }
          }
          return null;
        case 'actions':
          _client.updateNativeActions(_actionList(_decode(call.arguments)));
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

  void _scheduleStatePush() {
    if (_statePushScheduled || _stopped) return;
    _statePushScheduled = true;
    scheduleMicrotask(() {
      _statePushScheduled = false;
      if (_stopped || _info == null) return;
      final state = jsonEncode(_client.describeState());
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
