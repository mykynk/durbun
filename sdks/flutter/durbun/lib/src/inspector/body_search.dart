/// Find-in-body for the request and response bodies: a find bar with a
/// match count and previous / next, the current match in its own colour and
/// scrolled into view. The JSON tree and the code view both show their
/// content as [SearchLine]s through [FindableLines].
///
/// Built for large bodies on a phone in debug mode: the query is debounced,
/// lines and matches are cached per (content, query), every line's folded
/// text is computed once, and rows have one fixed height (long lines are cut
/// into screen-wide rows), so jumping to a match is one scroll offset.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

/// One logical line: styled pieces, matched as one string.
class SearchLine {
  SearchLine(this.segments, {this.indent = 0});

  final List<(String, TextStyle)> segments;

  /// Left indent of every row of the line (JSON depth).
  final double indent;

  late final String text = segments.length == 1 ? segments.first.$1 : segments.map((s) => s.$1).join();

  /// [text] folded for search ([foldText]), computed once.
  late final String folded = foldText(text);
}

/// A match: line index and its range in [SearchLine.text].
typedef Occurrence = (int line, int start, int end);

/// Every place [foldedQuery] occurs, in reading order (at most [limit]).
List<Occurrence> findOccurrences(List<SearchLine> lines, String foldedQuery, {int limit = 5000}) {
  final out = <Occurrence>[];
  if (foldedQuery.isEmpty) return out;
  for (var i = 0; i < lines.length && out.length < limit; i++) {
    final f = lines[i].folded;
    var at = f.indexOf(foldedQuery);
    while (at >= 0 && out.length < limit) {
      out.add((i, at, at + foldedQuery.length));
      at = f.indexOf(foldedQuery, at + foldedQuery.length);
    }
  }
  return out;
}

/// The part [from]..[to] of [line] as spans, every range in [ranges] marked
/// (clipped to the part), [current] (if any) in the stronger colour.
TextSpan markSlice(SearchLine line, int from, int to, List<(int, int)> ranges, (int, int)? current, Color mark, Color currentMark) {
  final spans = <InlineSpan>[];
  var offset = 0;
  for (final (text, style) in line.segments) {
    final segStart = offset, segEnd = offset + text.length;
    offset = segEnd;
    final a = segStart > from ? segStart : from;
    final b = segEnd < to ? segEnd : to;
    if (a >= b) continue;
    var at = a;
    for (final (s, e) in ranges) {
      if (e <= at || s >= b) continue;
      final x = s < at ? at : s;
      final y = e > b ? b : e;
      if (x > at) spans.add(TextSpan(text: text.substring(at - segStart, x - segStart), style: style));
      final isCurrent = current != null && current.$1 == s && current.$2 == e;
      spans.add(TextSpan(text: text.substring(x - segStart, y - segStart), style: style.copyWith(backgroundColor: isCurrent ? currentMark : mark)));
      at = y;
    }
    if (at < b) spans.add(TextSpan(text: text.substring(at - segStart, b - segStart), style: style));
  }
  return TextSpan(children: spans);
}

/// The whole of [line] marked (tests and simple callers).
TextSpan markLine(SearchLine line, List<(int, int)> ranges, (int, int)? current, Color mark, Color currentMark) =>
    markSlice(line, 0, line.text.length, ranges, current, mark, currentMark);

/// A screen row: a piece [from]..[to] of logical line [line].
typedef VisualRow = (int line, int from, int to);

/// Cuts [lines] into rows of at most [charsFor] columns (monospace), one
/// row for an empty line. CJK, Hangul, full-width forms and emoji take two
/// columns (the fallback font draws them about twice as wide), and a
/// surrogate pair is never split, so no row is cut off on screen.
List<VisualRow> wrapRows(List<SearchLine> lines, int Function(SearchLine line) charsFor) {
  final out = <VisualRow>[];
  for (var i = 0; i < lines.length; i++) {
    final text = lines[i].text;
    final n = text.length;
    final w = charsFor(lines[i]);
    if (!_hasWide(text)) {
      if (n <= w) {
        out.add((i, 0, n));
        continue;
      }
      for (var at = 0; at < n; at += w) {
        out.add((i, at, at + w > n ? n : at + w));
      }
      continue;
    }
    var start = 0, cols = 0, at = 0;
    while (at < n) {
      final u = text.codeUnitAt(at);
      final pair = u >= 0xD800 && u <= 0xDBFF && at + 1 < n;
      final width = pair || _isWide(u) ? 2 : 1;
      if (cols + width > w && at > start) {
        out.add((i, start, at));
        start = at;
        cols = 0;
      }
      cols += width;
      at += pair ? 2 : 1;
    }
    out.add((i, start, n));
  }
  return out;
}

bool _hasWide(String text) {
  for (var i = 0; i < text.length; i++) {
    final u = text.codeUnitAt(i);
    if (u >= 0x1100 && (_isWide(u) || (u >= 0xD800 && u <= 0xDBFF))) return true;
  }
  return false;
}

/// East Asian wide and full-width ranges of the Basic Multilingual Plane.
bool _isWide(int u) =>
    (u >= 0x1100 && u <= 0x115F) ||
    (u >= 0x2E80 && u <= 0xA4CF) ||
    (u >= 0xAC00 && u <= 0xD7A3) ||
    (u >= 0xF900 && u <= 0xFAFF) ||
    (u >= 0xFE30 && u <= 0xFE4F) ||
    (u >= 0xFF00 && u <= 0xFF60) ||
    (u >= 0xFFE0 && u <= 0xFFE6);

/// The find bar: field, "3 / 12" (or "No match"), previous, next.
class FindBar extends StatelessWidget {
  const FindBar(
      {super.key,
      required this.controller,
      required this.onChanged,
      required this.onSubmitted,
      required this.total,
      required this.current,
      required this.onPrev,
      required this.onNext,
      this.hint,
      this.capped = false,
      this.tooShort = false,
      this.trailing = const <Widget>[]});

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;
  final int total;

  /// 0-based index of the selected match.
  final int current;
  final VoidCallback onPrev;
  final VoidCallback onNext;
  final String? hint;

  /// [total] hit the search limit.
  final bool capped;

  /// The query is shorter than the minimum.
  final bool tooShort;
  final List<Widget> trailing;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final searching = controller.text.trim().isNotEmpty;
    final String label;
    if (tooShort) {
      label = t.findMinChars;
    } else if (total == 0) {
      label = t.noMatchShort;
    } else {
      label = '${current + 1} / $total${capped ? '+' : ''}';
    }
    final missing = !tooShort && total == 0;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 6),
      child: Row(
        children: <Widget>[
          Expanded(
            child: DSearchField(
              hint: hint ?? t.findInBody,
              controller: controller,
              onChanged: onChanged,
              onSubmitted: onSubmitted,
              trailing: !searching
                  ? null
                  : Padding(
                      padding: const EdgeInsets.only(right: 2),
                      child: Text(
                        label,
                        style: DurbunType.monoStyle(
                            size: 11.5,
                            color: missing ? c.danger : c.textMuted,
                            weight: missing ? FontWeight.w600 : FontWeight.w500),
                      ),
                    ),
            ),
          ),
          DIconButton(icon: Icons.keyboard_arrow_up, tooltip: t.prevMatch, size: 36, onTap: total > 0 ? onPrev : null),
          DIconButton(icon: Icons.keyboard_arrow_down, tooltip: t.nextMatch, size: 36, onTap: total > 0 ? onNext : null),
          ...trailing,
        ],
      ),
    );
  }
}

/// Lines with find.
///
/// [buildLines] makes the lines for the folded query (the JSON tree opens
/// containers around matches); it runs again only when [linesKey] or the
/// applied query changes. [rowBuilder] draws one fixed-height row: the part
/// of a line in `spans`, `first` for the line's first row (where the tree
/// draws its arrow and the code view its line number). [prefixWidth] is the
/// width that row prefix takes.
class FindableLines extends StatefulWidget {
  const FindableLines(
      {super.key,
      required this.linesKey,
      required this.buildLines,
      required this.rowBuilder,
      required this.textStyle,
      this.prefixWidth = 0,
      this.initialQuery = '',
      this.onQueryChanged,
      this.padding = EdgeInsets.zero,
      this.actions = const <Widget>[],
      this.hint,
      this.note,
      this.minChars = 2,
      this.debounce = const Duration(milliseconds: 200)});

  final Object linesKey;
  final List<SearchLine> Function(String foldedQuery) buildLines;
  final Widget Function(BuildContext context, int line, bool first, TextSpan spans) rowBuilder;

  /// The monospace style of the text (measured for row height and width).
  final TextStyle textStyle;
  final double prefixWidth;
  final String initialQuery;
  final ValueChanged<String>? onQueryChanged;
  final EdgeInsets padding;
  final List<Widget> actions;
  final String? hint;

  /// A line under the find bar for the applied (folded) query and its
  /// match count, or null (the code view: "only past the shown part").
  final String? Function(String foldedQuery, int matches)? note;

  /// Shorter queries do not search (one letter matches almost everything).
  final int minChars;
  final Duration debounce;

  @override
  State<FindableLines> createState() => FindableLinesState();
}

class FindableLinesState extends State<FindableLines> {
  late final TextEditingController _field = TextEditingController(text: widget.initialQuery);
  final ScrollController _scroll = ScrollController();
  Timer? _debounce;

  /// The folded query the results are for (lags the field by the debounce).
  late String _applied = _effective(widget.initialQuery);
  int _current = 0;

  /// Times the lines and matches were computed (tests: the debounce and the
  /// cache work).
  int searches = 0;

  /// Times this widget was built (tests: a store notification for another
  /// call does not rebuild the body).
  int builds = 0;

  Object? _cacheKey;
  List<SearchLine> _lines = const <SearchLine>[];
  List<Occurrence> _occ = const <Occurrence>[];
  Map<int, List<(int, int)>> _byLine = const <int, List<(int, int)>>{};

  Object? _rowsKey;
  List<VisualRow> _rows = const <VisualRow>[];
  double _rowHeight = 18;

  /// The deepest indent a row gets: JSON nested deeper than the screen is
  /// wide keeps 20 characters of room instead of overflowing.
  double _maxIndent = double.infinity;

  double _indentOf(SearchLine l) => l.indent < _maxIndent ? l.indent : _maxIndent;

  /// The line of the selected match (tests).
  int? get currentLine => _occ.isEmpty ? null : _occ[_current].$1;

  String _effective(String raw) {
    final f = foldText(raw.trim());
    return f.length < widget.minChars ? '' : f;
  }

  @override
  void initState() {
    super.initState();
    if (_applied.isNotEmpty) _revealAfterFrame();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _field.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    widget.onQueryChanged?.call(v);
    _debounce?.cancel();
    _debounce = Timer(widget.debounce, _apply);
    setState(() {}); // The counter's "too short" state follows the field.
  }

  void _apply() {
    _debounce?.cancel();
    final next = _effective(_field.text);
    if (!mounted || next == _applied) return;
    setState(() {
      _applied = next;
      _current = 0;
    });
    _revealAfterFrame();
  }

  void _onSubmitted(String _) {
    // Enter: search now if the text changed, else the next match.
    if (_effective(_field.text) != _applied) {
      _apply();
    } else {
      _step(1);
    }
  }

  void _step(int by) {
    if (_occ.isEmpty) return;
    setState(() => _current = (_current + by) % _occ.length); // Never negative here.
    _revealAfterFrame();
  }

  void _revealAfterFrame() => WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());

  /// Rows have one height: the selected match's row is at a known offset.
  void _reveal() {
    if (!mounted || _occ.isEmpty || !_scroll.hasClients) return;
    final (line, start, _) = _occ[_current];
    var row = 0;
    for (var i = 0; i < _rows.length; i++) {
      final r = _rows[i];
      if (r.$1 != line) continue;
      row = i;
      if (start < r.$3) break;
    }
    final pos = _scroll.position;
    final target = widget.padding.top + row * _rowHeight - pos.viewportDimension * 0.3;
    _scroll.jumpTo(target.clamp(0.0, pos.maxScrollExtent));
  }

  void _ensureResults() {
    final key = (widget.linesKey, _applied);
    if (key == _cacheKey) return;
    _cacheKey = key;
    searches++;
    _lines = widget.buildLines(_applied);
    _occ = findOccurrences(_lines, _applied);
    final byLine = <int, List<(int, int)>>{};
    for (final (l, s, e) in _occ) {
      (byLine[l] ??= <(int, int)>[]).add((s, e));
    }
    _byLine = byLine;
    if (_current >= _occ.length) _current = _occ.isEmpty ? 0 : _occ.length - 1;
  }

  void _ensureRows(double width, TextScaler scaler) {
    final key = (_cacheKey, width, scaler);
    if (key == _rowsKey) return;
    _rowsKey = key;
    final tp = TextPainter(
        text: TextSpan(text: 'MMMMMMMMMM', style: widget.textStyle),
        textDirection: TextDirection.ltr,
        textScaler: scaler)
      ..layout();
    final charW = tp.width / 10;
    _rowHeight = (tp.height + 2).ceilToDouble();
    tp.dispose();
    final avail = width - widget.padding.horizontal - widget.prefixWidth - 6;
    _maxIndent = avail - 20 * charW > 0 ? avail - 20 * charW : 0;
    _rows = wrapRows(_lines, (l) {
      final n = ((avail - _indentOf(l)) / charW).floor();
      return n < 8 ? 8 : n;
    });
  }

  @override
  Widget build(BuildContext context) {
    builds++;
    final c = DurbunColors.of(context);
    _ensureResults();
    final raw = foldText(_field.text.trim());
    final tooShort = raw.isNotEmpty && raw.length < widget.minChars;
    final cur = _occ.isEmpty ? null : _occ[_current];
    final currentMark = c.warning.withValues(alpha: 0.55);
    final scaler = MediaQuery.textScalerOf(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        FindBar(
          controller: _field,
          onChanged: _onChanged,
          onSubmitted: _onSubmitted,
          total: tooShort ? 0 : _occ.length,
          current: _current,
          capped: _occ.length >= 5000,
          tooShort: tooShort,
          hint: widget.hint,
          onPrev: () => _step(-1),
          onNext: () => _step(1),
          trailing: widget.actions,
        ),
        if (widget.note?.call(_applied, _occ.length) case final String note)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
            child: Callout(tone: CalloutTone.warning, title: note),
          ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, box) {
              _ensureRows(box.maxWidth, scaler);
              // One selection area for the list: rows are plain Text.rich
              // (a SelectableText per row is heavy). Not where it would take
              // the tabs' swipe ([swipeSafeSelection]).
              return swipeSafeSelection(
                ListView.builder(
                  controller: _scroll,
                  padding: widget.padding,
                  itemExtent: _rowHeight,
                  itemCount: _rows.length,
                  itemBuilder: (context, i) {
                    final (line, from, to) = _rows[i];
                    final ranges = _byLine[line] ?? const <(int, int)>[];
                    final isCur = cur != null && cur.$1 == line;
                    final spans = markSlice(_lines[line], from, to, ranges,
                        isCur ? (cur.$2, cur.$3) : null, c.hlMark, currentMark);
                    final hit = ranges.any((r) => r.$1 < to && r.$2 > from);
                    final curHere = isCur && cur.$2 < to && cur.$3 > from;
                    return DecoratedBox(
                      // Rows with a match carry a bar on the left.
                      decoration: BoxDecoration(
                        border: Border(
                            left: BorderSide(
                                color: !hit ? Colors.transparent : (curHere ? c.warning : c.hlMark),
                                width: 3)),
                      ),
                      child: Padding(
                        padding: EdgeInsets.only(left: _indentOf(_lines[line])),
                        child: widget.rowBuilder(context, line, from == 0, spans),
                      ),
                    );
                  },
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
