/// Collapsible, searchable JSON tree (the desktop's body "Preview").
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import 'body_search.dart';
import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

/// Containers nested deeper than this are shown closed and cannot open
/// (and are not searched): the walks below recurse once per level, and a
/// hostile or broken body nested thousands deep would overflow the stack.
const int kMaxJsonDepth = 200;

/// One visible line of the tree.
class JsonLine {
  const JsonLine({required this.depth, required this.path, this.key, this.index, required this.value, required this.container, required this.expanded});

  /// A container past [kMaxJsonDepth]: summarised, never opened.
  bool get tooDeep => container && depth >= kMaxJsonDepth;

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
    final open = container &&
        depth < kMaxJsonDepth &&
        !collapsed.contains(path) &&
        (depth < autoDepth || opened.contains(path));
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

/// The tree flattened once per body for search: every node's path, parent,
/// folded key and folded leaf text, so a query does not walk the tree and
/// fold every value again.
class JsonSearchIndex {
  JsonSearchIndex(Object? root) {
    void walk(Object? v, String path, String? key, int parent, int depth) {
      final me = _paths.length;
      final container = v is Map || v is List;
      _paths.add(path);
      _parent.add(parent);
      _container.add(container);
      _key.add(key == null ? null : foldText(key));
      _leaf.add(container ? null : foldText('$v'));
      if (depth >= kMaxJsonDepth) return;
      if (v is Map) {
        for (final e in v.entries) {
          walk(e.value, '$path.${e.key}', '${e.key}', me, depth + 1);
        }
      } else if (v is List) {
        for (var i = 0; i < v.length; i++) {
          walk(v[i], '$path[$i]', null, me, depth + 1);
        }
      }
    }

    walk(root, r'$', null, -1, 0);
  }

  final List<String> _paths = <String>[];
  final List<int> _parent = <int>[];
  final List<bool> _container = <bool>[];
  final List<String?> _key = <String?>[];
  final List<String?> _leaf = <String?>[];

  /// Paths of every container whose subtree has a key or value containing
  /// the folded [q] (a container whose own key matches included).
  Set<String> pathsToMatches(String q) {
    final hits = <String>{};
    if (q.isEmpty) return hits;
    final marked = List<bool>.filled(_paths.length, false);
    for (var i = 0; i < _paths.length; i++) {
      final hit = (_key[i]?.contains(q) ?? false) || (_leaf[i]?.contains(q) ?? false);
      if (!hit) continue;
      var j = _container[i] ? i : _parent[i];
      while (j >= 0 && !marked[j]) {
        marked[j] = true;
        hits.add(_paths[j]);
        j = _parent[j];
      }
    }
    return hits;
  }
}

/// Paths of every container whose subtree has a key or value containing [q].
Set<String> pathsToMatches(Object? root, String q) => JsonSearchIndex(root).pathsToMatches(foldText(q));

/// Every container path (for "expand all").
Set<String> allContainerPaths(Object? root) {
  final out = <String>{};
  void walk(Object? v, String path, int depth) {
    if (v is! Map && v is! List) return;
    out.add(path);
    if (depth >= kMaxJsonDepth) return;
    if (v is Map) {
      for (final e in v.entries) {
        walk(e.value, '$path.${e.key}', depth + 1);
      }
    } else if (v is List) {
      for (var i = 0; i < v.length; i++) {
        walk(v[i], '$path[$i]', depth + 1);
      }
    }
  }

  walk(root, r'$', 0);
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

  /// Grows with every open / close: the find list rebuilds its lines only
  /// then (and when the query changes).
  int _rev = 0;
  List<JsonLine> _lines = const <JsonLine>[];
  late JsonSearchIndex _index = JsonSearchIndex(widget.value);

  @override
  void didUpdateWidget(JsonTreeView old) {
    super.didUpdateWidget(old);
    if (!identical(old.value, widget.value)) {
      _index = JsonSearchIndex(widget.value);
      _rev++;
    }
  }

  void _toggle(JsonLine l) => setState(() {
    _rev++;
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
    if (folded.isNotEmpty) opened.addAll(_index.pathsToMatches(folded));
    // A match inside a container the user closed opens it again.
    final collapsed = folded.isEmpty ? _collapsed : _collapsed.difference(opened);
    _lines = flattenJson(widget.value, collapsed: collapsed, opened: opened, autoDepth: _all ? 1 << 20 : 3);
    final base = _style(c);
    return <SearchLine>[
      for (final l in _lines) SearchLine(_segments(l, base, c), indent: l.depth * 14.0),
    ];
  }

  static TextStyle _style(DurbunColors c) => DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.3);

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
      out.add((l.expanded ? open : (l.tooDeep ? '$open $n … $close' : '$open $n $close'), base.copyWith(color: c.textMuted)));
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
      linesKey: _rev,
      initialQuery: widget.initialQuery,
      onQueryChanged: widget.onQueryChanged,
      padding: widget.padding,
      hint: t.searchJson,
      textStyle: _style(c),
      prefixWidth: 14,
      buildLines: (folded) => _build(folded, c),
      actions: <Widget>[
        DIconButton(
          icon: Icons.unfold_more,
          tooltip: t.expandAll,
          onTap: () => setState(() {
            _rev++;
            _all = true;
            _collapsed.clear();
          }),
        ),
        DIconButton(
          icon: Icons.unfold_less,
          tooltip: t.collapseAll,
          onTap: () => setState(() {
            _rev++;
            _all = false;
            _opened.clear();
            _collapsed
              ..clear()
              ..addAll(allContainerPaths(widget.value).where((p) => p != r'$'));
          }),
        ),
      ],
      rowBuilder: (context, i, first, spans) {
        final l = _lines[i];
        final text = Text.rich(spans, maxLines: 1, softWrap: false, overflow: TextOverflow.clip);
        final row = Row(children: <Widget>[const SizedBox(width: 14), Expanded(child: text)]);
        if ((l.container && !first) || l.tooDeep) return row;
        // A tap on a value copies it (a string without its quotes).
        if (!l.container) {
          return GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => copyText(context, l.value is String ? l.value! as String : jsonEncode(l.value),
                note: l.key ?? (l.index == null ? null : '[${l.index}]')),
            child: row,
          );
        }
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => _toggle(l),
          child: Row(
            children: <Widget>[
              SizedBox(
                width: 14,
                child: Icon(l.expanded ? Icons.arrow_drop_down : Icons.arrow_right, size: 16, color: c.textSubtle),
              ),
              Expanded(child: text),
            ],
          ),
        );
      },
    );
  }
}
