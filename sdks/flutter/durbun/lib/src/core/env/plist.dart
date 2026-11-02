/// Minimal property-list reader (XML and binary `bplist00`), enough for an
/// app's `Info.plist`. Returns null on anything malformed; never throws.
library;

import 'dart:convert';
import 'dart:typed_data';

/// Parses an XML or binary plist. Dictionaries become `Map<String, Object?>`,
/// arrays `List<Object?>`, data `Uint8List`, dates `DateTime` (UTC).
Object? parsePlist(Uint8List bytes) {
  try {
    if (bytes.length >= 8 && ascii.decode(bytes.sublist(0, 6)) == 'bplist') {
      return _BinaryPlist(bytes).parse();
    }
    return _XmlPlist(utf8.decode(bytes, allowMalformed: true)).parse();
  } catch (_) {
    return null;
  }
}

/* ─────────────────────────────── binary ─────────────────────────────── */

class _BinaryPlist {
  _BinaryPlist(this.bytes) : data = ByteData.sublistView(bytes);

  final Uint8List bytes;
  final ByteData data;
  late final int _offsetSize;
  late final int _refSize;
  late final int _numObjects;
  late final int _offsetTable;
  final Set<int> _visiting = <int>{};

  Object? parse() {
    if (bytes.length < 40) return null;
    final t = bytes.length - 32;
    _offsetSize = bytes[t + 6];
    _refSize = bytes[t + 7];
    _numObjects = _uint(t + 8, 8);
    final top = _uint(t + 16, 8);
    _offsetTable = _uint(t + 24, 8);
    if (_offsetSize < 1 ||
        _offsetSize > 8 ||
        _refSize < 1 ||
        _refSize > 8 ||
        _numObjects <= 0 ||
        top >= _numObjects ||
        _offsetTable + _numObjects * _offsetSize > t) {
      return null;
    }
    return _object(top, 0);
  }

  int _uint(int offset, int size) {
    if (offset < 0 || offset + size > bytes.length) {
      throw const FormatException('plist: out of bounds');
    }
    var v = 0;
    for (var i = 0; i < size; i++) {
      v = (v << 8) | bytes[offset + i];
    }
    return v;
  }

  int _objectOffset(int ref) {
    if (ref < 0 || ref >= _numObjects) {
      throw const FormatException('plist: bad object reference');
    }
    return _uint(_offsetTable + ref * _offsetSize, _offsetSize);
  }

  /// Reads a length that is either in the marker's low nibble or, when the
  /// nibble is 0xF, in a following int object. Returns (length, dataStart).
  (int, int) _length(int offset, int nibble) {
    if (nibble != 0x0F) return (nibble, offset + 1);
    final intMarker = bytes[offset + 1];
    if (intMarker >> 4 != 0x1) throw const FormatException('plist: bad length');
    final size = 1 << (intMarker & 0x0F);
    return (_uint(offset + 2, size), offset + 2 + size);
  }

  Object? _object(int ref, int depth) {
    if (depth > 64) throw const FormatException('plist: too deep');
    if (!_visiting.add(ref)) throw const FormatException('plist: cycle');
    try {
      final offset = _objectOffset(ref);
      final marker = bytes[offset];
      final type = marker >> 4;
      final nibble = marker & 0x0F;
      switch (type) {
        case 0x0:
          if (marker == 0x08) return false;
          if (marker == 0x09) return true;
          return null;
        case 0x1:
          final size = 1 << nibble;
          if (size == 8) return data.getInt64(offset + 1);
          if (size == 16) return data.getInt64(offset + 9); // low 64 bits
          return _uint(offset + 1, size);
        case 0x2:
          final size = 1 << nibble;
          if (size == 4) return data.getFloat32(offset + 1);
          if (size == 8) return data.getFloat64(offset + 1);
          throw const FormatException('plist: bad real');
        case 0x3:
          final seconds = data.getFloat64(offset + 1);
          return DateTime.utc(2001).add(
            Duration(microseconds: (seconds * 1e6).round()),
          );
        case 0x4:
          final (len, start) = _length(offset, nibble);
          return Uint8List.fromList(bytes.sublist(start, start + len));
        case 0x5:
          final (len, start) = _length(offset, nibble);
          return latin1.decode(bytes.sublist(start, start + len));
        case 0x6:
          final (len, start) = _length(offset, nibble);
          final units = <int>[
            for (var i = 0; i < len; i++) data.getUint16(start + i * 2),
          ];
          return String.fromCharCodes(units);
        case 0x8:
          return _uint(offset + 1, nibble + 1);
        case 0xA:
        case 0xC:
          final (count, start) = _length(offset, nibble);
          return <Object?>[
            for (var i = 0; i < count; i++)
              _object(_uint(start + i * _refSize, _refSize), depth + 1),
          ];
        case 0xD:
          final (count, start) = _length(offset, nibble);
          final out = <String, Object?>{};
          for (var i = 0; i < count; i++) {
            final key = _object(_uint(start + i * _refSize, _refSize), depth + 1);
            final value = _object(
              _uint(start + (count + i) * _refSize, _refSize),
              depth + 1,
            );
            out[key.toString()] = value;
          }
          return out;
      }
      throw const FormatException('plist: unknown object type');
    } finally {
      _visiting.remove(ref);
    }
  }
}

/* ─────────────────────────────── XML ─────────────────────────────── */

class _XmlPlist {
  _XmlPlist(this.s);

  final String s;
  int i = 0;

  Object? parse() {
    // Skip prolog, doctype and comments up to <plist ...>.
    while (true) {
      _skipWhitespace();
      if (_startsWith('<?')) {
        _skipPast('?>');
      } else if (_startsWith('<!--')) {
        _skipPast('-->');
      } else if (_startsWith('<!')) {
        _skipPast('>');
      } else {
        break;
      }
    }
    final tag = _readTag();
    if (tag.name != 'plist') {
      // Some files omit <plist>; parse the element as the root value.
      return _value(tag);
    }
    if (tag.selfClosing) return null;
    final inner = _nextElement();
    return inner == null ? null : _value(inner);
  }

  bool _startsWith(String p) => s.startsWith(p, i);

  void _skipWhitespace() {
    while (i < s.length && ' \t\r\n'.contains(s[i])) {
      i++;
    }
  }

  void _skipPast(String token) {
    final idx = s.indexOf(token, i);
    if (idx < 0) throw const FormatException('plist: unterminated');
    i = idx + token.length;
  }

  _Tag _readTag() {
    _skipWhitespace();
    if (i >= s.length || s[i] != '<') {
      throw const FormatException('plist: expected tag');
    }
    final end = s.indexOf('>', i);
    if (end < 0) throw const FormatException('plist: unterminated tag');
    var body = s.substring(i + 1, end).trim();
    i = end + 1;
    final closing = body.startsWith('/');
    if (closing) body = body.substring(1).trim();
    final selfClosing = body.endsWith('/');
    if (selfClosing) body = body.substring(0, body.length - 1).trim();
    final name = body.split(RegExp(r'\s+')).first;
    return _Tag(name, closing: closing, selfClosing: selfClosing);
  }

  /// Next opening element (skipping comments), or null at a closing tag.
  _Tag? _nextElement() {
    while (true) {
      _skipWhitespace();
      if (_startsWith('<!--')) {
        _skipPast('-->');
        continue;
      }
      final tag = _readTag();
      return tag.closing ? null : tag;
    }
  }

  String _text(String name) {
    final end = s.indexOf('</$name', i);
    if (end < 0) throw const FormatException('plist: unterminated element');
    final raw = s.substring(i, end);
    i = s.indexOf('>', end) + 1;
    return _unescape(raw);
  }

  Object? _value(_Tag tag) {
    switch (tag.name) {
      case 'dict':
        final out = <String, Object?>{};
        if (tag.selfClosing) return out;
        while (true) {
          final keyTag = _nextElement();
          if (keyTag == null) return out;
          if (keyTag.name != 'key') throw const FormatException('plist: key');
          final key = keyTag.selfClosing ? '' : _text('key');
          final valueTag = _nextElement();
          if (valueTag == null) return out;
          out[key] = _value(valueTag);
        }
      case 'array':
        final out = <Object?>[];
        if (tag.selfClosing) return out;
        while (true) {
          final item = _nextElement();
          if (item == null) return out;
          out.add(_value(item));
        }
      case 'string':
        return tag.selfClosing ? '' : _text('string');
      case 'integer':
        return int.tryParse(tag.selfClosing ? '0' : _text('integer').trim());
      case 'real':
        return double.tryParse(tag.selfClosing ? '0' : _text('real').trim());
      case 'true':
        if (!tag.selfClosing) _text('true');
        return true;
      case 'false':
        if (!tag.selfClosing) _text('false');
        return false;
      case 'date':
        return DateTime.tryParse(tag.selfClosing ? '' : _text('date').trim());
      case 'data':
        final text = tag.selfClosing ? '' : _text('data');
        return base64Decode(text.replaceAll(RegExp(r'\s+'), ''));
      default:
        if (!tag.selfClosing) _text(tag.name);
        return null;
    }
  }

  static String _unescape(String raw) {
    if (!raw.contains('&')) return raw;
    return raw.replaceAllMapped(RegExp(r'&(#x[0-9a-fA-F]+|#[0-9]+|\w+);'), (m) {
      final e = m.group(1)!;
      if (e.startsWith('#x')) {
        return String.fromCharCode(int.parse(e.substring(2), radix: 16));
      }
      if (e.startsWith('#')) return String.fromCharCode(int.parse(e.substring(1)));
      return switch (e) {
        'amp' => '&',
        'lt' => '<',
        'gt' => '>',
        'quot' => '"',
        'apos' => "'",
        _ => m.group(0)!,
      };
    });
  }
}

class _Tag {
  _Tag(this.name, {required this.closing, required this.selfClosing});
  final String name;
  final bool closing;
  final bool selfClosing;
}
