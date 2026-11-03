/// Search matching for the panel: case-, Turkish-letter- and
/// percent-encoding-insensitive, with the positions kept for highlighting.
library;

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
/// same index in [text].
String foldText(String text) {
  final out = List<int>.filled(text.length, 0);
  for (var i = 0; i < text.length; i++) {
    final u = text.codeUnitAt(i);
    final f = _fold[u];
    if (f != null) {
      out[i] = f;
    } else if (u >= 0x41 && u <= 0x5A) {
      out[i] = u + 32;
    } else if (u < 0x80) {
      out[i] = u;
    } else {
      final l = String.fromCharCode(u).toLowerCase();
      out[i] = l.length == 1 ? l.codeUnitAt(0) : u;
    }
  }
  return String.fromCharCodes(out);
}

/// [url] with %xx sequences decoded (the original when it is malformed).
String decodeUrl(String url) {
  if (!url.contains('%') && !url.contains('+')) return url;
  try {
    return Uri.decodeFull(url);
  } catch (_) {
    return url;
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
