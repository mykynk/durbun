/// Comparing two requests on the phone, as the desktop's Compare dialog:
/// pick the second request (same endpoint first), then General, Headers,
/// Response body and Request body tabs with a line diff. One column instead
/// of side by side: a phone is too narrow for two bodies.
library;

import 'package:flutter/foundation.dart' show compute;
import 'package:flutter/material.dart';

import 'compare_model.dart';
import 'format.dart';
import 'network_model.dart';
import 'network_view.dart' show CallRow;
import 'store.dart';
import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

String _statusText(InspectorCall c, InspectorStrings t) {
  if (c.state == InspectorCallState.pending) return t.pending;
  if (c.cancelled) return t.cancelled;
  if (c.status != null) {
    final s = '${c.status} ${c.statusText ?? reasonPhrase(c.status) ?? ''}'.trim();
    return c.error != null ? '$s · ${t.failed}' : s;
  }
  return t.failed;
}

String _pathOf(InspectorCall c) {
  final u = c.uri;
  if (u == null) return c.url;
  return u.hasQuery ? '${u.path}?${u.query}' : (u.path.isEmpty ? '/' : u.path);
}

/// The A / B marker of the desktop.
class _SideTag extends StatelessWidget {
  const _SideTag(this.label, {this.big = false});

  final String label;

  /// The size of the request cards at the top.
  final bool big;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final color = label == 'A' ? c.danger : c.success;
    final big = this.big;
    return Container(
      width: big ? 28 : 20,
      height: big ? 28 : 20,
      alignment: Alignment.center,
      decoration: BoxDecoration(
          color: color.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(big ? DurbunRadius.sm + 2 : DurbunRadius.sm)),
      child: Text(label, style: DurbunType.monoStyle(size: big ? 13 : 11.5, color: color, weight: FontWeight.w600, height: 1)),
    );
  }
}

class _SideSummary extends StatelessWidget {
  const _SideSummary(this.label, this.call);

  final String label;
  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final failed = call.error != null && !call.cancelled;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
      decoration: BoxDecoration(
          color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          _SideTag(label, big: true),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Wrap(
                  spacing: 6,
                  children: <Widget>[
                    Text(call.method, style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.method(call.method), weight: FontWeight.w600, height: 1.4)),
                    Text(_statusText(call, t), style: DurbunType.monoStyle(size: DurbunType.monoRow, color: call.cancelled ? c.textSubtle : c.status(call.status, failed: failed), weight: FontWeight.w600, height: 1.4)),
                    Text('${formatClock(call.ts)} · ${formatDuration(call.duration)}', style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.textMuted, height: 1.4)),
                  ],
                ),
                const SizedBox(height: 2),
                Text(decodeUrlForDisplay(_pathOf(call)), maxLines: 2, overflow: TextOverflow.ellipsis, style: DurbunType.monoStyle(size: DurbunType.monoMd, color: c.text, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// [s] with its escapes decoded; malformed ones (`%FF`) stay as written.
String decodeUrlForDisplay(String s) => decodeUrl(s);

/* ───────────────────────────── picker ───────────────────────────── */

/// Picks the second request; the same method and path are listed first.
class ComparePickerPage extends StatefulWidget {
  const ComparePickerPage({super.key, required this.base, required this.store});

  final InspectorCall base;
  final DurbunInspectorStore store;

  @override
  State<ComparePickerPage> createState() => _ComparePickerPageState();
}

class _ComparePickerPageState extends State<ComparePickerPage> {
  List<QueryClause> _q = const <QueryClause>[];

  void _pick(InspectorCall other) {
    FocusManager.instance.primaryFocus?.unfocus();
    Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
      builder: (routeContext) => DurbunTheme.wrap(routeContext, CompareCallsPage(a: widget.base, b: other)),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Scaffold(
      backgroundColor: c.bgApp,
      appBar: AppBar(
        surfaceTintColor: Colors.transparent,
        titleSpacing: 0,
        title: Text(t.comparePickTitle),
      ),
      body: ListenableBuilder(
        listenable: widget.store,
        builder: (context, _) {
          final all = compareCandidates(widget.base, widget.store.calls);
          final shown = all.where((x) => callMatchesQuery(x, _q)).toList();
          final same = shown.where((x) => sameEndpoint(x, widget.base)).toList();
          final rest = shown.where((x) => !sameEndpoint(x, widget.base)).toList();
          final terms = freeTerms(_q);
          return Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _SideSummary('A', widget.base),
                    const SizedBox(height: 12),
                    DSearchField(hint: t.netSearchHint, onChanged: (v) => setState(() => _q = parseQuery(v))),
                  ],
                ),
              ),
              Expanded(
                child: all.isEmpty
                    ? EmptyState(title: t.noOtherRequests, body: t.noOtherRequestsBody)
                    : shown.isEmpty
                        ? EmptyState(title: t.noMatchTitle, body: t.noMatchBody)
                        : ListView(
                            padding: EdgeInsets.only(bottom: 16 + MediaQuery.paddingOf(context).bottom),
                            children: <Widget>[
                              if (same.isNotEmpty) ...<Widget>[
                                _GroupTitle('${t.sameEndpoint} · ${same.length}'),
                                for (final x in same) CallRow(call: x, store: widget.store, terms: terms, onTap: () => _pick(x)),
                              ],
                              if (rest.isNotEmpty) ...<Widget>[
                                _GroupTitle('${t.otherRequests} · ${rest.length}'),
                                for (final x in rest) CallRow(call: x, store: widget.store, terms: terms, onTap: () => _pick(x)),
                              ],
                            ],
                          ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _GroupTitle extends StatelessWidget {
  const _GroupTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 8),
      child: Semantics(
          header: true, child: Text(text, style: DurbunType.ui(size: DurbunType.body, weight: FontWeight.w600, color: c.textMuted))),
    );
  }
}

/* ───────────────────────────── compare ───────────────────────────── */

DiffResult _diffInBackground((List<String>, List<String>) ab) => diffLines(ab.$1, ab.$2);

class CompareCallsPage extends StatefulWidget {
  const CompareCallsPage({super.key, required this.a, required this.b, this.initialTab = 2});

  final InspectorCall a;
  final InspectorCall b;

  /// 0 General, 1 Headers, 2 Response body, 3 Request body.
  final int initialTab;

  @override
  State<CompareCallsPage> createState() => _CompareCallsPageState();
}

class _CompareCallsPageState extends State<CompareCallsPage> {
  bool _swapped = false;
  bool _onlyChanges = true;
  bool _sortKeys = true;

  InspectorCall get _a => _swapped ? widget.b : widget.a;
  InspectorCall get _b => _swapped ? widget.a : widget.b;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Scaffold(
      backgroundColor: c.bgApp,
      appBar: AppBar(
        surfaceTintColor: Colors.transparent,
        titleSpacing: 0,
        title: Text(t.compareTitle),
        actions: <Widget>[
          DIconButton(icon: Icons.swap_vert_rounded, tooltip: t.swap, onTap: () => setState(() => _swapped = !_swapped)),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Column(children: <Widget>[_SideSummary('A', _a), const SizedBox(height: 8), _SideSummary('B', _b)]),
          ),
          Expanded(
            child: ColoredBox(
              color: c.bgApp,
              child: MediaQuery.removePadding(
                context: context,
                removeTop: true,
                child: SwipeTabs(
                  initialIndex: widget.initialTab,
                  tabs: <DTab>[DTab(t.general), DTab(t.headers), DTab(t.responseBody), DTab(t.requestBody)],
                  // Plain text: a SelectableText takes horizontal drags and
                  // the tabs would not swipe.
                  pages: <Widget>[
                    swipeSafeSelection(_GeneralDiff(a: _a, b: _b)),
                    swipeSafeSelection(_HeadersDiff(a: _a, b: _b, onlyChanges: _onlyChanges, onOnlyChanges: (v) => setState(() => _onlyChanges = v))),
                    for (final request in <bool>[false, true])
                      _BodyDiff(
                        key: ValueKey<String>('$request$_swapped$_sortKeys'),
                        a: _a,
                        b: _b,
                        request: request,
                        onlyChanges: _onlyChanges,
                        sortKeys: _sortKeys,
                        onOnlyChanges: (v) => setState(() => _onlyChanges = v),
                        onSortKeys: (v) => setState(() => _sortKeys = v),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A field (or header) with A's and B's value under its name; changed ones
/// are marked on the left.
class _FieldBlock extends StatelessWidget {
  const _FieldBlock(
      {required this.name, required this.a, required this.b, required this.changed, this.monoName = false, this.last = false});

  /// The card's last row: no rule under it.
  final bool last;

  final String name;
  final String? a;
  final String? b;
  final bool changed;
  final bool monoName;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    Widget value(String side, String? v) => Padding(
          padding: const EdgeInsets.only(top: 3),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _SideTag(side),
              const SizedBox(width: 8),
              Expanded(
                child: v == null
                    ? Text(t.missing, style: TextStyle(fontSize: 13, color: c.textSubtle))
                    : Text(v, style: DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.35)),
              ),
            ],
          ),
        );
    return Container(
      padding: const EdgeInsets.fromLTRB(13, 10, 16, 10),
      decoration: BoxDecoration(
        color: changed ? c.warningSoft : null,
        border: Border(
          left: BorderSide(color: changed ? c.warning : Colors.transparent, width: 3),
          bottom: last ? BorderSide.none : BorderSide(color: c.hairline),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(name,
              style: monoName
                  ? DurbunType.monoStyle(size: 12, color: c.textMuted, weight: FontWeight.w600)
                  : TextStyle(fontSize: 13, color: c.textMuted, fontWeight: FontWeight.w600)),
          // The same on both sides: one value, no A / B.
          if (changed) ...<Widget>[value('A', a), value('B', b)]
          else
            Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(a ?? '—', style: DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.35))),
        ],
      ),
    );
  }
}

class _GeneralDiff extends StatelessWidget {
  const _GeneralDiff({required this.a, required this.b});

  final InspectorCall a;
  final InspectorCall b;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    String size(InspectorBody? x) => x == null ? '—' : formatBytes(x.size);
    final fields = <(String, String, String)>[
      (t.method, a.method, b.method),
      ('URL', decodeUrlForDisplay(a.url), decodeUrlForDisplay(b.url)),
      (t.status, _statusText(a, t), _statusText(b, t)),
      (t.duration, formatDuration(a.duration), formatDuration(b.duration)),
      (t.responseSize, size(a.responseBody), size(b.responseBody)),
      (t.requestSize, size(a.requestBody), size(b.requestBody)),
      (t.responseType, a.responseContentType ?? '—', b.responseContentType ?? '—'),
      (t.protocol, a.protocol ?? '—', b.protocol ?? '—'),
      (t.source, a.source, b.source),
      (t.started, formatClock(a.ts), formatClock(b.ts)),
      (t.mock, a.mocked ? t.yes : '—', b.mocked ? t.yes : '—'),
      (t.errorMessage, a.error ?? '—', b.error ?? '—'),
    ];
    // Changed fields first: they are the point of comparing.
    final changed = fields.where((f) => f.$2 != f.$3).toList();
    final same = fields.where((f) => f.$2 == f.$3).toList();
    final rows = <(String, String, String)>[...changed, ...same];
    return ListView(
      padding: EdgeInsets.fromLTRB(16, 4, 16, 16 + MediaQuery.paddingOf(context).bottom),
      children: <Widget>[
        if (changed.isEmpty) Padding(padding: const EdgeInsets.only(bottom: 12), child: Callout(title: t.fieldsSame)),
        _DiffCard(children: <Widget>[
          for (var i = 0; i < rows.length; i++)
            _FieldBlock(name: rows[i].$1, a: rows[i].$2, b: rows[i].$3, changed: i < changed.length, last: i == rows.length - 1),
        ]),
      ],
    );
  }
}

class _OptionsBar extends StatelessWidget {
  const _OptionsBar({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: children),
    );
  }
}

class _HeadersDiff extends StatelessWidget {
  const _HeadersDiff({required this.a, required this.b, required this.onlyChanges, required this.onOnlyChanges});

  final InspectorCall a;
  final InspectorCall b;
  final bool onlyChanges;
  final ValueChanged<bool> onOnlyChanges;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    List<Widget> table(String title, List<HeaderDiffRow> rows) {
      final diff = rows.where((r) => r.state != HeaderDiffState.same).length;
      final shown = onlyChanges ? rows.where((r) => r.state != HeaderDiffState.same).toList() : rows;
      return <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 16, 4, 8),
          child: Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: <Widget>[
            Text(title, style: DurbunType.heading(size: DurbunType.label, color: c.text)),
            Text(t.headerStats(diff, rows.length), style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.textMuted)),
          ]),
        ),
        if (shown.isEmpty)
          Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
              child: Text(t.headersSame, style: DurbunType.ui(size: DurbunType.body, color: c.textMuted)))
        else
          _DiffCard(children: <Widget>[
            for (var i = 0; i < shown.length; i++)
              _FieldBlock(
                name: shown[i].name,
                monoName: true,
                a: shown[i].a.isEmpty ? null : shown[i].a.join('\n'),
                b: shown[i].b.isEmpty ? null : shown[i].b.join('\n'),
                changed: shown[i].state != HeaderDiffState.same,
                last: i == shown.length - 1,
              ),
          ]),
      ];
    }

    return Column(
      children: <Widget>[
        _OptionsBar(children: <Widget>[DToggle(label: t.onlyChanges, icon: Icons.difference_outlined, tonal: true, selected: onlyChanges, onTap: () => onOnlyChanges(!onlyChanges))]),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.paddingOf(context).bottom),
            children: <Widget>[
              ...table(t.requestHeaders, diffHeaders(a.requestHeaders, b.requestHeaders)),
              ...table(t.responseHeaders, diffHeaders(a.responseHeaders, b.responseHeaders)),
            ],
          ),
        ),
      ],
    );
  }
}

class _BodyDiff extends StatefulWidget {
  const _BodyDiff(
      {super.key,
      required this.a,
      required this.b,
      required this.request,
      required this.onlyChanges,
      required this.sortKeys,
      required this.onOnlyChanges,
      required this.onSortKeys});

  final InspectorCall a;
  final InspectorCall b;
  final bool request;
  final bool onlyChanges;
  final bool sortKeys;
  final ValueChanged<bool> onOnlyChanges;
  final ValueChanged<bool> onSortKeys;

  @override
  State<_BodyDiff> createState() => _BodyDiffState();
}

class _BodyDiffState extends State<_BodyDiff> {
  late final BodyLines _la = bodyLines(widget.request ? widget.a.requestBody : widget.a.responseBody,
      widget.request ? widget.a.requestContentType : widget.a.responseContentType,
      sortKeys: widget.sortKeys);
  late final BodyLines _lb = bodyLines(widget.request ? widget.b.requestBody : widget.b.responseBody,
      widget.request ? widget.b.requestContentType : widget.b.responseContentType,
      sortKeys: widget.sortKeys);

  /// Off the UI thread: two large bodies can take a while.
  late final Future<DiffResult> _diff = _la.kind == BodyKind.binary || _lb.kind == BodyKind.binary
      ? Future<DiffResult>.value(const DiffResult(ops: <DiffOp>[], approximate: false, truncated: false, added: 0, removed: 0, equal: 0))
      : (_la.lines.length + _lb.lines.length < 400
          ? Future<DiffResult>.value(diffLines(_la.lines, _lb.lines))
          : compute(_diffInBackground, (_la.lines, _lb.lines)));
  final Set<int> _expanded = <int>{};

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    if (_la.kind == BodyKind.binary || _lb.kind == BodyKind.binary) {
      final same = _la.kind == _lb.kind && _la.raw == _lb.raw;
      return EmptyState(
          title: same ? t.binarySame : t.binaryDifferent,
          body: t.binarySizes(formatBytes(_la.size), formatBytes(_lb.size)));
    }
    if (_la.kind == BodyKind.none && _lb.kind == BodyKind.none) {
      return EmptyState(title: widget.request ? t.noRequestBodies : t.noResponseBodies);
    }
    return Column(
      children: <Widget>[
        _OptionsBar(children: <Widget>[
          DToggle(label: t.onlyChanges, icon: Icons.difference_outlined, tonal: true, selected: widget.onlyChanges, onTap: () => widget.onOnlyChanges(!widget.onlyChanges)),
          DToggle(label: t.sortKeys, icon: Icons.sort_by_alpha_rounded, tonal: true, selected: widget.sortKeys, onTap: () => widget.onSortKeys(!widget.sortKeys)),
        ]),
        Expanded(
          child: FutureBuilder<DiffResult>(
            future: _diff,
            builder: (context, snap) {
              final r = snap.data;
              if (r == null) {
                return Center(child: Text(t.comparing, style: TextStyle(fontSize: 13, color: c.textMuted)));
              }
              final rows = widget.onlyChanges ? collapseUnchanged(r.ops, expanded: _expanded) : <DiffRow>[for (final op in r.ops) DiffRow.line(op)];
              final notes = <String>[
                if (_la.truncated || _lb.truncated) t.bodyTruncatedOne,
                if (r.approximate) t.diffApproximate,
                if (r.truncated) t.diffTooLong,
              ];
              return ListView.builder(
                padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.paddingOf(context).bottom),
                itemCount: rows.length + 1,
                itemBuilder: (context, i) {
                  if (i == 0) return _DiffStats(result: r, notes: notes);
                  final row = rows[i - 1];
                  // The lines sit in one card: each row draws its slice.
                  final first = i == 1;
                  final last = i == rows.length;
                  final Widget child;
                  if (row.op == null) {
                    child = InkWell(
                      onTap: () => setState(() => _expanded.add(row.from)),
                      child: Container(
                        color: Color.alphaBlend(c.accentSoft, c.cardBg),
                        constraints: const BoxConstraints(minHeight: 36),
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
                        alignment: Alignment.center,
                        child: Text(t.showHidden(row.hidden),
                            textAlign: TextAlign.center,
                            style: DurbunType.ui(size: DurbunType.body, color: c.accentInk, weight: FontWeight.w600)),
                      ),
                    );
                  } else {
                    child = _DiffLine(op: row.op!);
                  }
                  return _CardSlice(first: first, last: last, child: child);
                },
              );
            },
          ),
        ),
      ],
    );
  }
}

class _DiffStats extends StatelessWidget {
  const _DiffStats({required this.result, required this.notes});

  final DiffResult result;
  final List<String> notes;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 10, 4, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (result.identical)
            Row(children: <Widget>[
              Icon(Icons.check_circle_outline_rounded, size: 16, color: c.success),
              const SizedBox(width: 6),
              Text(t.identicalBodies, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.success)),
            ])
          else
            Wrap(spacing: 8, children: <Widget>[
              Text('+${result.added}', style: DurbunType.monoStyle(size: 13, color: c.success, weight: FontWeight.w600)),
              Text('−${result.removed}', style: DurbunType.monoStyle(size: 13, color: c.danger, weight: FontWeight.w600)),
              Text(t.linesChanged, style: TextStyle(fontSize: 13, color: c.textMuted)),
            ]),
          for (final n in notes)
            Padding(padding: const EdgeInsets.only(top: 6), child: Callout(title: n, tone: CalloutTone.warning)),
        ],
      ),
    );
  }
}

/// One line of the one-column diff: A's and B's line numbers, the sign and
/// the text (wrapped: a phone cannot scroll every line sideways).
class _DiffLine extends StatelessWidget {
  const _DiffLine({required this.op});

  final DiffOp op;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final (bg, fg, sign) = switch (op.type) {
      DiffOpType.remove => (c.danger.withValues(alpha: 0.12), c.danger, '−'),
      DiffOpType.add => (c.success.withValues(alpha: 0.12), c.success, '+'),
      DiffOpType.equal => (Colors.transparent, c.textSubtle, ' '),
    };
    final num = DurbunType.monoStyle(size: 11.5, color: c.textSubtle, height: 1.45);
    return Container(
      color: bg,
      padding: const EdgeInsets.fromLTRB(4, 2, 12, 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(width: 30, child: Text(op.a == null ? '' : '${op.a! + 1}', textAlign: TextAlign.right, style: num)),
          SizedBox(width: 30, child: Text(op.b == null ? '' : '${op.b! + 1}', textAlign: TextAlign.right, style: num)),
          SizedBox(width: 16, child: Text(sign, textAlign: TextAlign.center, style: DurbunType.monoStyle(size: 12, color: fg, weight: FontWeight.w600, height: 1.35))),
          Expanded(
            child: Text(
              // A huge single line (minified JSON) is cut: the row is a view,
              // the copy buttons on the detail page have the whole body.
              op.text.length > 2000 ? '${op.text.substring(0, 2000)}…' : op.text,
              style: DurbunType.monoStyle(size: 12, color: op.type == DiffOpType.equal ? c.textMuted : c.text, height: 1.35),
            ),
          ),
        ],
      ),
    );
  }
}

/// Rows in one card (fields, headers).
class _DiffCard extends StatelessWidget {
  const _DiffCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

/// One row of a card built lazily row by row (a long diff): the sides of
/// the card, and its top or bottom edge on the first and last row.
class _CardSlice extends StatelessWidget {
  const _CardSlice({required this.first, required this.last, required this.child});

  final bool first;
  final bool last;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final side = BorderSide(color: c.border);
    final radius = BorderRadius.vertical(
      top: first ? const Radius.circular(DurbunRadius.lg) : Radius.zero,
      bottom: last ? const Radius.circular(DurbunRadius.lg) : Radius.zero,
    );
    return Container(
      clipBehavior: first || last ? Clip.antiAlias : Clip.none,
      decoration: BoxDecoration(
        color: c.cardBg,
        borderRadius: first || last ? radius : null,
        border: Border(left: side, right: side, top: first ? side : BorderSide.none, bottom: last ? side : BorderSide.none),
      ),
      child: child,
    );
  }
}
