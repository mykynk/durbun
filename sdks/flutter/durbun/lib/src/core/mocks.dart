/// Mock rules (`MockRule` / `MockAction`) and the reference matcher, with the
/// exact semantics of `mockRuleMatches` in `packages/protocol/src/index.ts`.
library;

/// `MockAction` (flattened union; [type] is `respond`, `delay` or `fail`).
class MockAction {
  const MockAction({
    required this.type,
    this.status = 200,
    this.headers = const <List<String>>[],
    this.body,
    this.bodyEncoding = 'utf8',
    this.delayMs = 0,
    this.error = 'connection',
    this.message,
  });

  /// `respond` | `delay` | `fail`.
  final String type;

  /// respond: HTTP status.
  final int status;

  /// respond: `[name, value]` pairs.
  final List<List<String>> headers;

  /// respond: body text (or base64 when [bodyEncoding] is `base64`).
  final String? body;

  /// respond: `utf8` | `base64`.
  final String bodyEncoding;

  /// respond/fail: optional delay; delay: required delay.
  final int delayMs;

  /// fail: `timeout` | `connection` | `dns` | `tls` | `custom`.
  final String error;

  /// fail: optional message (used by `custom`).
  final String? message;

  bool get isRespond => type == 'respond';
  bool get isDelay => type == 'delay';
  bool get isFail => type == 'fail';

  /// Returns null for unknown/invalid actions (such rules never match).
  static MockAction? fromJson(Object? json) {
    if (json is! Map) return null;
    final type = json['type'];
    final delay = json['delayMs'];
    final delayMs = delay is num && delay > 0 ? delay.toInt() : 0;
    switch (type) {
      case 'respond':
        final status = json['status'];
        return MockAction(
          type: 'respond',
          status: status is num ? status.toInt() : 200,
          headers: _headersFromJson(json['headers']),
          body: json['body']?.toString(),
          bodyEncoding: json['bodyEncoding'] == 'base64' ? 'base64' : 'utf8',
          delayMs: delayMs,
        );
      case 'delay':
        return MockAction(type: 'delay', delayMs: delayMs);
      case 'fail':
        final error = json['error'];
        return MockAction(
          type: 'fail',
          error: const ['timeout', 'connection', 'dns', 'tls', 'custom']
                  .contains(error)
              ? error as String
              : 'connection',
          message: json['message']?.toString(),
          delayMs: delayMs,
        );
    }
    return null;
  }

  Map<String, Object?> toJson() {
    switch (type) {
      case 'respond':
        return <String, Object?>{
          'type': 'respond',
          'status': status,
          if (headers.isNotEmpty) 'headers': headers,
          if (body != null) 'body': body,
          'bodyEncoding': bodyEncoding,
          if (delayMs > 0) 'delayMs': delayMs,
        };
      case 'delay':
        return <String, Object?>{'type': 'delay', 'delayMs': delayMs};
      default:
        return <String, Object?>{
          'type': 'fail',
          'error': error,
          if (message != null) 'message': message,
          if (delayMs > 0) 'delayMs': delayMs,
        };
    }
  }

  static List<List<String>> _headersFromJson(Object? json) {
    if (json is! List) return const <List<String>>[];
    final out = <List<String>>[];
    for (final h in json) {
      if (h is List && h.length >= 2 && h[0] != null) {
        out.add(<String>[h[0].toString(), h[1]?.toString() ?? '']);
      }
    }
    return out;
  }
}

/// `MockRule`.
class MockRule {
  const MockRule({
    required this.id,
    required this.enabled,
    required this.method,
    required this.url,
    required this.match,
    required this.action,
    this.name,
    this.apps,
    this.createdAt = 0,
  });

  final String id;
  final bool enabled;
  final String? name;

  /// `*` or an HTTP method.
  final String method;
  final String url;

  /// `contains` | `exact` | `glob` | `regex`.
  final String match;

  /// Bundle ids / package names; null or empty = every app.
  final List<String>? apps;
  final MockAction action;
  final num createdAt;

  /// Returns null when the JSON is not a usable rule.
  static MockRule? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = json['id'];
    final action = MockAction.fromJson(json['action']);
    if (id == null || action == null) return null;
    final apps = json['apps'];
    final createdAt = json['createdAt'];
    return MockRule(
      id: id.toString(),
      enabled: json['enabled'] == true,
      name: json['name']?.toString(),
      method: (json['method'] ?? '*').toString(),
      url: (json['url'] ?? '').toString(),
      match: (json['match'] ?? 'contains').toString(),
      apps: apps is List ? [for (final a in apps) a.toString()] : null,
      action: action,
      createdAt: createdAt is num ? createdAt : 0,
    );
  }

  static List<MockRule> listFromJson(Object? json) {
    if (json is! List) return const <MockRule>[];
    return [
      for (final r in json)
        if (MockRule.fromJson(r) case final MockRule rule) rule,
    ];
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'enabled': enabled,
    if (name != null) 'name': name,
    'method': method,
    'url': url,
    'match': match,
    if (apps != null) 'apps': apps,
    'action': action.toJson(),
    'createdAt': createdAt,
  };

  /// Display label used in diagnostics headers.
  String get label => (name != null && name!.isNotEmpty) ? name! : id;
}

/// Reference matcher (identical semantics in every SDK):
///  - method: `*` matches anything, otherwise case-insensitive equality;
///  - contains / exact / glob: case-insensitive; glob `*` = any run of chars
///    (incl. `/`), `?` = one char, and must match the WHOLE url;
///  - regex: pattern used as-is (case-sensitive), searched anywhere in the url;
///    an invalid regex never matches;
///  - apps: empty/null = all apps, otherwise must contain [appId].
bool mockRuleMatches(MockRule rule, String method, String url, [String? appId]) {
  if (!rule.enabled) return false;
  final apps = rule.apps;
  if (apps != null &&
      apps.isNotEmpty &&
      (appId == null || !apps.contains(appId))) {
    return false;
  }
  if (rule.method != '*' && rule.method.toUpperCase() != method.toUpperCase()) {
    return false;
  }
  final u = url.toLowerCase();
  final p = rule.url.toLowerCase();
  switch (rule.match) {
    case 'contains':
      return p.isNotEmpty && u.contains(p);
    case 'exact':
      return u == p;
    case 'glob':
      return _globRegExp(p).hasMatch(u);
    case 'regex':
      final re = _userRegExp(rule.url);
      return re != null && re.hasMatch(url);
    default:
      return false;
  }
}

/// First enabled matching rule (rules are ordered; first match wins).
MockRule? findMockRule(
  List<MockRule> rules,
  String method,
  String url, [
  String? appId,
]) {
  for (final rule in rules) {
    if (mockRuleMatches(rule, method, url, appId)) return rule;
  }
  return null;
}

final Map<String, RegExp> _globCache = <String, RegExp>{};
final Map<String, RegExp?> _regexCache = <String, RegExp?>{};

/// Same transformation as the TypeScript reference:
/// escape `. + ^ $ { } ( ) | [ ] \`, then `*` → `.*`, `?` → `.`, anchored.
RegExp _globRegExp(String loweredPattern) {
  final cached = _globCache[loweredPattern];
  if (cached != null) return cached;
  const special = r'.+^${}()|[]\';
  final sb = StringBuffer('^');
  for (final rune in loweredPattern.runes) {
    final ch = String.fromCharCode(rune);
    if (ch == '*') {
      sb.write('.*');
    } else if (ch == '?') {
      sb.write('.');
    } else if (special.contains(ch)) {
      sb
        ..write(r'\')
        ..write(ch);
    } else {
      sb.write(ch);
    }
  }
  sb.write(r'$');
  final re = RegExp(sb.toString());
  if (_globCache.length > 256) _globCache.clear();
  _globCache[loweredPattern] = re;
  return re;
}

RegExp? _userRegExp(String pattern) {
  if (_regexCache.containsKey(pattern)) return _regexCache[pattern];
  RegExp? re;
  try {
    re = RegExp(pattern);
  } on FormatException {
    re = null;
  }
  if (_regexCache.length > 256) _regexCache.clear();
  _regexCache[pattern] = re;
  return re;
}
