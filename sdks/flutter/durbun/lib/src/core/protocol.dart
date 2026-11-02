/// Dart mirror of the Dürbün wire protocol (`packages/protocol/src/index.ts`).
/// Field names must stay identical to the TypeScript source of truth.
///
/// Outgoing messages are plain JSON-like maps (they cross isolate boundaries);
/// the builders below are the only place that spells out their shapes.
library;

import 'dart:typed_data';

import 'mocks.dart';

/// `PROTOCOL_VERSION`.
const int kProtocolVersion = 1;

/// SDK identity sent in `hello.sdk`.
const String kSdkName = 'durbun-flutter';
const String kSdkVersion = '0.1.0';

/// `DEFAULT_PORTS`.
const int kDefaultSdkPort = 9751;
const int kDeviceSdkFirstPort = 9752;
const int kDeviceSdkLastPort = 9755;

/// `MAX_FRAME_BYTES`: max size of one NDJSON line.
const int kMaxFrameBytes = 16 * 1024 * 1024;

/// Same as Flutter's `kReleaseMode` / `kProfileMode` / `kDebugMode`, without
/// importing Flutter.
const bool kDurbunReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kDurbunProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDurbunDebugMode = !kDurbunReleaseMode && !kDurbunProfileMode;

/// Current time as epoch milliseconds with microsecond precision (device clock).
double nowEpochMs() => DateTime.now().microsecondsSinceEpoch / 1000.0;

/// `SdkCapability` values.
abstract final class SdkCapability {
  static const String logs = 'logs';
  static const String network = 'network';
  static const String mocks = 'mocks';
  static const String metrics = 'metrics';
  static const String events = 'events';
  static const String crash = 'crash';
  static const String commands = 'commands';
}

/// `LogKind` values an SDK may send.
abstract final class SdkLogKind {
  static const String text = 'text';
  static const String crash = 'crash';
  static const String flutterError = 'flutter-error';
}

/* ───────────────────────────── Incoming (ServerToSdk) ───────────────────────────── */

/// `SdkConfig` pushed by the desktop in `welcome` and `config` messages.
class SdkConfig {
  const SdkConfig({
    required this.captureBodies,
    required this.maxBodyBytes,
    required this.metricsIntervalMs,
    required this.deviceLogsAvailable,
  });

  /// Used until the first `welcome` arrives (matches `DEFAULT_SETTINGS`).
  static const SdkConfig defaults = SdkConfig(
    captureBodies: true,
    maxBodyBytes: 1048576,
    metricsIntervalMs: 1000,
    deviceLogsAvailable: false,
  );

  final bool captureBodies;
  final int maxBodyBytes;
  final int metricsIntervalMs;
  final bool deviceLogsAvailable;

  /// Tolerant parser: missing/invalid fields fall back to [fallback].
  static SdkConfig fromJson(Object? json, {SdkConfig fallback = defaults}) {
    if (json is! Map) return fallback;
    final maxBody = json['maxBodyBytes'];
    final interval = json['metricsIntervalMs'];
    return SdkConfig(
      captureBodies: json['captureBodies'] is bool
          ? json['captureBodies'] as bool
          : fallback.captureBodies,
      maxBodyBytes: maxBody is num && maxBody >= 0
          ? maxBody.toInt()
          : fallback.maxBodyBytes,
      metricsIntervalMs: interval is num && interval >= 100
          ? interval.toInt()
          : fallback.metricsIntervalMs,
      deviceLogsAvailable: json['deviceLogsAvailable'] is bool
          ? json['deviceLogsAvailable'] as bool
          : fallback.deviceLogsAvailable,
    );
  }

  Map<String, Object?> toJson() => {
    'captureBodies': captureBodies,
    'maxBodyBytes': maxBodyBytes,
    'metricsIntervalMs': metricsIntervalMs,
    'deviceLogsAvailable': deviceLogsAvailable,
  };

  @override
  String toString() => 'SdkConfig(${toJson()})';
}

/// `ServerWelcome`.
class ServerWelcome {
  const ServerWelcome({
    required this.protocol,
    required this.server,
    required this.appId,
    required this.config,
    required this.mocks,
  });

  final int protocol;
  final String server;
  final String appId;
  final SdkConfig config;
  final List<MockRule> mocks;

  static ServerWelcome fromJson(Map<Object?, Object?> json) {
    final protocol = json['protocol'];
    return ServerWelcome(
      protocol: protocol is num ? protocol.toInt() : kProtocolVersion,
      server: json['server']?.toString() ?? 'durbun',
      appId: json['appId']?.toString() ?? '',
      config: SdkConfig.fromJson(json['config']),
      mocks: MockRule.listFromJson(json['mocks']),
    );
  }
}

/* ───────────────────────────── Outgoing (SdkToServer) ───────────────────────────── */

/// A captured body whose wire form (`WireBody`: UTF-8 vs base64, gzip/deflate
/// decoding, truncation) is produced by the transport encoder, off the UI
/// isolate when the background transport is used.
class PendingBody {
  PendingBody({
    required this.bytes,
    required this.size,
    required this.truncated,
    required this.limit,
    required this.capture,
    this.contentType,
    this.contentEncoding,
  });

  /// Captured prefix (at most [limit] bytes).
  final Uint8List bytes;

  /// Total number of bytes seen on the stream.
  final int size;

  /// Whether [bytes] is shorter than the whole body.
  final bool truncated;

  /// `config.maxBodyBytes` at capture time.
  final int limit;

  /// `config.captureBodies` at capture time; false → only the size is sent.
  final bool capture;
  final String? contentType;

  /// Set when [bytes] are still compressed (e.g. `gzip` with
  /// `autoUncompress = false`, or `br`/`deflate` which dart:io never decodes).
  final String? contentEncoding;

  /// Marker map understood by the encoder (see `resolvePendingBodies`).
  Map<String, Object?> toMessageValue() => <String, Object?>{
    kPendingBodyMarker: true,
    'bytes': bytes,
    'size': size,
    'truncated': truncated,
    'limit': limit,
    'capture': capture,
    'contentType': contentType,
    'contentEncoding': contentEncoding,
  };
}

/// Key that marks a [PendingBody] map inside an outgoing message.
const String kPendingBodyMarker = r'$durbunPendingBody';

/// `[name, value]` header pairs from a map-like iteration.
typedef HeaderPairs = List<List<String>>;

Map<String, Object?> buildHello({
  required Map<String, Object?> app,
  required Map<String, Object?> device,
  required String session,
  required List<String> capabilities,
  required List<Map<String, Object?>> actions,
  String platform = 'flutter',
}) {
  return <String, Object?>{
    'type': 'hello',
    'protocol': kProtocolVersion,
    'sdk': <String, Object?>{
      'name': kSdkName,
      'version': kSdkVersion,
      'platform': platform,
    },
    'app': app,
    'device': device,
    'session': session,
    'capabilities': capabilities,
    'actions': actions,
    'ts': nowEpochMs(),
  };
}

Map<String, Object?> buildLog({
  required String level,
  required String message,
  double? ts,
  String? tag,
  Object? data,
  Map<String, Object?>? error,
  String? kind,
  int? tid,
}) {
  return <String, Object?>{
    'type': 'log',
    'ts': ts ?? nowEpochMs(),
    'level': level,
    if (tag != null) 'tag': tag,
    'message': message,
    if (data != null) 'data': data,
    if (error != null) 'error': error,
    if (kind != null) 'kind': kind,
    if (tid != null) 'tid': tid,
  };
}

/// `ErrorInfo`.
Map<String, Object?>? buildErrorInfo({
  String? type,
  String? message,
  String? stack,
}) {
  if (type == null && message == null && stack == null) return null;
  return <String, Object?>{
    if (type != null) 'type': type,
    if (message != null) 'message': message,
    if (stack != null && stack.isNotEmpty) 'stack': stack,
  };
}

Map<String, Object?> buildNetRequest({
  required String id,
  required double ts,
  required String method,
  required String url,
  required HeaderPairs headers,
  PendingBody? body,
  String source = 'dart:io',
}) {
  return <String, Object?>{
    'type': 'net.request',
    'id': id,
    'ts': ts,
    'method': method,
    'url': url,
    'headers': headers,
    if (body != null) 'body': body.toMessageValue(),
    'source': source,
  };
}

Map<String, Object?> buildNetResponse({
  required String id,
  required double ts,
  required int status,
  String? statusText,
  required HeaderPairs headers,
  PendingBody? body,
  String? protocol,
  String? remoteAddress,
  Map<String, Object?>? timings,
  bool mocked = false,
  String? mockRuleId,
}) {
  return <String, Object?>{
    'type': 'net.response',
    'id': id,
    'ts': ts,
    'status': status,
    if (statusText != null && statusText.isNotEmpty) 'statusText': statusText,
    'headers': headers,
    if (body != null) 'body': body.toMessageValue(),
    if (protocol != null) 'protocol': protocol,
    if (remoteAddress != null) 'remoteAddress': remoteAddress,
    if (timings != null && timings.isNotEmpty) 'timings': timings,
    if (mocked) 'mocked': true,
    if (mockRuleId != null) 'mockRuleId': mockRuleId,
  };
}

Map<String, Object?> buildNetError({
  required String id,
  required double ts,
  required String error,
  bool cancelled = false,
  bool mocked = false,
  String? mockRuleId,
}) {
  return <String, Object?>{
    'type': 'net.error',
    'id': id,
    'ts': ts,
    'error': error,
    if (cancelled) 'cancelled': true,
    if (mocked) 'mocked': true,
    if (mockRuleId != null) 'mockRuleId': mockRuleId,
  };
}

Map<String, Object?> buildEvent({
  required String name,
  Map<String, Object?>? props,
  double? ts,
}) {
  return <String, Object?>{
    'type': 'event',
    'ts': ts ?? nowEpochMs(),
    'name': name,
    if (props != null) 'props': props,
  };
}

Map<String, Object?> buildMetric({
  double? ts,
  double? cpu,
  double? memoryMB,
  double? heapMB,
  double? fps,
  int? jankyFrames,
  double? frameBuildMs,
  double? frameRasterMs,
  int? threads,
}) {
  return <String, Object?>{
    'type': 'metric',
    'ts': ts ?? nowEpochMs(),
    if (cpu != null) 'cpu': cpu,
    if (memoryMB != null) 'memoryMB': memoryMB,
    if (heapMB != null) 'heapMB': heapMB,
    if (fps != null) 'fps': fps,
    if (jankyFrames != null) 'jankyFrames': jankyFrames,
    if (frameBuildMs != null) 'frameBuildMs': frameBuildMs,
    if (frameRasterMs != null) 'frameRasterMs': frameRasterMs,
    if (threads != null) 'threads': threads,
  };
}

Map<String, Object?> buildCommandResult({
  required String id,
  required bool ok,
  Object? data,
  String? error,
}) {
  return <String, Object?>{
    'type': 'command.result',
    'id': id,
    'ok': ok,
    if (data != null) 'data': data,
    if (error != null) 'error': error,
  };
}

Map<String, Object?> buildActionsUpdate(List<Map<String, Object?>> actions) =>
    <String, Object?>{'type': 'actions', 'actions': actions};

Map<String, Object?> buildPong() => <String, Object?>{
  'type': 'pong',
  'ts': nowEpochMs(),
};

/// Rounds to 2 decimals (keeps metric payloads compact and readable).
double round2(double v) => (v * 100).roundToDouble() / 100;
