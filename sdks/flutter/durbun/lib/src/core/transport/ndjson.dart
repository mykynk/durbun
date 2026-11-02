/// NDJSON framing: one JSON object per `\n`-terminated UTF-8 line.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../body.dart' show wireBodyFromPending;
import '../json_safe.dart' show capString;
import '../protocol.dart';

/// Thrown when an inbound line exceeds the frame limit.
class FrameTooLargeException implements Exception {
  FrameTooLargeException(this.bytes);
  final int bytes;

  @override
  String toString() => 'FrameTooLargeException: line exceeds $bytes bytes';
}

/// Splits a byte stream into lines. Multi-byte UTF-8 sequences may be split
/// across chunks; empty lines are skipped; a trailing `\r` is removed.
class NdjsonLineDecoder {
  NdjsonLineDecoder({this.maxLineBytes = kMaxFrameBytes});

  final int maxLineBytes;
  final BytesBuilder _pending = BytesBuilder(copy: true);

  /// Bytes waiting for their newline.
  int get pendingBytes => _pending.length;

  List<String> add(List<int> chunk) {
    final lines = <String>[];
    var start = 0;
    for (var i = 0; i < chunk.length; i++) {
      if (chunk[i] != 0x0A) continue;
      final Uint8List lineBytes;
      if (_pending.isEmpty) {
        lineBytes = chunk is Uint8List
            ? Uint8List.sublistView(chunk, start, i)
            : Uint8List.fromList(chunk.sublist(start, i));
      } else {
        _pending.add(
          chunk is Uint8List
              ? Uint8List.sublistView(chunk, start, i)
              : chunk.sublist(start, i),
        );
        lineBytes = _pending.takeBytes();
      }
      if (lineBytes.length > maxLineBytes) {
        throw FrameTooLargeException(maxLineBytes);
      }
      final line = _decode(lineBytes);
      if (line.isNotEmpty) lines.add(line);
      start = i + 1;
    }
    if (start < chunk.length) {
      _pending.add(
        chunk is Uint8List
            ? Uint8List.sublistView(chunk, start)
            : chunk.sublist(start),
      );
      if (_pending.length > maxLineBytes) {
        _pending.clear();
        throw FrameTooLargeException(maxLineBytes);
      }
    }
    return lines;
  }

  static String _decode(Uint8List bytes) {
    var end = bytes.length;
    if (end > 0 && bytes[end - 1] == 0x0D) end--;
    if (end == 0) return '';
    return utf8.decode(
      end == bytes.length ? bytes : Uint8List.sublistView(bytes, 0, end),
      allowMalformed: true,
    );
  }
}

/// Parses one inbound line; returns null for anything that is not a JSON
/// object with a string `type`.
Map<String, Object?>? parseMessageLine(String line) {
  try {
    final decoded = jsonDecode(line);
    if (decoded is Map<String, Object?> && decoded['type'] is String) {
      return decoded;
    }
  } catch (_) {
    // Invalid line: ignored, as the protocol requires.
  }
  return null;
}

/// Replaces [PendingBody] marker maps by wire bodies (in place).
void resolvePendingBodies(Map<String, Object?> message) {
  final body = message['body'];
  if (body is Map && body[kPendingBodyMarker] == true) {
    message['body'] = wireBodyFromPending(body);
  }
}

/// Encodes one outgoing message as a `\n`-terminated UTF-8 line. Oversized
/// messages are shrunk (body data dropped, long texts cut) to fit
/// [maxFrameBytes]; returns null if that is impossible.
Uint8List? encodeMessageLine(
  Map<String, Object?> message, {
  int maxFrameBytes = kMaxFrameBytes,
}) {
  try {
    final encoded = message[kEncodedLineKey];
    if (encoded is String) return _encodeLine(encoded, maxFrameBytes);
    resolvePendingBodies(message);
    var bytes = _encode(message);
    if (bytes.length <= maxFrameBytes) return bytes;

    final body = message['body'];
    if (body is Map) {
      message['body'] = <String, Object?>{
        'encoding': body['encoding'] ?? 'utf8',
        'data': '',
        'size': body['size'] ?? 0,
        'truncated': true,
      };
      bytes = _encode(message);
      if (bytes.length <= maxFrameBytes) return bytes;
    }
    final text = message['message'];
    if (text is String) {
      message['message'] = capString(text, maxFrameBytes ~/ 16);
    }
    if (message.containsKey('data')) {
      message['data'] = '<data omitted: message exceeded the 16 MiB frame limit>';
    }
    if (message.containsKey('props')) {
      message['props'] = <String, Object?>{
        'omitted': 'event props exceeded the 16 MiB frame limit',
      };
    }
    final error = message['error'];
    if (error is Map) {
      message['error'] = <String, Object?>{
        for (final e in error.entries)
          e.key.toString(): e.value is String
              ? capString(e.value as String, 65536)
              : e.value,
      };
    }
    bytes = _encode(message);
    return bytes.length <= maxFrameBytes ? bytes : null;
  } catch (_) {
    return null;
  }
}

/// A line the native layer already encoded (one JSON object, no newline).
Uint8List? _encodeLine(String json, int maxFrameBytes) {
  final trimmed = json.trimRight();
  if (trimmed.isEmpty || trimmed.contains('\n')) return null;
  final encoded = utf8.encode(trimmed);
  if (encoded.length + 1 > maxFrameBytes) return null;
  final out = Uint8List(encoded.length + 1);
  out.setRange(0, encoded.length, encoded);
  out[encoded.length] = 0x0A;
  return out;
}

Uint8List _encode(Map<String, Object?> message) {
  final json = jsonEncode(message, toEncodable: _fallbackEncodable);
  final encoded = utf8.encode(json);
  final out = Uint8List(encoded.length + 1);
  out.setRange(0, encoded.length, encoded);
  out[encoded.length] = 0x0A;
  return out;
}

Object? _fallbackEncodable(Object? value) {
  if (value is Uint8List) return base64Encode(value);
  try {
    return value.toString();
  } catch (_) {
    return '<${value.runtimeType}>';
  }
}

/// Rough in-memory cost of a queued message (used for the buffer byte budget).
int estimateMessageCost(Map<String, Object?> message) {
  var cost = 256;
  final encoded = message[kEncodedLineKey];
  if (encoded is String) return cost + encoded.length;
  final text = message['message'];
  if (text is String) cost += text.length;
  final body = message['body'];
  if (body is Map) {
    final bytes = body['bytes'];
    if (bytes is Uint8List) cost += bytes.length;
    final data = body['data'];
    if (data is String) cost += data.length;
  }
  if (message['data'] != null || message['props'] != null) cost += 1024;
  final error = message['error'];
  if (error is Map && error['stack'] is String) {
    cost += (error['stack'] as String).length;
  }
  return cost;
}
