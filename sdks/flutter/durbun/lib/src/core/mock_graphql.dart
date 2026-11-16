/// Mock matching v2: rule conditions (`MockRule.when`) and the GraphQL
/// operation of a request. Exact port of `graphqlOperationsOf` /
/// `mockRuleMatchesRequest` / `findMockRuleForRequest` in
/// `packages/protocol/src/index.ts`; the shared vectors in
/// `packages/protocol/vectors/mock-graphql.json` are the test. Dart strings
/// are UTF-16 like JavaScript's, so lengths and names compare the same; JSON
/// is read strictly (RFC 8259, as `JSON.parse` reads it) and URL parameters
/// are decoded like `decodeURIComponent`.
library;

/// The mock rule conditions this SDK evaluates (`hello.sdk.mockMatchers`).
const List<String> kMockMatchers = <String>['graphql'];

/// Longest text (UTF-16 code units: a body or a `query` URL parameter) the
/// GraphQL reading looks at.
const int kMockGraphqlMaxChars = 64 * 1024;

/// Bodies longer than this many bytes have more than [kMockGraphqlMaxChars]
/// UTF-16 units and are never decoded.
const int kMockGraphqlMaxBodyBytes = 3 * kMockGraphqlMaxChars;

/// A `MockRule.when.graphql` condition that can be evaluated.
class GraphqlCondition {
  /// A condition on [operationName] (and [operationType] when set).
  const GraphqlCondition(this.operationName, [this.operationType]);

  /// Exact, case-sensitive operation name.
  final String operationName;

  /// `query` | `mutation` | `subscription`, or null for any type.
  final String? operationType;
}

/// One GraphQL operation of a request: [name] null = anonymous, [type] null =
/// not known.
class GraphqlOperation {
  /// An operation as read from a request.
  const GraphqlOperation(this.name, this.type);

  /// Operation name, or null for an anonymous operation.
  final String? name;

  /// `query` | `mutation` | `subscription`, or null when not known.
  final String? type;

  @override
  bool operator ==(Object other) =>
      other is GraphqlOperation && other.name == name && other.type == type;

  @override
  int get hashCode => Object.hash(name, type);

  @override
  String toString() => 'GraphqlOperation($name, $type)';
}

/// The conditions of a rule as received (`MockRule.when`).
class MockConditions {
  /// Conditions with [usedKeys] and a valid [graphql] condition, if any.
  const MockConditions(this.usedKeys, this.graphql);

  /// No conditions (method / URL / apps only).
  static const MockConditions none = MockConditions(<String>[], null);

  /// Keys of `when` holding a value; `when` itself when it is not an object
  /// (never matches).
  final List<String> usedKeys;

  /// The `graphql` condition, null when absent or malformed (a malformed one
  /// never matches).
  final GraphqlCondition? graphql;

  /// Reads `rule.when` exactly like the reference's `mockRuleMatchersUsed`
  /// and condition check.
  static MockConditions fromJson(Object? value) {
    if (value == null) return none;
    if (value is! Map) return const MockConditions(<String>['when'], null);
    final keys = <String>[
      for (final e in value.entries)
        if (e.value != null) e.key.toString(),
    ];
    if (keys.isEmpty) return none;
    GraphqlCondition? condition;
    final raw = value['graphql'];
    if (raw is Map) {
      final name = raw['operationName'];
      final type = raw['operationType'];
      if (name is String &&
          name.isNotEmpty &&
          (type == null ||
              type == 'query' ||
              type == 'mutation' ||
              type == 'subscription')) {
        condition = GraphqlCondition(name, type as String?);
      }
    }
    return MockConditions(keys, condition);
  }

  /// Whether a rule (already matching method / URL / apps) holds;
  /// [operations] is read lazily.
  bool holds(List<GraphqlOperation>? Function() operations) {
    if (usedKeys.isEmpty) return true;
    if (usedKeys.any((k) => k != 'graphql')) return false;
    final condition = graphql;
    if (condition == null) return false;
    final ops = operations();
    if (ops == null) return false;
    return ops.any(
      (op) =>
          op.name == condition.operationName &&
          (condition.operationType == null ||
              op.type == condition.operationType),
    );
  }
}

/// The reference's `graphqlOperationsOf`: the operation(s) of a request, or
/// null when unknown (a rule with a GraphQL condition then does not match).
List<GraphqlOperation>? graphqlOperationsOf({
  required String method,
  required String url,
  String? contentType,
  String? body,
}) {
  final raw = body ?? '';
  final trimmed = _trimAsciiWhitespace(raw);
  if (trimmed.isNotEmpty) {
    if (raw.length > kMockGraphqlMaxChars) return null;
    final ct = (contentType ?? '').toLowerCase();
    if (ct.contains('application/graphql') && !ct.contains('json')) {
      final ops = graphqlDocumentOperations(trimmed);
      return ops.isEmpty ? null : <GraphqlOperation>[ops.first];
    }
    final first = trimmed.codeUnitAt(0);
    if (first != 0x7B && first != 0x5B) return null;
    final payloads = _StrictJson.payloads(trimmed);
    if (payloads == null) return null;
    final ops = <GraphqlOperation>[
      for (final p in payloads)
        if (_payloadOperation(p.query, p.operationName) case final op?) op,
    ];
    return ops.isEmpty ? null : ops;
  }
  if (method.toUpperCase() != 'GET') return null;
  final params = urlQueryParams(url);
  if (params == null) return null;
  final op = _payloadOperation(params['query'], params['operationName']);
  return op == null ? null : <GraphqlOperation>[op];
}

GraphqlOperation? _payloadOperation(String? query, String? operationName) {
  final name = (operationName == null || operationName.isEmpty)
      ? null
      : operationName;
  if (query != null) {
    if (query.length > kMockGraphqlMaxChars) return null;
    final ops = graphqlDocumentOperations(query);
    if (name != null) {
      String? type;
      for (final op in ops) {
        if (op.name == name) {
          type = op.type;
          break;
        }
      }
      return GraphqlOperation(name, type);
    }
    return ops.isEmpty ? null : ops.first;
  }
  return name == null ? null : GraphqlOperation(name, null);
}

bool _isNameStart(int c) =>
    (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || c == 0x5F;

bool _isNameChar(int c) => _isNameStart(c) || (c >= 0x30 && c <= 0x39);

/// Operation definitions of a GraphQL document, in order (fragments
/// skipped); the reference's tokenizer.
List<GraphqlOperation> graphqlDocumentOperations(String doc) {
  final ops = <GraphqlOperation>[];
  final n = doc.length;
  var i = 0;
  var depth = 0;
  var parens = 0;
  // A definition word was read at depth 0 and its selection set has not
  // started yet.
  var pending = false;
  while (i < n) {
    final c = doc.codeUnitAt(i);
    if (c == 0x23) {
      while (i < n && doc.codeUnitAt(i) != 0x0A && doc.codeUnitAt(i) != 0x0D) {
        i++;
      }
    } else if (c == 0x22) {
      if (doc.startsWith('"""', i)) {
        i += 3;
        while (i < n && !doc.startsWith('"""', i)) {
          i += doc.startsWith(r'\"""', i) ? 4 : 1;
        }
        i = i + 3 < n ? i + 3 : n;
      } else {
        i++;
        while (i < n &&
            doc.codeUnitAt(i) != 0x22 &&
            doc.codeUnitAt(i) != 0x0A) {
          i += doc.codeUnitAt(i) == 0x5C ? 2 : 1;
        }
        i = i + 1 < n ? i + 1 : n;
      }
    } else if (c == 0x28) {
      parens++;
      i++;
    } else if (c == 0x29) {
      parens = parens > 0 ? parens - 1 : 0;
      i++;
    } else if (c == 0x7B) {
      if (depth == 0 && parens == 0) {
        if (!pending) ops.add(const GraphqlOperation(null, 'query'));
        pending = false;
      }
      depth++;
      i++;
    } else if (c == 0x7D) {
      depth = depth > 0 ? depth - 1 : 0;
      i++;
    } else if (_isNameStart(c)) {
      final start = i;
      while (i < n && _isNameChar(doc.codeUnitAt(i))) {
        i++;
      }
      if (depth == 0 && parens == 0 && !pending) {
        final word = doc.substring(start, i);
        if (word == 'query' || word == 'mutation' || word == 'subscription') {
          var j = i;
          while (j < n) {
            final d = doc.codeUnitAt(j);
            if (d == 0x23) {
              while (j < n &&
                  doc.codeUnitAt(j) != 0x0A &&
                  doc.codeUnitAt(j) != 0x0D) {
                j++;
              }
            } else if (d == 0x20 ||
                d == 0x09 ||
                d == 0x0A ||
                d == 0x0D ||
                d == 0x2C ||
                d == 0xFEFF) {
              j++;
            } else {
              break;
            }
          }
          if (j < n && _isNameStart(doc.codeUnitAt(j))) {
            var k = j;
            while (k < n && _isNameChar(doc.codeUnitAt(k))) {
              k++;
            }
            ops.add(GraphqlOperation(doc.substring(j, k), word));
            i = k;
          } else {
            ops.add(GraphqlOperation(null, word));
          }
          pending = true;
        } else if (word == 'fragment') {
          pending = true;
        }
      }
    } else {
      i++;
    }
  }
  return ops;
}

bool _isAsciiSpace(int c) => c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D;

String _trimAsciiWhitespace(String s) {
  var a = 0;
  var b = s.length;
  while (a < b && _isAsciiSpace(s.codeUnitAt(a))) {
    a++;
  }
  while (b > a && _isAsciiSpace(s.codeUnitAt(b - 1))) {
    b--;
  }
  return s.substring(a, b);
}

/// `name=value` pairs of a URL's query string (first occurrence wins); null
/// when one cannot be decoded.
Map<String, String>? urlQueryParams(String url) {
  final params = <String, String>{};
  final q = url.indexOf('?');
  if (q < 0) return params;
  final hash = url.indexOf('#', q);
  final query = url.substring(q + 1, hash < 0 ? url.length : hash);
  for (final part in query.split('&')) {
    if (part.isEmpty) continue;
    final eq = part.indexOf('=');
    final rawKey = eq < 0 ? part : part.substring(0, eq);
    final rawValue = eq < 0 ? '' : part.substring(eq + 1);
    final key = decodeUriComponent(rawKey.replaceAll('+', ' '));
    final value = decodeUriComponent(rawValue.replaceAll('+', ' '));
    if (key == null || value == null) return null;
    params.putIfAbsent(key, () => value);
  }
  return params;
}

int _hex(int c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/// JavaScript's `decodeURIComponent`: `%XX` runs decoded as strict UTF-8;
/// null where it would throw.
String? decodeUriComponent(String s) {
  if (!s.contains('%')) return s;
  final out = StringBuffer();
  final n = s.length;
  var i = 0;
  while (i < n) {
    final c = s.codeUnitAt(i);
    if (c != 0x25) {
      out.writeCharCode(c);
      i++;
      continue;
    }
    final bytes = <int>[];
    while (i < n && s.codeUnitAt(i) == 0x25) {
      if (i + 2 >= n) return null;
      final hi = _hex(s.codeUnitAt(i + 1));
      final lo = _hex(s.codeUnitAt(i + 2));
      if (hi < 0 || lo < 0) return null;
      bytes.add(hi * 16 + lo);
      i += 3;
    }
    final decoded = strictUtf8Decode(bytes, 0, bytes.length);
    if (decoded == null) return null;
    out.write(decoded);
  }
  return out.toString();
}

/// Strict UTF-8 (no overlong forms, no encoded surrogates, nothing above
/// U+10FFFF); null when [bytes] from [start] to [end] are not well-formed.
String? strictUtf8Decode(List<int> bytes, int start, int end) {
  final units = <int>[];
  var i = start;
  while (i < end) {
    final b0 = bytes[i] & 0xFF;
    if (b0 < 0x80) {
      units.add(b0);
      i++;
      continue;
    }
    int need;
    var lower = 0x80;
    var upper = 0xBF;
    int cp;
    if (b0 >= 0xC2 && b0 <= 0xDF) {
      need = 1;
      cp = b0 & 0x1F;
    } else if (b0 >= 0xE0 && b0 <= 0xEF) {
      need = 2;
      cp = b0 & 0x0F;
      if (b0 == 0xE0) lower = 0xA0;
      if (b0 == 0xED) upper = 0x9F;
    } else if (b0 >= 0xF0 && b0 <= 0xF4) {
      need = 3;
      cp = b0 & 0x07;
      if (b0 == 0xF0) lower = 0x90;
      if (b0 == 0xF4) upper = 0x8F;
    } else {
      return null;
    }
    if (i + need >= end) return null;
    for (var k = 1; k <= need; k++) {
      final b = bytes[i + k] & 0xFF;
      if (b < lower || b > upper) return null;
      lower = 0x80;
      upper = 0xBF;
      cp = (cp << 6) | (b & 0x3F);
    }
    if (cp >= 0x10000) {
      final v = cp - 0x10000;
      units
        ..add(0xD800 + (v >> 10))
        ..add(0xDC00 + (v & 0x3FF));
    } else {
      units.add(cp);
    }
    i += need + 1;
  }
  return String.fromCharCodes(units);
}

/// The body text a matcher may read from bytes the SDK already holds:
/// well-formed UTF-8 (one leading BOM dropped, as `TextDecoder` does) of at
/// most [kMockGraphqlMaxBodyBytes] bytes; null otherwise.
String? mockBodyText(List<int> bytes) {
  if (bytes.length > kMockGraphqlMaxBodyBytes) return null;
  final bom = bytes.length >= 3 &&
      bytes[0] == 0xEF &&
      bytes[1] == 0xBB &&
      bytes[2] == 0xBF;
  return strictUtf8Decode(bytes, bom ? 3 : 0, bytes.length);
}

class _Payload {
  String? query;
  String? operationName;
}

class _Frame {
  _Frame(this.isObject, this.isTopArray, this.payload);

  final bool isObject;
  final bool isTopArray;
  final _Payload? payload;

  /// The member of [payload] the current value goes to: 1 = query,
  /// 2 = operationName, 0 = none.
  int member = 0;
}

class _Invalid implements Exception {
  const _Invalid();
}

/// Strict JSON reading for GraphQL payloads (RFC 8259 as `JSON.parse`
/// accepts it: no comments, single quotes, trailing commas, leading zeros or
/// raw control characters; lone surrogate escapes allowed; any nesting depth,
/// without recursion). Only `query` and `operationName` of the payload
/// objects (the top-level object, or the objects directly inside a top-level
/// array) are kept; the last duplicate key wins, like `JSON.parse`.
class _StrictJson {
  _StrictJson(this.s);

  final String s;
  int pos = 0;
  final List<_Frame> stack = <_Frame>[];
  final List<_Payload> found = <_Payload>[];

  static List<_Payload>? payloads(String text) {
    try {
      return _StrictJson(text)._read();
    } on _Invalid {
      return null;
    }
  }

  List<_Payload> _read() {
    final n = s.length;
    var expectValue = true;
    while (true) {
      if (expectValue) {
        expectValue = false;
        if (_openValue()) {
          expectValue = true;
          continue;
        }
      }
      // A value just ended: continue or close the enclosing container.
      if (stack.isEmpty) break;
      final top = stack.last;
      _skipWs();
      if (pos >= n) throw const _Invalid();
      final c = s.codeUnitAt(pos++);
      if (top.isObject) {
        if (c == 0x2C) {
          _readKey(top);
          expectValue = true;
        } else if (c == 0x7D) {
          _close();
        } else {
          throw const _Invalid();
        }
      } else {
        if (c == 0x2C) {
          expectValue = true;
        } else if (c == 0x5D) {
          _close();
        } else {
          throw const _Invalid();
        }
      }
    }
    _skipWs();
    if (pos != n) throw const _Invalid();
    return found;
  }

  void _close() {
    final frame = stack.removeLast();
    final payload = frame.payload;
    if (payload != null) found.add(payload);
  }

  void _skipWs() {
    while (pos < s.length) {
      final c = s.codeUnitAt(pos);
      if (c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D) {
        pos++;
      } else {
        break;
      }
    }
  }

  void _assign(String? value) {
    if (stack.isEmpty) return;
    final top = stack.last;
    final payload = top.payload;
    if (payload == null) return;
    if (top.member == 1) payload.query = value;
    if (top.member == 2) payload.operationName = value;
  }

  void _readKey(_Frame frame) {
    _skipWs();
    if (pos >= s.length || s.codeUnitAt(pos) != 0x22) throw const _Invalid();
    final key = _readString(frame.payload != null);
    frame.member = key == 'query'
        ? 1
        : key == 'operationName'
        ? 2
        : 0;
    _skipWs();
    if (pos >= s.length || s.codeUnitAt(pos) != 0x3A) throw const _Invalid();
    pos++;
  }

  /// Reads one value. A container is opened (pushed); returns true when its
  /// first member is due next (no recursion: nesting depth costs heap, not
  /// stack). Scalars and empty containers are read whole.
  bool _openValue() {
    _skipWs();
    if (pos >= s.length) throw const _Invalid();
    final c = s.codeUnitAt(pos);
    if (c == 0x7B || c == 0x5B) {
      _assign(null);
      pos++;
      final isObject = c == 0x7B;
      final isPayload =
          isObject &&
          (stack.isEmpty || (stack.length == 1 && stack[0].isTopArray));
      final frame = _Frame(
        isObject,
        !isObject && stack.isEmpty,
        isPayload ? _Payload() : null,
      );
      stack.add(frame);
      _skipWs();
      if (pos < s.length && s.codeUnitAt(pos) == (isObject ? 0x7D : 0x5D)) {
        pos++;
        _close();
        return false;
      }
      if (isObject) _readKey(frame);
      return true;
    }
    if (c == 0x22) {
      final wanted =
          stack.isNotEmpty &&
          stack.last.payload != null &&
          stack.last.member != 0;
      final value = _readString(wanted);
      _assign(wanted ? value : null);
    } else if (c == 0x74) {
      _literal('true');
    } else if (c == 0x66) {
      _literal('false');
    } else if (c == 0x6E) {
      _literal('null');
    } else if (c == 0x2D || (c >= 0x30 && c <= 0x39)) {
      _number();
      _assign(null);
    } else {
      throw const _Invalid();
    }
    return false;
  }

  void _literal(String word) {
    if (!s.startsWith(word, pos)) throw const _Invalid();
    pos += word.length;
    _assign(null);
  }

  int _digits() {
    final start = pos;
    while (pos < s.length) {
      final c = s.codeUnitAt(pos);
      if (c < 0x30 || c > 0x39) break;
      pos++;
    }
    return pos - start;
  }

  void _number() {
    if (s.codeUnitAt(pos) == 0x2D) pos++;
    if (pos >= s.length) throw const _Invalid();
    final c = s.codeUnitAt(pos);
    if (c == 0x30) {
      pos++;
    } else if (c >= 0x31 && c <= 0x39) {
      _digits();
    } else {
      throw const _Invalid();
    }
    if (pos < s.length && s.codeUnitAt(pos) == 0x2E) {
      pos++;
      if (_digits() == 0) throw const _Invalid();
    }
    if (pos < s.length &&
        (s.codeUnitAt(pos) == 0x65 || s.codeUnitAt(pos) == 0x45)) {
      pos++;
      if (pos < s.length &&
          (s.codeUnitAt(pos) == 0x2B || s.codeUnitAt(pos) == 0x2D)) {
        pos++;
      }
      if (_digits() == 0) throw const _Invalid();
    }
  }

  /// Reads a string starting at the opening quote; decodes it only when
  /// [decode] (else returns '').
  String _readString(bool decode) {
    pos++;
    final out = decode ? <int>[] : null;
    final n = s.length;
    while (true) {
      if (pos >= n) throw const _Invalid();
      final c = s.codeUnitAt(pos);
      if (c == 0x22) {
        pos++;
        return out == null ? '' : String.fromCharCodes(out);
      } else if (c == 0x5C) {
        if (pos + 1 >= n) throw const _Invalid();
        final e = s.codeUnitAt(pos + 1);
        int unit;
        switch (e) {
          case 0x22 || 0x5C || 0x2F:
            unit = e;
          case 0x62:
            unit = 0x08;
          case 0x66:
            unit = 0x0C;
          case 0x6E:
            unit = 0x0A;
          case 0x72:
            unit = 0x0D;
          case 0x74:
            unit = 0x09;
          case 0x75:
            if (pos + 5 >= n) throw const _Invalid();
            var code = 0;
            for (var k = 2; k <= 5; k++) {
              final v = _hex(s.codeUnitAt(pos + k));
              if (v < 0) throw const _Invalid();
              code = code * 16 + v;
            }
            unit = code;
            pos += 4;
          default:
            throw const _Invalid();
        }
        out?.add(unit);
        pos += 2;
      } else if (c < 0x20) {
        throw const _Invalid();
      } else {
        out?.add(c);
        pos++;
      }
    }
  }
}
