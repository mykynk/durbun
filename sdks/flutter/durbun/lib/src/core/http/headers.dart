import 'dart:collection';
import 'dart:io';

/// A standalone [HttpHeaders] implementation for mocked requests and
/// synthesized responses (dart:io's own implementation is private).
class DurbunHttpHeaders implements HttpHeaders {
  DurbunHttpHeaders({bool mutable = true, this.defaultPort = 80})
    : _mutable = mutable;

  /// Builds immutable headers from `[name, value]` pairs.
  factory DurbunHttpHeaders.fromPairs(
    Iterable<List<String>> pairs, {
    bool mutable = false,
  }) {
    final h = DurbunHttpHeaders();
    for (final pair in pairs) {
      if (pair.length < 2) continue;
      try {
        h._addValue(pair[0], pair[1], preserveHeaderCase: true, append: true);
      } catch (_) {}
    }
    h._mutable = mutable;
    return h;
  }

  static const Set<String> _singleValued = <String>{
    HttpHeaders.contentTypeHeader,
    HttpHeaders.contentLengthHeader,
    HttpHeaders.hostHeader,
    HttpHeaders.dateHeader,
    HttpHeaders.expiresHeader,
    HttpHeaders.ifModifiedSinceHeader,
  };

  final LinkedHashMap<String, List<String>> _values =
      LinkedHashMap<String, List<String>>();
  final Map<String, String> _originalNames = <String, String>{};
  final Set<String> _noFolding = <String>{};
  bool _mutable;
  final int defaultPort;

  /// Freezes the headers (like dart:io does once a request is sent).
  void freeze() => _mutable = false;

  bool get isMutable => _mutable;

  void _checkMutable() {
    if (!_mutable) throw HttpException('HTTP headers are not mutable');
  }

  static String _validateName(String name) {
    final lower = name.toLowerCase();
    for (final unit in lower.codeUnits) {
      if (unit <= 32 || unit >= 127 || '()<>@,;:\\"/[]?={}'.codeUnits.contains(unit)) {
        throw FormatException('Invalid HTTP header field name: ${name.codeUnits}', name);
      }
    }
    return lower;
  }

  static String _formatValue(Object value) {
    if (value is DateTime) return HttpDate.format(value);
    return value.toString();
  }

  void _addValue(
    String name,
    Object value, {
    required bool preserveHeaderCase,
    required bool append,
  }) {
    final lower = _validateName(name);
    if (value is Iterable && value is! String) {
      for (final Object? v in value) {
        if (v != null) {
          _addValue(name, v, preserveHeaderCase: preserveHeaderCase, append: append);
        }
      }
      return;
    }
    final formatted = _formatValue(value);
    if (preserveHeaderCase) {
      _originalNames[lower] = name;
    } else {
      _originalNames.remove(lower);
    }
    if (!append || _singleValued.contains(lower)) {
      _values[lower] = <String>[formatted];
    } else {
      (_values[lower] ??= <String>[]).add(formatted);
    }
  }

  @override
  List<String>? operator [](String name) {
    final v = _values[name.toLowerCase()];
    return v == null ? null : List<String>.of(v);
  }

  @override
  String? value(String name) {
    final v = _values[name.toLowerCase()];
    if (v == null) return null;
    if (v.length > 1) {
      throw HttpException('More than one value for header $name');
    }
    return v.first;
  }

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {
    _checkMutable();
    _addValue(name, value, preserveHeaderCase: preserveHeaderCase, append: true);
  }

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {
    _checkMutable();
    _values.remove(name.toLowerCase());
    _addValue(name, value, preserveHeaderCase: preserveHeaderCase, append: true);
  }

  @override
  void remove(String name, Object value) {
    _checkMutable();
    final lower = name.toLowerCase();
    final values = _values[lower];
    if (values == null) return;
    values.remove(_formatValue(value));
    if (values.isEmpty) {
      _values.remove(lower);
      _originalNames.remove(lower);
    }
  }

  @override
  void removeAll(String name) {
    _checkMutable();
    final lower = name.toLowerCase();
    _values.remove(lower);
    _originalNames.remove(lower);
  }

  @override
  void forEach(void Function(String name, List<String> values) action) {
    for (final entry in _values.entries.toList()) {
      action(_originalNames[entry.key] ?? entry.key, List<String>.of(entry.value));
    }
  }

  @override
  void noFolding(String name) => _noFolding.add(name.toLowerCase());

  @override
  void clear() {
    _checkMutable();
    _values.clear();
    _originalNames.clear();
  }

  /// `[name, value]` pairs in insertion order.
  List<List<String>> toPairs() {
    final out = <List<String>>[];
    forEach((name, values) {
      for (final v in values) {
        out.add(<String>[name, v]);
      }
    });
    return out;
  }

  /* ─────────────── typed accessors ─────────────── */

  DateTime? _dateHeader(String name) {
    final v = _values[name];
    if (v == null || v.isEmpty) return null;
    try {
      return HttpDate.parse(v.first);
    } catch (_) {
      return null;
    }
  }

  void _setDateHeader(String name, DateTime? date) {
    _checkMutable();
    if (date == null) {
      _values.remove(name);
    } else {
      _values[name] = <String>[HttpDate.format(date.toUtc())];
    }
  }

  @override
  DateTime? get date => _dateHeader(HttpHeaders.dateHeader);

  @override
  set date(DateTime? value) => _setDateHeader(HttpHeaders.dateHeader, value);

  @override
  DateTime? get expires => _dateHeader(HttpHeaders.expiresHeader);

  @override
  set expires(DateTime? value) =>
      _setDateHeader(HttpHeaders.expiresHeader, value);

  @override
  DateTime? get ifModifiedSince =>
      _dateHeader(HttpHeaders.ifModifiedSinceHeader);

  @override
  set ifModifiedSince(DateTime? value) =>
      _setDateHeader(HttpHeaders.ifModifiedSinceHeader, value);

  (String, int?)? _hostAndPort() {
    final v = _values[HttpHeaders.hostHeader];
    if (v == null || v.isEmpty) return null;
    final raw = v.first;
    final bracket = raw.lastIndexOf(']');
    final colon = raw.lastIndexOf(':');
    if (colon > bracket && colon > 0) {
      return (raw.substring(0, colon), int.tryParse(raw.substring(colon + 1)));
    }
    return (raw, null);
  }

  @override
  String? get host => _hostAndPort()?.$1;

  @override
  set host(String? value) {
    _checkMutable();
    if (value == null) {
      _values.remove(HttpHeaders.hostHeader);
      return;
    }
    final p = port;
    _values[HttpHeaders.hostHeader] = <String>[
      p == null || p == defaultPort ? value : '$value:$p',
    ];
  }

  @override
  int? get port => _hostAndPort()?.$2 ?? (host == null ? null : defaultPort);

  @override
  set port(int? value) {
    _checkMutable();
    final h = host;
    if (h == null) return;
    _values[HttpHeaders.hostHeader] = <String>[
      value == null || value == defaultPort ? h : '$h:$value',
    ];
  }

  @override
  ContentType? get contentType {
    final v = _values[HttpHeaders.contentTypeHeader];
    if (v == null || v.isEmpty) return null;
    try {
      return ContentType.parse(v.first);
    } catch (_) {
      return null;
    }
  }

  @override
  set contentType(ContentType? value) {
    _checkMutable();
    if (value == null) {
      _values.remove(HttpHeaders.contentTypeHeader);
    } else {
      _values[HttpHeaders.contentTypeHeader] = <String>[value.toString()];
    }
  }

  @override
  int get contentLength {
    final v = _values[HttpHeaders.contentLengthHeader];
    if (v == null || v.isEmpty) return -1;
    return int.tryParse(v.first.trim()) ?? -1;
  }

  @override
  set contentLength(int value) {
    _checkMutable();
    if (value < 0) {
      _values.remove(HttpHeaders.contentLengthHeader);
    } else {
      _values[HttpHeaders.contentLengthHeader] = <String>['$value'];
    }
  }

  @override
  bool get persistentConnection {
    final v = _values[HttpHeaders.connectionHeader];
    if (v == null) return true;
    return !v.any((x) => x.toLowerCase().contains('close'));
  }

  @override
  set persistentConnection(bool value) {
    _checkMutable();
    if (value) {
      _values.remove(HttpHeaders.connectionHeader);
    } else {
      _values[HttpHeaders.connectionHeader] = <String>['close'];
    }
  }

  @override
  bool get chunkedTransferEncoding {
    final v = _values[HttpHeaders.transferEncodingHeader];
    return v != null && v.any((x) => x.toLowerCase().contains('chunked'));
  }

  @override
  set chunkedTransferEncoding(bool value) {
    _checkMutable();
    if (value) {
      _values[HttpHeaders.transferEncodingHeader] = <String>['chunked'];
    } else {
      _values.remove(HttpHeaders.transferEncodingHeader);
    }
  }

  /// Every member of the dart:io interface (Dart 3.10) is implemented above.
  /// A member added by a newer Dart SDK then fails at runtime (only if used)
  /// instead of breaking the compilation of every app using Dürbün.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw NoSuchMethodError.withInvocation(this, invocation);

  @override
  String toString() {
    final sb = StringBuffer();
    forEach((name, values) {
      for (final v in values) {
        sb.writeln('$name: $v');
      }
    });
    return sb.toString();
  }
}
