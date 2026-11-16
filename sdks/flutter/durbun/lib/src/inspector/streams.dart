/// The panel's record of a long-lived connection's messages: a WebSocket's
/// messages or an event stream's events, kept per connection in a bounded
/// ring (see [DurbunInspectorStore] for the caps). A message is stored as it
/// arrived (the kept start of its payload, as bytes or as the wire's text)
/// and decoded only when it is shown. Must not import dart:io.
library;

import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import 'store.dart' show InspectorBody;
import 'text_match.dart' show foldText;

enum StreamKind { webSocket, sse }

/// [open] until a close frame, the event stream's end or a failure.
enum StreamState { open, closed, failed }

/// One WebSocket message or control frame, or one Server-Sent Events event.
class InspectorStreamMessage {
  InspectorStreamMessage({
    required this.seq,
    required this.ts,
    required this.out,
    required this.type,
    required this.size,
    Object? payload,
    bool base64 = false,
    bool truncated = false,
    this.closeCode,
    this.closeReason,
    this.event,
    this.eventId,
    this.retry,
  })  : _payload = payload,
        _base64 = base64,
        _truncated = truncated;

  /// Arrival order within its connection, from 1 (gaps: messages removed by
  /// the memory limits).
  final int seq;

  /// Epoch milliseconds (device clock).
  final double ts;

  /// Sent by the app (a WebSocket's outgoing side); events are received.
  final bool out;

  /// `text`, `binary`, `ping`, `pong`, `close` or `event`.
  final String type;

  /// Full payload size in bytes (the kept part may be shorter).
  final int size;

  /// The kept payload: a [Uint8List] (raw bytes) or a [String] (the wire's
  /// text, base64 when [_base64]); null when none was kept.
  final Object? _payload;
  final bool _base64;
  final bool _truncated;

  final int? closeCode;
  final String? closeReason;

  /// SSE: the `event:` type (null for "message"), `id:` and `retry:`.
  final String? event;
  final String? eventId;
  final int? retry;

  bool get isControl => type == 'ping' || type == 'pong';
  bool get isClose => type == 'close';

  /// Text payloads: text messages, events and close reasons; the others are
  /// bytes (ping and pong carry bytes too).
  bool get isText => type == 'text' || type == 'event';

  /// Whether some payload was kept.
  bool get hasPayload {
    final p = _payload;
    return p is Uint8List ? p.isNotEmpty : (p is String && p.isNotEmpty);
  }

  /// What the kept payload costs the store.
  int get heldBytes {
    final p = _payload;
    if (p is Uint8List) return p.length;
    if (p is String) return p.length;
    return 0;
  }

  /// Bytes of payload kept (the decoded size of a base64 text).
  int get keptBytes {
    final p = _payload;
    if (p is Uint8List) return p.length;
    if (p is String) return _base64 ? (p.length * 3) ~/ 4 : utf8Length(p);
    return 0;
  }

  /// Only the start of the payload was kept.
  bool get truncated => _truncated || (hasPayload && size > keptBytes);

  /// The kept payload as a body, decoded now (not kept: a message is
  /// decoded when it is opened).
  InspectorBody? body() {
    final p = _payload;
    if (p == null) return null;
    if (isText) {
      final text = p is Uint8List ? _decodeText(p, cut: truncated) : (p as String);
      return InspectorBody(encoding: 'utf8', data: text, size: size, truncated: truncated);
    }
    final b64 = p is Uint8List ? base64Encode(p) : (_base64 ? p as String : base64Encode(utf8.encode(p as String)));
    return InspectorBody(encoding: 'base64', data: b64, size: size, truncated: truncated);
  }

  /// The kept payload's bytes (binary messages, hex).
  Uint8List bytes() {
    final p = _payload;
    if (p is Uint8List) return p;
    if (p is String) {
      if (!_base64) return Uint8List.fromList(utf8.encode(p));
      try {
        return base64Decode(p);
      } catch (_) {
        return Uint8List(0);
      }
    }
    return Uint8List(0);
  }

  /// The kept text, decoded now (null for bytes or no payload).
  String? text() {
    if (!isText) return null;
    final p = _payload;
    if (p is Uint8List) return _decodeText(p, cut: truncated);
    return p is String ? p : null;
  }

  /// One line for a list row: the text's start with whitespace folded, or
  /// the first bytes in hex. Made once, when a row first shows it.
  String get preview => _preview ??= _makePreview();
  String? _preview;

  static const int _previewChars = 200;

  String _makePreview() {
    final p = _payload;
    if (p == null) return '';
    if (!isText) {
      final b = p is Uint8List ? p : bytes();
      final n = b.length < 16 ? b.length : 16;
      final hex = <String>[for (var i = 0; i < n; i++) b[i].toRadixString(16).padLeft(2, '0')].join(' ');
      return b.length > 16 ? '$hex …' : hex;
    }
    String head;
    if (p is Uint8List) {
      // Only the start is decoded: a row shows one line.
      final n = p.length < _previewChars * 4 ? p.length : _previewChars * 4;
      head = _decodeText(Uint8List.sublistView(p, 0, n), cut: n < p.length || truncated);
    } else {
      final s = p as String;
      head = s.length <= _previewChars * 2 ? s : s.substring(0, _previewChars * 2);
    }
    final folded = head.replaceAll(_space, ' ').trim();
    return folded.length <= _previewChars ? folded : folded.substring(0, _previewChars);
  }

  static final RegExp _space = RegExp(r'\s+');

  /// Whether [folded] (a [foldText] query) is in the payload's text, the
  /// event's type or id, or the close reason. Decodes the payload; called
  /// only while a search is typed.
  bool matches(String folded) {
    if (folded.isEmpty) return true;
    final parts = <String?>[text(), event, eventId, closeReason, closeCode?.toString(), if (!isText) preview, if (type != 'event') type];
    for (final s in parts) {
      if (s != null && s.isNotEmpty && foldText(s).contains(folded)) return true;
    }
    return false;
  }

  /// UTF-8 text of [b]; a kept start that ends inside a character drops
  /// that character instead of showing a replacement sign.
  static String _decodeText(Uint8List b, {required bool cut}) {
    var end = b.length;
    if (cut) {
      // Back up over a cut multi-byte sequence.
      var i = end - 1;
      var back = 0;
      while (i >= 0 && back < 3 && (b[i] & 0xC0) == 0x80) {
        i--;
        back++;
      }
      if (i >= 0 && b[i] >= 0xC0) {
        final need = b[i] >= 0xF0 ? 4 : (b[i] >= 0xE0 ? 3 : 2);
        if (end - i < need) end = i;
      }
    }
    return utf8.decode(end == b.length ? b : Uint8List.sublistView(b, 0, end), allowMalformed: true);
  }

  /// UTF-8 length of [s] without encoding it.
  static int utf8Length(String s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      final c = s.codeUnitAt(i);
      if (c < 0x80) {
        n += 1;
      } else if (c < 0x800) {
        n += 2;
      } else if ((c & 0xFC00) == 0xD800 && i + 1 < s.length && (s.codeUnitAt(i + 1) & 0xFC00) == 0xDC00) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    }
    return n;
  }
}

/// The messages and the state of one connection (its handshake is the
/// [InspectorCall] it belongs to). The first [headKept] messages (sign-in,
/// subscriptions) stay longest, then the newest; past [maxMessages] the
/// oldest after the head go first, and every message removed is counted in
/// [dropped] (the list shows the gap where they were).
class InspectorStream {
  InspectorStream(this.kind, {required this.openTs, this.maxMessages = 500, this.headKept = 20});

  final StreamKind kind;

  /// When the connection opened (the 101, the event stream's headers):
  /// message times count from here.
  double openTs;

  final int maxMessages;
  final int headKept;

  /// The SDK on this phone follows the connection's messages (dart:io and
  /// `DurbunNetwork.webSocket`); otherwise they arrive only through the
  /// copy that goes to the Mac (OkHttp, URLSession, other reporters).
  bool followed = false;

  StreamState state = StreamState.open;

  /// Who sent the first close frame (`in`: the server, `out`: the app).
  String? closedBy;
  int? closeCode;
  String? closeReason;

  /// The server ended the event stream.
  bool sseEnded = false;

  /// The app stopped reading the event stream.
  bool cancelled = false;

  /// Why the connection broke.
  String? error;
  double? endTs;

  /// Messages seen (also those removed since).
  int count = 0;
  int received = 0;
  int sent = 0;
  int control = 0;
  int bytesIn = 0;
  int bytesOut = 0;

  /// Messages removed by the memory limits.
  int dropped = 0;

  /// Grows with every change (new message, end, removal).
  int revision = 0;

  final List<InspectorStreamMessage> _head = <InspectorStreamMessage>[];
  final ListQueue<InspectorStreamMessage> _tail = ListQueue<InspectorStreamMessage>();
  int _heldBytes = 0;

  /// Messages kept now.
  int get held => _head.length + _tail.length;

  /// Payload bytes kept now.
  int get heldBytes => _heldBytes;

  bool get isOpen => state == StreamState.open;

  /// The kept messages in arrival order (a copy).
  List<InspectorStreamMessage> get messages => <InspectorStreamMessage>[..._head, ..._tail];

  /// Adds [m]; returns the messages it pushed out of this connection's ring
  /// (count and payload bytes).
  (int, int) add(InspectorStreamMessage m) {
    count++;
    if (m.out) {
      sent++;
      bytesOut += m.size;
    } else {
      received++;
      bytesIn += m.size;
    }
    if (m.isControl) control++;
    if (_head.length < headKept && _tail.isEmpty && dropped == 0) {
      _head.add(m);
    } else {
      _tail.addLast(m);
    }
    _heldBytes += m.heldBytes;
    var gone = 0, goneBytes = 0;
    while (held > maxMessages) {
      final b = _removeOldest();
      gone++;
      goneBytes += b;
    }
    revision++;
    return (gone, goneBytes);
  }

  /// Removes the oldest message after the head (the head's last when only
  /// the head is left); returns its payload bytes, or -1 when none is kept.
  int _removeOldest() {
    final InspectorStreamMessage m;
    if (_tail.isNotEmpty) {
      m = _tail.removeFirst();
    } else if (_head.isNotEmpty) {
      m = _head.removeLast();
    } else {
      return -1;
    }
    _heldBytes -= m.heldBytes;
    dropped++;
    return m.heldBytes;
  }

  /// Removes one message for the store's global limits (see
  /// [_removeOldest]); -1 when nothing is kept.
  int evictOne() {
    final b = _removeOldest();
    if (b >= 0) revision++;
    return b;
  }

  /// Every kept message goes (the request was removed or the store cleared).
  void releaseAll() {
    _head.clear();
    _tail.clear();
    _heldBytes = 0;
  }
}
