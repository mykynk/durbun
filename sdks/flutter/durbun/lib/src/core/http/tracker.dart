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
  /// stream failed after the headers arrived).
  void complete({
    required int status,
    String? statusText,
    required HeaderPairs headers,
    PendingBody? body,
    String? remoteAddress,
    String? protocol,
    Object? thenError,
  }) {
    if (_finished) return;
    sendRequest();
    _finished = true;
    markHeaders();
    final endUs = _nowUs;
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
