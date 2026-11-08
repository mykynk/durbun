/// Body capture (bounded tee buffer) and conversion to the wire `WireBody`.
library;

import 'dart:convert';
import 'dart:io' show ZLibDecoder, gzip;
import 'dart:typed_data';

import 'protocol.dart';

/// `isTextContentType` from the protocol: these bodies travel as UTF-8 text,
/// everything else as base64.
bool isTextContentType(String? contentType) {
  if (contentType == null) return false;
  final ct = contentType.toLowerCase();
  return ct.startsWith('text/') ||
      ct.contains('json') ||
      ct.contains('xml') ||
      ct.contains('html') ||
      ct.contains('javascript') ||
      ct.contains('x-www-form-urlencoded') ||
      ct.contains('graphql') ||
      ct.contains('yaml') ||
      ct.contains('csv');
}

/// Accumulates at most [limit] bytes of a stream while counting its full size.
/// Never holds on to the caller's buffers (bytes are copied).
class BodyCapture {
  BodyCapture({required this.limit, required this.enabled});

  final int limit;
  final bool enabled;
  final BytesBuilder _bytes = BytesBuilder(copy: true);
  int _size = 0;

  /// Total bytes seen.
  int get size => _size;

  /// Bytes kept so far.
  int get captured => _bytes.length;

  bool get truncated => _size > _bytes.length;

  /// The whole body is known to be [total] bytes although fewer were added
  /// (a caller that stopped encoding at the limit).
  void reportSize(int total) {
    if (total > _size) _size = total;
  }

  void add(List<int> chunk) {
    final n = chunk.length;
    if (n == 0) return;
    _size += n;
    if (!enabled) return;
    final room = limit - _bytes.length;
    if (room <= 0) return;
    if (n <= room) {
      _bytes.add(chunk);
    } else if (chunk is Uint8List) {
      _bytes.add(Uint8List.sublistView(chunk, 0, room));
    } else {
      _bytes.add(chunk.sublist(0, room));
    }
  }

  /// Builds the pending wire body, or null when nothing was written.
  /// [incomplete]: the stream failed or was cancelled before its end.
  PendingBody? toPending({
    String? contentType,
    String? contentEncoding,
    bool incomplete = false,
  }) {
    if (_size == 0) return null;
    final bytes = _bytes.toBytes();
    return PendingBody(
      bytes: bytes,
      size: _size,
      truncated: incomplete || _size > bytes.length,
      limit: limit,
      capture: enabled,
      contentType: contentType,
      contentEncoding: contentEncoding,
    );
  }
}

/// Converts a [PendingBody] marker map (see [PendingBody.toMessageValue]) into
/// a protocol `WireBody` map. Runs inside the transport encoder.
Map<String, Object?> wireBodyFromPending(Map<Object?, Object?> pending) {
  var bytes = pending['bytes'] is Uint8List
      ? pending['bytes'] as Uint8List
      : Uint8List(0);
  var size = (pending['size'] as num?)?.toInt() ?? bytes.length;
  var truncated = pending['truncated'] == true;
  final limit = (pending['limit'] as num?)?.toInt() ?? bytes.length;
  final capture = pending['capture'] != false;
  final contentType = pending['contentType'] as String?;
  final contentEncoding = (pending['contentEncoding'] as String?)
      ?.toLowerCase()
      .trim();

  var stillCompressed = false;
  if (contentEncoding != null &&
      contentEncoding.isNotEmpty &&
      contentEncoding != 'identity') {
    final decoded = (capture && !truncated)
        ? decompressBounded(bytes, contentEncoding, keep: limit)
        : null;
    if (decoded != null) {
      size = decoded.size;
      bytes = decoded.bytes;
      truncated = decoded.size > decoded.bytes.length;
    } else {
      stillCompressed = true;
    }
  }

  final text =
      !stillCompressed &&
      (isTextContentType(contentType) ||
          (contentType == null && looksLikeText(bytes)));
  if (!capture) {
    return <String, Object?>{
      'encoding': text ? 'utf8' : 'base64',
      'data': '',
      'size': size,
      'truncated': true,
    };
  }
  if (text) {
    final usable = truncated ? trimIncompleteUtf8(bytes) : bytes;
    return <String, Object?>{
      'encoding': 'utf8',
      'data': utf8.decode(usable, allowMalformed: true),
      'size': size,
      if (truncated) 'truncated': true,
    };
  }
  return <String, Object?>{
    'encoding': 'base64',
    'data': base64Encode(bytes),
    'size': size,
    if (truncated) 'truncated': true,
  };
}

/// Most decoded bytes [decompressBounded] inflates (and counts) before it
/// stops: a small gzip body can expand a thousandfold.
const int kMaxInflatedBytes = 64 * 1024 * 1024;

/// Decodes gzip / deflate bodies chunk by chunk: keeps the first [keep]
/// bytes, counts the decoded size up to [countLimit] and stops there (`size`
/// is then a lower bound). Null when the encoding is unknown (e.g. `br`) or
/// the data is not valid.
({Uint8List bytes, int size})? decompressBounded(
  Uint8List bytes,
  String contentEncoding, {
  required int keep,
  int countLimit = kMaxInflatedBytes,
}) {
  ({Uint8List bytes, int size})? run(ZLibDecoder decoder) {
    final sink = _CappedSink(keep < 0 ? 0 : keep, countLimit);
    try {
      decoder.startChunkedConversion(sink)
        ..add(bytes)
        ..close();
    } on _InflateLimitReached {
      // Enough: the rest is never decoded.
    }
    return (bytes: sink.kept.takeBytes(), size: sink.total);
  }

  try {
    switch (contentEncoding) {
      case 'gzip':
      case 'x-gzip':
        return run(gzip.decoder);
      case 'deflate':
        try {
          return run(ZLibDecoder());
        } on FormatException {
          return run(ZLibDecoder(raw: true));
        }
    }
  } catch (_) {
    return null;
  }
  return null;
}

class _InflateLimitReached implements Exception {
  const _InflateLimitReached();
}

/// Keeps the first [keep] decoded bytes and counts the rest; throws
/// [_InflateLimitReached] past [countLimit] so the decoder stops.
class _CappedSink implements Sink<List<int>> {
  _CappedSink(this.keep, this.countLimit);

  final int keep;
  final int countLimit;
  final BytesBuilder kept = BytesBuilder(copy: true);
  int total = 0;

  @override
  void add(List<int> chunk) {
    total += chunk.length;
    final room = keep - kept.length;
    if (room > 0) {
      kept.add(chunk.length <= room ? chunk : chunk.sublist(0, room));
    }
    if (total >= countLimit) throw const _InflateLimitReached();
  }

  @override
  void close() {}
}

/// Decodes a whole gzip / deflate body; returns null when not possible (e.g.
/// `br`). Only for bodies the app itself receives (mock responses).
Uint8List? tryDecompress(Uint8List bytes, String contentEncoding) {
  try {
    switch (contentEncoding) {
      case 'gzip':
      case 'x-gzip':
        return Uint8List.fromList(gzip.decode(bytes));
      case 'deflate':
        try {
          return Uint8List.fromList(ZLibDecoder().convert(bytes));
        } on FormatException {
          return Uint8List.fromList(ZLibDecoder(raw: true).convert(bytes));
        }
    }
  } catch (_) {
    return null;
  }
  return null;
}

/// Heuristic for bodies without a content type: valid UTF-8 without control
/// characters (other than tab/CR/LF/FF) is treated as text.
bool looksLikeText(Uint8List bytes) {
  if (bytes.isEmpty) return true;
  final sample = bytes.length > 4096
      ? trimIncompleteUtf8(Uint8List.sublistView(bytes, 0, 4096))
      : bytes;
  for (final b in sample) {
    if (b < 0x20 && b != 0x09 && b != 0x0A && b != 0x0D && b != 0x0C) {
      return false;
    }
    if (b == 0x7F) return false;
  }
  try {
    utf8.decode(sample);
    return true;
  } on FormatException {
    return false;
  }
}

/// Drops an incomplete UTF-8 sequence at the end of a truncated buffer.
Uint8List trimIncompleteUtf8(Uint8List bytes) {
  var end = bytes.length;
  // Walk back over at most 3 continuation bytes to the lead byte.
  var i = end - 1;
  var continuation = 0;
  while (i >= 0 && continuation < 3 && (bytes[i] & 0xC0) == 0x80) {
    i--;
    continuation++;
  }
  if (i < 0) return bytes;
  final lead = bytes[i];
  final int expected;
  if (lead & 0x80 == 0) {
    expected = 1;
  } else if (lead & 0xE0 == 0xC0) {
    expected = 2;
  } else if (lead & 0xF0 == 0xE0) {
    expected = 3;
  } else if (lead & 0xF8 == 0xF0) {
    expected = 4;
  } else {
    return bytes;
  }
  if (continuation + 1 < expected) end = i;
  return end == bytes.length ? bytes : Uint8List.sublistView(bytes, 0, end);
}
