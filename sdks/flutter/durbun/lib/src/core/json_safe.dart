/// Converts arbitrary app values (log `data`, event props, command results)
/// into JSON-safe, isolate-sendable structures. Never throws.
library;

import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

/// Limits keep the conversion cheap on the UI isolate.
const int _maxDepth = 24;
const int _maxNodes = 20000;
const int _maxEntriesPerCollection = 5000;

/// Returns a value made only of `null`, `bool`, `num` (finite), `String`,
/// `List<Object?>` and `Map<String, Object?>`.
///
/// Handles cycles, deep/huge structures, `NaN`/`Infinity`, [DateTime],
/// [Duration], [Uri], enums, typed data and objects with a `toJson()` method;
/// anything else becomes its `toString()`.
Object? toJsonSafe(Object? value) => _JsonSafe().convert(value, 0);

class _JsonSafe {
  int _nodes = 0;
  final Set<Object> _active = HashSet<Object>.identity();

  Object? convert(Object? value, int depth) {
    if (++_nodes > _maxNodes) return '…';
    if (value == null || value is bool || value is String) return value;
    if (value is num) {
      if (value is double && (value.isNaN || value.isInfinite)) {
        return value.toString();
      }
      return value;
    }
    if (value is BigInt) return value.toString();
    if (value is DateTime) return value.toIso8601String();
    if (value is Duration) return value.toString();
    if (value is Uri) return value.toString();
    if (value is Enum) return value.name;
    if (value is Uint8List) {
      return value.length <= 64
          ? 'bytes(${value.length}): ${base64Encode(value)}'
          : '<${value.length} bytes>';
    }
    if (value is TypedData) return '<${value.lengthInBytes} bytes>';
    if (depth >= _maxDepth) return '<max depth>';
    if (value is Map) return _map(value, depth);
    if (value is Iterable) return _iterable(value, depth);
    return _object(value, depth);
  }

  Object? _map(Map<Object?, Object?> map, int depth) {
    if (!_active.add(map)) return '<cycle>';
    try {
      final out = <String, Object?>{};
      var n = 0;
      for (final entry in map.entries) {
        if (n++ >= _maxEntriesPerCollection) {
          out['…'] = '${map.length - _maxEntriesPerCollection} more entries';
          break;
        }
        out[_key(entry.key)] = convert(entry.value, depth + 1);
      }
      return out;
    } catch (e) {
      return '<unreadable map: $e>';
    } finally {
      _active.remove(map);
    }
  }

  Object? _iterable(Iterable<Object?> it, int depth) {
    if (!_active.add(it)) return '<cycle>';
    try {
      final out = <Object?>[];
      for (final item in it) {
        if (out.length >= _maxEntriesPerCollection) {
          out.add('…');
          break;
        }
        out.add(convert(item, depth + 1));
      }
      return out;
    } catch (e) {
      return '<unreadable list: $e>';
    } finally {
      _active.remove(it);
    }
  }

  Object? _object(Object value, int depth) {
    if (!_active.add(value)) return '<cycle>';
    try {
      Object? json;
      var hasToJson = false;
      try {
        // ignore: avoid_dynamic_calls
        json = (value as dynamic).toJson();
        hasToJson = true;
      } on NoSuchMethodError {
        hasToJson = false;
      }
      if (hasToJson && !identical(json, value)) {
        return convert(json, depth + 1);
      }
      return _string(value);
    } catch (_) {
      return _string(value);
    } finally {
      _active.remove(value);
    }
  }

  String _key(Object? key) {
    if (key is String) return key;
    if (key is Enum) return key.name;
    return _string(key);
  }

  String _string(Object? value) {
    try {
      return value.toString();
    } catch (_) {
      return '<${value.runtimeType}>';
    }
  }
}

/// Renders a log message argument: strings stay as they are, maps/lists become
/// compact JSON (the desktop shows JSON messages as an expandable tree).
String stringifyMessage(Object? message) {
  if (message is String) return message;
  if (message == null) return 'null';
  if (message is Map || message is Iterable) {
    try {
      return jsonEncode(toJsonSafe(message));
    } catch (_) {
      // fall through
    }
  }
  try {
    return message.toString();
  } catch (_) {
    return '<${message.runtimeType}>';
  }
}

/// Caps very long strings (keeps the head, notes how much was cut).
String capString(String value, int maxChars) {
  if (value.length <= maxChars) return value;
  return '${value.substring(0, maxChars)}… [${value.length - maxChars} more characters]';
}
