import 'dart:io';

import '../body.dart';
import '../json_safe.dart' show capString;
import '../mocks.dart';
import '../protocol.dart';
import 'recorder.dart';

/// Value shown for redacted headers.
const String kRedactedValue = '••••';

/// Lifecycle of one logical request: emits exactly one `net.request` followed
/// by one `net.response` and/or `net.error`, with phase timings.
class RequestTracker {
  RequestTracker(
    this.recorder, {
    required this.method,
    required this.url,
    this.mockRule,
    this.source = 'dart:io',
  }) : id = recorder.nextRequestId(),
       startEpochMs = nowEpochMs(),
       requestBody = BodyCapture(
         limit: recorder.maxBodyBytes,
         enabled: recorder.captureBodies,
       ),
       _clock = Stopwatch()..start();

  final NetworkRecorder recorder;
  final String id;
  final String method;
  final String url;
  final MockRule? mockRule;

  /// `net.request.source` (`dart:io`, `dio`, …).
  final String source;
  final double startEpochMs;
  final BodyCapture requestBody;
  final Stopwatch _clock;

  /// Live request headers / content type (set by the request wrapper so a
  /// late `net.request` still carries them).
  HeaderPairs Function()? headersSnapshot;
  String? Function()? contentTypeSnapshot;

  /// Time spent in a mock `delay`/`respond` wait (counted as server wait).
  int injectedDelayUs = 0;

  int? _openedUs;
  int? _closedUs;
  int? _headersUs;
  bool _requestSent = false;
  bool _finished = false;
  bool _aborted = false;

  bool get finished => _finished;
  bool get requestSent => _requestSent;
  bool get aborted => _aborted;
  bool get responseArrived => _headersUs != null;

  int get _nowUs => _clock.elapsedMicroseconds;

  double _epochAt(int us) => startEpochMs + us / 1000.0;

  void markOpened() => _openedUs ??= _nowUs;

  void markHeaders() => _headersUs ??= _nowUs;

  void markAborted() => _aborted = true;

  /// Emits `net.request` (once) with the body written so far.
  void sendRequest() {
    if (_requestSent) return;
    _requestSent = true;
    _closedUs ??= _nowUs;
    HeaderPairs headers = const <List<String>>[];
    String? contentType;
    try {
      headers = headersSnapshot?.call() ?? const <List<String>>[];
      contentType = contentTypeSnapshot?.call();
    } catch (_) {}
    recorder.sendNetMessage(
      buildNetRequest(
        id: id,
        ts: startEpochMs,
        method: method,
        url: url,
        headers: headers,
        body: requestBody.toPending(contentType: contentType),
        source: source,
      ),
    );
  }

  /// Emits `net.response`; with [thenError] also a `net.error` (the body
  /// stream failed after the headers arrived). [bodyUnread]: the app never
  /// read the body, so the exchange ends when the headers arrived (no made-up
  /// receive time).
  void complete({
    required int status,
    String? statusText,
    required HeaderPairs headers,
    PendingBody? body,
    String? remoteAddress,
    String? protocol,
    Object? thenError,
    bool bodyUnread = false,
  }) {
    if (_finished) return;
    sendRequest();
    _finished = true;
    markHeaders();
    final endUs = bodyUnread ? (_headersUs ?? _nowUs) : _nowUs;
    recorder.sendNetMessage(
      buildNetResponse(
        id: id,
        ts: _epochAt(endUs),
        status: status,
        statusText: statusText,
        headers: headers,
        body: body,
        protocol: protocol,
        remoteAddress: remoteAddress,
        timings: _timings(endUs),
        mocked: mockRule != null,
        mockRuleId: mockRule?.id,
      ),
    );
    if (thenError != null) {
      recorder.sendNetMessage(
        buildNetError(
          id: id,
          ts: _epochAt(_nowUs),
          error: describeNetError(thenError),
          mocked: mockRule != null,
          mockRuleId: mockRule?.id,
        ),
      );
    }
  }

  /// Emits `net.error` (after `net.request` if that was not sent yet).
  void fail(Object error, {bool cancelled = false}) {
    if (_finished) return;
    sendRequest();
    _finished = true;
    recorder.sendNetMessage(
      buildNetError(
        id: id,
        ts: _epochAt(_nowUs),
        error: describeNetError(error),
        cancelled: cancelled,
        mocked: mockRule != null,
        mockRuleId: mockRule?.id,
      ),
    );
  }

  Map<String, Object?> _timings(int endUs) {
    double ms(int us) => round2((us < 0 ? 0 : us) / 1000.0);
    final t = <String, Object?>{};
    final opened = _openedUs;
    final closed = _closedUs;
    final headers = _headersUs;
    if (opened != null) t['connect'] = ms(opened - injectedDelayUs);
    if (opened != null && closed != null) t['send'] = ms(closed - opened);
    if (closed != null && headers != null) {
      t['wait'] = ms(headers - closed + (opened == null ? 0 : injectedDelayUs));
    }
    if (headers != null) t['receive'] = ms(endUs - headers);
    return t;
  }
}

/// dart:io followed [redirects] on its own (inside the wrapped client, so
/// the hops never passed through Dürbün): [first] is completed with the first
/// 3xx and every hop becomes its own entry, as URLSession hops are reported.
/// Returns the tracker, method and URL of the last hop, which gets the final
/// response. Hop requests repeat the original headers (without `host`);
/// their 3xx responses carry only the `location` dart:io exposes.
(RequestTracker, String, Uri) reportRedirectHops(
  RequestTracker first,
  Uri firstUri,
  List<RedirectInfo> redirects,
) {
  var current = first;
  var uri = firstUri;
  final original = first.headersSnapshot;
  HeaderPairs hopHeaders() {
    final pairs = original?.call() ?? const <List<String>>[];
    return <List<String>>[
      for (final h in pairs)
        if (h.isNotEmpty && h[0].toLowerCase() != HttpHeaders.hostHeader) h,
    ];
  }

  for (final hop in redirects) {
    final next = uri.resolveUri(hop.location).removeFragment();
    current.complete(
      status: hop.statusCode,
      headers: <List<String>>[
        <String>[HttpHeaders.locationHeader, hop.location.toString()],
      ],
      protocol: 'HTTP/1.1',
    );
    final tracker = RequestTracker(
      first.recorder,
      method: hop.method.toUpperCase(),
      url: next.toString(),
    )..headersSnapshot = hopHeaders;
    tracker
      ..markOpened()
      ..sendRequest()
      ..markHeaders();
    current = tracker;
    uri = next;
  }
  return (current, current.method, uri);
}

/// Header pairs with redaction applied.
HeaderPairs headerPairs(HttpHeaders headers, NetworkRecorder recorder) {
  final out = <List<String>>[];
  try {
    headers.forEach((name, values) {
      final redact = recorder.isRedactedHeader(name.toLowerCase());
      for (final value in values) {
        out.add(<String>[name, redact ? kRedactedValue : value]);
      }
    });
  } catch (_) {}
  return out;
}

/// `ip:port` of the peer, or null.
String? remoteAddressOf(HttpConnectionInfo? info) {
  if (info == null) return null;
  try {
    final address = info.remoteAddress;
    final host = address.type == InternetAddressType.IPv6
        ? '[${address.address}]'
        : address.address;
    return '$host:${info.remotePort}';
  } catch (_) {
    return null;
  }
}

String describeNetError(Object error) {
  String text;
  try {
    text = error.toString();
  } catch (_) {
    text = error.runtimeType.toString();
  }
  return capString(text, 4000);
}
