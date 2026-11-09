/// Network helpers of the in-app inspector, ported from the desktop UI
/// (`packages/ui/src/features/network/model/*`): filters and the query
/// language, short error labels, reason phrases, the timing breakdown,
/// GraphQL operations and the "Copy as" generators.
library;

import 'dart:convert';

import 'store.dart';
import 'text_match.dart';

/* ───────────────────────────── filters ───────────────────────────── */

const List<String> kMethodChips = <String>['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER'];
const List<String> kStatusClasses = <String>['2xx', '3xx', '4xx', '5xx', 'fail'];
const int kSlowMs = 1000;

class NetFilters {
  NetFilters();

  final Set<String> methods = <String>{};
  final Set<String> statuses = <String>{};

  /// Hosts outside the default list the user ticked, and default hosts
  /// they unticked.
  final Set<String> extraHosts = <String>{};
  final Set<String> hiddenHosts = <String>{};
  bool errorsOnly = false;
  bool slowOnly = false;
  bool mockedOnly = false;
  bool searchBodies = false;

  bool get isEmpty =>
      methods.isEmpty && statuses.isEmpty && extraHosts.isEmpty && hiddenHosts.isEmpty && !errorsOnly && !slowOnly && !mockedOnly;

  /// Whether calls to [host] are listed; [isDefault] says whether it is in
  /// the default host list.
  bool showsHost(String host, {required bool isDefault}) =>
      isDefault ? !hiddenHosts.contains(host) : extraHosts.contains(host);

  /// Filters away from their default (the badge on the Filters button).
  int get activeCount =>
      methods.length +
      statuses.length +
      (extraHosts.isNotEmpty || hiddenHosts.isNotEmpty ? 1 : 0) +
      (errorsOnly ? 1 : 0) +
      (slowOnly ? 1 : 0) +
      (mockedOnly ? 1 : 0) +
      (searchBodies ? 1 : 0);

  /// Changes whenever a filter does (tells the live list to follow again).
  String get signature =>
      '${methods.join(',')}|${statuses.join(',')}|${extraHosts.join(',')}|${hiddenHosts.join(',')}|$errorsOnly|$slowOnly|$mockedOnly|$searchBodies';

  void reset() {
    searchBodies = false;
    methods.clear();
    statuses.clear();
    extraHosts.clear();
    hiddenHosts.clear();
    errorsOnly = false;
    slowOnly = false;
    mockedOnly = false;
  }
}

String methodChip(String method) {
  final m = method.toUpperCase();
  return kMethodChips.contains(m) ? m : 'OTHER';
}

/// `2xx` … `5xx`, `fail` (transport error) or null (pending / 1xx).
String? statusClass(InspectorCall c) {
  if (c.error != null) return c.cancelled ? null : 'fail';
  final s = c.status;
  if (s == null || s < 200) return null;
  if (s >= 500) return '5xx';
  if (s >= 400) return '4xx';
  if (s >= 300) return '3xx';
  return '2xx';
}

bool isSlow(InspectorCall c, [int slowMs = kSlowMs]) =>
    (c.duration?.inMilliseconds ?? 0) >= slowMs;

String hostOf(InspectorCall c) => c.uri?.host ?? '';

/// One clause of the search field.
class QueryClause {
  const QueryClause(this.key, this.value, {this.negate = false});

  /// status, method, host, path, source, is, op — null for a free word.
  final String? key;
  final String value;
  final bool negate;
}

const Map<String, String> _keyAliases = <String, String>{
  'status': 'status',
  'durum': 'status',
  'method': 'method',
  'metot': 'method',
  'host': 'host',
  'path': 'path',
  'yol': 'path',
  'source': 'source',
  'kaynak': 'source',
  'is': 'is',
  'op': 'op',
  'tag': 'tag',
  'level': 'level',
  'seviye': 'level',
  'message': 'message',
  'mesaj': 'message',
};

/// Splits on spaces, keeping "quoted phrases" together.
List<String> tokenize(String text) {
  final out = <String>[];
  final b = StringBuffer();
  var quoted = false;
  for (final ch in text.split('')) {
    if (ch == '"') {
      quoted = !quoted;
      b.write(ch);
    } else if (ch == ' ' && !quoted) {
      if (b.isNotEmpty) out.add(b.toString());
      b.clear();
    } else {
      b.write(ch);
    }
  }
  if (b.isNotEmpty) out.add(b.toString());
  return out;
}

List<QueryClause> parseQuery(String text) {
  final clauses = <QueryClause>[];
  for (var t in tokenize(text.trim())) {
    var negate = false;
    if (t == '-') continue;
    if (t.startsWith('-')) {
      negate = true;
      t = t.substring(1);
    }
    final colon = t.indexOf(':');
    final key = colon > 0 ? _keyAliases[foldText(t.substring(0, colon))] : null;
    final raw = key == null ? t : t.substring(colon + 1);
    // Folded: case, ş ı ğ ü ö ç and İ never decide a match.
    final value = foldText(raw.replaceAll(RegExp(r'^"|"$'), ''));
    if (value.isEmpty) continue;
    clauses.add(QueryClause(key, value, negate: negate));
  }
  return clauses;
}

/// The free (non-negated, key-less) words of a query, to mark in rows.
List<String> freeTerms(List<QueryClause> clauses) => <String>[
      for (final q in clauses)
        if (q.key == null && !q.negate) q.value
    ];

bool _statusMatches(InspectorCall c, String v) {
  final s = c.status;
  if (RegExp(r'^[1-5]xx$').hasMatch(v)) return s != null && c.error == null && s ~/ 100 == int.parse(v[0]);
  if (const <String>['fail', 'failed', 'hata', 'error'].contains(v)) return c.error != null && !c.cancelled;
  if (const <String>['pending', 'bekliyor'].contains(v)) return c.state == InspectorCallState.pending;
  if (const <String>['cancelled', 'iptal'].contains(v)) return c.cancelled;
  final cmp = RegExp(r'^(>=|<=|>|<)?(\d{1,3})$').firstMatch(v);
  if (cmp == null || s == null) return false;
  final n = int.parse(cmp.group(2)!);
  return switch (cmp.group(1)) {
    '>=' => s >= n,
    '<=' => s <= n,
    '>' => s > n,
    '<' => s < n,
    _ => s == n,
  };
}

bool _isMatches(InspectorCall c, String v) => switch (v) {
  'failed' || 'fail' || 'error' || 'hata' => c.isFailure,
  'pending' || 'bekliyor' => c.state == InspectorCallState.pending,
  'mocked' || 'mock' => c.mocked,
  'slow' || 'yavas' || 'yavaş' => isSlow(c),
  'graphql' => graphqlLabel(c) != null,
  'cancelled' || 'iptal' => c.cancelled,
  'native' => c.native,
  _ => false,
};

/// Whether [c] matches the parsed search [clauses] (free words search the
/// URL, method, status, error and GraphQL operation; with [bodies] also the
/// captured text bodies).
bool callMatchesQuery(InspectorCall c, List<QueryClause> clauses, {bool bodies = false}) {
  for (final q in clauses) {
    final bool hit;
    switch (q.key) {
      case 'status':
        hit = _statusMatches(c, q.value);
      case 'method':
        hit = q.value.split(',').contains(foldText(c.method));
      case 'host':
        hit = foldContains(hostOf(c), q.value);
      case 'path':
        hit = urlContains(c.uri?.path ?? c.url, q.value);
      case 'source':
        hit = foldContains(c.source, q.value);
      case 'is':
        hit = _isMatches(c, q.value);
      case 'op':
        hit = foldContains(graphqlLabel(c) ?? '', q.value);
      default:
        final v = q.value;
        hit = urlContains(c.url, v) ||
            foldText(c.method) == v ||
            '${c.status ?? ''}' == v ||
            foldContains(c.error ?? '', v) ||
            foldContains(graphqlLabel(c) ?? '', v) ||
            (bodies && (bodyContains(c.requestBody, v) || bodyContains(c.responseBody, v)));
    }
    if (hit == q.negate) return false;
  }
  return true;
}

/// Whether a text [body] contains the folded [needle] (the body's folded
/// text is computed once and kept).
bool bodyContains(InspectorBody? body, String needle) =>
    body != null && body.isText && body.folded.contains(needle);

bool callMatchesFilters(InspectorCall c, NetFilters f, {bool Function(String host)? isDefaultHost}) {
  final host = hostOf(c);
  if (!f.showsHost(host, isDefault: isDefaultHost?.call(host) ?? true)) return false;
  if (f.methods.isNotEmpty && !f.methods.contains(methodChip(c.method))) return false;
  if (f.statuses.isNotEmpty && !f.statuses.contains(statusClass(c))) return false;
  if (f.errorsOnly && !c.isFailure) return false;
  if (f.slowOnly && !isSlow(c)) return false;
  if (f.mockedOnly && !c.mocked) return false;
  return true;
}

/* ───────────────────────────── order ───────────────────────────── */

/// Orders of the Network list, as the sort sheet lists them. [newest] is the
/// default ([kDefaultNetSort]). [arrival] is oldest at the top, newest at the
/// bottom, where the list follows new requests; the others put their first
/// request at the top.
enum NetSort { newest, arrival, slowest, largest, status }

/// The order the Network list opens in: the newest request on top.
const NetSort kDefaultNetSort = NetSort.newest;

/// [calls] (oldest first, as the store keeps them) in the order of [sort].
/// A pending request counts as slow as it has waited until [nowMs] (a hung
/// request is the slowest one); a request without a response size counts
/// as the smallest. Ties go newest first. [arrival] returns [calls] itself.
List<InspectorCall> sortCalls(List<InspectorCall> calls, NetSort sort, {double? nowMs}) {
  if (sort == NetSort.arrival) return calls;
  final now = nowMs ?? DateTime.now().microsecondsSinceEpoch / 1000;
  double elapsed(InspectorCall c) => (c.endTs ?? now) - c.ts;
  int newer(InspectorCall a, InspectorCall b) => b.seq.compareTo(a.seq);
  final out = List<InspectorCall>.of(calls);
  switch (sort) {
    case NetSort.arrival:
      break;
    case NetSort.newest:
      out.sort(newer);
    case NetSort.slowest:
      out.sort((a, b) {
        final d = elapsed(b).compareTo(elapsed(a));
        return d != 0 ? d : newer(a, b);
      });
    case NetSort.largest:
      out.sort((a, b) {
        final d = (b.responseSize ?? -1).compareTo(a.responseSize ?? -1);
        return d != 0 ? d : newer(a, b);
      });
    case NetSort.status:
      out.sort((a, b) {
        final r = statusRank(a).compareTo(statusRank(b));
        if (r != 0) return r;
        final s = (a.status ?? 0).compareTo(b.status ?? 0);
        return s != 0 ? s : newer(a, b);
      });
  }
  return out;
}

/// Errors first: transport error 0, 5xx 1, 4xx 2, pending 3, 3xx 4,
/// 1xx / 2xx 5, cancelled 6.
int statusRank(InspectorCall c) {
  if (c.error != null) return c.cancelled ? 6 : 0;
  final s = c.status;
  if (s == null) return 3;
  if (s >= 500) return 1;
  if (s >= 400) return 2;
  if (s >= 300) return 4;
  return 5;
}

/* ───────────────────────────── errors ───────────────────────────── */

/// timeout · dns · refused · tls · reset · offline · cancelled · generic
String shortErrorKey(String? error, {bool cancelled = false}) {
  final e = (error ?? '').toLowerCase();
  if (cancelled || RegExp('cancel').hasMatch(e)) return 'cancelled';
  if (e.isEmpty) return 'generic';
  if (RegExp(r'time ?out|timed out|-1001\b').hasMatch(e)) return 'timeout';
  if (RegExp(r'host lookup|enotfound|eai_again|nodename|unknownhostexception|unable to resolve host|dns|cannot find host|-1003\b').hasMatch(e)) {
    return 'dns';
  }
  if (RegExp(r'handshake|certificate|ssl|tls|-120[0-9]\b').hasMatch(e)) return 'tls';
  if (RegExp(r'refused|econnrefused|-1004\b').hasMatch(e)) return 'refused';
  if (RegExp(r'not connected to the internet|network is unreachable|offline|-1009\b|enetunreach').hasMatch(e)) return 'offline';
  if (RegExp(r'reset|closed|broken pipe|econnreset|connection abort|-1005\b|unexpected end of stream').hasMatch(e)) return 'reset';
  return 'generic';
}

/// "SocketException: Failed host lookup…" → (SocketException, Failed host lookup…).
(String?, String) splitError(String? error) {
  final e = (error ?? '').trim();
  final m = RegExp(r'^([A-Za-z_$][\w$.]*(?:Exception|Error|Failure))(?::\s*|\s+)([\s\S]*)$').firstMatch(e);
  if (m != null && (m.group(2) ?? '').isNotEmpty) return (m.group(1), m.group(2)!);
  return (null, e);
}

const Map<int, String> kReasonPhrases = <int, String>{
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted',
  203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect',
  308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Content Too Large', 414: 'URI Too Long',
  415: 'Unsupported Media Type', 418: "I'm a teapot", 422: 'Unprocessable Content', 425: 'Too Early',
  426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

String? reasonPhrase(int? status) => status == null ? null : kReasonPhrases[status];

/* ───────────────────────────── timing ───────────────────────────── */

const List<String> kTimingPhases = <String>['dns', 'connect', 'tls', 'send', 'wait', 'receive'];

class PhaseSpan {
  const PhaseSpan(this.phase, this.start, this.ms);

  /// queue, dns, connect, tls, send, wait, receive.
  final String phase;
  final double start;
  final double ms;
}

class TimingBreakdown {
  const TimingBreakdown(this.spans, this.total, {required this.known});

  final List<PhaseSpan> spans;
  final double? total;
  final bool known;
}

/// Phases one after another; time the SDK did not attribute to a phase is
/// shown first as "queue"; phases adding up to more than the total are
/// scaled down (as the desktop's `timingBreakdown`).
TimingBreakdown timingBreakdown(InspectorCall c) {
  final total = c.duration == null ? null : c.duration!.inMicroseconds / 1000;
  final t = c.timings ?? const <String, Object?>{};
  final raw = <(String, double)>[
    for (final p in kTimingPhases)
      if (t[p] is num && (t[p] as num) > 0 && (t[p] as num).isFinite) (p, (t[p] as num).toDouble()),
  ];
  if (raw.isEmpty) return TimingBreakdown(const <PhaseSpan>[], total, known: false);
  final reported = raw.fold<double>(0, (s, x) => s + x.$2);
  final scale = total != null && reported > total && reported > 0 ? total / reported : 1.0;
  final spans = <PhaseSpan>[];
  var at = 0.0;
  final gap = total == null ? 0.0 : (total - reported).clamp(0.0, double.infinity);
  if (gap >= 1) {
    spans.add(PhaseSpan('queue', 0, gap));
    at = gap;
  }
  for (final (p, ms) in raw) {
    spans.add(PhaseSpan(p, at, ms * scale));
    at += ms * scale;
  }
  return TimingBreakdown(spans, total, known: true);
}

/* ───────────────────────────── GraphQL ───────────────────────────── */

final Expando<Object> _gqlCache = Expando<Object>();
const Object _noGql = Object();

/// "query GetUser" / "mutation LikeStory" for GraphQL requests, else null.
String? graphqlLabel(InspectorCall c) {
  final cached = _gqlCache[c];
  if (cached != null) return identical(cached, _noGql) ? null : cached as String;
  String? label;
  try {
    label = _graphql(c);
  } catch (_) {
    label = null;
  }
  _gqlCache[c] = label ?? _noGql;
  return label;
}

String? _graphql(InspectorCall c) {
  final path = c.uri?.path.toLowerCase() ?? '';
  final ct = (c.requestContentType ?? '').toLowerCase();
  String? query;
  String? name;
  if (c.method.toUpperCase() == 'GET') {
    // Not Uri.queryParameters: it throws on `%FF` or a cut escape.
    for (final p in queryPairs(c.uri?.query ?? '')) {
      if (p[0] == 'query') query ??= p[1];
      if (p[0] == 'operationName') name ??= p[1];
    }
  } else {
    // Peeked: the label is cached, and an export reading every call's label
    // should not keep every request body decoded.
    final body = c.peekRequestBody();
    if (body == null || !body.isText || body.data.isEmpty) return null;
    if (ct.contains('application/graphql')) {
      query = body.data;
    } else {
      if (!ct.contains('json') && !path.contains('graphql')) return null;
      final v = jsonDecode(body.data);
      final op = v is List && v.isNotEmpty ? v.first : v;
      if (op is! Map || op['query'] is! String) return null;
      query = op['query'] as String;
      name = op['operationName'] is String ? op['operationName'] as String : null;
    }
  }
  if (query == null) return null;
  final m = RegExp(r'^\s*(query|mutation|subscription)\b\s*([A-Za-z_][\w]*)?').firstMatch(query);
  final kind = m?.group(1) ?? (query.trimLeft().startsWith('{') ? 'query' : null);
  if (kind == null) return null;
  final opName = name ?? m?.group(2);
  return opName == null ? kind : '$kind $opName';
}

/* ───────────────────────────── content ───────────────────────────── */

/// JSON, HTML, XML, Image, Text, Binary … for the body header line.
String bodyKindLabel(String? contentType, InspectorBody body) {
  final ct = (contentType ?? '').toLowerCase();
  if (ct.contains('json')) return 'JSON';
  if (ct.contains('html')) return 'HTML';
  if (ct.contains('xml')) return 'XML';
  if (ct.startsWith('image/')) return 'Image';
  if (ct.contains('form-urlencoded')) return 'Form';
  if (ct.contains('multipart')) return 'Multipart';
  if (ct.startsWith('text/') || body.isText) {
    final t = body.data.trimLeft();
    if (t.startsWith('{') || t.startsWith('[')) return 'JSON';
    return 'Text';
  }
  return 'Binary';
}

/* ───────────────────────────── copy as ───────────────────────────── */

const List<String> kCopyFormats = <String>['curl', 'fetch', 'dio', 'swift', 'kotlin'];
const int _maxInlineBinary = 256 * 1024;

bool _dropHeader(String name) {
  final n = name.toLowerCase();
  return n.startsWith(':') || n == 'content-length' || n == 'host' || n == 'connection' || n == 'transfer-encoding';
}

class _Prepared {
  _Prepared(this.method, this.headers, this.kind, this.text, this.base64, this.size);

  final String method;
  final List<List<String>> headers;

  /// none · text · binary
  final String kind;
  final String? text;
  final String? base64;
  final int size;
}

_Prepared _prepare(InspectorCall c) => _prepareParts(c.method, c.requestHeaders, c.requestBody);

_Prepared _prepareParts(String rawMethod, List<List<String>> requestHeaders, InspectorBody? b) {
  final method = rawMethod.isEmpty || rawMethod == '?' ? 'GET' : rawMethod.toUpperCase();
  final headers = <List<String>>[
    for (final h in requestHeaders)
      if (!_dropHeader(h[0])) h,
  ];
  if (b != null && b.data.isNotEmpty) {
    if (b.isText) return _Prepared(method, headers, 'text', b.data, null, utf8.encode(b.data).length);
    final clean = b.data.replaceAll(RegExp(r'\s+'), '');
    return _Prepared(method, headers, 'binary', null, clean, b.bytes.length);
  }
  return _Prepared(method, headers, 'none', null, null, 0);
}

String _shell(String s) =>
    RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(s) ? s : "'${s.replaceAll("'", r"'\''")}'";

List<List<String>> _merged(List<List<String>> headers) {
  final map = <String, List<String>>{};
  for (final h in headers) {
    final key = h[0].toLowerCase();
    final cur = map[key];
    if (cur != null) {
      cur[1] = '${cur[1]}${key == 'cookie' ? '; ' : ', '}${h[1]}';
    } else {
      map[key] = <String>[h[0], h[1]];
    }
  }
  return map.values.toList();
}

String? _contentType(List<List<String>> headers) {
  for (final h in headers) {
    if (h[0].toLowerCase() == 'content-type') return h[1];
  }
  return null;
}

String toCurl(InspectorCall c) => curlCommand(c.method, c.url, c.requestHeaders, c.requestBody);

/// cURL from parts (the share report passes masked headers and body).
String curlCommand(String method, String url, List<List<String>> headers, InspectorBody? body) {
  final p = _prepareParts(method, headers, body);
  final parts = <String>['curl ${_shell(url)}'];
  final hasData = p.kind != 'none';
  if (p.method == 'HEAD') {
    parts.add('--head');
  } else if (!((p.method == 'GET' && !hasData) || (p.method == 'POST' && hasData))) {
    parts.add('-X ${_shell(p.method)}');
  }
  var compressed = false;
  for (final h in p.headers) {
    if (h[0].toLowerCase() == 'accept-encoding' && RegExp('gzip|deflate|br|zstd', caseSensitive: false).hasMatch(h[1])) {
      compressed = true;
      continue;
    }
    parts.add('-H ${_shell('${h[0]}: ${h[1]}')}');
  }
  if (p.kind == 'text') parts.add('--data-raw ${_shell(p.text ?? '')}');
  if (p.kind == 'binary') parts.add('--data-binary @body.bin');
  if (compressed) parts.add('--compressed');
  return parts.join(' \\\n  ');
}

String _js(String s) => jsonEncode(s);

String toFetch(InspectorCall c) {
  final p = _prepare(c);
  final lines = <String>['const response = await fetch(${_js(c.url)}, {', '  method: ${_js(p.method)},'];
  final merged = _merged(p.headers);
  if (merged.isNotEmpty) {
    lines.add('  headers: {');
    for (final h in merged) {
      lines.add('    ${_js(h[0])}: ${_js(h[1])},');
    }
    lines.add('  },');
  }
  if (p.kind == 'text') {
    Object? json;
    var isJson = false;
    if ((_contentType(p.headers) ?? '').toLowerCase().contains('json')) {
      try {
        json = jsonDecode(p.text!);
        isJson = true;
      } catch (_) {}
    }
    if (isJson) {
      final pretty = const JsonEncoder.withIndent('  ').convert(json).split('\n').join('\n  ');
      lines.add('  body: JSON.stringify($pretty),');
    } else {
      lines.add('  body: ${_js(p.text!)},');
    }
  } else if (p.kind == 'binary') {
    lines.add(p.size > _maxInlineBinary
        ? '  body: binaryBody, // the captured binary body is too large to inline'
        : '  body: Uint8Array.from(atob(${_js(p.base64!)}), (c) => c.charCodeAt(0)),');
  }
  lines.add('});');
  return lines.join('\n');
}

String _escape(String s, String quote, {bool dollar = false, bool kotlinUnicode = false}) {
  final out = StringBuffer(quote);
  for (final rune in s.runes) {
    final ch = String.fromCharCode(rune);
    if (ch == r'\') {
      out.write(r'\\');
    } else if (ch == quote) {
      out.write('\\$quote');
    } else if (dollar && ch == r'$') {
      out.write(r'\$');
    } else if (ch == '\n') {
      out.write(r'\n');
    } else if (ch == '\r') {
      out.write(r'\r');
    } else if (ch == '\t') {
      out.write(r'\t');
    } else if (rune < 0x20 || rune == 0x7f) {
      out.write(kotlinUnicode ? '\\u${rune.toRadixString(16).padLeft(4, '0')}' : '\\u{${rune.toRadixString(16)}}');
    } else {
      out.write(ch);
    }
  }
  out.write(quote);
  return out.toString();
}

String dartString(String s) => _escape(s, "'", dollar: true);
String swiftString(String s) => _escape(s, '"');
String kotlinString(String s) => _escape(s, '"', dollar: true, kotlinUnicode: true);

String toDio(InspectorCall c) {
  final p = _prepare(c);
  final imports = <String>["import 'package:dio/dio.dart';"];
  String? data;
  if (p.kind == 'text') data = dartString(p.text!);
  if (p.kind == 'binary') {
    if (p.size > _maxInlineBinary) {
      data = 'binaryBody /* the captured binary body is too large to inline */';
    } else {
      imports.insert(0, "import 'dart:convert';");
      data = 'base64Decode(${dartString(p.base64!)})';
    }
  }
  final merged = _merged(p.headers);
  final lines = <String>[...imports, '', 'final dio = Dio();', 'final response = await dio.request<dynamic>(', '  ${dartString(c.url)},'];
  if (data != null) lines.add('  data: $data,');
  lines
    ..add('  options: Options(')
    ..add('    method: ${dartString(p.method)},');
  if (merged.isNotEmpty) {
    lines.add('    headers: {');
    for (final h in merged) {
      lines.add('      ${dartString(h[0])}: ${dartString(h[1])},');
    }
    lines.add('    },');
  }
  lines
    ..add('  ),')
    ..add(');');
  return lines.join('\n');
}

String toSwift(InspectorCall c) {
  final p = _prepare(c);
  final lines = <String>[
    'import Foundation',
    '',
    'var request = URLRequest(url: URL(string: ${swiftString(c.url)})!)',
    'request.httpMethod = ${swiftString(p.method)}',
    for (final h in p.headers) 'request.addValue(${swiftString(h[1])}, forHTTPHeaderField: ${swiftString(h[0])})',
  ];
  if (p.kind == 'text') lines.add('request.httpBody = Data(${swiftString(p.text!)}.utf8)');
  if (p.kind == 'binary') {
    lines.add(p.size > _maxInlineBinary
        ? 'request.httpBody = binaryBody // the captured binary body is too large to inline'
        : 'request.httpBody = Data(base64Encoded: ${swiftString(p.base64!)})');
  }
  lines.addAll(<String>['', 'let (data, response) = try await URLSession.shared.data(for: request)']);
  return lines.join('\n');
}

String toKotlin(InspectorCall c) {
  final p = _prepare(c);
  final imports = <String>['import okhttp3.OkHttpClient', 'import okhttp3.Request'];
  final ct = _contentType(c.requestHeaders);
  final media = ct != null ? '${kotlinString(ct)}.toMediaType()' : 'null';
  String? bodyExpr;
  if (p.kind == 'text') {
    bodyExpr = '${kotlinString(p.text!)}.toRequestBody($media)';
    imports.add('import okhttp3.RequestBody.Companion.toRequestBody');
  } else if (p.kind == 'binary') {
    if (p.size > _maxInlineBinary) {
      bodyExpr = 'binaryBody.toRequestBody($media) /* the captured binary body is too large to inline */';
    } else {
      bodyExpr = '${kotlinString(p.base64!)}.decodeBase64()!!.toRequestBody($media)';
      imports.add('import okio.ByteString.Companion.decodeBase64');
    }
    imports.add('import okhttp3.RequestBody.Companion.toRequestBody');
  } else if (const <String>{'POST', 'PUT', 'PATCH', 'PROPPATCH', 'REPORT'}.contains(p.method)) {
    bodyExpr = 'ByteArray(0).toRequestBody($media)';
    imports.add('import okhttp3.RequestBody.Companion.toRequestBody');
  }
  if (ct != null && bodyExpr != null) imports.add('import okhttp3.MediaType.Companion.toMediaType');
  final lines = <String>[
    ...imports.toSet(),
    '',
    'val client = OkHttpClient()',
    'val request = Request.Builder()',
    '    .url(${kotlinString(c.url)})',
    for (final h in p.headers) '    .addHeader(${kotlinString(h[0])}, ${kotlinString(h[1])})',
  ];
  if (p.method == 'GET' && bodyExpr == null) {
    lines.add('    .get()');
  } else if (p.method == 'HEAD' && bodyExpr == null) {
    lines.add('    .head()');
  } else {
    lines.add('    .method(${kotlinString(p.method)}, ${bodyExpr ?? 'null'})');
  }
  lines.addAll(<String>['    .build()', '', 'client.newCall(request).execute().use { response ->', '    println(response.body?.string())', '}']);
  return lines.join('\n');
}

String copyAs(String format, InspectorCall c) => switch (format) {
  'fetch' => toFetch(c),
  'dio' => toDio(c),
  'swift' => toSwift(c),
  'kotlin' => toKotlin(c),
  _ => toCurl(c),
};

/// Notes shown next to copied code (never inside it).
enum CopyNote { bodyNotCaptured, bodyTruncated, binaryBody }

List<CopyNote> copyNotes(InspectorCall c) {
  final b = c.requestBody;
  return <CopyNote>[
    if (b == null && c.hasRequestBody) CopyNote.bodyNotCaptured,
    if (b != null && b.data.isEmpty && b.size > 0) CopyNote.bodyNotCaptured,
    if (b != null && b.data.isNotEmpty && b.truncated) CopyNote.bodyTruncated,
    if (b != null && b.data.isNotEmpty && !b.isText) CopyNote.binaryBody,
  ];
}
