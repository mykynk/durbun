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
import '../core/streams/sse_parser.dart' show isEventStreamContentType;
import '../core/streams/stream_host.dart';
import 'panel_tools.dart';
import 'print_lines.dart';
import 'streams.dart';
import 'text_match.dart';

export 'streams.dart';

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

  /// Keeps [text] as [displayText] when it was made elsewhere (a large body
  /// is pretty-printed off the main isolate).
  void cacheDisplayText(String? text) {
    if (text != null && isText) _display ??= text;
  }

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
    required String url,
    required this.requestHeaders,
    required this.source,
    required this.native,
  }) : _url = url;

  final String key;
  final String id;
  final int seq;
  final double ts;
  final String method;

  /// The request's URL (a WebSocket's `ws(s)://` once the panel knows the
  /// connection is one).
  String get url => _url;
  String _url;
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

  /// The messages of the connection this request opened (a WebSocket, an
  /// event stream), once the panel follows them or one arrived.
  InspectorStream? stream;

  /// The SDK saw this handshake but has no hook on its messages
  /// (`net.response.noStream`).
  bool noStream = false;

  /// A WebSocket or an event stream, by its messages or, without them, by
  /// its handshake (a 101 upgrade to `websocket`, a `text/event-stream`
  /// response); null for any other request.
  StreamKind? get connectionKind {
    final s = stream;
    if (s != null) return s.kind;
    if (status == 101) {
      final upgrade = (header(responseHeaders, 'upgrade') ?? header(requestHeaders, 'upgrade') ?? '').toLowerCase();
      if (upgrade.contains('websocket') || url.startsWith('ws')) return StreamKind.webSocket;
      return null;
    }
    if (status != null && isEventStreamContentType(responseContentType)) return StreamKind.sse;
    return null;
  }

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

  Duration? get duration {
    final end = endTs;
    if (end == null) return null;
    final us = (end - ts) * 1000;
    return us.isFinite ? Duration(microseconds: us.round()) : null;
  }

  /// Parsed once (rows, filters and the header badge read it on every
  /// store update).
  Uri? get uri {
    if (!_uriParsed) {
      _uriParsed = true;
      _uri = Uri.tryParse(_url);
    }
    return _uri;
  }

  Uri? _uri;
  bool _uriParsed = false;

  void _setUrl(String url) {
    _url = url;
    _uriParsed = false;
    _uri = null;
  }

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
    this.cpu,
    this.threads,
  });

  final double ts;
  final double? fps;
  final int? jankyFrames;
  final double? frameBuildMs;
  final double? frameRasterMs;
  final double? memoryMB;
  final double? cpu;
  final int? threads;
}

/// The on-device store behind the in-app inspector.
///
/// It also keeps the messages of WebSockets and event streams
/// ([LocalStreamSink]), apart from what goes to the desktop: per connection
/// at most [maxStreamMessages] (the first [kStreamHeadKept] stay longest,
/// then the newest), each payload cut at [streamMessageCap] bytes (the size
/// stays the true one), and across connections at most
/// [maxStreamBytes] of payload and [maxStreamMessagesTotal] messages, the
/// oldest closed connection's messages going first.
class DurbunInspectorStore extends ChangeNotifier implements LocalStreamSink {
  DurbunInspectorStore({
    int maxLogs = kDefaultMaxLogs,
    int maxCalls = kDefaultMaxCalls,
    this.maxMetrics = 120,
    int maxBodyBytes = kDefaultMaxBodyBytes,
    this.notifyDelay = const Duration(milliseconds: 200),
    this.maxStreamMessages = kDefaultStreamMessages,
    this.streamMessageCap = kDefaultStreamMessageCap,
    this.maxStreamBytes = kDefaultStreamBytes,
    this.maxStreamMessagesTotal = kDefaultStreamMessagesTotal,
  })  : _maxLogs = maxLogs < 1 ? 1 : maxLogs,
        _maxCalls = maxCalls < 1 ? 1 : maxCalls,
        _maxBodyBytes = maxBodyBytes < 0 ? 0 : maxBodyBytes;

  /// Default sizes of the rings ([DurbunInspector] can change them).
  static const int kDefaultMaxLogs = 2000;
  static const int kDefaultMaxCalls = 1000;
  static const int kDefaultMaxBodyBytes = 24 * 1024 * 1024;

  /// Messages kept per connection.
  static const int kDefaultStreamMessages = 500;

  /// The first messages of a connection kept longest (sign-in, subscribe).
  static const int kStreamHeadKept = 20;

  /// Payload bytes kept per message: a phone screen shows a few KB, and
  /// almost every chat, ticker or GraphQL message fits whole.
  static const int kDefaultStreamMessageCap = 16 * 1024;

  /// Payload bytes kept across all connections.
  static const int kDefaultStreamBytes = 8 * 1024 * 1024;

  /// Messages kept across all connections.
  static const int kDefaultStreamMessagesTotal = 5000;

  final int maxStreamMessages;
  final int streamMessageCap;
  final int maxStreamBytes;
  final int maxStreamMessagesTotal;

  /// Whether bodies are captured right now (set by the IO backend): a
  /// message without a payload then says why.
  bool Function()? captureBodiesNow;

  /// Bodies (and message payloads) are captured; true when unknown.
  bool get capturesBodies {
    try {
      return captureBodiesNow?.call() ?? true;
    } catch (_) {
      return true;
    }
  }

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

  /// Stream payload bytes and messages kept across connections.
  int _streamBytes = 0;
  int _streamHeld = 0;
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

  /// Slack incoming webhook for "Send to Slack" (`DurbunOptions.slackWebhook`
  /// or `--dart-define=DURBUN_SLACK_WEBHOOK`); null hides the button.
  String? slackWebhook;

  DurbunPanelTools _panelTools = const DurbunPanelTools();
  bool _networkBadge = true;
  bool _logsBadge = true;
  String? _slackSender;

  /// What Tools shows ([DurbunInspector.tools]).
  DurbunPanelTools get panelTools => _panelTools;

  /// Red counts on the Network and Logs tabs (and next to the Logs title)
  /// ([DurbunInspector.showNetworkBadge], [DurbunInspector.showLogsBadge]).
  bool get networkBadge => _networkBadge;
  bool get logsBadge => _logsBadge;

  /// The app's name for whoever sends to Slack from the panel
  /// ([DurbunInspector.slackSender]); a name typed on the phone wins.
  String? get slackSender => _slackSender;

  /// Takes the app's panel settings; an open panel follows at once.
  void configurePanel({
    DurbunPanelTools tools = const DurbunPanelTools(),
    bool networkBadge = true,
    bool logsBadge = true,
    String? slackSender,
  }) {
    final sender = slackSender?.trim();
    final name = sender == null || sender.isEmpty ? null : sender;
    if (tools == _panelTools && networkBadge == _networkBadge && logsBadge == _logsBadge && name == _slackSender) return;
    _panelTools = tools;
    _networkBadge = networkBadge;
    _logsBadge = logsBadge;
    _slackSender = name;
    // Called while the app builds (DurbunInspector's update): the panel's
    // listeners hear it right after that build.
    scheduleMicrotask(() {
      if (!_disposed) notifyListeners();
    });
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

  /// Grows with every [clear], [clearLogs] and [clearCalls] (lists let go
  /// of rows kept from before).
  int get clears => _clears;
  int _clears = 0;

  /// Removes the log lines only (Logs → Clear): requests and samples stay.
  void clearLogs() {
    _clears++;
    _logs.clear();
    _droppedLogs = 0;
    _errorsTotal = 0;
    _seenErrors = 0;
    _scheduleNotify();
  }

  /// Removes the requests only (Network → Clear), with their bodies and
  /// stream messages: log lines and samples stay.
  void clearCalls() {
    _clears++;
    for (final c in _calls) {
      c.stream?.releaseAll();
    }
    _calls.clear();
    _callsByKey.clear();
    _bodyBytes = 0;
    _streamBytes = 0;
    _streamHeld = 0;
    _droppedCalls = 0;
    _droppedOtherHostCalls = 0;
    _failuresTotal = 0;
    _seenFailures = 0;
    _scheduleNotify();
  }

  void clear() {
    _clears++;
    for (final c in _calls) {
      c.stream?.releaseAll();
    }
    _logs.clear();
    _calls.clear();
    _callsByKey.clear();
    _metrics.clear();
    _bodyBytes = 0;
    _streamBytes = 0;
    _streamHeld = 0;
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
            ts: _ts(m['ts']),
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
            ts: _ts(m['ts']),
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
      case 'net.ws':
        _onWireWs(m, native: native);
      case 'net.sse':
        _onWireSse(m, native: native);
      case 'metric':
        _metrics.addLast(
          InspectorMetric(
            ts: _ts(m['ts']),
            fps: _num(m['fps']),
            jankyFrames: _num(m['jankyFrames'])?.toInt(),
            frameBuildMs: _num(m['frameBuildMs']),
            frameRasterMs: _num(m['frameRasterMs']),
            memoryMB: _num(m['memoryMB']),
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
      _releaseStream(gone);
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
      ts: _ts(m['ts']),
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
    // The panel's own copy of a connection's handshake, then the same
    // handshake once the desktop takes its messages: one entry.
    if (_callsByKey[key]?.stream != null) return;
    _setBody(call, m['body'], request: true);
    final previous = _callsByKey.remove(key);
    if (previous != null) {
      _calls.remove(previous);
      _bodyBytes -= previous._bodyCost;
      previous._onCost = null;
      _releaseStream(previous);
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
      ..endTs = _ts(m['ts'])
      ..protocol = m['protocol'] as String?
      ..remoteAddress = m['remoteAddress'] as String?
      ..timings = _map(m['timings'])
      ..mocked = m['mocked'] == true
      ..mockRuleId = m['mockRuleId'] as String?
      ..noStream = m['noStream'] == true;
    _setBody(call, m['body'], request: false);
    call.revision++;
    if (!wasFailure && call.isFailure) _failuresTotal++;
    _enforceBodyBudget();
    _scheduleNotify();
  }

  void _onError(Map<String, Object?> m, {required bool native}) {
    final call = _callsByKey[_key(m['id'], native)];
    if (call == null) return;
    // A connection that opened: its stream ends (the handshake stays done).
    final ts = _ts(m['ts']);
    final stream = call.stream ??
        (call.status != null && call.connectionKind == StreamKind.webSocket
            ? _streamOf(call, StreamKind.webSocket, ts)
            : null);
    if (stream != null && call.status != null) {
      final cancelled = m['cancelled'] == true;
      _endStream(call, stream, ts,
          error: cancelled ? null : (m['error'] is String ? m['error'] as String : 'error'), cancelled: cancelled);
      return;
    }
    final wasFailure = call.isFailure;
    call
      ..error = m['error'] is String ? m['error'] as String : 'error'
      ..cancelled = m['cancelled'] == true
      ..endTs = _ts(m['ts'])
      ..mocked = call.mocked || m['mocked'] == true
      ..mockRuleId = call.mockRuleId ?? m['mockRuleId'] as String?;
    call.revision++;
    if (!wasFailure && !call.cancelled) _failuresTotal++;
    _scheduleNotify();
  }

  // ---------------------------------------------------------------------
  // Stream messages (WebSockets, event streams).

  @override
  bool get recordsStreams => attached && !_disposed && !readOnly;

  @override
  int get localStreamCap => streamMessageCap < 0 ? 0 : streamMessageCap;

  /// Stream messages kept right now across connections, and their payload
  /// bytes.
  int get streamMessagesHeld => _streamHeld;
  int get streamBytesHeld => _streamBytes;

  int get _headKept {
    final max = maxStreamMessages < 1 ? 1 : maxStreamMessages;
    return max >= kStreamHeadKept * 4 ? kStreamHeadKept : max ~/ 4;
  }

  InspectorStream _streamOf(InspectorCall call, StreamKind kind, double ts) {
    final existing = call.stream;
    if (existing != null) return existing;
    final s = InspectorStream(
      kind,
      openTs: call.endTs ?? ts,
      maxMessages: maxStreamMessages < 1 ? 1 : maxStreamMessages,
      headKept: _headKept,
    );
    call.stream = s;
    if (kind == StreamKind.webSocket) {
      final url = call.url;
      if (url.startsWith('https:')) {
        call._setUrl('wss:${url.substring(6)}');
      } else if (url.startsWith('http:')) {
        call._setUrl('ws:${url.substring(5)}');
      }
    }
    return s;
  }

  @override
  void streamOpened(
    String id, {
    required String kind,
    required double ts,
    String? url,
    int? status,
    String? statusText,
    List<List<String>>? headers,
  }) {
    if (!recordsStreams) return;
    try {
      final call = _callsByKey[_key(id, false)];
      if (call == null) return;
      if (call.status == null && status != null) {
        // An event stream the desktop gets as one body at its end: the panel
        // shows it open now.
        call
          ..status = status
          ..statusText = statusText
          ..responseHeaders = headers ?? const <List<String>>[]
          ..endTs = ts;
        if (call.isFailure) _failuresTotal++;
      }
      final s = _streamOf(call, kind == 'sse' ? StreamKind.sse : StreamKind.webSocket, ts);
      s.followed = true;
      if (url != null && url.isNotEmpty && url != call.url) call._setUrl(url);
      s.revision++;
      call.revision++;
      _scheduleNotify();
    } catch (_) {}
  }

  @override
  void streamWs(
    String id,
    double ts,
    String dir,
    String opcode,
    int size,
    Uint8List? data,
    int? closeCode,
    String? closeReason,
  ) {
    if (!recordsStreams) return;
    try {
      final call = _callsByKey[_key(id, false)];
      if (call == null) return;
      _addStreamMessage(call, StreamKind.webSocket, ts,
          out: dir == 'out',
          type: opcode,
          size: size,
          payload: data == null ? null : _keptBytes(data),
          truncated: data != null && size > data.length,
          closeCode: closeCode,
          closeReason: closeReason);
    } catch (_) {}
  }

  @override
  void streamSse(String id, double ts, String? event, String? eventId, int? retry, int size, Uint8List? data) {
    if (!recordsStreams) return;
    try {
      final call = _callsByKey[_key(id, false)];
      if (call == null) return;
      _addStreamMessage(call, StreamKind.sse, ts,
          out: false,
          type: 'event',
          size: size,
          payload: data == null ? null : _keptBytes(data),
          truncated: data != null && size > data.length,
          event: event == 'message' ? null : event,
          eventId: eventId,
          retry: retry);
    } catch (_) {}
  }

  @override
  void streamEnded(String id, double ts, {String? error, bool cancelled = false}) {
    if (!recordsStreams) return;
    try {
      final call = _callsByKey[_key(id, false)];
      final stream = call?.stream;
      if (call == null || stream == null) return;
      _endStream(call, stream, ts, error: error, cancelled: cancelled, sseEnded: error == null && !cancelled);
    } catch (_) {}
  }

  @override
  void localNet(Map<String, Object?> message) {
    if (!recordsStreams) return;
    try {
      _take(message, native: false);
    } catch (_) {}
  }

  /// A `net.ws` the SDK sent to the desktop (the panel keeps its copy).
  void _onWireWs(Map<String, Object?> m, {required bool native}) {
    final call = _callsByKey[_key(m['id'], native)];
    if (call == null) return;
    final (payload, base64, truncated) = _wirePayload(m['body']);
    final opcode = m['opcode'] is String ? m['opcode'] as String : 'text';
    _addStreamMessage(call, StreamKind.webSocket, _ts(m['ts']),
        out: m['dir'] == 'out',
        type: opcode,
        size: _num(m['size'])?.toInt() ?? 0,
        payload: opcode == 'close' ? null : payload,
        base64: base64,
        truncated: truncated,
        closeCode: _num(m['closeCode'])?.toInt(),
        closeReason: m['closeReason'] is String ? m['closeReason'] as String : null);
  }

  /// A `net.sse` the SDK sent to the desktop.
  void _onWireSse(Map<String, Object?> m, {required bool native}) {
    final call = _callsByKey[_key(m['id'], native)];
    if (call == null) return;
    final ts = _ts(m['ts']);
    if (m['end'] == true) {
      _endStream(call, _streamOf(call, StreamKind.sse, ts), ts, sseEnded: true);
      return;
    }
    final (payload, base64, truncated) = _wirePayload(m['body']);
    _addStreamMessage(call, StreamKind.sse, ts,
        out: false,
        type: 'event',
        size: _num(m['size'])?.toInt() ?? 0,
        payload: payload,
        base64: base64,
        truncated: truncated,
        event: m['event'] is String ? m['event'] as String : null,
        eventId: m['eventId'] is String ? m['eventId'] as String : null,
        retry: _num(m['retry'])?.toInt());
  }

  /// The kept part of a message body as the SDK sent it: a pending marker
  /// (bytes) or a wire map (text or base64), cut at [streamMessageCap].
  (Object?, bool, bool) _wirePayload(Object? body) {
    if (body is! Map) return (null, false, false);
    final truncated = body['truncated'] == true;
    if (body[kPendingBodyMarker] == true) {
      final bytes = body['bytes'];
      if (bytes is! Uint8List || bytes.isEmpty) return (null, false, truncated);
      final kept = _keptBytes(bytes);
      return (kept, false, truncated || kept.length < bytes.length);
    }
    final data = body['data'];
    if (data is! String || data.isEmpty) return (null, false, truncated);
    final cap = localStreamCap;
    if (cap <= 0) return (null, false, truncated);
    if (body['encoding'] == 'base64') {
      final max = (cap ~/ 3) * 4;
      return data.length <= max ? (data, true, truncated) : (data.substring(0, max), true, true);
    }
    if (data.length <= cap) return (data, false, truncated);
    var end = cap;
    if ((data.codeUnitAt(end - 1) & 0xFC00) == 0xD800) end--;
    return (data.substring(0, end), false, true);
  }

  /// At most [streamMessageCap] bytes of [b]; a copy when [b] is a view into
  /// a much larger buffer (a cut message must not keep the whole one).
  Uint8List _keptBytes(Uint8List b) {
    final cap = localStreamCap;
    final v = b.length > cap ? Uint8List.sublistView(b, 0, cap) : b;
    final buffer = v.buffer.lengthInBytes;
    return buffer > v.length * 2 && buffer - v.length > 4096 ? Uint8List.fromList(v) : v;
  }

  void _addStreamMessage(
    InspectorCall call,
    StreamKind kind,
    double ts, {
    required bool out,
    required String type,
    required int size,
    Object? payload,
    bool base64 = false,
    bool truncated = false,
    int? closeCode,
    String? closeReason,
    String? event,
    String? eventId,
    int? retry,
  }) {
    final s = _streamOf(call, kind, ts);
    final m = InspectorStreamMessage(
      seq: s.count + 1,
      ts: ts,
      out: out,
      type: type,
      size: size < 0 ? 0 : size,
      payload: payload,
      base64: base64,
      truncated: truncated,
      closeCode: closeCode,
      closeReason: closeReason,
      event: event,
      eventId: eventId,
      retry: retry,
    );
    final (gone, goneBytes) = s.add(m);
    _streamHeld += 1 - gone;
    _streamBytes += m.heldBytes - goneBytes;
    if (m.isClose && s.closedBy == null) {
      s
        ..closedBy = out ? 'out' : 'in'
        ..closeCode = closeCode
        ..closeReason = closeReason;
      if (s.state == StreamState.open) {
        s
          ..state = StreamState.closed
          ..endTs = ts;
      }
    }
    _enforceStreamBudget();
    call.revision++;
    _scheduleNotify();
  }

  void _endStream(
    InspectorCall call,
    InspectorStream s,
    double ts, {
    String? error,
    bool cancelled = false,
    bool sseEnded = false,
  }) {
    if (error != null) {
      s
        ..state = StreamState.failed
        ..error = error;
    } else if (s.state == StreamState.open) {
      s.state = StreamState.closed;
      if (cancelled) s.cancelled = true;
      if (sseEnded) s.sseEnded = true;
    }
    s.endTs ??= ts;
    s.revision++;
    call.revision++;
    _scheduleNotify();
  }

  /// Removes messages until the global limits fit: the oldest ended
  /// connection's first, then the oldest open one's.
  void _enforceStreamBudget() {
    bool over() => _streamBytes > maxStreamBytes || _streamHeld > maxStreamMessagesTotal;
    if (!over()) return;
    for (final endedOnly in const <bool>[true, false]) {
      for (final c in _calls) {
        final s = c.stream;
        if (s == null || s.held == 0 || (endedOnly && s.isOpen)) continue;
        while (over() && s.held > 0) {
          final b = s.evictOne();
          if (b < 0) break;
          _streamHeld--;
          _streamBytes -= b;
        }
        c.revision++;
        if (!over()) return;
      }
    }
  }

  void _releaseStream(InspectorCall call) {
    final s = call.stream;
    if (s == null) return;
    _streamHeld -= s.held;
    _streamBytes -= s.heldBytes;
    s.releaseAll();
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

  /// A message's time (epoch ms); one no date can hold (nanoseconds, a
  /// broken clock) reads as its arrival, so rows, reports and exports always
  /// have a real time.
  static double _ts(Object? v) {
    final ms = _num(v);
    return ms != null && ms.abs() < 8.6e15 ? ms : _now();
  }

  /// A number from a message; NaN and infinities read as missing (a
  /// status, time or sample the panel cannot round or plot).
  static double? _num(Object? v) => v is num && v.isFinite ? v.toDouble() : null;

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
