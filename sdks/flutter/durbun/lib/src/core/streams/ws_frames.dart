/// RFC 6455 frame reader for one direction of a WebSocket connection, fed
/// with copies of the bytes on the wire (it never changes them). Joins
/// fragmented messages, unmasks client frames and inflates
/// `permessage-deflate` messages (RFC 7692).
library;

import 'dart:convert';
import 'dart:io' show RawZLibFilter;
import 'dart:typed_data';

/// One complete WebSocket message or control frame as the reader saw it.
class WsMessage {
  WsMessage({
    required this.opcode,
    required this.size,
    required this.data,
    this.closeCode,
    this.closeReason,
    this.undecoded = false,
  });

  /// `text` | `binary` | `ping` | `pong` | `close`.
  final String opcode;

  /// Payload bytes (after inflating a compressed message). When the message
  /// could not be inflated ([undecoded]) the size of the compressed payload.
  final int size;

  /// The first bytes of the payload (at most the reader's cap at the time the
  /// message started); null when nothing is kept (cap 0, close frames, a
  /// message that could not be decoded).
  final Uint8List? data;

  /// Close frames: the status code and reason, when the frame had them.
  final int? closeCode;
  final String? closeReason;

  /// A compressed message whose content could not be recovered exactly
  /// (its compression history was not followed): sizes only.
  final bool undecoded;

  bool get truncated => data != null && size > data!.length;
}

/// Reads the frames of one direction.
///
/// [wanted] is asked when a message starts: false skips all payload work
/// (and gives up the compression history, so a later compressed message
/// that refers to it is reported with sizes only). [cap] is the payload
/// prefix kept per message. Messages are reported through [onMessage] when
/// their last frame ends; a message not wanted at its start is not reported.
/// Control frames are always reported (they are small; the close frames tell
/// the connection's end).
class WsFrameReader {
  WsFrameReader({
    required this.onMessage,
    required this.wanted,
    required this.cap,
    this.deflate = false,
    this.noContextTakeover = false,
  });

  final void Function(WsMessage message) onMessage;
  final bool Function() wanted;
  final int Function() cap;

  /// `permessage-deflate` was negotiated: RSV1 marks compressed messages.
  final bool deflate;

  /// The sender starts every message with an empty compression history
  /// (`server_no_context_takeover` for the server's frames,
  /// `client_no_context_takeover` for the client's).
  final bool noContextTakeover;

  /// The stream is not RFC 6455 (or the reader failed): nothing more is
  /// reported for this direction.
  bool get lost => _lost;
  bool _lost = false;

  // Frame header.
  final Uint8List _header = Uint8List(14);
  int _headerLength = 0;
  int _headerNeed = 2;

  // Current frame.
  bool _inPayload = false;
  int _remaining = 0;
  int _opcode = 0;
  bool _fin = false;
  Uint8List? _mask;
  int _maskOffset = 0;

  // Current data message.
  bool _inMessage = false;
  bool _messageWanted = false;
  bool _messageText = false;
  bool _messageCompressed = false;
  int _messageSize = 0;
  int _wireSize = 0;
  int _keep = 0;
  BytesBuilder? _kept;
  bool _inflateFailed = false;

  // Current control frame.
  final BytesBuilder _control = BytesBuilder(copy: true);

  // Compression history of this direction; dropped when a message was
  // skipped or failed, so it never holds a wrong history.
  RawZLibFilter? _inflater;

  static const List<int> _deflateTail = <int>[0x00, 0x00, 0xFF, 0xFF];

  /// Feeds bytes in wire order. Never throws.
  void add(List<int> chunk) {
    if (_lost) return;
    try {
      _add(chunk);
    } catch (_) {
      _lost = true;
      _inflater = null;
    }
  }

  void _add(List<int> chunk) {
    var i = 0;
    final n = chunk.length;
    while (i < n && !_lost) {
      if (!_inPayload) {
        while (i < n && _headerLength < _headerNeed) {
          _header[_headerLength++] = chunk[i++];
          if (_headerLength == 2) {
            final len7 = _header[1] & 0x7F;
            _headerNeed = 2 + (len7 == 126 ? 2 : (len7 == 127 ? 8 : 0)) + ((_header[1] & 0x80) != 0 ? 4 : 0);
          }
        }
        if (_headerLength < _headerNeed) return;
        _startFrame();
        if (_lost) return;
        if (_remaining == 0) _endFrame();
        continue;
      }
      final take = (n - i) < _remaining ? n - i : _remaining;
      _payload(chunk, i, i + take);
      i += take;
      _remaining -= take;
      if (_remaining == 0) _endFrame();
    }
  }

  void _startFrame() {
    final b0 = _header[0];
    final b1 = _header[1];
    _fin = (b0 & 0x80) != 0;
    final rsv1 = (b0 & 0x40) != 0;
    _opcode = b0 & 0x0F;
    final len7 = b1 & 0x7F;
    var offset = 2;
    int length;
    if (len7 == 126) {
      length = (_header[2] << 8) | _header[3];
      offset = 4;
    } else if (len7 == 127) {
      if ((_header[2] & 0x80) != 0) {
        _lost = true;
        return;
      }
      length = 0;
      for (var k = 2; k < 10; k++) {
        length = (length << 8) | _header[k];
      }
      offset = 10;
    } else {
      length = len7;
    }
    if ((b1 & 0x80) != 0) {
      _mask = Uint8List.fromList(_header.sublist(offset, offset + 4));
    } else {
      _mask = null;
    }
    _maskOffset = 0;
    _remaining = length;
    _inPayload = true;
    _headerLength = 0;
    _headerNeed = 2;

    switch (_opcode) {
      case 0x0: // continuation
        break;
      case 0x1:
      case 0x2:
        _startMessage(text: _opcode == 0x1, compressed: rsv1 && deflate);
      case 0x8:
      case 0x9:
      case 0xA:
        if (length > 125 || !_fin) {
          // Control frames are short and never fragmented.
          _lost = true;
          return;
        }
        _control.clear();
      default:
        _lost = true;
    }
  }

  void _startMessage({required bool text, required bool compressed}) {
    bool want;
    try {
      want = wanted();
    } catch (_) {
      want = false;
    }
    _inMessage = true;
    _messageWanted = want;
    _messageText = text;
    _messageCompressed = compressed;
    _messageSize = 0;
    _wireSize = 0;
    _inflateFailed = false;
    _kept = null;
    _keep = 0;
    if (!want) {
      // Not followed: a later compressed message may refer to this one's
      // history (uncompressed messages never enter it).
      if (compressed) _inflater = null;
      return;
    }
    try {
      _keep = cap();
    } catch (_) {
      _keep = 0;
    }
    if (_keep < 0) _keep = 0;
    if (_keep > 0) _kept = BytesBuilder(copy: true);
    if (compressed && (noContextTakeover || _inflater == null)) {
      _inflater = _newInflater();
    }
    if (compressed && _inflater == null) _inflateFailed = true;
  }

  static RawZLibFilter? _newInflater() {
    try {
      // The largest window decodes data compressed with any smaller one.
      return RawZLibFilter.inflateFilter(windowBits: 15, raw: true);
    } catch (_) {
      return null;
    }
  }

  void _payload(List<int> chunk, int start, int end) {
    final isControl = _opcode >= 0x8;
    if (isControl) {
      _control.add(_unmasked(chunk, start, end, end - start));
      return;
    }
    final len = end - start;
    if (!_inMessage) {
      // A continuation without a message: skipped.
      _advanceMask(len);
      return;
    }
    _wireSize += len;
    if (!_messageWanted) {
      _advanceMask(len);
      return;
    }
    if (_messageCompressed) {
      if (_inflateFailed) {
        _advanceMask(len);
        return;
      }
      _inflate(_unmasked(chunk, start, end, len));
      return;
    }
    _messageSize += len;
    final room = _keep - (_kept?.length ?? 0);
    if (room > 0) {
      final take = len < room ? len : room;
      _kept!.add(_unmasked(chunk, start, start + take, len));
    } else {
      _advanceMask(len);
    }
  }

  /// The payload bytes [start, end) unmasked (a copy when masked); the mask
  /// position moves by [consumed] (>= end - start: bytes not copied still
  /// count).
  Uint8List _unmasked(List<int> chunk, int start, int end, int consumed) {
    final mask = _mask;
    final len = end - start;
    Uint8List out;
    if (mask == null) {
      out = chunk is Uint8List ? Uint8List.sublistView(chunk, start, end) : Uint8List.fromList(chunk.sublist(start, end));
    } else {
      out = Uint8List(len);
      var m = _maskOffset;
      for (var k = 0; k < len; k++) {
        out[k] = chunk[start + k] ^ mask[m & 3];
        m++;
      }
    }
    _advanceMask(consumed);
    return out;
  }

  void _advanceMask(int n) {
    _maskOffset = (_maskOffset + n) & 3;
  }

  void _inflate(List<int> bytes) {
    final inflater = _inflater;
    if (inflater == null) {
      _inflateFailed = true;
      return;
    }
    try {
      inflater.process(bytes, 0, bytes.length);
      while (true) {
        final out = inflater.processed();
        if (out == null) break;
        _messageSize += out.length;
        final room = _keep - (_kept?.length ?? 0);
        if (room > 0) {
          _kept!.add(out.length <= room ? out : out.sublist(0, room));
        }
      }
    } catch (_) {
      // A reference into history this reader never saw (or corrupt data):
      // this message is reported with sizes only, the history starts over.
      _inflateFailed = true;
      _inflater = null;
    }
  }

  void _endFrame() {
    _inPayload = false;
    if (_opcode >= 0x8) {
      _endControl();
      return;
    }
    if (!_fin || !_inMessage) return;
    _inMessage = false;
    if (!_messageWanted) return;
    if (_messageCompressed && !_inflateFailed) _inflate(_deflateTail);
    if (_messageCompressed && noContextTakeover) _inflater = null;
    final kept = _kept;
    _kept = null;
    final WsMessage message;
    if (_messageCompressed && _inflateFailed) {
      message = WsMessage(
        opcode: _messageText ? 'text' : 'binary',
        size: _wireSize,
        data: null,
        undecoded: true,
      );
    } else {
      message = WsMessage(
        opcode: _messageText ? 'text' : 'binary',
        size: _messageSize,
        data: kept?.takeBytes(),
      );
    }
    _emit(message);
  }

  void _endControl() {
    final payload = _control.takeBytes();
    switch (_opcode) {
      case 0x8:
        int? code;
        String? reason;
        if (payload.length >= 2) {
          code = (payload[0] << 8) | payload[1];
          if (payload.length > 2) {
            reason = utf8.decode(Uint8List.sublistView(payload, 2), allowMalformed: true);
          }
        }
        _emit(WsMessage(opcode: 'close', size: payload.length, data: null, closeCode: code, closeReason: reason));
      case 0x9:
      case 0xA:
        int keep;
        try {
          keep = cap();
        } catch (_) {
          keep = 0;
        }
        final data = keep <= 0 || payload.isEmpty
            ? null
            : (payload.length <= keep ? payload : Uint8List.sublistView(payload, 0, keep));
        _emit(WsMessage(opcode: _opcode == 0x9 ? 'ping' : 'pong', size: payload.length, data: data));
    }
  }

  void _emit(WsMessage message) {
    try {
      onMessage(message);
    } catch (_) {}
  }
}

/// The `permessage-deflate` parameters a server accepted
/// (`Sec-WebSocket-Extensions` of the 101 response), or null when the
/// connection is not compressed.
({bool serverNoContextTakeover, bool clientNoContextTakeover})? parsePerMessageDeflate(String? header) {
  if (header == null || header.trim().isEmpty) return null;
  for (final ext in header.split(',')) {
    final parts = ext.split(';').map((p) => p.trim().toLowerCase()).toList();
    if (parts.isEmpty || parts.first != 'permessage-deflate') continue;
    final params = <String>{for (final p in parts.skip(1)) p.split('=').first.trim()};
    return (
      serverNoContextTakeover: params.contains('server_no_context_takeover'),
      clientNoContextTakeover: params.contains('client_no_context_takeover'),
    );
  }
  return null;
}
