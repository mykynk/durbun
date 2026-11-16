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

/// This package's version, sent in `hello.sdk` next to [kSdkName].
const String kSdkVersion = '0.2.0';

/// `DEFAULT_PORTS`.
const int kDefaultSdkPort = 9751;
const int kDeviceSdkFirstPort = 9752;
const int kDeviceSdkLastPort = 9755;

/// `MAX_FRAME_BYTES`: max size of one NDJSON line.
const int kMaxFrameBytes = 16 * 1024 * 1024;

/// Highest `config.maxBodyBytes` the desktop accepts (its settings range,
/// `packages/server/src/config.ts`). A larger value from a peer is clamped,
/// so no peer can make the SDK hold huge bodies.
const int kMaxBodyBytesCeiling = 10 * 1024 * 1024;

/// Highest `config.maxStreamMessageBytes` the SDK honours: the desktop keeps
/// at most this much of one WebSocket message / SSE event
/// (`STREAM_MESSAGE_CAP` in `packages/server/src/hub/streams.ts`).
const int kMaxStreamMessageBytesCeiling = 64 * 1024;

/// Same as Flutter's `kReleaseMode` / `kProfileMode` / `kDebugMode`, without
/// importing Flutter.
const bool kDurbunReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kDurbunProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDurbunDebugMode = !kDurbunReleaseMode && !kDurbunProfileMode;

/// `--dart-define=DURBUN=true|false` given at build time.
const bool kDurbunDefineGiven = bool.hasEnvironment('DURBUN');

/// Value of `--dart-define=DURBUN=…` (false when not given).
const bool kDurbunDefine = bool.fromEnvironment('DURBUN');

/// Whether the SDK runs when `DurbunOptions.enabled` is null: debug and
/// profile builds yes, release builds only with `--dart-define=DURBUN=true`.
/// `--dart-define=DURBUN=false` turns it off in every build mode.
bool durbunEnabledByDefault({
  bool releaseMode = kDurbunReleaseMode,
  bool defineGiven = kDurbunDefineGiven,
  bool defineValue = kDurbunDefine,
}) => defineGiven ? defineValue : !releaseMode;

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
  static const String streams = 'streams';
}

/// `SdkLayer` values (`hello.sdk.layers`): the parts of the app that feed one
/// session. The Flutter SDK always sends `dart`, plus `android` / `ios` while
/// the plugin's native core is attached.
abstract final class SdkLayer {
  static const String dart = 'dart';
  static const String android = 'android';
  static const String ios = 'ios';
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
  /// A config with every field given; the SDK reads them with [fromJson].
  const SdkConfig({
    required this.captureBodies,
    required this.maxBodyBytes,
    required this.metricsIntervalMs,
    required this.deviceLogsAvailable,
    this.captureStreams = false,
    this.maxStreamMessageBytes = 0,
  });

  /// Used until the first `welcome` arrives (matches `DEFAULT_SETTINGS`;
  /// stream messages stay off until a desktop asks for them).
  static const SdkConfig defaults = SdkConfig(
    captureBodies: true,
    maxBodyBytes: 1048576,
    metricsIntervalMs: 1000,
    deviceLogsAvailable: false,
  );

  /// Whether request and response bodies are captured (sizes always are).
  final bool captureBodies;

  /// Bodies are cut after this many bytes (at most 10 MiB).
  final int maxBodyBytes;

  /// How often metric samples are sent, in milliseconds (at least 100).
  final int metricsIntervalMs;

  /// Whether the desktop reads the device's own logs (adb logcat, iOS
  /// syslog); `print` capture in `auto` mode stays off then, so lines are
  /// not shown twice.
  final bool deviceLogsAvailable;

  /// Whether `net.ws` / `net.sse` messages may be sent. Only a config that
  /// says `true` turns them on: an older desktop leaves the field out, which
  /// means off even when an earlier config had it on.
  final bool captureStreams;

  /// Payload cap of one stream message in bytes (0: sizes only), at most
  /// [kMaxStreamMessageBytesCeiling].
  final int maxStreamMessageBytes;

  /// Payload bytes of one stream message the SDK keeps right now: 0 when
  /// bodies are off.
  int get streamMessageCap => captureBodies ? maxStreamMessageBytes : 0;

  /// A copy with the given fields replaced.
  SdkConfig copyWith({bool? captureBodies}) => SdkConfig(
    captureBodies: captureBodies ?? this.captureBodies,
    maxBodyBytes: maxBodyBytes,
    metricsIntervalMs: metricsIntervalMs,
    deviceLogsAvailable: deviceLogsAvailable,
    captureStreams: captureStreams,
    maxStreamMessageBytes: maxStreamMessageBytes,
  );

  /// Tolerant parser: missing/invalid fields fall back to [fallback].
  static SdkConfig fromJson(Object? json, {SdkConfig fallback = defaults}) {
    if (json is! Map) return fallback;
    final maxBody = json['maxBodyBytes'];
    final interval = json['metricsIntervalMs'];
    final streamCap = json['maxStreamMessageBytes'];
    return SdkConfig(
      captureBodies: json['captureBodies'] is bool
          ? json['captureBodies'] as bool
          : fallback.captureBodies,
      maxBodyBytes: maxBody is num && !maxBody.isNaN && maxBody >= 0
          ? (maxBody > kMaxBodyBytesCeiling ? kMaxBodyBytesCeiling : maxBody.toInt())
          : fallback.maxBodyBytes,
      metricsIntervalMs: interval is num && interval.isFinite && interval >= 100
          ? interval.toInt()
          : fallback.metricsIntervalMs,
      deviceLogsAvailable: json['deviceLogsAvailable'] is bool
          ? json['deviceLogsAvailable'] as bool
          : fallback.deviceLogsAvailable,
      // Never inherited: absent (an older desktop) means no stream messages.
      captureStreams: json['captureStreams'] == true,
      maxStreamMessageBytes: streamCap is num && !streamCap.isNaN && streamCap >= 0
          ? (streamCap > kMaxStreamMessageBytesCeiling ? kMaxStreamMessageBytesCeiling : streamCap.toInt())
          : fallback.maxStreamMessageBytes,
    );
  }

  /// The config as wire JSON.
  Map<String, Object?> toJson() => {
    'captureBodies': captureBodies,
    'maxBodyBytes': maxBodyBytes,
    'metricsIntervalMs': metricsIntervalMs,
    'deviceLogsAvailable': deviceLogsAvailable,
    'captureStreams': captureStreams,
    'maxStreamMessageBytes': maxStreamMessageBytes,
  };

  @override
  String toString() => 'SdkConfig(${toJson()})';
}

/// `ServerWelcome`: the desktop's answer to the SDK's hello.
class ServerWelcome {
  /// A welcome with every field given; the SDK reads them with [fromJson].
  const ServerWelcome({
    required this.protocol,
    required this.server,
    required this.appId,
    required this.config,
    required this.mocks,
  });

  /// The desktop's protocol version.
  final int protocol;

  /// The desktop's name and version, e.g. `durbun/0.2.0`.
  final String server;

  /// The app session id the desktop gave this connection (e.g. `app:3`).
  final String appId;

  /// Settings that apply from now on.
  final SdkConfig config;

  /// The mock rules in force, first match wins.
  final List<MockRule> mocks;

  /// Reads a `welcome` message; missing fields get safe defaults.
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
  /// A captured body; [bytes] is at most [limit] long.
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

  /// The body's `content-type` header, if any.
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

/// Key of an outgoing message that is already encoded, i.e. a map with this
/// single key whose value is one JSON object as a string (lines produced by
/// the native layer of the Flutter plugin). The encoder writes it as is.
const String kEncodedLineKey = r'$durbunEncodedLine';

/// `[name, value]` header pairs from a map-like iteration.
typedef HeaderPairs = List<List<String>>;

Map<String, Object?> buildHello({
  required Map<String, Object?> app,
  required Map<String, Object?> device,
  required String session,
  required List<String> capabilities,
  required List<Map<String, Object?>> actions,
  String platform = 'flutter',
  List<String>? layers,
}) {
  return <String, Object?>{
    'type': 'hello',
    'protocol': kProtocolVersion,
    'sdk': <String, Object?>{
      'name': kSdkName,
      'version': kSdkVersion,
      'platform': platform,
      if (layers != null) 'layers': layers,
      // Mock rule conditions this SDK evaluates (the server sends conditional
      // rules only to SDKs listing them).
      'mockMatchers': kMockMatchers,
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
  bool noStream = false,
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
    // A 101 whose messages the SDK has no hook on: the desktop keeps it a
    // plain response instead of an open stream with no messages.
    if (noStream) 'noStream': true,
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

/// `SdkNetWs`: one WebSocket message of the connection whose handshake was
/// request [id]. [body] is omitted when payloads are not captured.
Map<String, Object?> buildNetWs({
  required String id,
  required double ts,
  required String dir,
  required String opcode,
  required int size,
  PendingBody? body,
  int? closeCode,
  String? closeReason,
}) {
  return <String, Object?>{
    'type': 'net.ws',
    'id': id,
    'ts': ts,
    'dir': dir,
    'opcode': opcode,
    'size': size,
    if (body != null) 'body': body.toMessageValue(),
    if (closeCode != null) 'closeCode': closeCode,
    if (closeReason != null && closeReason.isNotEmpty) 'closeReason': closeReason,
  };
}

/// `SdkNetSse`: one Server-Sent Events event of the response to request
/// [id], or the normal end of the stream ([end]).
Map<String, Object?> buildNetSse({
  required String id,
  required double ts,
  String? event,
  String? eventId,
  int? retry,
  int? size,
  PendingBody? body,
  bool end = false,
}) {
  if (end) return <String, Object?>{'type': 'net.sse', 'id': id, 'ts': ts, 'end': true};
  return <String, Object?>{
    'type': 'net.sse',
    'id': id,
    'ts': ts,
    if (event != null && event.isNotEmpty && event != 'message') 'event': event,
    if (eventId != null) 'eventId': eventId,
    if (retry != null) 'retry': retry,
    if (size != null) 'size': size,
    if (body != null) 'body': body.toMessageValue(),
  };
}

/// Whether [message] is a stream message (`net.ws` / `net.sse`): only sent
/// while `config.captureStreams` is true, dropped first under pressure.
bool isStreamMessage(Map<Object?, Object?> message) {
  final type = message['type'];
  if (type == 'net.ws' || type == 'net.sse') return true;
  final line = message[kEncodedLineKey];
  // A line of the plugin's native core (OkHttp / URLSession streams).
  return line is String && (line.contains('"type":"net.ws"') || line.contains('"type":"net.sse"'));
}

/// Whether [message] finishes a stream (a close frame, the SSE end): it goes
/// to every desktop that knows streams, also after `captureStreams` turned
/// off, so a stream that started is never left open.
bool isFinalStreamMessage(Map<Object?, Object?> message) {
  final type = message['type'];
  if (type != null) {
    return (type == 'net.ws' && message['opcode'] == 'close') || (type == 'net.sse' && message['end'] == true);
  }
  final line = message[kEncodedLineKey];
  if (line is! String) return false;
  return (line.contains('"type":"net.ws"') && line.contains('"opcode":"close"')) ||
      (line.contains('"type":"net.sse"') && line.contains('"end":true'));
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
