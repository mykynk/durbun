/// Find-in-body for the request and response bodies: a find bar with a
/// match count and previous / next, the current match in its own colour and
/// scrolled into view. The JSON tree and the code view both show their
/// content as [SearchLine]s through [FindableLines].
library;

import 'package:flutter/material.dart';

import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

/// One shown line: styled pieces, matched as one string.
class SearchLine {
  const SearchLine(this.segments);

  final List<(String, TextStyle)> segments;

  String get text => segments.map((s) => s.$1).join();
}

/// A match: line index and its range in [SearchLine.text].
typedef Occurrence = (int line, int start, int end);

/// Every place [foldedQuery] occurs, in reading order (at most [limit]).
List<Occurrence> findOccurrences(List<SearchLine> lines, String foldedQuery, {int limit = 5000}) {
  final out = <Occurrence>[];
  if (foldedQuery.isEmpty) return out;
  for (var i = 0; i < lines.length && out.length < limit; i++) {
    for (final (s, e) in matchRanges(lines[i].text, <String>[foldedQuery])) {
      out.add((i, s, e));
      if (out.length >= limit) break;
    }
  }
  return out;
}

/// [line] as spans, every range in [ranges] marked, [current] (if any) in
/// the stronger colour.
TextSpan markLine(SearchLine line, List<(int, int)> ranges, (int, int)? current, Color mark, Color currentMark) {
  if (ranges.isEmpty) {
    return TextSpan(children: <InlineSpan>[for (final (t, st) in line.segments) TextSpan(text: t, style: st)]);
  }
  final spans = <InlineSpan>[];
  var offset = 0;
  for (final (text, style) in line.segments) {
    final segStart = offset, segEnd = offset + text.length;
    var at = segStart;
    for (final (s, e) in ranges) {
      if (e <= at || s >= segEnd) continue;
      final from = s < at ? at : s;
      final to = e > segEnd ? segEnd : e;
      if (from > at) spans.add(TextSpan(text: text.substring(at - segStart, from - segStart), style: style));
      final isCurrent = current != null && current.$1 == s && current.$2 == e;
      spans.add(TextSpan(
          text: text.substring(from - segStart, to - segStart),
          style: style.copyWith(backgroundColor: isCurrent ? currentMark : mark)));
      at = to;
    }
    if (at < segEnd) spans.add(TextSpan(text: text.substring(at - segStart), style: style));
    offset = segEnd;
  }
  return TextSpan(children: spans);
}

/// The find bar: field, "3 / 12" (or "No match"), previous, next.
class FindBar extends StatelessWidget {
  const FindBar(
      {super.key,
      required this.controller,
      required this.onChanged,
      required this.total,
      required this.current,
      required this.onPrev,
      required this.onNext,
      this.hint,
      this.capped = false,
      this.trailing = const <Widget>[]});

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final int total;

  /// 0-based index of the selected match.
  final int current;
  final VoidCallback onPrev;
  final VoidCallback onNext;
  final String? hint;

  /// [total] hit the search limit.
  final bool capped;
  final List<Widget> trailing;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final searching = controller.text.trim().isNotEmpty;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 6),
      child: Row(
        children: <Widget>[
          Expanded(
            child: DSearchField(
              hint: hint ?? t.findInBody,
              controller: controller,
              onChanged: onChanged,
              onSubmitted: (_) => onNext(),
              trailing: !searching
                  ? null
                  : Padding(
                      padding: const EdgeInsets.only(right: 2),
                      child: Text(
                        total == 0 ? t.noMatchShort : '${current + 1} / $total${capped ? '+' : ''}',
                        style: DurbunType.monoStyle(
                            size: 11.5,
                            color: total == 0 ? c.danger : c.textMuted,
                            weight: total == 0 ? FontWeight.w600 : FontWeight.w500),
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

/// Lines with find: [buildLines] makes the lines for the folded query (the
/// JSON tree opens containers around matches), [rowBuilder] draws a line
/// from its marked spans. The query survives a rebuild with a new
/// [initialQuery] only when the parent changes it.
class FindableLines extends StatefulWidget {
  const FindableLines(
      {super.key,
      required this.buildLines,
      required this.rowBuilder,
      this.initialQuery = '',
      this.onQueryChanged,
      this.padding = EdgeInsets.zero,
      this.actions = const <Widget>[],
      this.hint});

  final List<SearchLine> Function(String foldedQuery) buildLines;
  final Widget Function(BuildContext context, int index, TextSpan spans, bool hasMatch) rowBuilder;
  final String initialQuery;
  final ValueChanged<String>? onQueryChanged;
  final EdgeInsets padding;
  final List<Widget> actions;
  final String? hint;

  @override
  State<FindableLines> createState() => FindableLinesState();
}

class FindableLinesState extends State<FindableLines> {
  late final TextEditingController _field = TextEditingController(text: widget.initialQuery);
  final ScrollController _scroll = ScrollController();
  final Map<int, GlobalKey> _keys = <int, GlobalKey>{};
  int _current = 0;
  int _revealTry = 0;

  String get _folded => foldText(_field.text.trim());

  @override
  void initState() {
    super.initState();
    if (_folded.isNotEmpty) _revealAfterFrame();
  }

  @override
  void dispose() {
    _field.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    widget.onQueryChanged?.call(v);
    setState(() => _current = 0);
    _revealAfterFrame();
  }

  void _step(int by, int total) {
    if (total == 0) return;
    setState(() => _current = (_current + by) % total); // Dart's % is never negative here.
    _revealAfterFrame();
  }

  /// The line of the selected match, for tests.
  int? currentLine;

  void _revealAfterFrame() {
    _revealTry = 0;
    WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());
  }

  /// Scrolls the current match's line into view: directly when the row is
  /// built, else jumps to an estimate (rows vary in height) and tries again.
  void _reveal() {
    final line = currentLine;
    if (!mounted || line == null || !_scroll.hasClients) return;
    final ctx = _keys[line]?.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(ctx, alignment: 0.3, duration: const Duration(milliseconds: 120));
      return;
    }
    if (_revealTry++ > 20) return;
    final pos = _scroll.position;
    final count = _lineCount == 0 ? 1 : _lineCount;
    final perLine = (pos.maxScrollExtent + pos.viewportDimension) / count;
    _scroll.jumpTo((line * perLine - pos.viewportDimension * 0.3).clamp(0.0, pos.maxScrollExtent));
    WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());
  }

  int _lineCount = 0;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final folded = _folded;
    final lines = widget.buildLines(folded);
    _lineCount = lines.length;
    final occ = findOccurrences(lines, folded);
    final capped = occ.length >= 5000;
    if (_current >= occ.length) _current = occ.isEmpty ? 0 : occ.length - 1;
    final cur = occ.isEmpty ? null : occ[_current];
    currentLine = cur?.$1;
    final byLine = <int, List<(int, int)>>{};
    for (final (l, s, e) in occ) {
      (byLine[l] ??= <(int, int)>[]).add((s, e));
    }
    final currentMark = c.warning.withValues(alpha: 0.55);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        FindBar(
          controller: _field,
          onChanged: _onChanged,
          total: occ.length,
          current: _current,
          capped: capped,
          hint: widget.hint,
          onPrev: () => _step(-1, occ.length),
          onNext: () => _step(1, occ.length),
          trailing: widget.actions,
        ),
        Expanded(
          child: ListView.builder(
            controller: _scroll,
            padding: widget.padding,
            itemCount: lines.length,
            itemBuilder: (context, i) {
              final ranges = byLine[i] ?? const <(int, int)>[];
              final spans = markLine(lines[i], ranges, cur != null && cur.$1 == i ? (cur.$2, cur.$3) : null, c.hlMark, currentMark);
              return KeyedSubtree(
                key: _keys.putIfAbsent(i, GlobalKey.new),
                child: Container(
                  // Lines with a match carry a bar on the left, so they are
                  // found while scrolling.
                  decoration: BoxDecoration(
                    border: Border(
                        left: BorderSide(
                            color: ranges.isEmpty ? Colors.transparent : (cur != null && cur.$1 == i ? c.warning : c.hlMark),
                            width: 3)),
                  ),
                  child: widget.rowBuilder(context, i, spans, ranges.isNotEmpty),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
