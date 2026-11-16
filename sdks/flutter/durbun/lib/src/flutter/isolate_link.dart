// Logs, events and dart:io HTTP from other isolates (`compute`,
// `Isolate.run`, `Isolate.spawn`, a background engine in the same process)
// reach the SDK running in the app's main isolate through one port
// published under a fixed name. Nothing here may throw into the app.
import 'dart:async';
import 'dart:io' show HttpOverrides;
import 'dart:isolate';
import 'dart:typed_data';
import 'dart:ui' show IsolateNameServer;

import '../core/client.dart';
import '../core/http/http_client.dart';
import '../core/json_safe.dart';
import '../core/mocks.dart';
import '../core/protocol.dart';
import '../core/streams/stream_host.dart';
import '../core/types.dart';

/// The name the main isolate's port is published under.
const String kDurbunIsolatePortName = 'dev.durbun.isolates';

/// The main isolate's end: publishes a port and feeds what other isolates
/// send into [client]. One per running SDK.
class IsolateHub {
  IsolateHub(this.client) {
    client.addConfigListener(_onConfig);
    try {
      final port = RawReceivePort(_onMessage, 'durbun.isolates');
      _port = port;
      // A port left by an earlier run (hot restart) is replaced.
      IsolateNameServer.removePortNameMapping(kDurbunIsolatePortName);
      IsolateNameServer.registerPortWithName(port.sendPort, kDurbunIsolatePortName);
    } catch (_) {
      // No name server (an embedder without it): other isolates stay silent.
    }
  }

  final DurbunClient client;
  RawReceivePort? _port;
  int _attached = 0;

  /// Ports of attached isolates that take settings updates (the newest
  /// [_maxSettingsPorts]; one goes stale when its isolate ends).
  final List<SendPort> _settingsPorts = <SendPort>[];
  static const int _maxSettingsPorts = 32;

  /// What an attached isolate's capture needs to know, live.
  Map<String, Object?> _settings() => <String, Object?>{
    'captureBodies': client.captureBodies,
    'maxBodyBytes': client.maxBodyBytes,
    'captureStreams': client.captureStreams,
    'streamsWanted': client.streamsWanted,
    'streamMessageCap': client.streamMessageCap,
  };

  void _onConfig(SdkConfig _) {
    if (_settingsPorts.isEmpty) return;
    final settings = _settings();
    for (final port in _settingsPorts) {
      try {
        port.send(settings);
      } catch (_) {}
    }
  }

  void _onMessage(Object? message) {
    if (client.isDisposed || message is! List || message.isEmpty) return;
    try {
      client.runInternal(() {
        switch (message[0]) {
          case 'log':
            client.sendLog(
              level: DurbunLogLevel.values[message[1]! as int],
              message: message[2]! as String,
              tag: message[3] as String?,
              data: _deep(message[4]),
              error: _deep(message[5]) as Map<String, Object?>?,
              ts: (message[6] as num?)?.toDouble(),
            );
          case 'event':
            client.event(message[1]! as String, _deep(message[2]) as Map<String, Object?>?);
          case 'attach':
            final reply = message[1]! as SendPort;
            if (message.length > 2 && message[2] is SendPort) {
              _settingsPorts.add(message[2]! as SendPort);
              if (_settingsPorts.length > _maxSettingsPorts) _settingsPorts.removeAt(0);
            }
            reply.send(<String, Object?>{
              'network': client.networkEnabled,
              ..._settings(),
              'redact': client.options.redactHeaders.map((h) => h.toLowerCase()).toList(),
              'prefix': 'isolate${++_attached}-',
            });
          case 'net':
            if (!client.networkEnabled) return;
            final net = _deep(message[1])! as Map<String, Object?>;
            // The isolate may not have heard of a config change yet.
            if (isStreamMessage(net) && !isFinalStreamMessage(net) && !client.captureStreams) return;
            client.sendNetMessage(net);
        }
      });
    } catch (_) {}
  }

  void dispose() {
    client.removeConfigListener(_onConfig);
    _settingsPorts.clear();
    final port = _port;
    _port = null;
    if (port == null) return;
    try {
      if (IsolateNameServer.lookupPortByName(kDurbunIsolatePortName) == port.sendPort) {
        IsolateNameServer.removePortNameMapping(kDurbunIsolatePortName);
      }
      port.close();
    } catch (_) {}
  }
}

/// Maps from another isolate group arrive as `Map<dynamic, dynamic>`; the
/// SDK reads them as `Map<String, Object?>`.
Object? _deep(Object? v) {
  if (v is Map) return <String, Object?>{for (final e in v.entries) '${e.key}': _deep(e.value)};
  if (v is List && v is! TypedData) return <Object?>[for (final x in v) _deep(x)];
  return v;
}

/// The main isolate's port seen from this isolate, or null (no SDK running
/// in this process, or this is the main isolate before it started).
SendPort? _hub() {
  try {
    return IsolateNameServer.lookupPortByName(kDurbunIsolatePortName);
  } catch (_) {
    return null;
  }
}

/// `Durbun.log` in an isolate without the SDK: sent to the main isolate.
void forwardLog(DurbunLogLevel level, Object? message, String? tag, Object? data, Object? error, StackTrace? stackTrace) {
  try {
    final hub = _hub();
    if (hub == null) return;
    hub.send(<Object?>[
      'log',
      level.index,
      stringifyMessage(message),
      tag,
      data == null ? null : toJsonSafe(data),
      DurbunClient.errorInfo(error, stackTrace),
      nowEpochMs(),
    ]);
  } catch (_) {}
}

/// `Durbun.event` in an isolate without the SDK.
void forwardEvent(String name, Map<String, Object?>? props) {
  try {
    _hub()?.send(<Object?>['event', name, props == null ? null : toJsonSafe(props)]);
  } catch (_) {}
}

/// Whether this isolate's dart:io HTTP goes to the main isolate already.
bool _attached = false;

/// Installs the HTTP capture in this isolate; its requests are sent to the
/// main isolate. True when they are captured.
Future<bool> attachThisIsolate() async {
  if (_attached) return true;
  final hub = _hub();
  if (hub == null) return false;
  final reply = ReceivePort('durbun.attach');
  _RemoteHost? host;
  // Settings changes from the main isolate (body and stream capture); it
  // does not keep this isolate alive.
  final settings = RawReceivePort((Object? message) {
    if (message is Map) host?.apply(message);
  }, 'durbun.settings')
    ..keepIsolateAlive = false;
  try {
    hub.send(<Object?>['attach', reply.sendPort, settings.sendPort]);
    final answer = await reply.first.timeout(const Duration(seconds: 2));
    if (answer is! Map || answer['network'] != true) {
      settings.close();
      return false;
    }
    host = _RemoteHost(
      hub,
      prefix: answer['prefix'] as String? ?? 'isolate-',
      redacted: <String>{for (final h in (answer['redact'] as List?) ?? const <Object?>[]) '$h'},
    )..apply(answer);
    HttpOverrides.global = DurbunHttpOverrides(host, previous: HttpOverrides.current);
    _attached = true;
    return true;
  } catch (_) {
    settings.close();
    return false;
  } finally {
    reply.close();
  }
}

/// The capture host of an attached isolate: the main isolate's settings
/// (kept up to date by it), no mock rules (they live in the main isolate),
/// messages sent to the main isolate.
class _RemoteHost implements HttpCaptureHost, StreamCaptureHost {
  _RemoteHost(this._hub, {required this.prefix, required Set<String> redacted}) : _redacted = redacted;

  final SendPort _hub;
  final String prefix;
  final Set<String> _redacted;
  int _seq = 0;

  @override
  bool captureBodies = false;

  @override
  int maxBodyBytes = 0;

  @override
  bool captureStreams = false;

  @override
  bool streamsWanted = false;

  @override
  int streamMessageCap = 0;

  /// Takes the main isolate's settings.
  void apply(Map<Object?, Object?> settings) {
    captureBodies = settings['captureBodies'] == true;
    maxBodyBytes = (settings['maxBodyBytes'] as num?)?.toInt() ?? 0;
    captureStreams = settings['captureStreams'] == true;
    streamsWanted = settings['streamsWanted'] == true;
    streamMessageCap = (settings['streamMessageCap'] as num?)?.toInt() ?? 0;
  }

  @override
  bool get networkEnabled => true;

  @override
  bool isRedactedHeader(String lowerCaseName) => _redacted.contains(lowerCaseName);

  @override
  MockRule? matchMock(String method, String url) => null;

  @override
  Future<void>? get mocksReady => null;

  @override
  String nextRequestId() => '$prefix${++_seq}';

  @override
  void sendNetMessage(Map<String, Object?> message) {
    try {
      _hub.send(<Object?>['net', message]);
    } catch (_) {}
  }

  @override
  Timer startTimer(Duration duration, void Function() callback) => Zone.root.createTimer(duration, callback);
}
