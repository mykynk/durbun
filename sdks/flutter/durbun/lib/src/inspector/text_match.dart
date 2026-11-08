/// Search matching for the panel: case-, Turkish-letter- and
/// percent-encoding-insensitive, with the positions kept for highlighting.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/painting.dart';

const Map<int, int> _fold = <int, int>{
  0x0130: 0x69, // İ
  0x0049: 0x69, // I
  0x0131: 0x69, // ı
  0x015E: 0x73, 0x015F: 0x73, // Ş ş
  0x011E: 0x67, 0x011F: 0x67, // Ğ ğ
  0x00DC: 0x75, 0x00FC: 0x75, // Ü ü
  0x00D6: 0x6F, 0x00F6: 0x6F, // Ö ö
  0x00C7: 0x63, 0x00E7: 0x63, // Ç ç
};

/// Lower-cases [text] and folds ş ı ğ ü ö ç (and İ, I) to their ASCII
/// letters. One UTF-16 unit in, one out, so an index in the result is the
/// same index in [text]. Returns [text] itself when nothing changes (most
/// JSON is lower case), so a cached copy costs nothing then.
String foldText(String text) {
  Uint16List? out;
  for (var i = 0; i < text.length; i++) {
    final u = text.codeUnitAt(i);
    final f = u < 0x80 ? (u >= 0x41 && u <= 0x5A ? u + 32 : u) : _foldUnit(u);
    if (f == u) {
      out?[i] = u;
      continue;
    }
    if (out == null) {
      out = Uint16List(text.length);
      for (var j = 0; j < i; j++) {
        out[j] = text.codeUnitAt(j);
      }
    }
    out[i] = f;
  }
  return out == null ? text : String.fromCharCodes(out);
}

/// Folded units above ASCII, filled in as they are met (0: not yet).
final Uint16List _foldTable = Uint16List(0x10000);

int _foldUnit(int u) {
  final known = _foldTable[u];
  if (known != 0) return known;
  final f = _fold[u];
  final int folded;
  if (f != null) {
    folded = f;
  } else {
    final l = String.fromCharCode(u).toLowerCase();
    folded = l.length == 1 ? l.codeUnitAt(0) : u;
  }
  return _foldTable[u] = folded;
}

/// [url] with %xx sequences decoded. Escapes that are not valid UTF-8
/// (`%FF`, Latin-1 `%E7`, a cut `%E2%82`) and a `%` without two hex digits
/// stay as they are; the rest is decoded.
String decodeUrl(String url) {
  if (!url.contains('%') && !url.contains('+')) return url;
  try {
    return Uri.decodeFull(url);
  } catch (_) {
    return lenientPercentDecode(url);
  }
}

/// Decodes %xx escapes like [Uri.decodeComponent] but never throws: a run
/// of escapes that is not valid UTF-8, or a `%` without two hex digits, is
/// kept as written. [plusToSpace] reads `+` as a space (form and query
/// values).
String lenientPercentDecode(String text, {bool plusToSpace = false}) {
  if (!text.contains('%') && !(plusToSpace && text.contains('+'))) return text;
  final out = StringBuffer();
  var i = 0;
  while (i < text.length) {
    final ch = text.codeUnitAt(i);
    if (ch == 0x25 && _hexAt(text, i)) {
      // A run of escapes, decoded together (one character can be several).
      final start = i;
      final bytes = <int>[];
      while (i < text.length && text.codeUnitAt(i) == 0x25 && _hexAt(text, i)) {
        bytes.add(int.parse(text.substring(i + 1, i + 3), radix: 16));
        i += 3;
      }
      try {
        out.write(utf8.decode(bytes));
      } catch (_) {
        out.write(text.substring(start, i));
      }
      continue;
    }
    out.writeCharCode(plusToSpace && ch == 0x2B ? 0x20 : ch);
    i++;
  }
  return out.toString();
}

bool _hexAt(String s, int percent) {
  if (percent + 2 >= s.length) return false;
  bool hex(int c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
  return hex(s.codeUnitAt(percent + 1)) && hex(s.codeUnitAt(percent + 2));
}

/// The name / value pairs of a query string or a form body (`a=1&b=%C3%A7`),
/// in order, repeats kept. Never throws: [Uri.splitQueryString] and
/// [Uri.queryParametersAll] throw on `discount=50%`, `%FF` or a cut escape.
List<List<String>> queryPairs(String query) {
  final out = <List<String>>[];
  for (final part in query.split('&')) {
    if (part.isEmpty) continue;
    final eq = part.indexOf('=');
    final name = eq < 0 ? part : part.substring(0, eq);
    final value = eq < 0 ? '' : part.substring(eq + 1);
    out.add(<String>[_queryComponent(name), _queryComponent(value)]);
  }
  return out;
}

String _queryComponent(String s) {
  try {
    return Uri.decodeQueryComponent(s);
  } catch (_) {
    return lenientPercentDecode(s, plusToSpace: true);
  }
}

/// Whether the folded [haystack] contains the folded [needle].
bool foldContains(String haystack, String foldedNeedle) =>
    foldText(haystack).contains(foldedNeedle);

/// Whether [url] (raw or decoded) contains the folded [needle].
bool urlContains(String url, String foldedNeedle) {
  if (foldText(url).contains(foldedNeedle)) return true;
  final d = decodeUrl(url);
  return !identical(d, url) && foldText(d).contains(foldedNeedle);
}

/// Every place one of [terms] (already folded) occurs in [text], merged
/// and sorted.
List<(int, int)> matchRanges(String text, Iterable<String> terms) {
  final folded = foldText(text);
  final ranges = <(int, int)>[];
  for (final t in terms) {
    if (t.isEmpty) continue;
    var at = 0;
    while (true) {
      final i = folded.indexOf(t, at);
      if (i < 0) break;
      ranges.add((i, i + t.length));
      at = i + t.length;
    }
  }
  if (ranges.isEmpty) return ranges;
  ranges.sort((a, b) => a.$1.compareTo(b.$1));
  final merged = <(int, int)>[ranges.first];
  for (final r in ranges.skip(1)) {
    final last = merged.last;
    if (r.$1 <= last.$2) {
      if (r.$2 > last.$2) merged[merged.length - 1] = (last.$1, r.$2);
    } else {
      merged.add(r);
    }
  }
  return merged;
}

/// [text] with every term of [terms] (folded search words) marked.
TextSpan highlightTerms(
    String text, List<String> terms, TextStyle style, Color mark) {
  final ranges = matchRanges(text, terms);
  if (ranges.isEmpty) return TextSpan(text: text, style: style);
  final spans = <TextSpan>[];
  var at = 0;
  for (final (s, e) in ranges) {
    if (s > at) spans.add(TextSpan(text: text.substring(at, s)));
    spans.add(TextSpan(
        text: text.substring(s, e), style: TextStyle(backgroundColor: mark)));
    at = e;
  }
  if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
  return TextSpan(style: style, children: spans);
}
