/// On-device copy of what the SDK sends (logs, events, HTTP calls, metrics),
/// fed by `DurbunClient.outgoingTap`. It sees the same wire messages as the
/// desktop, native-encoded lines included, so the in-app inspector shows
/// Dart, OkHttp and URLSession traffic side by side. Must not import dart:io
/// (the web build compiles it too).
library;

import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/protocol.dart' show kEncodedLineKey, kPendingBodyMarker;

/// Turns a pending body marker map into a wire body map (`encoding`, `data`,
/// `size`, `truncated`). Supplied by the IO backend (`wireBodyFromPending`).
typedef InspectorBodyResolver = Map<String, Object?> Function(
    Map<Object?, Object?> pending);

/// One log line, event or crash.
class InspectorLog {
  InspectorLog({
    required this.seq,
    required this.ts,
    required this.level,
    required this.message,
    this.tag,
    this.data,
    this.error,
    this.kind,
    this.isEvent = false,
    this.native = false,
  });

  final int seq;

  /// Epoch milliseconds (device clock).
  final double ts;

  /// Wire level: verbose, debug, info, warn, error, fatal.
  final String level;
  final String message;
  final String? tag;
  final Object? data;

  /// `ErrorInfo`: `{type, message, stack}`.
  final Map<String, Object?>? error;

  /// `text`, `crash` or `flutter-error`.
  final String? kind;
  final bool isEvent;

  /// Came from the plugin's native layer (Kotlin / Swift).
  final bool native;

  bool get isError => level == 'error' || level == 'fatal' || kind == 'crash';

  bool get isCrash => kind == 'crash';
}

/// A captured body in wire form.
class InspectorBody {
  const InspectorBody({
    required this.encoding,
    required this.data,
    required this.size,
    this.truncated = false,
  });

  /// `utf8` or `base64`.
  final String encoding;
  final String data;

  /// Total size on the wire (bytes).
  final int size;
  final bool truncated;

  bool get isText => encoding == 'utf8';

  /// Bytes of the captured part (decoded base64 or UTF-8).
  Uint8List get bytes {
    if (isText) return Uint8List.fromList(utf8.encode(data));
    try {
      return base64Decode(data);
    } catch (_) {
      return Uint8List(0);
    }
  }

  static InspectorBody? fromWire(Object? wire) {
    if (wire is! Map) return null;
    final data = wire['data'];
    return InspectorBody(
      encoding: wire['encoding'] == 'base64' ? 'base64' : 'utf8',
      data: data is String ? data : '',
      size: (wire['size'] as num?)?.toInt() ?? 0,
      truncated: wire['truncated'] == true,
    );
  }
}

enum InspectorCallState { pending, done, failed }

/// One HTTP request and its outcome.
class InspectorCall {
  InspectorCall._({
    required this.key,
    required this.id,
    required this.seq,
    required this.ts,
    required this.method,
    required this.url,
    required this.requestHeaders,
    required this.source,
    required this.native,
  });

  final String key;
  final String id;
  final int seq;
  final double ts;
  final String method;
  final String url;
  final List<List<String>> requestHeaders;

  /// `dart:io`, `dio`, `okhttp`, `urlsession`, …
  final String source;
  final bool native;

  int? status;
  String? statusText;
  List<List<String>> responseHeaders = const <List<String>>[];
  double? endTs;
  String? error;
  bool cancelled = false;
  bool mocked = false;
  String? mockRuleId;
  String? protocol;
  String? remoteAddress;
  Map<String, Object?>? timings;

  /// Bodies dropped to stay inside the store's byte budget.
  bool bodiesDropped = false;

  Object? _rawRequestBody;
  Object? _rawResponseBody;
  InspectorBody? _requestBody;
  InspectorBody? _responseBody;
  InspectorBodyResolver? _resolver;
  int _bodyCost = 0;

  InspectorCallState get state => error != null
      ? InspectorCallState.failed
      : status != null
          ? InspectorCallState.done
          : InspectorCallState.pending;

  /// HTTP failure (4xx/5xx) or a transport error.
  bool get isFailure =>
      state == InspectorCallState.failed || (status != null && status! >= 400);

  Duration? get duration => endTs == null
      ? null
      : Duration(microseconds: ((endTs! - ts) * 1000).round());

  Uri? get uri => Uri.tryParse(url);

  InspectorBody? get requestBody => _requestBody ??= _resolve(_rawRequestBody);

  InspectorBody? get responseBody =>
      _responseBody ??= _resolve(_rawResponseBody);

  bool get hasRequestBody => _rawRequestBody != null || _requestBody != null;
  bool get hasResponseBody => _rawResponseBody != null || _responseBody != null;

  String? header(List<List<String>> headers, String name) {
    final lower = name.toLowerCase();
    for (final h in headers) {
      if (h.length >= 2 && h[0].toLowerCase() == lower) return h[1];
    }
    return null;
  }

  String? get requestContentType => header(requestHeaders, 'content-type');
  String? get responseContentType => header(responseHeaders, 'content-type');

  InspectorBody? _resolve(Object? raw) {
    if (raw is! Map) return null;
    if (raw[kPendingBodyMarker] == true) {
      final resolver = _resolver;
      if (resolver == null) return null;
      try {
        return InspectorBody.fromWire(resolver(raw));
      } catch (_) {
        return null;
      }
    }
    return InspectorBody.fromWire(raw);
  }

  void _dropBodies() {
    _rawRequestBody = null;
    _rawResponseBody = null;
    _requestBody = null;
    _responseBody = null;
    _bodyCost = 0;
    bodiesDropped = true;
  }
}

/// One `metric` sample.
class InspectorMetric {
  const InspectorMetric({
    required this.ts,
    this.fps,
    this.jankyFrames,
    this.frameBuildMs,
    this.frameRasterMs,
    this.memoryMB,
    this.heapMB,
    this.cpu,
    this.threads,
  });

  final double ts;
  final double? fps;
  final int? jankyFrames;
  final double? frameBuildMs;
  final double? frameRasterMs;
  final double? memoryMB;
  final double? heapMB;
  final double? cpu;
  final int? threads;
}

/// The on-device store behind the in-app inspector.
class DurbunInspectorStore extends ChangeNotifier {
  DurbunInspectorStore({
    this.maxLogs = 2000,
    this.maxCalls = 300,
    this.maxMetrics = 120,
    this.maxBodyBytes = 24 * 1024 * 1024,
    this.notifyDelay = const Duration(milliseconds: 200),
  });

  /// The store the SDK feeds (created on first use).
  static DurbunInspectorStore get instance =>
      _instance ??= DurbunInspectorStore();
  static DurbunInspectorStore? _instance;

  /// The store if one was created (does not create it).
  static DurbunInspectorStore? get existing => _instance;

  @visibleForTesting
  static set instance(DurbunInspectorStore store) => _instance = store;

  final int maxLogs;
  final int maxCalls;
  final int maxMetrics;
  final int maxBodyBytes;

  /// Listeners hear about changes at most this often (logs can arrive by the
  /// thousand per second; the UI must not rebuild per line).
  final Duration notifyDelay;

  InspectorBodyResolver? bodyResolver;

  /// Whether the SDK feeds this store (false: off, or a release build).
  bool attached = false;

  final ListQueue<InspectorLog> _logs = ListQueue<InspectorLog>();
  final ListQueue<InspectorCall> _calls = ListQueue<InspectorCall>();
  final Map<String, InspectorCall> _callsByKey = <String, InspectorCall>{};
  final ListQueue<InspectorMetric> _metrics = ListQueue<InspectorMetric>();
  int _seq = 0;
  int _bodyBytes = 0;
  int _droppedLogs = 0;
  int _droppedCalls = 0;
  int _errorsTotal = 0;
  int _seenErrors = 0;
  int _seenFailures = 0;
  int _failuresTotal = 0;
  Map<String, Object?>? _hello;
  Timer? _notifyTimer;
  bool _disposed = false;

  /// Oldest first.
  List<InspectorLog> get logs => List<InspectorLog>.unmodifiable(_logs);

  /// Oldest first.
  List<InspectorCall> get calls => List<InspectorCall>.unmodifiable(_calls);

  /// Oldest first.
  List<InspectorMetric> get metrics =>
      List<InspectorMetric>.unmodifiable(_metrics);

  InspectorMetric? get lastMetric => _metrics.isEmpty ? null : _metrics.last;

  /// The last `hello` (app, device, sdk layers).
  Map<String, Object?>? get hello => _hello;

  /// Lines / calls evicted since the last [clear] (the ring is full).
  int get droppedLogs => _droppedLogs;
  int get droppedCalls => _droppedCalls;

  /// Error and crash lines since the last [clear].
  int get errorCount => _errorsTotal;

  /// Failed requests (4xx/5xx or transport error) since the last [clear].
  int get failureCount => _failuresTotal;

  /// Errors and failed requests that arrived after the last [markSeen].
  int get unseenErrors =>
      (_errorsTotal - _seenErrors) + (_failuresTotal - _seenFailures);

  void markSeen() {
    if (_seenErrors == _errorsTotal && _seenFailures == _failuresTotal) return;
    _seenErrors = _errorsTotal;
    _seenFailures = _failuresTotal;
    _scheduleNotify();
  }

  /// Bytes of bodies kept right now.
  int get bodyBytes => _bodyBytes;

  InspectorCall? callByKey(String key) => _callsByKey[key];

  void clear() {
    _logs.clear();
    _calls.clear();
    _callsByKey.clear();
    _metrics.clear();
    _bodyBytes = 0;
    _droppedLogs = 0;
    _droppedCalls = 0;
    _errorsTotal = 0;
    _seenErrors = 0;
    _failuresTotal = 0;
    _seenFailures = 0;
    _scheduleNotify();
  }

  /// Takes one outgoing SDK message. Never throws, never mutates [message].
  void ingest(Map<String, Object?> message) {
    if (_disposed) return;
    try {
      final encoded = message[kEncodedLineKey];
      if (encoded is String) {
        final decoded = jsonDecode(encoded);
        if (decoded is Map<String, Object?>) _take(decoded, native: true);
        return;
      }
      _take(message, native: false);
    } catch (_) {
      // A malformed message must never reach the app.
    }
  }

  void _take(Map<String, Object?> m, {required bool native}) {
    switch (m['type']) {
      case 'log':
        _addLog(
          InspectorLog(
            seq: ++_seq,
            ts: _num(m['ts']) ?? _now(),
            level: m['level'] is String ? m['level'] as String : 'info',
            message: m['message'] is String ? m['message'] as String : '',
            tag: m['tag'] as String?,
            data: m['data'],
            error: _map(m['error']),
            kind: m['kind'] as String?,
            native: native,
          ),
        );
      case 'event':
        final props = m['props'];
        _addLog(
          InspectorLog(
            seq: ++_seq,
            ts: _num(m['ts']) ?? _now(),
            level: 'info',
            message: m['name'] is String ? m['name'] as String : '',
            data: props,
            isEvent: true,
            native: native,
          ),
        );
      case 'net.request':
        _onRequest(m, native: native);
      case 'net.response':
        _onResponse(m, native: native);
      case 'net.error':
        _onError(m, native: native);
      case 'metric':
        _metrics.addLast(
          InspectorMetric(
            ts: _num(m['ts']) ?? _now(),
            fps: _num(m['fps']),
            jankyFrames: _num(m['jankyFrames'])?.toInt(),
            frameBuildMs: _num(m['frameBuildMs']),
            frameRasterMs: _num(m['frameRasterMs']),
            memoryMB: _num(m['memoryMB']),
            heapMB: _num(m['heapMB']),
            cpu: _num(m['cpu']),
            threads: _num(m['threads'])?.toInt(),
          ),
        );
        while (_metrics.length > maxMetrics) {
          _metrics.removeFirst();
        }
        _scheduleNotify();
      case 'hello':
        _hello = Map<String, Object?>.of(m)..remove('actions');
        _scheduleNotify();
    }
  }

  void _addLog(InspectorLog log) {
    _logs.addLast(log);
    if (log.isError) _errorsTotal++;
    // Evicted lines still count in the totals (the badge says what happened).
    while (_logs.length > maxLogs) {
      _logs.removeFirst();
      _droppedLogs++;
    }
    _scheduleNotify();
  }

  // Dart ids are a counter, native ids carry a prefix (`okhttp-…`); the
  // layer is part of the key so the two never collide.
  String _key(Object? id, bool native) => '${native ? 'n' : 'd'}:$id';

  void _onRequest(Map<String, Object?> m, {required bool native}) {
    final id = '${m['id']}';
    final key = _key(id, native);
    final call = InspectorCall._(
      key: key,
      id: id,
      seq: ++_seq,
      ts: _num(m['ts']) ?? _now(),
      method: m['method'] is String ? m['method'] as String : 'GET',
      url: m['url'] is String ? m['url'] as String : '',
      requestHeaders: _headers(m['headers']),
      source: m['source'] is String
          ? m['source'] as String
          : (native ? 'native' : 'dart:io'),
      native: native,
    ).._resolver = bodyResolver;
    _setBody(call, m['body'], request: true);
    final previous = _callsByKey.remove(key);
    if (previous != null) _calls.remove(previous);
    _calls.addLast(call);
    _callsByKey[key] = call;
    while (_calls.length > maxCalls) {
      final gone = _calls.removeFirst();
      _callsByKey.remove(gone.key);
      _bodyBytes -= gone._bodyCost;
      _droppedCalls++;
    }
    _enforceBodyBudget();
    _scheduleNotify();
  }

  void _onResponse(Map<String, Object?> m, {required bool native}) {
    final call = _callsByKey[_key(m['id'], native)];
    if (call == null) return;
    final wasFailure = call.isFailure;
    call
      ..status = _num(m['status'])?.toInt()
      ..statusText = m['statusText'] as String?
      ..responseHeaders = _headers(m['headers'])
      ..endTs = _num(m['ts']) ?? _now()
      ..protocol = m['protocol'] as String?
      ..remoteAddress = m['remoteAddress'] as String?
      ..timings = _map(m['timings'])
      ..mocked = m['mocked'] == true
      ..mockRuleId = m['mockRuleId'] as String?;
    _setBody(call, m['body'], request: false);
    if (!wasFailure && call.isFailure) _failuresTotal++;
    _enforceBodyBudget();
    _scheduleNotify();
  }

  void _onError(Map<String, Object?> m, {required bool native}) {
    final call = _callsByKey[_key(m['id'], native)];
    if (call == null) return;
    final wasFailure = call.isFailure;
    call
      ..error = m['error'] is String ? m['error'] as String : 'error'
      ..cancelled = m['cancelled'] == true
      ..endTs = _num(m['ts']) ?? _now()
      ..mocked = call.mocked || m['mocked'] == true
      ..mockRuleId = call.mockRuleId ?? m['mockRuleId'] as String?;
    if (!wasFailure && !call.cancelled) _failuresTotal++;
    _scheduleNotify();
  }

  void _setBody(InspectorCall call, Object? body, {required bool request}) {
    if (body is! Map) return;
    final cost = _bodyCostOf(body);
    if (request) {
      call._rawRequestBody = body;
    } else {
      call._rawResponseBody = body;
    }
    call._bodyCost += cost;
    _bodyBytes += cost;
  }

  int _bodyCostOf(Map<Object?, Object?> body) {
    if (body[kPendingBodyMarker] == true) {
      final bytes = body['bytes'];
      return bytes is Uint8List ? bytes.length : 0;
    }
    final data = body['data'];
    return data is String ? data.length : 0;
  }

  /// Drops the bodies of the oldest calls until the budget fits.
  void _enforceBodyBudget() {
    if (_bodyBytes <= maxBodyBytes) return;
    for (final call in _calls) {
      if (_bodyBytes <= maxBodyBytes) break;
      if (call._bodyCost == 0) continue;
      _bodyBytes -= call._bodyCost;
      call._dropBodies();
    }
  }

  void _scheduleNotify() {
    if (_disposed || _notifyTimer != null) return;
    if (notifyDelay == Duration.zero) {
      notifyListeners();
      return;
    }
    _notifyTimer = Timer(notifyDelay, () {
      _notifyTimer = null;
      if (!_disposed) notifyListeners();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _notifyTimer?.cancel();
    _notifyTimer = null;
    if (identical(_instance, this)) _instance = null;
    super.dispose();
  }

  static double _now() => DateTime.now().microsecondsSinceEpoch / 1000.0;

  static double? _num(Object? v) => v is num ? v.toDouble() : null;

  static Map<String, Object?>? _map(Object? v) =>
      v is Map ? v.map((k, v) => MapEntry('$k', v)) : null;

  static List<List<String>> _headers(Object? v) {
    if (v is! List) return const <List<String>>[];
    return <List<String>>[
      for (final h in v)
        if (h is List && h.length >= 2) <String>['${h[0]}', '${h[1]}'],
    ];
  }
}
