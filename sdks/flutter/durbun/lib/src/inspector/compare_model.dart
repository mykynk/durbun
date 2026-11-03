/// Comparing two requests, ported from the desktop
/// (`packages/ui/src/features/network/model/diff.ts` and `compare.ts`):
/// a line diff for bodies, header tables, and bodies as lines (pretty JSON,
/// keys optionally sorted).
library;

import 'dart:convert';
import 'dart:typed_data';

import 'store.dart';

enum DiffOpType { equal, remove, add }

class DiffOp {
  const DiffOp(this.type, this.text, {this.a, this.b});

  final DiffOpType type;
  final String text;

  /// 0-based line in A (equal / remove).
  final int? a;

  /// 0-based line in B (equal / add).
  final int? b;
}

class DiffResult {
  const DiffResult(
      {required this.ops,
      required this.approximate,
      required this.truncated,
      required this.added,
      required this.removed,
      required this.equal});

  final List<DiffOp> ops;

  /// Part of the input was too large and is shown as a block replacement.
  final bool approximate;

  /// A or B had more than `maxLines` lines; only the first were compared.
  final bool truncated;
  final int added;
  final int removed;
  final int equal;

  bool get identical => added == 0 && removed == 0;
}

List<String> splitLines(String text) {
  if (text.isEmpty) return <String>[];
  final lines = text.replaceAll(RegExp('\r\n?'), '\n').split('\n');
  if (lines.length > 1 && lines.last.isEmpty) lines.removeLast();
  return lines;
}

/// Line diff: common prefix/suffix first, a DP LCS for what fits
/// [maxCells], and "patience" anchors (lines unique on both sides) to split
/// larger middles. Same algorithm as the desktop.
DiffResult diffLines(List<String> aIn, List<String> bIn,
    {int maxLines = 20000, int maxCells = 4000000}) {
  final truncated = aIn.length > maxLines || bIn.length > maxLines;
  final aLines = aIn.length > maxLines ? aIn.sublist(0, maxLines) : aIn;
  final bLines = bIn.length > maxLines ? bIn.sublist(0, maxLines) : bIn;

  // Lines as integers: comparisons become cheap.
  final ids = <String, int>{};
  int intern(String s) => ids.putIfAbsent(s, () => ids.length);
  final a = Int32List.fromList(<int>[for (final l in aLines) intern(l)]);
  final b = Int32List.fromList(<int>[for (final l in bLines) intern(l)]);

  final ops = <DiffOp>[];
  var approximate = false;
  void equal(int i, int j) => ops.add(DiffOp(DiffOpType.equal, aLines[i], a: i, b: j));
  void remove(int i) => ops.add(DiffOp(DiffOpType.remove, aLines[i], a: i));
  void add(int j) => ops.add(DiffOp(DiffOpType.add, bLines[j], b: j));

  void lcs(int a0, int a1, int b0, int b1) {
    final n = a1 - a0, m = b1 - b0, w = m + 1;
    // L[i][j] = LCS length of a[a0+i..a1) and b[b0+j..b1).
    final List<int> l = n < 65535 && m < 65535 ? Uint16List((n + 1) * w) : Uint32List((n + 1) * w);
    for (var i = n - 1; i >= 0; i--) {
      final ai = a[a0 + i];
      final row = i * w, next = row + w;
      for (var j = m - 1; j >= 0; j--) {
        l[row + j] = ai == b[b0 + j]
            ? l[next + j + 1] + 1
            : (l[next + j] >= l[row + j + 1] ? l[next + j] : l[row + j + 1]);
      }
    }
    var i = 0, j = 0;
    while (i < n && j < m) {
      if (a[a0 + i] == b[b0 + j]) {
        equal(a0 + i++, b0 + j++);
      } else if (l[(i + 1) * w + j] >= l[i * w + j + 1]) {
        remove(a0 + i++);
      } else {
        add(b0 + j++);
      }
    }
    for (; i < n; i++) {
      remove(a0 + i);
    }
    for (; j < m; j++) {
      add(b0 + j);
    }
  }

  // Lines unique in both ranges, as increasing (i, j) pairs (LIS over j).
  List<(int, int)> anchors(int a0, int a1, int b0, int b1) {
    final countA = <int, int>{}, countB = <int, int>{}, posB = <int, int>{};
    for (var i = a0; i < a1; i++) {
      countA[a[i]] = (countA[a[i]] ?? 0) + 1;
    }
    for (var j = b0; j < b1; j++) {
      countB[b[j]] = (countB[b[j]] ?? 0) + 1;
      posB[b[j]] = j;
    }
    final pairs = <(int, int)>[
      for (var i = a0; i < a1; i++)
        if (countA[a[i]] == 1 && countB[a[i]] == 1) (i, posB[a[i]]!)
    ];
    if (pairs.isEmpty) return pairs;
    final tails = <int>[];
    final prev = List<int>.filled(pairs.length, -1);
    for (var k = 0; k < pairs.length; k++) {
      final j = pairs[k].$2;
      var lo = 0, hi = tails.length;
      while (lo < hi) {
        final mid = (lo + hi) >> 1;
        if (pairs[tails[mid]].$2 < j) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      if (lo > 0) prev[k] = tails[lo - 1];
      if (lo == tails.length) {
        tails.add(k);
      } else {
        tails[lo] = k;
      }
    }
    final out = <(int, int)>[];
    for (var k = tails.last; k >= 0; k = prev[k]) {
      out.add(pairs[k]);
    }
    return out.reversed.toList();
  }

  void diffRange(int a0, int a1, int b0, int b1, int depth) {
    while (a0 < a1 && b0 < b1 && a[a0] == b[b0]) {
      equal(a0++, b0++);
    }
    var suffix = 0;
    while (a1 - suffix > a0 && b1 - suffix > b0 && a[a1 - 1 - suffix] == b[b1 - 1 - suffix]) {
      suffix++;
    }
    final aEnd = a1 - suffix, bEnd = b1 - suffix;
    final n = aEnd - a0, m = bEnd - b0;
    if (n == 0) {
      for (var j = b0; j < bEnd; j++) {
        add(j);
      }
    } else if (m == 0) {
      for (var i = a0; i < aEnd; i++) {
        remove(i);
      }
    } else if (n * m <= maxCells) {
      lcs(a0, aEnd, b0, bEnd);
    } else {
      final list = depth < 12 ? anchors(a0, aEnd, b0, bEnd) : const <(int, int)>[];
      if (list.isEmpty) {
        approximate = true;
        for (var i = a0; i < aEnd; i++) {
          remove(i);
        }
        for (var j = b0; j < bEnd; j++) {
          add(j);
        }
      } else {
        var ca = a0, cb = b0;
        for (final (i, j) in list) {
          diffRange(ca, i, cb, j, depth + 1);
          equal(i, j);
          ca = i + 1;
          cb = j + 1;
        }
        diffRange(ca, aEnd, cb, bEnd, depth + 1);
      }
    }
    for (var k = 0; k < suffix; k++) {
      equal(aEnd + k, bEnd + k);
    }
  }

  diffRange(0, a.length, 0, b.length, 0);
  var added = 0, removed = 0, same = 0;
  for (final op in ops) {
    switch (op.type) {
      case DiffOpType.add:
        added++;
      case DiffOpType.remove:
        removed++;
      case DiffOpType.equal:
        same++;
    }
  }
  return DiffResult(ops: ops, approximate: approximate, truncated: truncated, added: added, removed: removed, equal: same);
}

/// A row of the phone's one-column diff: a line, or "N unchanged lines".
class DiffRow {
  const DiffRow.line(DiffOp this.op)
      : hidden = 0,
        from = 0;
  const DiffRow.skip(this.hidden, this.from) : op = null;

  final DiffOp? op;

  /// Unchanged lines folded into this row.
  final int hidden;

  /// Index in the op list of the first folded line (the key to expand it).
  final int from;
}

/// Hides long runs of unchanged lines, keeping [context] lines around every
/// change; a run whose hidden part starts at an index in [expanded] is shown
/// in full. Same rules as the desktop's `collapseUnchanged`.
List<DiffRow> collapseUnchanged(List<DiffOp> ops, {int context = 3, Set<int> expanded = const <int>{}}) {
  final out = <DiffRow>[];
  var i = 0;
  while (i < ops.length) {
    if (ops[i].type != DiffOpType.equal) {
      out.add(DiffRow.line(ops[i++]));
      continue;
    }
    var j = i;
    while (j < ops.length && ops[j].type == DiffOpType.equal) {
      j++;
    }
    final keepHead = i == 0 ? 0 : context;
    final keepTail = j == ops.length ? 0 : context;
    final hidden = j - i - keepHead - keepTail;
    if (hidden <= 1 || expanded.contains(i + keepHead)) {
      for (var k = i; k < j; k++) {
        out.add(DiffRow.line(ops[k]));
      }
    } else {
      for (var k = i; k < i + keepHead; k++) {
        out.add(DiffRow.line(ops[k]));
      }
      out.add(DiffRow.skip(hidden, i + keepHead));
      for (var k = j - keepTail; k < j; k++) {
        out.add(DiffRow.line(ops[k]));
      }
    }
    i = j;
  }
  return out;
}

/* ─────────────────────────── headers ─────────────────────────── */

enum HeaderDiffState { same, changed, onlyA, onlyB }

class HeaderDiffRow {
  HeaderDiffRow(this.name);

  /// Display name (first spelling seen).
  final String name;
  final List<String> a = <String>[];
  final List<String> b = <String>[];
  HeaderDiffState state = HeaderDiffState.same;
}

/// Union of header names (case-insensitive) with each side's values: A's
/// order, then names only B has.
List<HeaderDiffRow> diffHeaders(List<List<String>> a, List<List<String>> b) {
  final rows = <String, HeaderDiffRow>{};
  for (final h in a) {
    if (h.length < 2) continue;
    rows.putIfAbsent(h[0].toLowerCase(), () => HeaderDiffRow(h[0])).a.add(h[1]);
  }
  for (final h in b) {
    if (h.length < 2) continue;
    rows.putIfAbsent(h[0].toLowerCase(), () => HeaderDiffRow(h[0])).b.add(h[1]);
  }
  for (final r in rows.values) {
    r.state = r.a.isEmpty
        ? HeaderDiffState.onlyB
        : r.b.isEmpty
            ? HeaderDiffState.onlyA
            : (r.a.join('\n') == r.b.join('\n') ? HeaderDiffState.same : HeaderDiffState.changed);
  }
  return rows.values.toList();
}

/* ──────────────────────────── bodies ──────────────────────────── */

enum BodyKind { none, text, json, binary }

class BodyLines {
  const BodyLines(this.kind, this.lines, {this.size = 0, this.truncated = false, this.raw = ''});

  final BodyKind kind;
  final List<String> lines;
  final int size;
  final bool truncated;

  /// Raw data, for "are the binary bodies the same?".
  final String raw;
}

Object? _sortKeys(Object? v) {
  if (v is Map) {
    final keys = v.keys.map((k) => '$k').toList()..sort();
    return <String, Object?>{for (final k in keys) k: _sortKeys(v[k])};
  }
  if (v is List) return v.map(_sortKeys).toList();
  return v;
}

/// [body] as lines for the diff: pretty JSON (keys sorted with [sortKeys])
/// when it parses, the text otherwise.
BodyLines bodyLines(InspectorBody? body, String? contentType, {bool sortKeys = true}) {
  if (body == null || (body.data.isEmpty && body.size == 0)) return const BodyLines(BodyKind.none, <String>[]);
  if (!body.isText) {
    return BodyLines(BodyKind.binary, const <String>[], size: body.size, truncated: body.truncated, raw: body.data);
  }
  final text = body.data;
  final looksJson = RegExp('json', caseSensitive: false).hasMatch(contentType ?? '') || RegExp(r'^\s*[\[{]').hasMatch(text);
  if (looksJson) {
    try {
      final v = jsonDecode(text);
      final pretty = const JsonEncoder.withIndent('  ').convert(sortKeys ? _sortKeys(v) : v);
      return BodyLines(BodyKind.json, splitLines(pretty), size: body.size, truncated: body.truncated, raw: text);
    } catch (_) {}
  }
  return BodyLines(BodyKind.text, splitLines(text), size: body.size, truncated: body.truncated, raw: text);
}

/// Calls to offer as the second side: the same method and path first (the
/// usual "why did this one fail?"), then the rest, newest first.
List<InspectorCall> compareCandidates(InspectorCall base, List<InspectorCall> all) {
  String endpoint(InspectorCall c) => '${c.method} ${c.uri?.path ?? c.url}';
  final key = endpoint(base);
  final others = all.where((c) => c.key != base.key).toList().reversed.toList();
  return <InspectorCall>[
    ...others.where((c) => endpoint(c) == key),
    ...others.where((c) => endpoint(c) != key),
  ];
}

bool sameEndpoint(InspectorCall a, InspectorCall b) =>
    a.method == b.method && (a.uri?.path ?? a.url) == (b.uri?.path ?? b.url);
