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
import '../core/types.dart';

/// The name the main isolate's port is published under.
const String kDurbunIsolatePortName = 'dev.durbun.isolates';

/// The main isolate's end: publishes a port and feeds what other isolates
/// send into [client]. One per running SDK.
class IsolateHub {
  IsolateHub(this.client) {
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
            reply.send(<String, Object?>{
              'network': client.networkEnabled,
              'captureBodies': client.captureBodies,
              'maxBodyBytes': client.maxBodyBytes,
              'redact': client.options.redactHeaders.map((h) => h.toLowerCase()).toList(),
              'prefix': 'isolate${++_attached}-',
            });
          case 'net':
            if (client.networkEnabled) client.sendNetMessage(_deep(message[1])! as Map<String, Object?>);
        }
      });
    } catch (_) {}
  }

  void dispose() {
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
  try {
    hub.send(<Object?>['attach', reply.sendPort]);
    final answer = await reply.first.timeout(const Duration(seconds: 2));
    if (answer is! Map || answer['network'] != true) return false;
    final host = _RemoteHost(
      hub,
      prefix: answer['prefix'] as String? ?? 'isolate-',
      captureBodies: answer['captureBodies'] == true,
      maxBodyBytes: (answer['maxBodyBytes'] as num?)?.toInt() ?? 0,
      redacted: <String>{for (final h in (answer['redact'] as List?) ?? const <Object?>[]) '$h'},
    );
    HttpOverrides.global = DurbunHttpOverrides(host, previous: HttpOverrides.current);
    _attached = true;
    return true;
  } catch (_) {
    return false;
  } finally {
    reply.close();
  }
}

/// The capture host of an attached isolate: the main isolate's settings at
/// attach time, no mock rules (they live in the main isolate), messages sent
/// to the main isolate.
class _RemoteHost implements HttpCaptureHost {
  _RemoteHost(this._hub,
      {required this.prefix, required this.captureBodies, required this.maxBodyBytes, required Set<String> redacted})
      : _redacted = redacted;

  final SendPort _hub;
  final String prefix;
  final Set<String> _redacted;
  int _seq = 0;

  @override
  final bool captureBodies;

  @override
  final int maxBodyBytes;

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
