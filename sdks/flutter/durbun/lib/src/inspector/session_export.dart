/// The session export (tools → Export session): many requests as one file,
/// either a Markdown report (a summary table, then every request as the
/// share report prints it) or a HAR 1.2 log that browser tools, Charles and
/// Proxyman open. Secret values are masked by default with the share
/// report's rules (headers, URL credentials, query and form fields, JSON
/// string values).
///
/// Both builders are lazy: they yield one piece per request and read each
/// body only then, without keeping its decoded copy, so a writer can write
/// a large export a slice at a time.
library;

import 'dart:convert';

import '../core/protocol.dart' show kSdkVersion;
import 'network_model.dart';
import 'share_report.dart';
import 'stats.dart';
import 'store.dart';
import 'strings.dart';

enum ExportFormat { markdown, har }

class ExportOptions {
  const ExportOptions({this.format = ExportFormat.markdown, this.mask = true, this.bodies = true, this.all = false});

  final ExportFormat format;

  /// Replace secret values with ••••.
  final bool mask;

  /// Request and response bodies (off: only their sizes).
  final bool bodies;

  /// Every request kept on the phone instead of the ones the Network list
  /// shows.
  final bool all;

  ExportOptions copyWith({ExportFormat? format, bool? mask, bool? bodies, bool? all}) => ExportOptions(
      format: format ?? this.format, mask: mask ?? this.mask, bodies: bodies ?? this.bodies, all: all ?? this.all);
}

/// What the export says about where it comes from.
class ExportContext {
  const ExportContext({
    required this.nowMs,
    this.app,
    this.device,
    this.listed = true,
    this.total = 0,
    this.utcOffsetMinutes,
  });

  /// Epoch ms of the export.
  final double nowMs;
  final String? app;
  final String? device;

  /// The requests are the Network list's (else every request kept).
  final bool listed;

  /// Requests kept on the phone.
  final int total;

  /// Minutes east of UTC for local times (default: this device's offset).
  final int? utcOffsetMinutes;
}

/// Exports larger than this (in UTF-16 units, about bytes for ASCII) are not
/// copied to the clipboard when sharing the file fails.
const int kMaxClipboardExportChars = 512 * 1024;

String exportExtension(ExportFormat f) => f == ExportFormat.har ? 'har' : 'md';

String exportMime(ExportFormat f) => f == ExportFormat.har ? 'application/json' : 'text/markdown';

/// `durbun-shop-20261108-213500.har`: the app's name (letters and digits
/// only) and the local time, so exports sort and never clash.
String exportFileName(ExportFormat f, DateTime local, {String? appName}) {
  String two(int n) => n.toString().padLeft(2, '0');
  final app = (appName ?? '').toLowerCase().replaceAll(RegExp('[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');
  final stamp = '${local.year}${two(local.month)}${two(local.day)}-${two(local.hour)}${two(local.minute)}${two(local.second)}';
  final name = app.isEmpty ? 'session' : (app.length > 32 ? app.substring(0, 32) : app);
  return 'durbun-$name-$stamp.${exportExtension(f)}';
}

/* ───────────────────────────── Markdown ───────────────────────────── */

String _pad2(int n) => n.toString().padLeft(2, '0');

/// "21:34:59.120" in the export's local time.
String _clock(double ts, int? utcOffsetMinutes) {
  final ms = ts.round();
  final off = utcOffsetMinutes ?? DateTime.fromMillisecondsSinceEpoch(ms).timeZoneOffset.inMinutes;
  final t = DateTime.fromMillisecondsSinceEpoch(ms + off * 60000, isUtc: true);
  return '${_pad2(t.hour)}:${_pad2(t.minute)}:${_pad2(t.second)}.${t.millisecond.toString().padLeft(3, '0')}';
}

/// A table cell: no line breaks, `|` escaped.
String _cell(String s) => s.replaceAll(RegExp(r'[\r\n]+'), ' ').replaceAll('|', r'\|');

String _statusText(InspectorCall c, InspectorStrings t) {
  if (c.error != null) {
    return c.cancelled ? t.cancelled : '${t.failShort} · ${t.shortError(shortErrorKey(c.error))}';
  }
  return c.status?.toString() ?? t.pending;
}

String _durationText(InspectorCall c) {
  final d = c.duration;
  return d == null ? '—' : shareDuration(d.inMicroseconds / 1000);
}

/// The section title: `POST /v1/login → 401`.
String _title(InspectorCall c, InspectorStrings t) {
  final method = (c.method.isEmpty ? 'GET' : c.method).toUpperCase();
  final path = c.uri?.path ?? '';
  return '$method ${path.isEmpty ? '/' : path} → ${_statusText(c, t)}';
}

/// The Markdown report of [calls] (in the given order), one piece at a time.
Iterable<String> sessionMarkdown(List<InspectorCall> calls, ExportOptions o, InspectorStrings t, ExportContext ctx) sync* {
  final m = ShareMasker(o.mask);
  final stats = computeNetworkStats(calls);
  final count = ctx.listed && calls.length != ctx.total
      ? '${calls.length} (${t.exportOfTotal(ctx.total)})'
      : '${calls.length}';
  final head = <String>[
    '# ${t.exportReportTitle}',
    '',
    if (ctx.app != null) '- ${t.reportApp}: ${ctx.app}',
    if (ctx.device != null) '- ${t.reportDevice}: ${ctx.device}',
    '- ${t.exportedAt}: ${shareTime(ctx.nowMs, ctx.utcOffsetMinutes)}',
    '- ${t.requests}: $count, ${ctx.listed ? t.exportScopeListedNote : t.exportScopeAllNote}',
    '- ${t.statsSummaryLine(stats.success, stats.clientErrors, stats.serverErrors, stats.failed, stats.pending)}',
    if (stats.averageMs != null)
      '- ${t.duration}: ${t.statsDurationLine(shareDuration(stats.averageMs!), shareDuration(stats.p50Ms!), shareDuration(stats.p95Ms!))}',
    '',
  ];
  yield '${head.join('\n')}\n';
  if (calls.isEmpty) return;

  final table = StringBuffer()
    ..writeln('## ${t.exportSummary}')
    ..writeln()
    ..writeln('| # | ${t.reportTime} | ${t.method} | ${t.status} | ${t.duration} | ${t.responseSize} | URL |')
    ..writeln('| ---: | --- | --- | --- | ---: | ---: | --- |');
  for (var i = 0; i < calls.length; i++) {
    final c = calls[i];
    final size = c.responseSize;
    table.writeln('| ${i + 1} | ${_clock(c.ts, ctx.utcOffsetMinutes)} | ${_cell(c.method.toUpperCase())} | '
        '${_cell(_statusText(c, t))} | ${_durationText(c)} | ${size == null ? '—' : shareBytes(size)} | ${_cell(m.url(c.url))} |');
    if (table.length > 16 * 1024) {
      yield table.toString();
      table.clear();
    }
  }
  table
    ..writeln()
    ..writeln('## ${t.exportDetails}')
    ..writeln();
  yield table.toString();

  final options = ShareOptions(mask: o.mask, bodies: o.bodies, curl: false);
  for (var i = 0; i < calls.length; i++) {
    final c = calls[i];
    final lines = shareReportLines(shareInputForCall(c, peek: true), options, t, m);
    yield '### ${i + 1}. ${_title(c, t)}\n\n${lines.join('\n').trimRight()}\n\n';
  }
  if (m.count > 0) yield '---\n\n${t.reportMasked}\n';
}

/* ───────────────────────────── HAR 1.2 ───────────────────────────── */

double _ms3(double ms) => (ms * 1000).roundToDouble() / 1000;

String _iso(double ts) => DateTime.fromMillisecondsSinceEpoch(ts.round(), isUtc: true).toIso8601String();

String _decodeComponent(String s) {
  try {
    return Uri.decodeQueryComponent(s);
  } catch (_) {
    return s;
  }
}

/// The query of [url] as name / value pairs (decoded), values masked.
List<Map<String, Object?>> _queryString(String url, ShareMasker m) {
  final hash = url.indexOf('#');
  final base = hash < 0 ? url : url.substring(0, hash);
  final q = base.indexOf('?');
  if (q < 0 || q == base.length - 1) return const <Map<String, Object?>>[];
  return <Map<String, Object?>>[
    for (final part in base.substring(q + 1).split('&'))
      if (part.isNotEmpty)
        () {
          final eq = part.indexOf('=');
          final name = _decodeComponent(eq < 0 ? part : part.substring(0, eq));
          final value = eq < 0 ? '' : _decodeComponent(part.substring(eq + 1));
          return <String, Object?>{'name': name, 'value': m.queryValue(name, value)};
        }(),
  ];
}

List<Map<String, Object?>> _harHeaders(List<List<String>> headers, ShareMasker m) => <Map<String, Object?>>[
      for (final h in m.headers(headers)) <String, Object?>{'name': h[0], 'value': h[1]},
    ];

/// `Cookie: a=1; b=2` → a, b; values are secrets ([ShareMasker] masks them).
List<Map<String, Object?>> _requestCookies(List<List<String>> headers, ShareMasker m) => <Map<String, Object?>>[
      for (final h in headers)
        if (h[0].toLowerCase() == 'cookie')
          for (final part in h[1].split(';'))
            if (part.trim().isNotEmpty)
              () {
                final p = part.trim();
                final eq = p.indexOf('=');
                return <String, Object?>{
                  'name': eq < 0 ? p : p.substring(0, eq),
                  'value': m.queryValue('cookie', eq < 0 ? '' : p.substring(eq + 1)),
                };
              }(),
    ];

/// `Set-Cookie: sid=abc; Path=/; HttpOnly` → name, value, path, domain,
/// httpOnly, secure (the expiry is left out: HAR wants ISO dates).
List<Map<String, Object?>> _responseCookies(List<List<String>> headers, ShareMasker m) {
  final out = <Map<String, Object?>>[];
  for (final h in headers) {
    if (h[0].toLowerCase() != 'set-cookie') continue;
    final parts = h[1].split(';').map((p) => p.trim()).toList();
    final eq = parts.first.indexOf('=');
    if (eq <= 0) continue;
    final cookie = <String, Object?>{
      'name': parts.first.substring(0, eq),
      'value': m.queryValue('cookie', parts.first.substring(eq + 1)),
    };
    for (final attr in parts.skip(1)) {
      final a = attr.toLowerCase();
      if (a.startsWith('path=')) cookie['path'] = attr.substring(5);
      if (a.startsWith('domain=')) cookie['domain'] = attr.substring(7);
      if (a == 'httponly') cookie['httpOnly'] = true;
      if (a == 'secure') cookie['secure'] = true;
    }
    out.add(cookie);
  }
  return out;
}

/// HAR timings from the SDK's phases ([timingBreakdown]); unknown phases
/// are -1 (blocked, dns, connect, ssl) or 0 (send, receive), and a request
/// without phases spends its whole time waiting. `connect` includes `ssl`,
/// as HAR defines it.
Map<String, Object?> _harTimings(InspectorCall c, double total) {
  final b = timingBreakdown(c);
  if (!b.known) {
    return <String, Object?>{'blocked': -1, 'dns': -1, 'connect': -1, 'send': 0, 'wait': _ms3(total), 'receive': 0, 'ssl': -1};
  }
  double? span(String p) {
    double? sum;
    for (final s in b.spans) {
      if (s.phase == p) sum = (sum ?? 0) + s.ms;
    }
    return sum;
  }

  final connect = span('connect'), tls = span('tls');
  return <String, Object?>{
    'blocked': _ms3(span('queue') ?? -1),
    'dns': _ms3(span('dns') ?? -1),
    'connect': connect == null && tls == null ? -1 : _ms3((connect ?? 0) + (tls ?? 0)),
    'send': _ms3(span('send') ?? 0),
    'wait': _ms3(span('wait') ?? 0),
    'receive': _ms3(span('receive') ?? 0),
    'ssl': _ms3(tls ?? -1),
  };
}

/// `1.2.3.4:443` / `[::1]:443` → (address, port).
(String, String?) _splitAddress(String remote) {
  final v6 = RegExp(r'^\[([^\]]+)\]:(\d+)$').firstMatch(remote);
  if (v6 != null) return (v6.group(1)!, v6.group(2));
  final v4 = RegExp(r'^([^:]+):(\d+)$').firstMatch(remote);
  if (v4 != null) return (v4.group(1)!, v4.group(2));
  return (remote, null);
}

Map<String, Object?> _content(InspectorBody body, String text, int? size, String mime) => <String, Object?>{
      'size': size ?? body.size,
      'mimeType': mime,
      'text': text,
      if (!body.isText) 'encoding': 'base64',
    };

/// One HAR entry for [c]; [m] masks it, [bodies] adds the captured bodies.
Map<String, Object?> harEntry(InspectorCall c, ShareMasker m, {required bool bodies}) {
  final reqCt = c.requestContentType ?? '';
  final resCt = c.responseContentType ?? '';
  final reqBody = bodies ? c.peekRequestBody() : null;
  final resBody = bodies ? c.peekResponseBody() : null;
  final total = c.duration == null ? 0.0 : c.duration!.inMicroseconds / 1000;
  final responded = c.status != null;
  final location = c.header(c.responseHeaders, 'location');

  final request = <String, Object?>{
    'method': (c.method.isEmpty ? 'GET' : c.method).toUpperCase(),
    'url': m.url(c.url),
    'httpVersion': c.protocol ?? '',
    'cookies': _requestCookies(c.requestHeaders, m),
    'headers': _harHeaders(c.requestHeaders, m),
    'queryString': _queryString(c.url, m),
    'headersSize': -1,
    'bodySize': c.requestSize ?? (c.hasRequestBody ? -1 : 0),
    if (reqBody != null && reqBody.data.isNotEmpty)
      'postData': <String, Object?>{
        'mimeType': reqCt,
        'text': reqBody.isText ? m.bodyText(reqBody.data, reqCt) : reqBody.data,
        // HAR has no encoding for postData; a binary body is base64 here.
        if (!reqBody.isText) '_encoding': 'base64',
      },
  };

  final mime = resCt.isEmpty ? 'x-unknown' : resCt;
  final response = <String, Object?>{
    'status': c.status ?? 0,
    'statusText': responded ? (c.statusText?.isNotEmpty == true ? c.statusText! : (reasonPhrase(c.status) ?? '')) : '',
    'httpVersion': responded ? (c.protocol ?? '') : '',
    'cookies': _responseCookies(c.responseHeaders, m),
    'headers': _harHeaders(c.responseHeaders, m),
    'content': resBody != null && resBody.data.isNotEmpty
        ? _content(resBody, resBody.isText ? m.bodyText(resBody.data, resCt) : resBody.data, c.responseSize, mime)
        : <String, Object?>{'size': c.responseSize ?? 0, 'mimeType': mime},
    'redirectURL': location == null ? '' : m.url(location),
    'headersSize': -1,
    'bodySize': c.responseSize ?? (responded ? 0 : -1),
    if (c.error != null && !c.cancelled) '_error': c.error,
  };

  final remote = c.remoteAddress;
  final (ip, port) = remote == null || remote.isEmpty ? ('', null) : _splitAddress(remote);
  final state = switch (c.state) {
    InspectorCallState.pending => 'pending',
    InspectorCallState.failed => c.cancelled ? 'cancelled' : 'failed',
    InspectorCallState.done => 'complete',
  };
  final gql = graphqlLabel(c);
  return <String, Object?>{
    'startedDateTime': _iso(c.ts),
    'time': _ms3(total),
    'request': request,
    'response': response,
    'cache': const <String, Object?>{},
    'timings': c.state == InspectorCallState.pending
        ? const <String, Object?>{'blocked': -1, 'dns': -1, 'connect': -1, 'send': 0, 'wait': 0, 'receive': 0, 'ssl': -1}
        : _harTimings(c, total),
    if (ip.isNotEmpty) 'serverIPAddress': ip,
    if (port != null) 'connection': port,
    '_durbun': <String, Object?>{
      'id': c.id,
      'source': c.source,
      'state': state,
      if (c.native) 'native': true,
      if (gql != null) 'graphql': gql,
      if (c.mocked) 'mocked': true,
      if (c.mockRuleId != null) 'mockRule': c.mockRuleId,
      if (c.error != null) 'error': c.error,
      if (c.bodiesDropped) 'bodiesDropped': true,
      if (reqBody?.truncated == true) 'requestBodyTruncated': true,
      if (resBody?.truncated == true) 'responseBodyTruncated': true,
      if (!bodies && (c.hasRequestBody || c.hasResponseBody)) 'bodiesOmitted': true,
    },
  };
}

/// The HAR 1.2 log of [calls] (by start time, as HAR viewers expect), one
/// piece at a time: the log header, each entry, then the closing part with
/// Dürbün's notes.
Iterable<String> sessionHar(List<InspectorCall> calls, ExportOptions o, ExportContext ctx) sync* {
  final m = ShareMasker(o.mask);
  final ordered = List<InspectorCall>.of(calls)
    ..sort((a, b) {
      final d = a.ts.compareTo(b.ts);
      return d != 0 ? d : a.seq.compareTo(b.seq);
    });
  final creator = jsonEncode(<String, Object?>{'name': 'Dürbün', 'version': kSdkVersion});
  yield '{"log":{"version":"1.2","creator":$creator,"pages":[],"entries":[\n';
  for (var i = 0; i < ordered.length; i++) {
    yield '${i > 0 ? ',\n' : ''}${jsonEncode(harEntry(ordered[i], m, bodies: o.bodies))}';
  }
  final notes = <String, Object?>{
    if (ctx.app != null) 'app': ctx.app,
    if (ctx.device != null) 'device': ctx.device,
    'exportedAt': _iso(ctx.nowMs),
    'scope': ctx.listed ? 'listed' : 'all',
    'requests': ordered.length,
    'masked': o.mask,
    'maskedValues': m.count,
    'bodies': o.bodies,
  };
  final comment = <String>[if (ctx.app != null) ctx.app!, if (ctx.device != null) ctx.device!].join(' · ');
  yield '\n],"comment":${jsonEncode(comment)},"_durbun":${jsonEncode(notes)}}}\n';
}

/// The export of [calls] in [o]'s format.
Iterable<String> sessionExport(List<InspectorCall> calls, ExportOptions o, InspectorStrings t, ExportContext ctx) =>
    o.format == ExportFormat.har ? sessionHar(calls, o, ctx) : sessionMarkdown(calls, o, t, ctx);
