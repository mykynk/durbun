/// Collapsible, searchable JSON tree (the desktop's body "Preview").
library;

import 'package:flutter/material.dart';

import 'strings.dart';
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
  final needle = q.toLowerCase();
  bool walk(Object? v, String path, String? key) {
    var hit = key != null && key.toLowerCase().contains(needle);
    if (v is Map) {
      for (final e in v.entries) {
        if (walk(e.value, '$path.${e.key}', '${e.key}')) hit = true;
      }
    } else if (v is List) {
      for (var i = 0; i < v.length; i++) {
        if (walk(v[i], '$path[$i]', null)) hit = true;
      }
    } else if ('$v'.toLowerCase().contains(needle)) {
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
  const JsonTreeView({super.key, required this.value, this.padding = const EdgeInsets.fromLTRB(12, 4, 12, 24)});

  final Object? value;
  final EdgeInsets padding;

  @override
  State<JsonTreeView> createState() => _JsonTreeViewState();
}

class _JsonTreeViewState extends State<JsonTreeView> {
  final Set<String> _collapsed = <String>{};
  final Set<String> _opened = <String>{};
  String _query = '';
  bool _all = false;

  void _toggle(JsonLine l) => setState(() {
    if (l.expanded) {
      _collapsed.add(l.path);
      _opened.remove(l.path);
    } else {
      _collapsed.remove(l.path);
      _opened.add(l.path);
    }
  });

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final opened = <String>{..._opened};
    if (_all) opened.addAll(allContainerPaths(widget.value));
    if (_query.isNotEmpty) opened.addAll(pathsToMatches(widget.value, _query));
    final lines = flattenJson(widget.value, collapsed: _collapsed, opened: opened, autoDepth: _all ? 1 << 20 : 3);
    return Column(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
          child: Row(
            children: <Widget>[
              Expanded(
                child: DSearchField(hint: t.searchJson, onChanged: (v) => setState(() => _query = v.trim())),
              ),
              const SizedBox(width: 4),
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
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: widget.padding,
            itemCount: lines.length,
            itemBuilder: (context, i) => _line(context, c, lines[i]),
          ),
        ),
      ],
    );
  }

  Widget _line(BuildContext context, DurbunColors c, JsonLine l) {
    final base = DurbunType.monoStyle(size: 12.5, color: c.text);
    final spans = <InlineSpan>[];
    if (l.key != null) {
      spans
        ..add(highlightSpan(l.key!, _query, base.copyWith(color: c.jsonKey), c.hlMark))
        ..add(TextSpan(text: ': ', style: base.copyWith(color: c.textSubtle)));
    } else if (l.index != null) {
      spans.add(TextSpan(text: '${l.index}: ', style: base.copyWith(color: c.textSubtle)));
    }
    final v = l.value;
    if (v is Map || v is List) {
      final n = v is Map ? v.length : (v as List).length;
      final open = v is Map ? '{' : '[';
      final close = v is Map ? '}' : ']';
      spans.add(TextSpan(
        text: l.expanded ? open : '$open $n $close',
        style: base.copyWith(color: c.textMuted),
      ));
    } else {
      final (text, color) = switch (v) {
        null => ('null', c.jsonNull),
        bool b => ('$b', c.jsonBool),
        num n => ('$n', c.jsonNumber),
        String s => ('"$s"', c.jsonString),
        _ => ('$v', c.text),
      };
      spans.add(highlightSpan(text, _query, base.copyWith(color: color), c.hlMark));
    }
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
              child: l.container ? Text.rich(TextSpan(children: spans)) : SelectableText.rich(TextSpan(children: spans)),
            ),
          ],
        ),
      ),
    );
  }
}
