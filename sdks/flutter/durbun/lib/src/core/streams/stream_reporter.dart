/// Sends the messages of one stream entry (a WebSocket connection or an SSE
/// response) whose handshake was reported as request [StreamReporter.id].
///
/// Messages go out only while the desktop's latest config asks for them
/// (`captureStreams`). A stream whose reporting started is always finished
/// (its close frames, the SSE end, or `net.error`), also after the setting
/// turned off; one that never started stays the plain entry it was before
/// streams existed.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../http/recorder.dart';
import '../http/tracker.dart' show describeNetError;
import '../protocol.dart';
import 'sse_parser.dart';
import 'stream_host.dart';
import 'ws_frames.dart';

const String _textType = 'text/plain; charset=utf-8';
const String _binaryType = 'application/octet-stream';

class StreamReporter {
  StreamReporter(this.recorder, this.id, {this.mockRuleId});

  final NetworkRecorder recorder;

  /// The handshake request's id.
  final String id;

  /// Set when the handshake was answered by a mock rule.
  final String? mockRuleId;

  bool _ended = false;
  bool _started = false;

  /// Whether the entry ended (normal SSE end, failure or cancel).
  bool get ended => _ended;

  /// Whether a stream message (or an SSE response without body) went out:
  /// the desktop holds an open stream that must be finished.
  bool get started => _started;

  /// The handshake was reported as a stream (an SSE response at its headers).
  void markStarted() => _started = true;

  /// Close frames, the SSE end and failures go out while messages do, and
  /// always once the stream started.
  bool get _mayFinish => _networkOn() && (_started || sending);

  StreamCaptureHost? get _host {
    final r = recorder;
    return r is StreamCaptureHost ? r as StreamCaptureHost : null;
  }

  bool _networkOn() {
    try {
      return recorder.networkEnabled;
    } catch (_) {
      return false;
    }
  }

  /// Stream messages go out right now.
  bool get sending {
    try {
      return _networkOn() && (_host?.captureStreams ?? false);
    } catch (_) {
      return false;
    }
  }

  /// Stream messages are, or may soon be, wanted: keep decoding.
  bool get wanted {
    try {
      return _networkOn() && (_host?.streamsWanted ?? false);
    } catch (_) {
      return false;
    }
  }

  /// Payload bytes kept per message right now.
  int get cap {
    try {
      final c = _host?.streamMessageCap ?? 0;
      return c < 0 ? 0 : c;
    } catch (_) {
      return 0;
    }
  }

  PendingBody? _body(Uint8List? data, int size, {required bool text}) {
    if (data == null || size <= 0) return null;
    final limit = cap;
    if (limit <= 0) return null;
    final kept = data.length > limit ? Uint8List.sublistView(data, 0, limit) : data;
    return PendingBody(
      bytes: kept,
      size: size,
      truncated: size > kept.length,
      limit: limit,
      capture: true,
      contentType: text ? _textType : _binaryType,
    );
  }

  /// A WebSocket message or control frame read off the wire.
  void wsFrame(String dir, WsMessage message) {
    if (message.opcode == 'close' ? !_mayFinish : !sending) return;
    _started = true;
    try {
      recorder.sendNetMessage(buildNetWs(
        id: id,
        ts: nowEpochMs(),
        dir: dir,
        opcode: message.opcode,
        size: message.size,
        body: message.opcode == 'close' ? null : _body(message.data, message.size, text: message.opcode == 'text'),
        closeCode: message.closeCode,
        closeReason: _cut(message.closeReason),
      ));
    } catch (_) {}
  }

  /// A WebSocket message seen through an app-level wrapper: [data] is a
  /// String (text) or a list of bytes (binary).
  void wsData(String dir, Object? data) {
    if (!sending) return;
    _started = true;
    try {
      final limit = cap;
      if (data is String) {
        final bytes = limit > 0 ? _utf8Prefix(data, limit) : null;
        final size = utf8Length(data);
        recorder.sendNetMessage(buildNetWs(
          id: id,
          ts: nowEpochMs(),
          dir: dir,
          opcode: 'text',
          size: size,
          body: _body(bytes, size, text: true),
        ));
      } else if (data is List<int>) {
        final size = data.length;
        Uint8List? bytes;
        if (limit > 0) {
          final end = size < limit ? size : limit;
          bytes = data is Uint8List ? Uint8List.sublistView(data, 0, end) : Uint8List.fromList(data.sublist(0, end));
        }
        recorder.sendNetMessage(buildNetWs(
          id: id,
          ts: nowEpochMs(),
          dir: dir,
          opcode: 'binary',
          size: size,
          body: _body(bytes, size, text: false),
        ));
      }
    } catch (_) {}
  }

  /// A close frame seen through an app-level wrapper.
  void wsClose(String dir, {int? code, String? reason}) {
    if (!_mayFinish) return;
    _started = true;
    try {
      final reasonSize = reason == null ? 0 : utf8Length(reason);
      recorder.sendNetMessage(buildNetWs(
        id: id,
        ts: nowEpochMs(),
        dir: dir,
        opcode: 'close',
        size: code == null ? 0 : 2 + reasonSize,
        closeCode: code,
        closeReason: _cut(reason),
      ));
    } catch (_) {}
  }

  /// One dispatched SSE event.
  void sseEvent(SseEvent event) {
    if (_ended || !sending) return;
    try {
      recorder.sendNetMessage(buildNetSse(
        id: id,
        ts: nowEpochMs(),
        event: _cut(event.event),
        eventId: _cut(event.eventId),
        retry: event.retry,
        size: event.size,
        body: _body(event.data, event.size, text: true),
      ));
    } catch (_) {}
  }

  /// The event stream ended normally.
  void sseEnd() {
    if (_ended) return;
    _ended = true;
    if (!_mayFinish) return;
    try {
      recorder.sendNetMessage(buildNetSse(id: id, ts: nowEpochMs(), end: true));
    } catch (_) {}
  }

  /// The connection broke after it opened ([cancelled]: the app stopped
  /// reading). Sent once; not at all for a stream that never started while
  /// the desktop does not take stream messages (the entry stays as before).
  void fail(Object error, {bool cancelled = false}) {
    if (_ended) return;
    _ended = true;
    if (!_mayFinish) return;
    try {
      recorder.sendNetMessage(buildNetError(
        id: id,
        ts: nowEpochMs(),
        error: describeNetError(error),
        cancelled: cancelled,
        mocked: mockRuleId != null,
        mockRuleId: mockRuleId,
      ));
    } catch (_) {}
  }
}

/// The desktop keeps at most this many characters of `event`, `eventId` and
/// `closeReason`.
const int kMaxStreamLabelChars = 256;

String? _cut(String? text) {
  if (text == null || text.length <= kMaxStreamLabelChars) return text;
  var end = kMaxStreamLabelChars;
  if ((text.codeUnitAt(end - 1) & 0xFC00) == 0xD800) end--;
  return text.substring(0, end);
}

/// UTF-8 length of [text] without encoding it.
int utf8Length(String text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    final c = text.codeUnitAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if ((c & 0xFC00) == 0xD800 && i + 1 < text.length && (text.codeUnitAt(i + 1) & 0xFC00) == 0xDC00) {
      n += 4;
      i++;
    } else {
      n += 3;
    }
  }
  return n;
}

/// UTF-8 of [text], encoding only about the first [limit] bytes (the cut may
/// end inside a character; the wire encoder trims it).
Uint8List _utf8Prefix(String text, int limit) {
  // A code unit is at most 3 bytes (a surrogate pair 4 for 2 units).
  final units = text.length <= limit ? text.length : limit;
  var end = units;
  if (end > 0 && end < text.length && (text.codeUnitAt(end - 1) & 0xFC00) == 0xD800) end--;
  final bytes = Uint8List.fromList(_encode(text.substring(0, end)));
  return bytes.length > limit ? Uint8List.sublistView(bytes, 0, limit) : bytes;
}

List<int> _encode(String s) => utf8.encode(s);
