/// Text helpers of the in-app inspector (cURL, sizes, times, JSON).
library;

import 'dart:convert';

import 'store.dart';

/// `curl` command that repeats [call] (text bodies only; a binary body is
/// left out with a note).
String curlFor(InspectorCall call) {
  final b = StringBuffer('curl');
  if (call.method != 'GET') b.write(' -X ${call.method}');
  b.write(' ${_shellQuote(call.url)}');
  for (final h in call.requestHeaders) {
    final name = h[0].toLowerCase();
    // curl computes these itself.
    if (name == 'content-length' || name == 'host') continue;
    b.write(" \\\n  -H ${_shellQuote('${h[0]}: ${h[1]}')}");
  }
  final body = call.requestBody;
  if (body != null && body.data.isNotEmpty) {
    if (body.isText) {
      b.write(' \\\n  --data-raw ${_shellQuote(body.data)}');
    } else {
      b.write(' \\\n  # binary body (${formatBytes(body.size)}) left out');
    }
  }
  return b.toString();
}

String _shellQuote(String s) => "'${s.replaceAll("'", r"'\''")}'";

String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String formatDuration(Duration? d) {
  if (d == null) return '…';
  final ms = d.inMicroseconds / 1000;
  if (ms < 1000) return '${ms.round()} ms';
  return '${(ms / 1000).toStringAsFixed(2)} s';
}

/// `HH:mm:ss.SSS` in local time.
String formatClock(double epochMs) {
  final t = DateTime.fromMicrosecondsSinceEpoch((epochMs * 1000).round());
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}.'
      '${t.millisecond.toString().padLeft(3, '0')}';
}

const JsonEncoder _pretty = JsonEncoder.withIndent('  ');

/// Pretty JSON when [text] is JSON, else null.
String? prettyJsonText(String text) {
  final t = text.trimLeft();
  if (t.isEmpty || (t[0] != '{' && t[0] != '[')) return null;
  try {
    return _pretty.convert(jsonDecode(text));
  } catch (_) {
    return null;
  }
}

/// Any value as readable text (maps and lists as pretty JSON).
String prettyValue(Object? value) {
  if (value == null) return '';
  if (value is String) return prettyJsonText(value) ?? value;
  try {
    return _pretty.convert(value);
  } catch (_) {
    return '$value';
  }
}

/// One log line with its data and stack as plain text.
String logAsText(InspectorLog log) {
  final b = StringBuffer(
    '${formatClock(log.ts)} ${log.level.toUpperCase()}'
    '${log.tag != null ? ' [${log.tag}]' : ''} ${log.message}',
  );
  if (log.data != null) b.write('\n${prettyValue(log.data)}');
  final e = log.error;
  if (e != null) {
    final head = [e['type'], e['message']].whereType<String>().join(': ');
    if (head.isNotEmpty) b.write('\n$head');
    final stack = e['stack'];
    if (stack is String && stack.isNotEmpty) b.write('\n$stack');
  }
  return b.toString();
}
