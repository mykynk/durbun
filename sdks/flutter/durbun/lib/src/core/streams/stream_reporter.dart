/// Sends the messages of one stream entry (a WebSocket connection or an SSE
/// response) whose handshake was reported as request [StreamReporter.id].
///
/// Messages go out only while the desktop's latest config asks for them
/// (`captureStreams`). A stream whose reporting started is always finished
/// (its close frames, the SSE end, or `net.error`), also after the setting
/// turned off; one that never started stays the plain entry it was before
/// streams existed.
///
/// The in-app panel keeps its own record ([LocalStreamSink]): a message the
/// desktop does not take goes to the panel alone, so what the desktop gets
/// is exactly as above, with or without the panel.
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
  StreamReporter(this.recorder, this.id, {this.mockRuleId, this.localOnly = false});

  final NetworkRecorder recorder;

  /// The handshake request's id.
  final String id;

  /// Set when the handshake was answered by a mock rule.
  final String? mockRuleId;

  /// Nothing goes to the desktop: an event stream it gets the usual way (as
  /// a body at its end) is followed for the in-app panel only.
  final bool localOnly;

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
  bool get _mayFinish => !localOnly && _networkOn() && (_started || sending);

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
    if (localOnly) return false;
    try {
      return _networkOn() && (_host?.captureStreams ?? false);
    } catch (_) {
      return false;
    }
  }

  /// The in-app panel while it records stream messages, else null.
  LocalStreamSink? get localSink {
    try {
      final r = recorder;
      if (r is! LocalStreamHost || !_networkOn()) return null;
      final sink = (r as LocalStreamHost).localStreams;
      return sink != null && sink.recordsStreams ? sink : null;
    } catch (_) {
      return null;
    }
  }

  /// Stream messages are, or may soon be, wanted (by the desktop or the
  /// panel): keep decoding.
  bool get wanted {
    try {
      if (!_networkOn()) return false;
      return (!localOnly && (_host?.streamsWanted ?? false)) || localSink != null;
    } catch (_) {
      return false;
    }
  }

  /// The desktop's payload cap per message right now.
  int get _hostCap {
    if (localOnly) return 0;
    try {
      final c = _host?.streamMessageCap ?? 0;
      return c < 0 ? 0 : c;
    } catch (_) {
      return 0;
    }
  }

  /// The panel's payload cap per message (0 while bodies are not captured).
  int _localCap(LocalStreamSink sink) {
    try {
      if (!recorder.captureBodies) return 0;
      final c = sink.localStreamCap;
      return c < 0 ? 0 : c;
    } catch (_) {
      return 0;
    }
  }

  /// Payload bytes kept per message right now: enough for whichever of the
  /// desktop and the panel takes it.
  int get cap {
    final host = _hostCap;
    final sink = localSink;
    final local = sink == null ? 0 : _localCap(sink);
    return host > local ? host : local;
  }

  PendingBody? _body(Uint8List? data, int size, {required bool text}) {
    if (data == null || size <= 0) return null;
    final limit = _hostCap;
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

  /// The start of [data] the panel keeps (a view; the panel copies what it
  /// keeps when the view holds on to more).
  static Uint8List? _localBytes(Uint8List? data, int size, int limit) {
    if (data == null || size <= 0 || limit <= 0) return null;
    return data.length > limit ? Uint8List.sublistView(data, 0, limit) : data;
  }

  /// Tells the panel that the SDK follows this connection's messages
  /// ([kind] `ws` or `sse`; see [LocalStreamSink.streamOpened]).
  void announce(String kind, {String? url, int? status, String? statusText, HeaderPairs? headers}) {
    final sink = localSink;
    if (sink == null) return;
    try {
      sink.streamOpened(id,
          kind: kind, ts: nowEpochMs(), url: url, status: status, statusText: statusText, headers: headers);
    } catch (_) {}
  }

  /// A WebSocket message or control frame read off the wire.
  void wsFrame(String dir, WsMessage message) {
    final close = message.opcode == 'close';
    if (close ? _mayFinish : sending) {
      _started = true;
      try {
        recorder.sendNetMessage(buildNetWs(
          id: id,
          ts: nowEpochMs(),
          dir: dir,
          opcode: message.opcode,
          size: message.size,
          body: close ? null : _body(message.data, message.size, text: message.opcode == 'text'),
          closeCode: message.closeCode,
          closeReason: _cut(message.closeReason),
        ));
      } catch (_) {}
      return;
    }
    final sink = localSink;
    if (sink == null) return;
    try {
      sink.streamWs(id, nowEpochMs(), dir, message.opcode, message.size,
          close ? null : _localBytes(message.data, message.size, _localCap(sink)), message.closeCode, _cut(message.closeReason));
    } catch (_) {}
  }

  /// A WebSocket message seen through an app-level wrapper: [data] is a
  /// String (text) or a list of bytes (binary).
  void wsData(String dir, Object? data) {
    final desktop = sending;
    final sink = desktop ? null : localSink;
    if (!desktop && sink == null) return;
    if (desktop) _started = true;
    try {
      final limit = desktop ? _hostCap : _localCap(sink!);
      final String opcode;
      final int size;
      Uint8List? bytes;
      if (data is String) {
        opcode = 'text';
        size = utf8Length(data);
        if (limit > 0) bytes = _utf8Prefix(data, limit);
      } else if (data is List<int>) {
        opcode = 'binary';
        size = data.length;
        if (limit > 0) {
          final end = size < limit ? size : limit;
          bytes = data is Uint8List ? Uint8List.sublistView(data, 0, end) : Uint8List.fromList(data.sublist(0, end));
        }
      } else {
        return;
      }
      final ts = nowEpochMs();
      if (desktop) {
        recorder.sendNetMessage(buildNetWs(
          id: id,
          ts: ts,
          dir: dir,
          opcode: opcode,
          size: size,
          body: _body(bytes, size, text: opcode == 'text'),
        ));
      } else {
        sink!.streamWs(id, ts, dir, opcode, size, _localBytes(bytes, size, limit), null, null);
      }
    } catch (_) {}
  }

  /// A close frame seen through an app-level wrapper.
  void wsClose(String dir, {int? code, String? reason}) {
    final desktop = _mayFinish;
    final sink = desktop ? null : localSink;
    if (!desktop && sink == null) return;
    try {
      final reasonSize = reason == null ? 0 : utf8Length(reason);
      final size = code == null ? 0 : 2 + reasonSize;
      if (!desktop) {
        sink!.streamWs(id, nowEpochMs(), dir, 'close', size, null, code, _cut(reason));
        return;
      }
      _started = true;
      recorder.sendNetMessage(buildNetWs(
        id: id,
        ts: nowEpochMs(),
        dir: dir,
        opcode: 'close',
        size: size,
        closeCode: code,
        closeReason: _cut(reason),
      ));
    } catch (_) {}
  }

  /// One dispatched SSE event.
  void sseEvent(SseEvent event) {
    if (_ended) return;
    if (sending) {
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
      return;
    }
    final sink = localSink;
    if (sink == null) return;
    try {
      sink.streamSse(id, nowEpochMs(), _cut(event.event), _cut(event.eventId), event.retry, event.size,
          _localBytes(event.data, event.size, _localCap(sink)));
    } catch (_) {}
  }

  /// The event stream ended normally.
  void sseEnd() {
    if (_ended) return;
    _ended = true;
    try {
      if (_mayFinish) {
        recorder.sendNetMessage(buildNetSse(id: id, ts: nowEpochMs(), end: true));
      } else {
        localSink?.streamEnded(id, nowEpochMs());
      }
    } catch (_) {}
  }

  /// The connection broke after it opened ([cancelled]: the app stopped
  /// reading). Sent once; not at all for a stream that never started while
  /// the desktop does not take stream messages (the entry stays as before;
  /// the panel is told).
  void fail(Object error, {bool cancelled = false}) {
    if (_ended) return;
    _ended = true;
    try {
      if (_mayFinish) {
        recorder.sendNetMessage(buildNetError(
          id: id,
          ts: nowEpochMs(),
          error: describeNetError(error),
          cancelled: cancelled,
          mocked: mockRuleId != null,
          mockRuleId: mockRuleId,
        ));
      } else {
        localSink?.streamEnded(id, nowEpochMs(), error: describeNetError(error), cancelled: cancelled);
      }
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
