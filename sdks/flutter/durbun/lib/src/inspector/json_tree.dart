/// Collapsible, searchable JSON tree (the desktop's body "Preview").
library;

import 'package:flutter/material.dart';

import 'body_search.dart';
import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

/// One visible line of the tree.
class JsonLine {
  const JsonLine({required this.depth, required this.path, this.key, this.index, required this.value, required this.container, required this.expanded});

  final int depth;
  final String path;
  final String? key;
  final int? index;
  final Object? value;
  final bool container;
  final bool expanded;
}

/// Flattens [root] into visible lines. [collapsed] holds the paths of closed
/// containers; when [openAll] is false containers deeper than [autoDepth]
/// start closed unless they are in [opened].
List<JsonLine> flattenJson(
  Object? root, {
  Set<String> collapsed = const <String>{},
  Set<String> opened = const <String>{},
  int autoDepth = 3,
}) {
  final out = <JsonLine>[];
  void walk(Object? v, int depth, String path, String? key, int? index) {
    final container = v is Map || v is List;
    final open = container && !collapsed.contains(path) && (depth < autoDepth || opened.contains(path));
    out.add(JsonLine(depth: depth, path: path, key: key, index: index, value: v, container: container, expanded: open));
    if (!open) return;
    if (v is Map) {
      for (final e in v.entries) {
        walk(e.value, depth + 1, '$path.${e.key}', '${e.key}', null);
      }
    } else if (v is List) {
      for (var i = 0; i < v.length; i++) {
        walk(v[i], depth + 1, '$path[$i]', null, i);
      }
    }
  }

  walk(root, 0, r'$', null, null);
  return out;
}

/// Paths of every container whose subtree has a key or value containing [q].
Set<String> pathsToMatches(Object? root, String q) {
  final hits = <String>{};
  final needle = foldText(q);
  bool walk(Object? v, String path, String? key) {
    var hit = key != null && foldText(key).contains(needle);
    if (v is Map) {
      for (final e in v.entries) {
        if (walk(e.value, '$path.${e.key}', '${e.key}')) hit = true;
      }
    } else if (v is List) {
      for (var i = 0; i < v.length; i++) {
        if (walk(v[i], '$path[$i]', null)) hit = true;
      }
    } else if (foldText('$v').contains(needle)) {
      hit = true;
    }
    if (hit && (v is Map || v is List)) hits.add(path);
    return hit;
  }

  walk(root, r'$', null);
  return hits;
}

/// Every container path (for "expand all").
Set<String> allContainerPaths(Object? root) {
  final out = <String>{};
  void walk(Object? v, String path) {
    if (v is Map) {
      out.add(path);
      for (final e in v.entries) {
        walk(e.value, '$path.${e.key}');
      }
    } else if (v is List) {
      out.add(path);
      for (var i = 0; i < v.length; i++) {
        walk(v[i], '$path[$i]');
      }
    }
  }

  walk(root, r'$');
  return out;
}

class JsonTreeView extends StatefulWidget {
  const JsonTreeView(
      {super.key,
      required this.value,
      this.padding = const EdgeInsets.fromLTRB(12, 4, 12, 24),
      this.initialQuery = '',
      this.onQueryChanged});

  final Object? value;
  final EdgeInsets padding;

  /// Find text to start with (kept by the body pane across modes).
  final String initialQuery;
  final ValueChanged<String>? onQueryChanged;

  @override
  State<JsonTreeView> createState() => _JsonTreeViewState();
}

class _JsonTreeViewState extends State<JsonTreeView> {
  final Set<String> _collapsed = <String>{};
  final Set<String> _opened = <String>{};
  bool _all = false;
  List<JsonLine> _lines = const <JsonLine>[];

  void _toggle(JsonLine l) => setState(() {
    if (l.expanded) {
      _collapsed.add(l.path);
      _opened.remove(l.path);
    } else {
      _collapsed.remove(l.path);
      _opened.add(l.path);
    }
  });

  /// The tree as lines; containers around a match open, so every match is
  /// on a visible line.
  List<SearchLine> _build(String folded, DurbunColors c) {
    final opened = <String>{..._opened};
    if (_all) opened.addAll(allContainerPaths(widget.value));
    if (folded.isNotEmpty) opened.addAll(pathsToMatches(widget.value, folded));
    // A match inside a container the user closed opens it again.
    final collapsed = folded.isEmpty ? _collapsed : _collapsed.difference(opened);
    _lines = flattenJson(widget.value, collapsed: collapsed, opened: opened, autoDepth: _all ? 1 << 20 : 3);
    final base = DurbunType.monoStyle(size: 12.5, color: c.text);
    return <SearchLine>[
      for (final l in _lines) SearchLine(_segments(l, base, c)),
    ];
  }

  static List<(String, TextStyle)> _segments(JsonLine l, TextStyle base, DurbunColors c) {
    final out = <(String, TextStyle)>[];
    if (l.key != null) {
      out
        ..add((l.key!, base.copyWith(color: c.jsonKey)))
        ..add((': ', base.copyWith(color: c.textSubtle)));
    } else if (l.index != null) {
      out.add(('${l.index}: ', base.copyWith(color: c.textSubtle)));
    }
    final v = l.value;
    if (v is Map || v is List) {
      final n = v is Map ? v.length : (v as List).length;
      final open = v is Map ? '{' : '[';
      final close = v is Map ? '}' : ']';
      out.add((l.expanded ? open : '$open $n $close', base.copyWith(color: c.textMuted)));
    } else {
      final (text, color) = switch (v) {
        null => ('null', c.jsonNull),
        bool b => ('$b', c.jsonBool),
        num n => ('$n', c.jsonNumber),
        String s => ('"$s"', c.jsonString),
        _ => ('$v', c.text),
      };
      out.add((text, base.copyWith(color: color)));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return FindableLines(
      initialQuery: widget.initialQuery,
      onQueryChanged: widget.onQueryChanged,
      padding: widget.padding,
      hint: t.searchJson,
      buildLines: (folded) => _build(folded, c),
      actions: <Widget>[
        DIconButton(
          icon: Icons.unfold_more,
          tooltip: t.expandAll,
          onTap: () => setState(() {
            _all = true;
            _collapsed.clear();
          }),
        ),
        DIconButton(
          icon: Icons.unfold_less,
          tooltip: t.collapseAll,
          onTap: () => setState(() {
            _all = false;
            _opened.clear();
            _collapsed
              ..clear()
              ..addAll(allContainerPaths(widget.value).where((p) => p != r'$'));
          }),
        ),
      ],
      rowBuilder: (context, i, spans, _) {
        final l = _lines[i];
        return InkWell(
          onTap: l.container ? () => _toggle(l) : null,
          child: Padding(
            padding: EdgeInsets.only(left: l.depth * 14.0, top: 1, bottom: 1),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(
                  width: 14,
                  height: 18,
                  child: l.container
                      ? Icon(l.expanded ? Icons.arrow_drop_down : Icons.arrow_right, size: 16, color: c.textSubtle)
                      : null,
                ),
                // Containers toggle on tap; leaves stay selectable.
                Expanded(
                  child: l.container ? Text.rich(spans) : SelectableText.rich(spans),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
