/// The reporting handles behind `DurbunHttpCall.eventStream` and
/// `DurbunNetwork.webSocket`, for stacks Dürbün cannot see by itself.
library;

import '../http/recorder.dart';
import '../http/tracker.dart';
import '../protocol.dart';
import '../types.dart';
import 'sse_parser.dart';
import 'stream_reporter.dart';

/// An event stream read outside dart:io; its response was already reported.
class EventStreamCall extends DurbunEventStreamCall {
  EventStreamCall(this._reporter) {
    _parser = SseParser(_reporter.sseEvent);
  }

  /// The handle for [tracker]'s response, reported now without a body; null
  /// when stream messages are not wanted (the caller reports the response
  /// as usual then).
  static EventStreamCall? start(
    RequestTracker tracker, {
    required int status,
    String? statusText,
    required HeaderPairs headers,
  }) {
    final reporter = StreamReporter(tracker.recorder, tracker.id, mockRuleId: tracker.mockRule?.id);
    if (!reporter.sending || tracker.finished) return null;
    tracker.complete(status: status, statusText: statusText, headers: headers);
    reporter
      ..markStarted()
      ..announce('sse');
    return EventStreamCall(reporter);
  }

  final StreamReporter _reporter;
  late final SseParser _parser;

  @override
  void add(List<int> chunk) {
    try {
      if (_reporter.ended) return;
      _parser
        ..keepBytes = _reporter.wanted ? _reporter.cap : 0
        ..add(chunk);
    } catch (_) {}
  }

  @override
  void done() {
    try {
      _parser.close();
      _reporter.sseEnd();
    } catch (_) {}
  }

  @override
  void error(Object error, {bool cancelled = false}) {
    try {
      _parser.close();
      _reporter.fail(error, cancelled: cancelled);
    } catch (_) {}
  }
}

/// A WebSocket connection reported through the app's own calls. Nothing is
/// sent while the desktop does not take stream messages; the handshake is
/// reported (with its original start time) when the first message goes out.
class WebSocketCall extends DurbunWebSocketCall {
  WebSocketCall._(this._tracker, this._redact) : _reporter = StreamReporter(_tracker.recorder, _tracker.id);

  /// A handle for [url]; its request goes out now when the desktop takes
  /// stream messages. [redact] applies the app's header redaction.
  static WebSocketCall start(
    NetworkRecorder recorder, {
    required Uri url,
    required HeaderPairs headers,
    required String source,
    required HeaderPairs Function(HeaderPairs headers) redact,
  }) {
    var u = url.removeFragment();
    if (u.scheme == 'http' || u.scheme == 'https') u = u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws');
    final tracker = RequestTracker(recorder, method: 'GET', url: u.toString(), source: source);
    final redacted = redact(headers);
    tracker
      ..headersSnapshot = (() => redacted)
      ..markOpened();
    return WebSocketCall._(tracker, redact).._report();
  }

  final RequestTracker _tracker;
  final StreamReporter _reporter;
  final HeaderPairs Function(HeaderPairs headers) _redact;
  bool _requestReported = false;
  bool _opened = false;
  HeaderPairs? _openHeaders;
  int _openStatus = 101;
  String? _openStatusText;
  bool _responseReported = false;
  bool _failed = false;

  /// The in-app panel got the handshake (the desktop did not take stream
  /// messages then).
  bool _localRequest = false;
  bool _localResponse = false;

  @override
  String get id => _tracker.id;

  /// Reports what is not reported yet; true when the entry is on the
  /// desktop (now or earlier) or, while the desktop does not take stream
  /// messages, in the in-app panel.
  bool _report() {
    try {
      if (!_requestReported) {
        if (_failed) return false;
        if (!_reporter.sending) return _reportLocally();
        _requestReported = true;
        _tracker.sendRequest();
      }
      if (_opened && !_responseReported) {
        _responseReported = true;
        _tracker.complete(status: _openStatus, statusText: _openStatusText, headers: _openHeaders ?? <List<String>>[]);
        if (!_localResponse) _reporter.announce('ws');
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /// The handshake for the panel alone: nothing reaches the desktop. If it
  /// starts taking stream messages later, [_report] sends the handshake to
  /// it as before (the panel keeps one entry for both).
  bool _reportLocally() {
    final sink = _reporter.localSink;
    if (sink == null) return false;
    if (!_localRequest) {
      _localRequest = true;
      sink.localNet(_tracker.requestMessage());
    }
    if (_opened && !_localResponse) {
      _localResponse = true;
      sink.localNet(_tracker.responseMessage(
          status: _openStatus, statusText: _openStatusText, headers: _openHeaders ?? <List<String>>[]));
      _reporter.announce('ws');
    }
    return true;
  }

  @override
  void opened({
    int status = 101,
    String? statusText,
    List<List<String>> headers = const <List<String>>[],
    String? protocol,
  }) {
    if (_opened || _failed) return;
    _opened = true;
    try {
      final pairs = _redact(headers);
      if (protocol != null &&
          protocol.isNotEmpty &&
          !pairs.any((h) => h.isNotEmpty && h[0].toLowerCase() == 'sec-websocket-protocol')) {
        pairs.add(<String>['sec-websocket-protocol', protocol]);
      }
      _openHeaders = pairs;
      _openStatus = status;
      _openStatusText = statusText ?? (status == 101 ? 'Switching Protocols' : null);
    } catch (_) {}
    _report();
  }

  @override
  void sent(Object? message) {
    if (_report()) _reporter.wsData('out', message);
  }

  @override
  void received(Object? message) {
    if (!_opened) opened();
    if (_report()) _reporter.wsData('in', message);
  }

  @override
  void closeSent({int? code, String? reason}) {
    if (_requestReported || _report()) _reporter.wsClose('out', code: code, reason: reason);
  }

  @override
  void closeReceived({int? code, String? reason}) {
    if (!_opened) opened();
    if (_requestReported || _report()) _reporter.wsClose('in', code: code, reason: reason);
  }

  @override
  void failed(Object error) {
    if (_failed) return;
    try {
      if (!_opened) {
        // The handshake itself failed: a plain failed request, when it was
        // reported at all.
        _failed = true;
        if (_requestReported) {
          _tracker.fail(error);
        } else if (_localRequest) {
          _reporter.localSink?.localNet(buildNetError(id: id, ts: nowEpochMs(), error: describeNetError(error)));
        }
        return;
      }
      if (_requestReported || _report()) _reporter.fail(error);
    } catch (_) {}
  }
}
