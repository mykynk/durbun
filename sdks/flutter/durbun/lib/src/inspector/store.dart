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
import 'print_lines.dart';
import 'text_match.dart';

/// Turns a pending body marker map into a wire body map (`encoding`, `data`,
/// `size`, `truncated`). Supplied by the IO backend (`wireBodyFromPending`).
typedef InspectorBodyResolver = Map<String, Object?> Function(
    Map<Object?, Object?> pending);

/// Whether [host] matches one of [patterns]: `api.example.com` exactly,
/// `*.example.com` for it and its subdomains, `*` for all. No patterns: true.
bool hostMatchesPatterns(String host, List<String> patterns) {
  if (patterns.isEmpty) return true;
  final h = host.toLowerCase();
  for (final raw in patterns) {
    final p = raw.trim().toLowerCase();
    if (p.isEmpty) continue;
    if (p == '*' || p == h) return true;
    if (p.startsWith('*.')) {
      final base = p.substring(2);
      if (h == base || h.endsWith('.$base')) return true;
    }
  }
  return false;
}

/// Logcat tags of Android's own rendering, input and window machinery, as in
/// the desktop's default noise rules (plus the GPU stack of common phones).
const Set<String> _noisyDeviceLogTags = <String>{
  'chatty', 'OpenGLRenderer', 'InputMethodManager', 'InsetsController',
  'ImeTracker', 'BLASTBufferQueue', 'BLASTBufferQueue_Java', 'SurfaceFlinger',
  'SurfaceComposerClient', 'SurfaceView', 'Gralloc4', 'gralloc4', 'qdgralloc',
  'GraphicBufferAllocator', 'AHardwareBuffer', 'BufferQueueProducer',
  'EGL_emulation', 'HostConnection', 'libEGL', 'HWUI', 'vulkan',
  'AdrenoGLES-0', 'AdrenoVK-0', 'AdrenoUtils', 'CompatibilityChangeReporter',
  'CompatChangeReporter', 'AutofillManager', 'ProfileInstaller', 'FrameEvents',
  'InputTransport', 'TrafficStats', 'nativeloader',
};

/// Whether a device-log line with this tag is framework chatter: the tags
/// above, `ViewRootImpl…` / `VRI[…]` (touch dispatch per window), `SV[…]`
/// (SurfaceView) and Apple's own subsystems (`com.apple.…`).
bool isNoisyDeviceLogTag(Object? tag) {
  if (tag is! String) return false;
  return _noisyDeviceLogTags.contains(tag) ||
      tag.startsWith('ViewRootImpl') ||
      tag.startsWith('VRI[') ||
      tag.startsWith('SV[') ||
      tag.startsWith('com.apple.');
}

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
    this.cutChars = 0,
  });

  /// Longest message kept on the phone. Apps log whole response bodies (one
  /// HTML document can be hundreds of KB on a single line); the panel keeps
  /// the start, the desktop still gets all of it.
  static const int maxMessageChars = 64 * 1024;

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

  /// Characters cut from the end of [message] (see [maxMessageChars]).
  final int cutChars;

  /// [message] folded for search ([foldText]), computed once.
  late final String folded = foldText(message);

  bool get isError => level == 'error' || level == 'fatal' || kind == 'crash';

  bool get isCrash => kind == 'crash';
}

/// A captured body in wire form.
class InspectorBody {
  InspectorBody({
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

  /// [data] folded for search ([foldText]), computed on the first body
  /// search and kept with the body (a list search runs again on every store
  /// update; folding a large body each time froze the panel).
  String get folded => _folded ??= foldText(data);
  String? _folded;

  /// The text to show: pretty JSON when it is JSON. Computed once (the
  /// detail page rebuilds while other traffic arrives).
  String? get displayText =>
      isText ? (_display ??= prettyJson?.call(data) ?? data) : null;
  String? _display;

  /// Set by the inspector UI (format.dart) so this file needs no formatter.
  static String? Function(String text)? prettyJson;

  /// Bytes of the captured part (decoded base64 or UTF-8).
  Uint8List get bytes {
    if (isText) return Uint8List.fromList(utf8.encode(data));
    try {
      return base64Decode(data);
    } catch (_) {
      return Uint8List(0);
    }
  }

  /// The first [maxChars] characters of [data] (base64 cut on a whole
  /// group, a text never inside a surrogate pair), [truncated] when cut.
  InspectorBody head(int maxChars) {
    if (data.length <= maxChars) return this;
    var cut = isText ? maxChars : maxChars - maxChars % 4;
    if (isText && cut > 0) {
      final code = data.codeUnitAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    return InspectorBody(encoding: encoding, data: data.substring(0, cut), size: size, truncated: true);
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

  /// Grows whenever this call changes (response, error, bodies dropped), so
  /// a page about it rebuilds for its own changes only ([CallWatch]).
  int revision = 0;

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

  /// The bodies as they arrived (a pending marker map with the captured
  /// bytes, or a wire map), until they are resolved; then the resolved
  /// [InspectorBody] alone is kept.
  Object? _rawRequestBody;
  Object? _rawResponseBody;
  InspectorBody? _requestBody;
  InspectorBody? _responseBody;
  bool _requestResolved = false;
  bool _responseResolved = false;
  InspectorBodyResolver? _resolver;

  /// What each body counts against the store's budget: the captured bytes
  /// until it is resolved, then the resolved text.
  int _requestCost = 0;
  int _responseCost = 0;
  int get _bodyCost => _requestCost + _responseCost;

  /// Tells the store a resolved body costs a different amount.
  void Function(InspectorCall call, int delta)? _onCost;

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

  /// Parsed once (rows, filters and the header badge read it on every
  /// store update).
  late final Uri? uri = Uri.tryParse(url);

  /// The request body, decoded on first use (then the captured bytes are
  /// let go).
  InspectorBody? get requestBody {
    if (!_requestResolved) {
      _requestResolved = true;
      _requestBody = _resolve(_rawRequestBody, request: true);
    }
    return _requestBody;
  }

  /// The response body, decoded on first use (then the captured bytes are
  /// let go).
  InspectorBody? get responseBody {
    if (!_responseResolved) {
      _responseResolved = true;
      _responseBody = _resolve(_rawResponseBody, request: false);
    }
    return _responseBody;
  }

  bool get hasRequestBody => _rawRequestBody != null || _requestBody != null;
  bool get hasResponseBody => _rawResponseBody != null || _responseBody != null;

  /// The response body's size without decoding it (list rows): the
  /// resolved body's, else the size the capture reported (for a body still
  /// compressed, the compressed size).
  int? get responseSize => _sizeOf(_responseBody, _rawResponseBody);

  /// The request body's size without decoding it (statistics), as
  /// [responseSize].
  int? get requestSize => _sizeOf(_requestBody, _rawRequestBody);

  static int? _sizeOf(InspectorBody? resolved, Object? raw) {
    if (resolved != null) return resolved.size;
    if (raw is! Map) return null;
    final size = raw['size'];
    return size is num ? size.toInt() : null;
  }

  /// The request body without keeping a decoded copy: an export or the
  /// previous-run log reads every body once, and keeping them all would
  /// grow the store past its byte budget (and drop other bodies).
  InspectorBody? peekRequestBody() => _requestResolved ? _requestBody : _decode(_rawRequestBody);

  /// The response body without keeping a decoded copy ([peekRequestBody]).
  InspectorBody? peekResponseBody() => _responseResolved ? _responseBody : _decode(_rawResponseBody);

  /// The start of the request body (at most [maxBytes]) without keeping
  /// anything: the previous-run log keeps only that much. A captured body
  /// that is not compressed decodes only its start.
  InspectorBody? peekRequestStart(int maxBytes) =>
      _peekStart(_requestResolved, _requestBody, _rawRequestBody, maxBytes);

  /// The start of the response body ([peekRequestStart]).
  InspectorBody? peekResponseStart(int maxBytes) =>
      _peekStart(_responseResolved, _responseBody, _rawResponseBody, maxBytes);

  InspectorBody? _peekStart(bool resolved, InspectorBody? body, Object? raw, int maxBytes) {
    if (resolved) return body?.head(maxBytes);
    var source = raw;
    if (raw is Map && raw[kPendingBodyMarker] == true) {
      final bytes = raw['bytes'];
      final encoding = '${raw['contentEncoding'] ?? ''}'.trim().toLowerCase();
      final plain = encoding.isEmpty || encoding == 'identity';
      source = <Object?, Object?>{
        ...raw,
        // A compressed body keeps only this much once inflated.
        'limit': maxBytes,
        if (plain && bytes is Uint8List && bytes.length > maxBytes) ...<Object?, Object?>{
          'bytes': Uint8List.sublistView(bytes, 0, maxBytes),
          'truncated': true,
        },
      };
    }
    return _decode(source)?.head(maxBytes);
  }

  InspectorBody? _decode(Object? raw) {
    if (raw is! Map) return null;
    if (raw[kPendingBodyMarker] != true) return InspectorBody.fromWire(raw);
    final resolver = _resolver;
    if (resolver == null) return null;
    try {
      return InspectorBody.fromWire(resolver(raw));
    } catch (_) {
      return null;
    }
  }

  String? header(List<List<String>> headers, String name) {
    final lower = name.toLowerCase();
    for (final h in headers) {
      if (h.length >= 2 && h[0].toLowerCase() == lower) return h[1];
    }
    return null;
  }

  String? get requestContentType => header(requestHeaders, 'content-type');
  String? get responseContentType => header(responseHeaders, 'content-type');

  InspectorBody? _resolve(Object? raw, {required bool request}) {
    final body = _decode(raw);
    if (body == null) return null;
    // Only the resolved copy stays; the budget counts what is kept.
    final cost = body.data.length;
    final int delta;
    if (request) {
      _rawRequestBody = null;
      delta = cost - _requestCost;
      _requestCost = cost;
    } else {
      _rawResponseBody = null;
      delta = cost - _responseCost;
      _responseCost = cost;
    }
    if (delta != 0) _onCost?.call(this, delta);
    return body;
  }

  void _dropBodies() {
    _rawRequestBody = null;
    _rawResponseBody = null;
    _requestBody = null;
    _responseBody = null;
    _requestResolved = true;
    _responseResolved = true;
    _requestCost = 0;
    _responseCost = 0;
    bodiesDropped = true;
    revision++;
  }
}

/// Notifies when [call] changes, not on every store notification (the app's
/// logs notify the store up to five times a second).
class CallWatch extends ChangeNotifier {
  CallWatch(this.store, this.call) : _seen = call.revision {
    store.addListener(_check);
  }

  final DurbunInspectorStore store;
  final InspectorCall call;
  int _seen;

  void _check() {
    if (call.revision == _seen) return;
    _seen = call.revision;
    notifyListeners();
  }

  @override
  void dispose() {
    store.removeListener(_check);
    super.dispose();
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
    int maxLogs = kDefaultMaxLogs,
    int maxCalls = kDefaultMaxCalls,
    this.maxMetrics = 120,
    int maxBodyBytes = kDefaultMaxBodyBytes,
    this.notifyDelay = const Duration(milliseconds: 200),
  })  : _maxLogs = maxLogs < 1 ? 1 : maxLogs,
        _maxCalls = maxCalls < 1 ? 1 : maxCalls,
        _maxBodyBytes = maxBodyBytes < 0 ? 0 : maxBodyBytes;

  /// Default sizes of the rings ([DurbunInspector] can change them).
  static const int kDefaultMaxLogs = 2000;
  static const int kDefaultMaxCalls = 1000;
  static const int kDefaultMaxBodyBytes = 24 * 1024 * 1024;

  /// The store the SDK feeds (created on first use).
  static DurbunInspectorStore get instance =>
      _instance ??= DurbunInspectorStore();
  static DurbunInspectorStore? _instance;

  /// The store if one was created (does not create it).
  static DurbunInspectorStore? get existing => _instance;

  @visibleForTesting
  static set instance(DurbunInspectorStore store) => _instance = store;

  /// Log lines kept; the oldest go first.
  int get maxLogs => _maxLogs;
  int _maxLogs;
  set maxLogs(int value) {
    final v = value < 1 ? 1 : value;
    if (v == _maxLogs) return;
    _maxLogs = v;
    _trimLogs();
    _scheduleNotify();
  }

  /// Requests kept. Requests to hosts outside [defaultHosts] (hidden in the
  /// panel) go first, then the oldest.
  int get maxCalls => _maxCalls;
  int _maxCalls;
  set maxCalls(int value) {
    final v = value < 1 ? 1 : value;
    if (v == _maxCalls) return;
    _maxCalls = v;
    _trimCalls();
    _scheduleNotify();
  }

  /// Bytes of bodies kept (as text); past it the oldest bodies are dropped
  /// (other hosts' first), their requests stay.
  int get maxBodyBytes => _maxBodyBytes;
  int _maxBodyBytes;
  set maxBodyBytes(int value) {
    final v = value < 0 ? 0 : value;
    if (v == _maxBodyBytes) return;
    _maxBodyBytes = v;
    _enforceBodyBudget();
    _scheduleNotify();
  }

  final int maxMetrics;

  /// Listeners hear about changes at most this often (logs can arrive by the
  /// thousand per second; the UI must not rebuild per line).
  final Duration notifyDelay;

  InspectorBodyResolver? bodyResolver;

  /// A store rebuilt from a saved run (the previous run): the panel shows
  /// it without the live controls (Pause, Replay, Clear).
  bool readOnly = false;

  /// Whether the SDK feeds this store (false: off, or a release build).
  /// [attachedListenable] says when it changes: `Durbun.init()` may run
  /// after `runApp`, and the inspector then starts listening for shakes.
  bool get attached => _attached.value;
  set attached(bool value) => _attached.value = value;
  final ValueNotifier<bool> _attached = ValueNotifier<bool>(false);
  ValueListenable<bool> get attachedListenable => _attached;

  final ListQueue<InspectorLog> _logs = ListQueue<InspectorLog>();
  final ListQueue<InspectorCall> _calls = ListQueue<InspectorCall>();
  final Map<String, InspectorCall> _callsByKey = <String, InspectorCall>{};
  final ListQueue<InspectorMetric> _metrics = ListQueue<InspectorMetric>();
  int _seq = 0;
  int _bodyBytes = 0;
  int _droppedLogs = 0;
  int _droppedCalls = 0;
  int _droppedOtherHostCalls = 0;
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

  /// The last `hello` (app, device, sdk layers): the running client's, or
  /// one that passed through [ingest].
  Map<String, Object?>? get hello {
    try {
      return helloProvider?.call() ?? _hello;
    } catch (_) {
      return _hello;
    }
  }

  /// Set by the IO backend: builds the client's current hello.
  Map<String, Object?>? Function()? helloProvider;

  /// Hosts the panel lists by default ([DurbunInspector.defaultHosts]):
  /// exact names or `*.example.com`. Empty: every host. Calls to other
  /// hosts are still captured (and sent to the desktop); the panel hides
  /// them until they are ticked in its filters.
  List<String> defaultHosts = const <String>[];

  bool isDefaultHost(String host) => hostMatchesPatterns(host, defaultHosts);

  /// Whether the panel is on screen (set by `DurbunInspector`). The native
  /// layer reads the app's own os_log lines more often while it is.
  final ValueNotifier<bool> panelOpen = ValueNotifier<bool>(false);

  /// Where the native layer reads the app's own device-log lines from:
  /// `logcat`, `os_log` (iOS 15+), `off` (`capturePrint: never`) or null
  /// (no native layer, or iOS 13/14).
  String? nativeDeviceLogs;

  /// Takes one of the app's own device-log lines (logcat / os_log, encoded
  /// by the native layer). Framework chatter ([isNoisyDeviceLogTag]) stays
  /// out: the panel keeps a bounded number of lines and that chatter would
  /// push the app's own lines out. The desktop's copy is not filtered here.
  void ingestDeviceLog(String line) {
    if (_disposed) return;
    try {
      final decoded = jsonDecode(line);
      if (decoded is! Map<String, Object?>) return;
      if (isNoisyDeviceLogTag(decoded['tag'])) return;
      _take(decoded, native: true);
    } catch (_) {
      // A malformed line must never reach the app.
    }
  }

  /// Lines evicted since the last [clear] (the ring is full).
  int get droppedLogs => _droppedLogs;

  /// Requests to listed hosts ([defaultHosts]) evicted since the last
  /// [clear] (the panel says so under the list).
  int get droppedCalls => _droppedCalls;

  /// Requests to other hosts evicted since the last [clear]; they go first.
  int get droppedOtherHostCalls => _droppedOtherHostCalls;

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

  /// Grows with every [clear] (lists let go of rows kept from before).
  int get clears => _clears;
  int _clears = 0;

  void clear() {
    _clears++;
    _logs.clear();
    _calls.clear();
    _callsByKey.clear();
    _metrics.clear();
    _bodyBytes = 0;
    _droppedLogs = 0;
    _droppedCalls = 0;
    _droppedOtherHostCalls = 0;
    _errorsTotal = 0;
    _seenErrors = 0;
    _failuresTotal = 0;
    _seenFailures = 0;
    _scheduleNotify();
  }

  late final PrintLineAssembler _prints = PrintLineAssembler(_addPrint);
  int _tapMuted = 0;

  /// Takes a captured `print` / `debugPrint` line straight from the app,
  /// whether or not it is also sent to the desktop. PrettyPrinter boxes
  /// (logger package) become one entry.
  void ingestPrint(String line, double ts) {
    if (_disposed) return;
    try {
      _prints.add(line, ts);
    } catch (_) {}
  }

  /// Runs [send] with [ingest] ignoring what it sends: print lines reach the
  /// panel through [ingestPrint], so their desktop copy must not count twice.
  void withoutTap(void Function() send) {
    _tapMuted++;
    try {
      send();
    } finally {
      _tapMuted--;
    }
  }

  void _addPrint(PrintEntry e) {
    if (_disposed) return;
    _addLog(
      InspectorLog(
        seq: ++_seq,
        ts: e.ts,
        level: e.level,
        message: _cap(e.message),
        cutChars: _cutOf(e.message),
        tag: e.tag,
        error: e.stack == null && e.error == null
            ? null
            : <String, Object?>{
                if (e.error != null) 'message': e.error,
                if (e.stack != null) 'stack': e.stack,
              },
        kind: 'text',
      ),
    );
  }

  /// Takes one outgoing SDK message. Never throws, never mutates [message].
  void ingest(Map<String, Object?> message) {
    if (_disposed || _tapMuted > 0) return;
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

  /// Takes one wire message as the [native] or Dart layer sent it: a saved
  /// run is rebuilt this way (`run_log.dart`). Never throws.
  void restore(Map<String, Object?> message, {required bool native}) {
    if (_disposed) return;
    try {
      _take(message, native: native);
    } catch (_) {
      // A damaged record is skipped.
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
            message: _cap(m['message'] is String ? m['message'] as String : ''),
            cutChars: _cutOf(m['message']),
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
    _trimLogs();
    _scheduleNotify();
  }

  // Evicted lines still count in the totals (the badge says what happened).
  void _trimLogs() {
    while (_logs.length > _maxLogs) {
      _logs.removeFirst();
      _droppedLogs++;
    }
  }

  bool _listed(InspectorCall call) => isDefaultHost(call.uri?.host ?? '');

  /// Evicts requests over [maxCalls]: the oldest to a host outside
  /// [defaultHosts] first (the panel does not list them), then the oldest.
  void _trimCalls() {
    while (_calls.length > _maxCalls) {
      InspectorCall? gone;
      if (defaultHosts.isNotEmpty) {
        for (final c in _calls) {
          if (!_listed(c)) {
            gone = c;
            break;
          }
        }
      }
      gone ??= _calls.first;
      _calls.remove(gone);
      _callsByKey.remove(gone.key);
      _bodyBytes -= gone._bodyCost;
      gone._onCost = null;
      if (_listed(gone)) {
        _droppedCalls++;
      } else {
        _droppedOtherHostCalls++;
      }
    }
  }

  void _costChanged(InspectorCall call, int delta) {
    if (_disposed || !identical(_callsByKey[call.key], call)) return;
    _bodyBytes += delta;
    // Resolved while a page builds: dropping bodies (and notifying) waits.
    if (_bodyBytes > _maxBodyBytes) {
      scheduleMicrotask(() {
        if (_disposed || _bodyBytes <= _maxBodyBytes) return;
        _enforceBodyBudget();
        _scheduleNotify();
      });
    }
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
    )
      .._resolver = bodyResolver
      .._onCost = _costChanged;
    _setBody(call, m['body'], request: true);
    final previous = _callsByKey.remove(key);
    if (previous != null) {
      _calls.remove(previous);
      _bodyBytes -= previous._bodyCost;
      previous._onCost = null;
    }
    _calls.addLast(call);
    _callsByKey[key] = call;
    _trimCalls();
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
    call.revision++;
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
    call.revision++;
    if (!wasFailure && !call.cancelled) _failuresTotal++;
    _scheduleNotify();
  }

  void _setBody(InspectorCall call, Object? body, {required bool request}) {
    if (body is! Map) return;
    final cost = _bodyCostOf(body);
    if (request) {
      _bodyBytes -= call._requestCost;
      call
        .._rawRequestBody = body
        .._requestBody = null
        .._requestResolved = false
        .._requestCost = cost;
    } else {
      _bodyBytes -= call._responseCost;
      call
        .._rawResponseBody = body
        .._responseBody = null
        .._responseResolved = false
        .._responseCost = cost;
    }
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

  /// Drops the bodies of the oldest calls until the budget fits: calls to
  /// hosts outside [defaultHosts] first.
  void _enforceBodyBudget() {
    if (_bodyBytes <= _maxBodyBytes) return;
    for (final otherHostsOnly in <bool>[if (defaultHosts.isNotEmpty) true, false]) {
      for (final call in _calls) {
        if (_bodyBytes <= _maxBodyBytes) return;
        if (call._bodyCost == 0 || (otherHostsOnly && _listed(call))) continue;
        _bodyBytes -= call._bodyCost;
        call._dropBodies();
      }
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
    _prints.dispose();
    _notifyTimer?.cancel();
    _notifyTimer = null;
    if (identical(_instance, this)) _instance = null;
    super.dispose();
  }

  static String _cap(String m) => m.length <= InspectorLog.maxMessageChars
      ? m
      : m.substring(0, InspectorLog.maxMessageChars);

  static int _cutOf(Object? m) => m is String && m.length > InspectorLog.maxMessageChars
      ? m.length - InspectorLog.maxMessageChars
      : 0;

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
