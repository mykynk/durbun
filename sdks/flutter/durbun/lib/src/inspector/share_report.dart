/// The share report: one request as text a teammate can read without Dürbün
/// (Slack, Jira, e-mail, GitHub). Light Markdown: plain lines, a bullet list
/// and fenced blocks, so it reads well rendered and as plain text.
///
/// The desktop builds the same text
/// (`packages/ui/src/features/network/model/shareReport.ts`); keep the two in
/// step (`share_report_test.dart` and `shareReport.test.ts` pin the same
/// English report). Secret values are masked by default. Numbers and units
/// are formatted without a locale.
library;

import 'dart:convert';

import '../core/stack_format.dart';
import 'network_model.dart';
import 'store.dart';
import 'strings.dart';

const String kShareMask = '••••';

/// Longer bodies are cut for sharing (a chat message stays readable).
const int kMaxSharedBodyChars = 20000;

class ShareInput {
  const ShareInput({
    required this.method,
    required this.url,
    required this.state,
    required this.startTs,
    required this.source,
    required this.requestHeaders,
    this.status,
    this.statusText,
    this.error,
    this.utcOffsetMinutes,
    this.durationMs,
    this.graphql,
    this.app,
    this.device,
    this.mocked = false,
    this.mockRule,
    this.responseHeaders = const <List<String>>[],
    this.requestContentType,
    this.responseContentType,
    this.requestBody,
    this.responseBody,
    this.requestBodyMissing = false,
    this.responseBodyMissing = false,
  });

  final String method;
  final String url;

  /// pending · complete · failed · cancelled
  final String state;
  final int? status;
  final String? statusText;
  final String? error;

  /// Epoch ms.
  final double startTs;

  /// Minutes east of UTC for the local time (default: this device's offset).
  final int? utcOffsetMinutes;
  final double? durationMs;
  final String source;
  final String? graphql;
  final String? app;
  final String? device;
  final bool mocked;
  final String? mockRule;
  final List<List<String>> requestHeaders;
  final List<List<String>> responseHeaders;
  final String? requestContentType;
  final String? responseContentType;
  final InspectorBody? requestBody;
  final InspectorBody? responseBody;

  /// A body was sent / received but not captured (or dropped later).
  final bool requestBodyMissing;
  final bool responseBodyMissing;
}

class ShareOptions {
  const ShareOptions({this.mask = true, this.bodies = true, this.curl = true});

  /// Replace secret values with ••••.
  final bool mask;

  /// Request and response bodies (also the body in cURL).
  final bool bodies;

  /// A cURL command at the end.
  final bool curl;

  ShareOptions copyWith({bool? mask, bool? bodies, bool? curl}) =>
      ShareOptions(mask: mask ?? this.mask, bodies: bodies ?? this.bodies, curl: curl ?? this.curl);
}

/// The report input for [c]; [app] and [device] as the General tab shows them.
/// [peek] reads the bodies without keeping their decoded copies (a session
/// export reads every body once).
ShareInput shareInputForCall(InspectorCall c, {String? app, String? device, bool peek = false}) {
  final ms = c.duration?.inMicroseconds;
  final requestBody = peek ? c.peekRequestBody() : c.requestBody;
  final responseBody = peek ? c.peekResponseBody() : c.responseBody;
  return ShareInput(
    method: c.method,
    url: c.url,
    state: switch (c.state) {
      InspectorCallState.pending => 'pending',
      InspectorCallState.failed => c.cancelled ? 'cancelled' : 'failed',
      InspectorCallState.done => 'complete',
    },
    status: c.status,
    statusText: c.statusText,
    error: c.error,
    startTs: c.ts,
    durationMs: ms == null ? null : ms / 1000,
    source: c.source,
    graphql: graphqlLabel(c),
    app: app,
    device: device,
    mocked: c.mocked,
    mockRule: c.mockRuleId,
    requestHeaders: c.requestHeaders,
    responseHeaders: c.responseHeaders,
    requestContentType: c.requestContentType,
    responseContentType: c.responseContentType,
    requestBody: requestBody,
    responseBody: responseBody,
    requestBodyMissing: c.hasRequestBody && requestBody == null,
    responseBodyMissing: c.hasResponseBody && responseBody == null,
  );
}

/* ───────────── secrets ───────────── */

const Set<String> _secretNames = <String>{'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'pwd', 'pass', 'otp', 'auth', 'session', 'sid'};
const List<String> _secretParts = <String>[
  'token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'api-key', 'credential', 'signature', 'sessionid', 'session_id', 'session-id', //
];

/// The app's own secret names (`DurbunOptions.secretNames`), normalized by
/// [_normalizeName]; a `*` at either end matches any text there.
List<String> _extraNames = const <String>[];

/// `cardNumber`, `card_number`, `Card-Number` → `cardnumber`.
String _normalizeName(String name) => name.toLowerCase().replaceAll(RegExp(r'[\s._-]'), '');

/// Sets the app's own secret names, masked on top of the built-in ones
/// wherever the panel shares or exports. Called when the SDK starts.
void setExtraSecretNames(Iterable<String> names) {
  _extraNames = <String>[
    for (final n in names)
      if (_normalizeName(n).replaceAll('*', '').isNotEmpty) _normalizeName(n),
  ];
}

bool _extraMatch(String pattern, String name) {
  final start = pattern.startsWith('*');
  final end = pattern.length > 1 && pattern.endsWith('*');
  final core = pattern.substring(start ? 1 : 0, end ? pattern.length - 1 : pattern.length);
  if (start && end) return name.contains(core);
  if (start) return name.endsWith(core);
  if (end) return name.startsWith(core);
  return name == core;
}

/// Header, query, form or JSON key whose value is a secret.
bool isSecretName(String name) {
  final n = name.toLowerCase();
  if (_secretNames.contains(n) || _secretParts.any(n.contains)) return true;
  if (_extraNames.isEmpty) return false;
  final normalized = _normalizeName(name);
  return _extraNames.any((p) => _extraMatch(p, normalized));
}

String _maskHeaderValue(String name, String value) {
  final n = name.toLowerCase();
  if (n == 'cookie') {
    return value
        .split(';')
        .map((p) => p.trim())
        .where((p) => p.isNotEmpty)
        .map((p) => p.indexOf('=') > 0 ? '${p.substring(0, p.indexOf('='))}=$kShareMask' : p)
        .join('; ');
  }
  if (n == 'set-cookie') {
    final parts = value.split(';').map((p) => p.trim()).toList();
    final first = parts.first;
    final eq = first.indexOf('=');
    return <String>[eq > 0 ? '${first.substring(0, eq)}=$kShareMask' : kShareMask, ...parts.skip(1).where((p) => p.isNotEmpty)].join('; ');
  }
  if (n == 'authorization' || n == 'proxy-authorization') {
    final m = RegExp(r'^(\S+)\s+\S').firstMatch(value);
    return m != null ? '${m.group(1)} $kShareMask' : kShareMask;
  }
  return kShareMask;
}

String _decodeKey(String key) {
  try {
    return Uri.decodeQueryComponent(key);
  } catch (_) {
    return key;
  }
}

/// A JSON key with a string, number or boolean value (`"pin": 1234` is as
/// secret as `"pin": "1234"`).
final RegExp _jsonPair =
    RegExp(r'"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false)');

/// `scheme://…` in log text, up to whitespace or a closing quote or bracket.
final RegExp _urlInText = RegExp(r'''\b[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>`)\]}]+''');

/// A cookie header printed in a log line: the rest of the line is values.
final RegExp _cookieLine = RegExp(r'\b(cookie|set-cookie)\s*:\s*(?!••••)[^\n]+', caseSensitive: false);

/// A JSON Web Token anywhere (`eyJ….eyJ….sig`).
final RegExp _jwt = RegExp(r'\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*');

/// `Bearer <token>` / `Basic <credentials>` (a value of 8 characters or more).
final RegExp _authValue = RegExp(r'\b(Bearer|Basic)\s+([A-Za-z0-9\-._~+/]{8,}=*|••••)', caseSensitive: false);

final RegExp _authScheme = RegExp(r'^(bearer|basic)$', caseSensitive: false);

/// `key=value`, `key: value`, `key = "value"` in prose.
final RegExp _textPair = RegExp(r'''\b([A-Za-z_][\w.-]{0,47})(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&"'}\])]+)''');

/// Masks secret values in headers, URLs, query strings and text bodies
/// (JSON string values, form fields) when [on]; [count] says how many it
/// masked. Shared by the share report, the session export and the previous
/// run's log.
class ShareMasker {
  ShareMasker(this.on);

  final bool on;
  int count = 0;

  String _hit(String v) {
    count++;
    return v;
  }

  String header(String name, String value) {
    if (!on || !isSecretName(name) || value == kShareMask) return value;
    final masked = _maskHeaderValue(name, value);
    return masked == value ? value : _hit(masked);
  }

  List<List<String>> headers(List<List<String>> list) => <List<String>>[
        for (final h in list) <String>[h[0], header(h[0], h[1])],
      ];

  String query(String qs) {
    if (!on) return qs;
    return qs.split('&').map((p) {
      final eq = p.indexOf('=');
      if (eq <= 0 || !isSecretName(_decodeKey(p.substring(0, eq))) || p.substring(eq + 1) == kShareMask || eq == p.length - 1) return p;
      return _hit('${p.substring(0, eq)}=$kShareMask');
    }).join('&');
  }

  String url(String url) {
    if (!on) return url;
    final hash = url.indexOf('#');
    final base = hash < 0 ? url : url.substring(0, hash);
    final frag = hash < 0 ? '' : url.substring(hash);
    var out = base.replaceFirstMapped(
        RegExp(r'^([A-Za-z][A-Za-z0-9+.-]*://[^/?#@:]*):([^/?#@]+)@'), (m) => _hit('${m.group(1)}:$kShareMask@'));
    final q = out.indexOf('?');
    if (q >= 0) out = out.substring(0, q + 1) + query(out.substring(q + 1));
    return out + frag;
  }

  /// A query or form value named [name] (decoded).
  String queryValue(String name, String value) =>
      !on || !isSecretName(name) || value.isEmpty || value == kShareMask ? value : _hit(kShareMask);

  /// [text] of a body with [contentType] (JSON when it looks like JSON).
  String bodyText(String text, String contentType) => body(text, contentType, looksJson(contentType, text));

  String body(String text, String contentType, bool json) {
    if (!on) return text;
    if (json) {
      return text.replaceAllMapped(_jsonPair, (m) {
        final key = m.group(1)!;
        return isSecretName(key) && m.group(3) != '"$kShareMask"' ? _hit('"$key"${m.group(2)}"$kShareMask"') : m.group(0)!;
      });
    }
    if (contentType.toLowerCase().contains('x-www-form-urlencoded')) return query(text);
    return text;
  }

  /// Free-form log text (a message, a stack, data printed as JSON) with its
  /// secret-looking values masked: URLs with secret query values, cookie
  /// lines, JSON Web Tokens, `Bearer …` / `Basic …` credentials, JSON pairs
  /// and `password=…` / `apiKey: …` pairs whose name is a secret. Log text
  /// has no fixed shape, so this masks what looks like a secret and keeps
  /// the rest (the desktop's bug report masks log lines the same way).
  String text(String input) {
    if (!on || input.isEmpty) return input;
    var out = input.replaceAllMapped(_urlInText, (m) => url(m.group(0)!));
    out = out.replaceAllMapped(_cookieLine, (m) => _hit('${m.group(1)}: $kShareMask'));
    out = out.replaceAllMapped(_jwt, (_) => _hit(kShareMask));
    out = out.replaceAllMapped(
        _authValue, (m) => m.group(2) == kShareMask ? m.group(0)! : _hit('${m.group(1)} $kShareMask'));
    out = out.replaceAllMapped(_jsonPair, (m) {
      final key = m.group(1)!;
      return isSecretName(key) && m.group(3) != '"$kShareMask"' ? _hit('"$key"${m.group(2)}"$kShareMask"') : m.group(0)!;
    });
    // Pair by pair from every word start: a pair whose name is no secret
    // must not swallow the next one ("retrying: refresh_token=…").
    final pairs = StringBuffer();
    var i = 0;
    while (i < out.length) {
      final m = _textPair.matchAsPrefix(out, i);
      if (m != null) {
        final key = m.group(1)!;
        final value = m.group(3)!;
        if (isSecretName(key) && !value.contains(kShareMask) && !_authScheme.hasMatch(value)) {
          pairs.write(_hit('$key${m.group(2)}$kShareMask'));
          i = m.end;
          continue;
        }
      }
      pairs.write(out[i]);
      i++;
    }
    return pairs.toString();
  }

  /// Structured log data: string, number and boolean values under a secret
  /// key become `••••`, at any depth. Returns [data] itself when nothing
  /// was masked.
  Object? data(Object? data) {
    if (!on) return data;
    Object? walk(Object? v, int depth) {
      if (depth > 32) return v;
      if (v is Map) {
        var changed = false;
        final out = <String, Object?>{};
        for (final e in v.entries) {
          final key = '${e.key}';
          final value = e.value;
          Object? next;
          if ((value is String || value is num || value is bool) && isSecretName(key) && value != kShareMask) {
            next = _hit(kShareMask);
          } else {
            next = walk(value, depth + 1);
          }
          if (!identical(next, value)) changed = true;
          out[key] = next;
        }
        return changed ? out : v;
      }
      if (v is List) {
        var changed = false;
        final out = <Object?>[];
        for (final item in v) {
          final next = walk(item, depth + 1);
          if (!identical(next, item)) changed = true;
          out.add(next);
        }
        return changed ? out : v;
      }
      return v;
    }

    return walk(data, 0);
  }
}

/* ───────────── formatting ───────────── */

const Set<String> _traceHeaders = <String>{
  'x-request-id',
  'x-correlation-id',
  'correlation-id',
  'request-id',
  'x-trace-id',
  'traceparent',
  'x-amzn-trace-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-b3-traceid',
  'x-cloud-trace-context',
  'cf-ray',
  'x-vercel-id',
  'sentry-trace',
  'x-datadog-trace-id',
};

String _pad(int n, [int width = 2]) => n.toString().padLeft(width, '0');

String _stamp(DateTime t, String between) =>
    '${_pad(t.year, 4)}-${_pad(t.month)}-${_pad(t.day)}$between${_pad(t.hour)}:${_pad(t.minute)}:${_pad(t.second)}.${_pad(t.millisecond, 3)}';

/// "2026-11-04 19:22:19.768 (UTC+03:00) · 2026-11-04T16:22:19.768Z"
String shareTime(double ts, [int? utcOffsetMinutes]) {
  final ms = ts.round();
  final off = utcOffsetMinutes ?? DateTime.fromMillisecondsSinceEpoch(ms).timeZoneOffset.inMinutes;
  final local = DateTime.fromMillisecondsSinceEpoch(ms + off * 60000, isUtc: true);
  final abs = off.abs();
  final zone = 'UTC${off < 0 ? '-' : '+'}${_pad(abs ~/ 60)}:${_pad(abs % 60)}';
  return '${_stamp(local, ' ')} ($zone) · ${_stamp(DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true), 'T')}Z';
}

/// "12 B", "1.5 KB", "3.2 MB"
String shareBytes(int n) {
  if (n < 1024) return '$n B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
  return '${(n / (1024 * 1024)).toStringAsFixed(1)} MB';
}

/// "120 ms", "1.50 s"
String shareDuration(double ms) => ms < 1000 ? '${ms.round()} ms' : '${(ms / 1000).toStringAsFixed(2)} s';

bool _space(String c) => c == ' ' || c == '\n' || c == '\r' || c == '\t';

/// Pretty JSON without parsing it: numbers stay exactly as sent, cut or
/// broken JSON still indents.
String reindentJson(String text) {
  final out = StringBuffer();
  final n = text.length;
  var depth = 0;
  var i = 0;
  String nl() => '\n${'  ' * depth}';
  while (i < n) {
    final ch = text[i];
    if (ch == '"') {
      var j = i + 1;
      while (j < n && text[j] != '"') {
        j += text[j] == r'\' ? 2 : 1;
      }
      out.write(text.substring(i, j + 1 < n ? j + 1 : n));
      i = j + 1;
    } else if (_space(ch)) {
      i++;
    } else if (ch == '{' || ch == '[') {
      var j = i + 1;
      while (j < n && _space(text[j])) {
        j++;
      }
      if (j < n && text[j] == (ch == '{' ? '}' : ']')) {
        out.write(ch + text[j]);
        i = j + 1;
      } else {
        depth++;
        out.write(ch + nl());
        i++;
      }
    } else if (ch == '}' || ch == ']') {
      depth = depth > 0 ? depth - 1 : 0;
      out.write(nl() + ch);
      i++;
    } else if (ch == ',') {
      out.write(',${nl()}');
      i++;
    } else if (ch == ':') {
      out.write(': ');
      i++;
    } else {
      out.write(ch);
      i++;
    }
  }
  return out.toString();
}

/// JSON by its content type, or by its first and last characters.
bool looksJson(String contentType, String text) {
  if (contentType.toLowerCase().contains('json')) return true;
  final t = text.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

String _fenceLanguage(String contentType, bool json) {
  final ct = contentType.toLowerCase();
  if (json) return 'json';
  if (ct.contains('html')) return 'html';
  if (ct.contains('xml')) return 'xml';
  return '';
}

/// [text] as a fenced block in [out] (the bug report's log lines).
void fencedBlock(List<String> out, String language, String text) => _fenced(out, language, text);

/// A fence longer than any backtick run in [text], so the block never closes early.
void _fenced(List<String> out, String language, String text) {
  var longest = 0;
  for (final m in RegExp('`{3,}').allMatches(text)) {
    if (m.group(0)!.length > longest) longest = m.group(0)!.length;
  }
  final f = '`' * (longest + 1 > 3 ? longest + 1 : 3);
  out.addAll(<String>['$f$language', text, f, '']);
}

int _base64Size(String b64) {
  final clean = b64.replaceAll(RegExp(r'\s+'), '');
  final pad = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
  final n = (clean.length * 3) ~/ 4 - pad;
  return n < 0 ? 0 : n;
}

void _bodySection(List<String> out, String label, InspectorBody? body, bool missing, String? contentType, ShareMasker m, InspectorStrings t) {
  if (body == null || body.data.isEmpty) {
    if (missing || (body != null && body.size > 0)) out.addAll(<String>['$label: ${t.reportNotCaptured}', '']);
    return;
  }
  final ct = contentType ?? '';
  final captured = body.isText ? utf8.encode(body.data).length : _base64Size(body.data);
  final size = body.truncated || captured < body.size ? t.reportCaptured(shareBytes(captured), shareBytes(body.size)) : shareBytes(body.size);
  final head = '$label (${<String>[ct.split(';').first.trim(), size].where((s) => s.isNotEmpty).join(', ')})';
  if (!body.isText) {
    out.addAll(<String>['$head: ${t.reportBinary}', '']);
    return;
  }
  final json = looksJson(ct, body.data);
  var text = m.body(body.data, ct, json);
  if (json) text = reindentJson(text);
  var rest = 0;
  if (text.length > kMaxSharedBodyChars) {
    var cut = kMaxSharedBodyChars;
    final code = text.codeUnitAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    rest = text.length - cut;
    text = text.substring(0, cut);
  }
  out.add('$head:');
  _fenced(out, _fenceLanguage(ct, json), text);
  if (rest > 0) out.addAll(<String>[t.reportMore(rest), '']);
}

void _headerSection(List<String> out, String label, List<List<String>> headers, ShareMasker m) {
  if (headers.isEmpty) return;
  out.add('$label (${headers.length}):');
  _fenced(out, 'http', m.headers(headers).map((h) => '${h[0]}: ${h[1]}').join('\n'));
}

String _outcome(ShareInput input, InspectorStrings t) {
  if (input.state == 'pending') return t.reportPending;
  final parts = <String>[];
  final status = input.status;
  if (status != null) {
    final text = input.statusText?.isNotEmpty == true ? input.statusText! : (reasonPhrase(status) ?? '');
    parts.add('$status $text'.trim());
  }
  if (input.state == 'cancelled') {
    parts.add(t.reportCancelled);
  } else if (input.state == 'failed') {
    parts.add(t.reportFailed);
  }
  final d = input.durationMs;
  if (d != null) parts.add(shareDuration(d));
  return parts.join(' · ');
}

List<String> _traceIds(List<List<String>> headers) {
  final out = <String>[];
  for (final h in headers) {
    if (!_traceHeaders.contains(h[0].toLowerCase())) continue;
    final item = '${h[0]} ${h[1]}';
    if (!out.contains(item)) out.add(item);
  }
  return out;
}

String buildShareReport(ShareInput input, ShareOptions options, InspectorStrings t) {
  final m = ShareMasker(options.mask);
  final out = shareReportLines(input, options, t, m);
  if (m.count > 0) out.add(t.reportMasked);
  return out.join('\n').trimRight();
}

/// The lines of one request's report, masked by [m]; no closing "masked"
/// note (a session export adds one at its end).
List<String> shareReportLines(ShareInput input, ShareOptions options, InspectorStrings t, ShareMasker m) {
  final method = (input.method.isNotEmpty && input.method != '?' ? input.method : 'GET').toUpperCase();
  final url = m.url(input.url);
  final out = <String>['$method $url', '→ ${_outcome(input, t)}', ''];

  out.add('- ${t.reportTime}: ${shareTime(input.startTs, input.utcOffsetMinutes)}');
  if (input.graphql != null) out.add('- GraphQL: ${input.graphql}');
  if (input.app != null) out.add('- ${t.reportApp}: ${input.app}');
  if (input.device != null) out.add('- ${t.reportDevice}: ${input.device}');
  out.add('- ${t.reportClient}: ${input.source}');
  final ids = _traceIds(<List<String>>[...input.requestHeaders, ...input.responseHeaders]);
  if (ids.isNotEmpty) out.add('- ${t.reportTrace}: ${ids.join(' · ')}');
  if (input.mocked) out.add('- ${t.reportMocked(input.mockRule)}');
  out.add('');

  final error = input.error;
  if (error != null && input.state != 'cancelled') {
    out.add('${t.reportError}:');
    _fenced(out, '', error);
  }
  _headerSection(out, t.reportRequestHeaders, input.requestHeaders, m);
  if (options.bodies) _bodySection(out, t.reportRequestBody, input.requestBody, input.requestBodyMissing, input.requestContentType, m, t);
  _headerSection(out, t.reportResponseHeaders, input.responseHeaders, m);
  if (options.bodies) _bodySection(out, t.reportResponseBody, input.responseBody, input.responseBodyMissing, input.responseContentType, m, t);

  if (options.curl && input.method != '?') {
    final b = options.bodies ? input.requestBody : null;
    final ct = input.requestContentType ?? '';
    // A body too long to show is too long for the command too.
    final tooLong = b != null && b.isText && b.data.length > kMaxSharedBodyChars;
    final body = tooLong
        ? null
        : b != null && b.isText && b.data.isNotEmpty
            ? InspectorBody(encoding: 'utf8', data: m.body(b.data, ct, looksJson(ct, b.data)), size: b.size, truncated: b.truncated)
            : b;
    out.add('cURL:');
    _fenced(out, 'bash', curlCommand(method, url, m.headers(input.requestHeaders), body));
    if (tooLong) out.addAll(<String>[t.reportCurlNoBody, '']);
  }
  return out;
}

/* ───────────── log lines ───────────── */

/// One log line for the log report (`buildLogReport`).
class LogShareInput {
  const LogShareInput({
    required this.level,
    required this.ts,
    required this.message,
    this.kind,
    this.tag,
    this.utcOffsetMinutes,
    this.app,
    this.device,
    this.process,
    this.data,
    this.errorType,
    this.errorMessage,
    this.stack,
  });

  final String level;

  /// "Crash", "Flutter error" (already localized); null for plain lines.
  final String? kind;
  final String? tag;

  /// Epoch ms.
  final double ts;

  /// Minutes east of UTC for the local time (default: this device's offset).
  final int? utcOffsetMinutes;
  final String? app;
  final String? device;
  final String? process;
  final String message;

  /// Structured data logged with the line (shown as JSON).
  final Object? data;
  final String? errorType;
  final String? errorMessage;
  final String? stack;
}

void _capped(List<String> out, String text, InspectorStrings t, [String language = '']) {
  var shown = text;
  var rest = 0;
  if (shown.length > kMaxSharedBodyChars) {
    var cut = kMaxSharedBodyChars;
    final code = shown.codeUnitAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    rest = shown.length - cut;
    shown = shown.substring(0, cut);
  }
  _fenced(out, language, shown);
  if (rest > 0) out.addAll(<String>[t.reportMore(rest), '']);
}

/// The share report of one log line: what a teammate needs in Slack, Jira or
/// an e-mail. The desktop builds the same text
/// (`packages/ui/src/features/logs/model/shareReport.ts`). Log text is shown
/// as it is: a free-form message has no field names to mask, so the preview
/// is what goes out. Structured [LogShareInput.data] has field names: with
/// [mask], secret values in it become `••••` and a closing line says so.
/// [maskText] masks secret-looking values in the message and the stack too
/// ([ShareMasker.text]; the bug report does), and [masker] counts into a
/// report that has its own closing line (no line is added here then).
String buildLogReport(LogShareInput input, InspectorStrings t, {bool mask = true, bool maskText = false, ShareMasker? masker}) {
  final m = masker ?? ShareMasker(mask);
  String txt(String s) => maskText ? m.text(s) : s;
  final data = m.data(input.data);
  final head = <String?>[input.level.toUpperCase(), input.kind, input.tag].whereType<String>().where((s) => s.isNotEmpty).join(' · ');
  final out = <String>[head, ''];
  out.add('- ${t.reportTime}: ${shareTime(input.ts, input.utcOffsetMinutes)}');
  if (input.app != null) out.add('- ${t.reportApp}: ${input.app}');
  if (input.device != null) out.add('- ${t.reportDevice}: ${input.device}');
  if (input.process != null) out.add('- ${t.reportProcess}: ${input.process}');
  out.add('');

  final message = txt(input.message.trimRight());
  if (message.isNotEmpty) {
    out.add('${t.message}:');
    _capped(out, message, t);
  }
  if (data != null) {
    String? json;
    try {
      json = txt(const JsonEncoder.withIndent('  ').convert(data));
    } catch (_) {
      json = null;
    }
    if (json != null) {
      out.add('${t.data}:');
      _capped(out, json, t, 'json');
    }
  }
  final errorMessage = input.errorMessage == null ? null : txt(input.errorMessage!);
  final errText = <String?>[input.errorType, errorMessage].whereType<String>().where((s) => s.isNotEmpty).join(': ');
  if (errText.isNotEmpty && !message.contains(errorMessage ?? errText)) out.addAll(<String>['${t.reportError}: $errText', '']);
  final stack = txt(input.stack?.trimRight() ?? '');
  if (stack.isNotEmpty && !message.contains(stack.split('\n').first)) {
    out.add('${t.stack}:');
    _capped(out, stack, t);
    final note = obfuscatedStackNote(stack, t);
    if (note != null) out.addAll(<String>[note, '']);
  }
  if (m.count > 0 && masker == null) out.add(t.reportMasked);
  return out.join('\n').trimRight();
}

/// One line under an address-only Dart stack (a `--split-debug-info`
/// build): what it is and the `flutter symbolize` command; null for any
/// other stack.
String? obfuscatedStackNote(String stack, InspectorStrings t) {
  final format = AddressOnlyStack.parse(stack);
  return format == null ? null : t.reportNoSymbols(format.symbolizeCommand());
}

/// The report input for a panel log line.
LogShareInput logShareInputFor(InspectorLog log, InspectorStrings t, {String? app, String? device}) {
  final e = log.error;
  String? text(Object? v) => v is String && v.isNotEmpty ? v : null;
  return LogShareInput(
    level: log.level,
    kind: log.isEvent
        ? t.event
        : switch (log.kind) { 'crash' => t.crash, 'flutter-error' => t.reportFlutterError, _ => null },
    tag: log.tag,
    ts: log.ts,
    app: app,
    device: device,
    message: log.message,
    data: log.data,
    errorType: text(e?['type']),
    errorMessage: text(e?['message']),
    stack: text(e?['stack']),
  );
}

/* ───────────── stream messages ───────────── */

/// The share report of one WebSocket message or event-stream event: the
/// connection, when (and how long after it opened), the direction, the
/// type and the kept body. With [mask], secret-looking values in the URL,
/// a JSON body (by key) and a text body (tokens, `password=…`) become
/// `••••` and a closing line says so.
String buildStreamMessageReport(
  InspectorCall call,
  InspectorStreamMessage message,
  InspectorStrings t, {
  bool mask = true,
  String? app,
  String? device,
}) {
  final m = ShareMasker(mask);
  final s = call.stream;
  final sse = (call.connectionKind ?? StreamKind.webSocket) == StreamKind.sse;
  final kind = sse ? 'SSE' : 'WebSocket';
  final what = <String>[
    if (!sse) t.streamDirName(message.out),
    sse ? (message.event ?? 'message') : message.type,
    shareBytes(message.size),
  ].join(' · ');
  final out = <String>['$kind ${m.url(call.url)}', '→ $what', ''];
  out.add('- ${t.reportTime}: ${shareTime(message.ts)}');
  final since = message.ts - (s?.openTs ?? call.ts);
  out.add('- ${t.fieldSinceOpen}: ${since < 0 ? 0 : since.round()} ms');
  out.add('- ${t.fieldSeq}: ${message.seq}');
  if (message.eventId != null) out.add('- ${t.fieldEventId}: ${message.eventId}');
  if (message.retry != null) out.add('- ${t.fieldRetry}: ${message.retry} ms');
  if (message.closeCode != null) {
    final name = t.closeCodeName(message.closeCode);
    out.add('- ${t.fieldCloseCode}: ${message.closeCode}${name == null ? '' : ' · $name'}');
  }
  if (message.closeReason?.isNotEmpty == true) out.add('- ${t.fieldCloseReason}: ${m.text(message.closeReason!)}');
  if (app != null) out.add('- ${t.reportApp}: $app');
  if (device != null) out.add('- ${t.reportDevice}: $device');
  out.add('');

  final body = message.body();
  if (body == null || body.data.isEmpty) {
    if (message.size > 0 && !message.isClose) out.addAll(<String>['${t.body}: ${t.reportNotCaptured}', '']);
  } else {
    final kept = message.keptBytes;
    final size = message.truncated ? t.reportCaptured(shareBytes(kept), shareBytes(message.size)) : shareBytes(message.size);
    if (!body.isText) {
      out.addAll(<String>['${t.body} ($size): ${t.reportBinary}', '']);
    } else {
      final json = looksJson('', body.data);
      var text = json ? m.body(body.data, 'application/json', true) : m.text(body.data);
      if (json) text = reindentJson(text);
      out.add('${t.body} ($size):');
      _capped(out, text, t, json ? 'json' : '');
    }
  }
  if (m.count > 0) out.add(t.reportMasked);
  return out.join('\n').trimRight();
}

/// A message's text is cut here in a Markdown export or a bug report's
/// file (the HAR carries every kept byte).
const int kExportMessageChars = 2000;

/// The kept text of [message] masked by [m] as the single message's share
/// report masks it (JSON by key, other text by what looks secret); null
/// for bytes or no payload.
String? exportMessageText(InspectorStreamMessage message, ShareMasker m) {
  final text = message.text();
  if (text == null || text.isEmpty) return null;
  return looksJson('', text) ? m.body(text, 'application/json', true) : m.text(text);
}

/// The messages of the connection [call] opened (a WebSocket, an event
/// stream) for a Markdown export: a title with the state and the count,
/// then every kept message (order, time since open, direction, type, size)
/// with its text when [bodies], each cut at [kExportMessageChars]. A gap
/// says how many messages the panel's memory limits removed there. Empty
/// for any other request.
List<String> streamExportLines(InspectorCall call, ShareMasker m, InspectorStrings t, {required bool bodies}) {
  final s = call.stream;
  if (s == null) return const <String>[];
  final sse = s.kind == StreamKind.sse;
  final title = t.streamChipTitle(sse ? 'SSE' : 'WebSocket', t.streamState(s.state.name), s.count);
  final out = <String>['${sse ? t.eventsTab : t.messagesTab} ($title):'];
  final messages = s.messages;
  if (messages.isEmpty) {
    return <String>[...out, if (s.dropped > 0) t.allDroppedTitle, ''];
  }
  final lines = <String>[];
  var previous = 0;
  for (final msg in messages) {
    final gap = msg.seq - previous - 1;
    if (gap > 0) lines.add('… ${t.streamGap(gap)}');
    previous = msg.seq;
    final since = msg.ts - s.openTs;
    final reason = msg.closeReason;
    lines.add(<String>[
      '#${msg.seq}',
      '+${shareDuration(since < 0 ? 0 : since)}',
      if (!sse) t.streamDirName(msg.out),
      sse ? (msg.event ?? 'message') : msg.type,
      if (msg.eventId != null) 'id ${msg.eventId}',
      shareBytes(msg.size),
      if (msg.closeCode != null) '${msg.closeCode}',
      if (reason != null && reason.isNotEmpty) m.text(reason),
    ].join(' · '));
    if (!bodies || msg.isClose || msg.isControl) continue;
    if (!msg.hasPayload) {
      if (msg.size > 0) lines.add('    ${t.body}: ${t.reportNotCaptured}');
      continue;
    }
    if (!msg.isText) {
      lines.add('    ${t.reportBinary}');
      continue;
    }
    var text = exportMessageText(msg, m) ?? '';
    var rest = 0;
    if (text.length > kExportMessageChars) {
      var cut = kExportMessageChars;
      final code = text.codeUnitAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
      rest = text.length - cut;
      text = text.substring(0, cut);
    }
    for (final line in text.split('\n')) {
      lines.add('    ${line.trimRight()}');
    }
    if (rest > 0) lines.add('    ${t.reportMore(rest)}');
    if (msg.truncated) lines.add('    ${t.reportCaptured(shareBytes(msg.keptBytes), shareBytes(msg.size))}');
  }
  _fenced(out, '', lines.join('\n'));
  return out;
}
