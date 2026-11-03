/// Network view of the in-app inspector: the desktop's request table,
/// toolbars and detail panel, laid out for a phone.
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import 'body_search.dart';
import 'compare_view.dart';
import 'filter_ui.dart';
import 'format.dart';
import 'json_tree.dart';
import 'live_list.dart';
import 'network_model.dart';
import 'replay.dart';
import 'store.dart';
import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

class NetworkView extends StatefulWidget {
  const NetworkView({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  State<NetworkView> createState() => _NetworkViewState();
}

class _NetworkViewState extends State<NetworkView> {
  final NetFilters _filters = NetFilters();
  final TextEditingController _search = TextEditingController();
  List<QueryClause> _clauses = const <QueryClause>[];

  bool _matches(InspectorCall c) =>
      callMatchesFilters(c, _filters, isDefaultHost: widget.store.isDefaultHost) &&
      callMatchesQuery(c, _clauses, bodies: _filters.searchBodies);

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _setQuery(String v) => setState(() => _clauses = parseQuery(v));

  void _clearAll() {
    _search.clear();
    setState(() {
      _filters.reset();
      _clauses = const <QueryClause>[];
    });
  }

  Color _statusColor(DurbunColors c, String s) => switch (s) {
        '2xx' => c.st2xx,
        '3xx' => c.st3xx,
        '4xx' => c.st4xx,
        _ => c.st5xx,
      };

  void _openFilters(List<String> hosts) {
    final t = InspectorStrings.of(context);
    void flip(Set<String> s, String v) => s.contains(v) ? s.remove(v) : s.add(v);
    showFilterSheet(
      context,
      title: t.netFilters,
      onChanged: () => setState(() {}),
      onReset: _filters.reset,
      build: (context, changed) {
        final c = DurbunColors.of(context);
        return <Widget>[
          SheetSection(
            title: t.method,
            children: <Widget>[
              for (final m in kMethodChips)
                DToggle(
                  label: m == 'OTHER' ? t.other : m,
                  mono: m != 'OTHER',
                  color: m == 'OTHER' ? null : c.method(m),
                  selected: _filters.methods.contains(m),
                  onTap: () {
                    flip(_filters.methods, m);
                    changed();
                  },
                ),
            ],
          ),
          SheetSection(
            title: t.statusTitle,
            children: <Widget>[
              for (final st in kStatusClasses)
                DToggle(
                  label: st == 'fail' ? t.failed : st,
                  mono: st != 'fail',
                  color: _statusColor(c, st),
                  selected: _filters.statuses.contains(st),
                  onTap: () {
                    flip(_filters.statuses, st);
                    changed();
                  },
                ),
            ],
          ),
          if (hosts.isNotEmpty) _HostsSection(filters: _filters, store: widget.store, changed: changed),
          const SizedBox(height: 8),
          SheetSwitch(label: t.errorsOnly, hint: t.failedHint, icon: Icons.warning_amber_rounded, value: _filters.errorsOnly, onChanged: (v) {
            _filters.errorsOnly = v;
            changed();
          }),
          SheetSwitch(label: t.slowOnly, icon: Icons.schedule, value: _filters.slowOnly, onChanged: (v) {
            _filters.slowOnly = v;
            changed();
          }),
          SheetSwitch(label: t.mockedOnly, icon: Icons.theater_comedy_outlined, value: _filters.mockedOnly, onChanged: (v) {
            _filters.mockedOnly = v;
            changed();
          }),
          SheetSwitch(label: t.searchBodies, hint: t.searchBodiesHint, icon: Icons.data_object, value: _filters.searchBodies, onChanged: (v) {
            _filters.searchBodies = v;
            changed();
          }),
        ];
      },
    );
  }

  /// Filters button, then the active filters (each with an ×) so they are
  /// always in view, then quick toggles for the common ones.
  List<Widget> _chips(InspectorStrings t, DurbunColors c, List<String> hosts) {
    final f = _filters;
    final active = <Widget>[
      for (final m in f.methods)
        ActiveChip(label: m == 'OTHER' ? t.other : m, mono: m != 'OTHER', color: m == 'OTHER' ? null : c.method(m), onRemove: () => setState(() => f.methods.remove(m))),
      for (final st in f.statuses)
        ActiveChip(label: st == 'fail' ? t.failed : st, mono: st != 'fail', color: _statusColor(c, st), onRemove: () => setState(() => f.statuses.remove(st))),
      for (final h in f.extraHosts) ActiveChip(label: h, mono: true, onRemove: () => setState(() => f.extraHosts.remove(h))),
      for (final h in f.hiddenHosts) ActiveChip(label: '−$h', mono: true, onRemove: () => setState(() => f.hiddenHosts.remove(h))),
      if (f.errorsOnly) ActiveChip(label: t.errorsOnly, onRemove: () => setState(() => f.errorsOnly = false)),
      if (f.slowOnly) ActiveChip(label: t.slowOnly, onRemove: () => setState(() => f.slowOnly = false)),
      if (f.mockedOnly) ActiveChip(label: t.mockedOnly, onRemove: () => setState(() => f.mockedOnly = false)),
      if (f.searchBodies) ActiveChip(label: t.inBodies, onRemove: () => setState(() => f.searchBodies = false)),
    ];
    final quick = <Widget>[
      if (!f.errorsOnly) DToggle(label: t.errorsOnly, icon: Icons.warning_amber_rounded, selected: false, onTap: () => setState(() => f.errorsOnly = true)),
      if (!f.slowOnly) DToggle(label: t.slowOnly, icon: Icons.schedule, selected: false, onTap: () => setState(() => f.slowOnly = true)),
      for (final st in const <String>['4xx', '5xx'])
        if (!f.statuses.contains(st)) DToggle(label: st, mono: true, color: _statusColor(c, st), selected: false, onTap: () => setState(() => f.statuses.add(st))),
    ];
    final otherHosts = widget.store.calls.where((x) {
      final h = hostOf(x);
      return !f.showsHost(h, isDefault: widget.store.isDefaultHost(h));
    }).length;
    return <Widget>[
      FilterButton(count: f.activeCount, onTap: () => _openFilters(hosts)),
      // Says that requests are left out by the host list, and opens it.
      if (otherHosts > 0) DToggle(label: t.otherHostsHidden(otherHosts), icon: Icons.visibility_off_outlined, selected: false, onTap: () => _openFilters(hosts)),
      ...active,
      ...quick,
    ];
  }

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final c = DurbunColors.of(context);
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final all = widget.store.calls;
        final shown = all.where(_matches).toList();
        final hosts = (<String>{for (final x in all) hostOf(x)}..remove('')).toList()..sort();
        final terms = freeTerms(_clauses);
        final filtered = _filters.activeCount > 0 || _clauses.isNotEmpty;
        return Column(
          children: <Widget>[
            Container(
              color: c.bgPanel,
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: DSearchField(
                      hint: t.netSearchHint,
                      controller: _search,
                      onChanged: _setQuery,
                      onHelp: () => showQueryHelp(context,
                          hints: <QueryHint>[for (final (k, v) in t.netQueryHints) QueryHint(k, v)], controller: _search, onChanged: _setQuery),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(filtered ? '${shown.length}/${all.length}' : '${all.length}',
                      style: DurbunType.monoStyle(size: 12, color: c.textSubtle)),
                ],
              ),
            ),
            FilterRow(children: _chips(t, c, hosts)),
            Divider(height: 1, color: c.border),
            Expanded(
              child: shown.isEmpty
                  ? EmptyState(
                      icon: Icons.swap_horiz,
                      title: all.isEmpty ? t.noRequestsTitle : t.noMatchTitle,
                      body: all.isEmpty ? t.noRequestsBody : t.noMatchBody,
                      actionLabel: all.isEmpty ? null : t.clearFilters,
                      onAction: all.isEmpty ? null : _clearAll,
                    )
                  : LiveList<InspectorCall>(
                      items: shown,
                      keyOf: (x) => x.key,
                      seqOf: (x) => x.seq,
                      filterKey: '${_filters.signature}#${_search.text}',
                      newText: t.newItems,
                      itemBuilder: (context, call) => CallRow(
                          call: call,
                          store: widget.store,
                          terms: terms,
                          bodyQuery: _filters.searchBodies && terms.isNotEmpty ? terms.first : null),
                    ),
            ),
            if (widget.store.droppedCalls > 0)
              Container(
                width: double.infinity,
                color: c.bgPanel,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                child: Text(t.dropped(widget.store.droppedCalls), style: TextStyle(fontSize: 11, color: c.textMeta)),
              ),
          ],
        );
      },
    );
  }
}

/// The filter sheet's host list: every host seen, its request count, the
/// default ones marked; ticked hosts are listed.
class _HostsSection extends StatelessWidget {
  const _HostsSection({required this.filters, required this.store, required this.changed});

  final NetFilters filters;
  final DurbunInspectorStore store;
  final VoidCallback changed;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final counts = <String, int>{};
    for (final x in store.calls) {
      final h = hostOf(x);
      if (h.isNotEmpty) counts[h] = (counts[h] ?? 0) + 1;
    }
    // Default hosts first, then the others; busiest first in each.
    final hosts = counts.keys.toList()
      ..sort((a, b) {
        final da = store.isDefaultHost(a), db = store.isDefaultHost(b);
        if (da != db) return da ? -1 : 1;
        return counts[b]!.compareTo(counts[a]!);
      });
    void set(String h, bool on) {
      if (store.isDefaultHost(h)) {
        on ? filters.hiddenHosts.remove(h) : filters.hiddenHosts.add(h);
      } else {
        on ? filters.extraHosts.add(h) : filters.extraHosts.remove(h);
      }
      changed();
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 14, 8, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(left: 12),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(t.hostsTitle, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.textMuted, letterSpacing: 0.2)),
                      const SizedBox(height: 2),
                      Text(t.hostsHint, style: TextStyle(fontSize: 11.5, color: c.textMeta)),
                    ],
                  ),
                ),
                TextButton(
                  onPressed: () {
                    filters.hiddenHosts.clear();
                    filters.extraHosts.addAll(hosts.where((h) => !store.isDefaultHost(h)));
                    changed();
                  },
                  child: Text(t.showAllHosts),
                ),
                if (store.defaultHosts.isNotEmpty)
                  TextButton(
                    onPressed: () {
                      filters.hiddenHosts.clear();
                      filters.extraHosts.clear();
                      changed();
                    },
                    child: Text(t.defaultHostsOnly),
                  ),
              ],
            ),
          ),
          for (final h in hosts)
            CheckboxListTile(
              dense: true,
              visualDensity: VisualDensity.compact,
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: const EdgeInsets.only(left: 4, right: 8),
              value: filters.showsHost(h, isDefault: store.isDefaultHost(h)),
              onChanged: (v) => set(h, v ?? false),
              title: Text(h, maxLines: 1, overflow: TextOverflow.ellipsis, style: DurbunType.monoStyle(size: 12.5, color: c.text)),
              secondary: Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: <Widget>[
                if (store.defaultHosts.isNotEmpty && store.isDefaultHost(h)) DBadge(t.defaultHost, tone: BadgeTone.accent),
                Text('${counts[h]}', style: DurbunType.monoStyle(size: 11.5, color: c.textMeta)),
              ]),
            ),
        ],
      ),
    );
  }
}

/// One request: status · method · path (+ badges) over host · source · size · time.
class CallRow extends StatelessWidget {
  const CallRow(
      {super.key,
      required this.call,
      required this.store,
      this.terms = const <String>[],
      this.onTap,
      this.bodyQuery});

  final InspectorCall call;
  final DurbunInspectorStore store;

  /// Folded free words of the search, marked in the path.
  final List<String> terms;

  /// Replaces opening the detail page (the compare picker).
  final VoidCallback? onTap;

  /// Set while the list searches bodies: the detail opens on the body with
  /// this text found.
  final String? bodyQuery;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final uri = call.uri;
    final path = decodeUrl(
        uri == null ? call.url : (uri.path.isEmpty ? '/' : uri.path));
    final q = uri != null && uri.hasQuery ? decodeUrl('?${uri.query}') : '';
    final failed = call.error != null && !call.cancelled;
    final statusText = call.error != null
        ? (call.cancelled ? t.cancelledShort : 'FAIL')
        : (call.status?.toString() ?? '···');
    final statusColor =
        call.cancelled ? c.textSubtle : c.status(call.status, failed: failed);
    final cls = statusClass(call);
    final tint = switch (cls) {
      '4xx' => c.lvWarnBg,
      '5xx' || 'fail' => c.lvErrorBg,
      _ => null,
    };
    final ms = call.duration?.inMilliseconds;
    final timeColor = ms == null
        ? c.textSubtle
        : ms >= 3000
            ? c.danger
            : ms >= kSlowMs
                ? c.warning
                : c.textMuted;
    final gql = graphqlLabel(call);
    final size = call.responseBody?.size;
    final mono = DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.3);
    return Material(
      color: tint ?? Colors.transparent,
      child: InkWell(
        onTap: () {
          FocusManager.instance.primaryFocus?.unfocus();
          if (onTap != null) return onTap!();
          Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => DurbunTheme.wrap(
                  context,
                  CallDetailPage(
                      call: call, store: store, bodyQuery: bodyQuery))));
        },
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
          decoration: BoxDecoration(
              border: Border(
                  bottom: BorderSide(color: c.border.withValues(alpha: 0.6)))),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  SizedBox(
                    width: 38,
                    child: Text(statusText,
                        style: DurbunType.monoStyle(
                            size: 12,
                            color: statusColor,
                            weight: FontWeight.w700,
                            height: 1.3)),
                  ),
                  SizedBox(
                    width: 52,
                    child: Text(call.method,
                        style: DurbunType.monoStyle(
                            size: 12,
                            color: c.method(call.method),
                            weight: FontWeight.w600,
                            height: 1.3)),
                  ),
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: <InlineSpan>[
                          highlightTerms(path, terms, mono, c.hlMark),
                          if (q.isNotEmpty)
                            highlightTerms(q, terms,
                                mono.copyWith(color: c.textSubtle), c.hlMark),
                        ],
                      ),
                      // Two lines, so a match deep in a long path is seen.
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 3),
              Row(
                children: <Widget>[
                  const SizedBox(width: 90),
                  Expanded(
                    child: Wrap(
                      spacing: 5,
                      runSpacing: 3,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: <Widget>[
                        // One line: a host broken mid-word is hard to read.
                        Text.rich(
                            highlightTerms(
                                uri?.host ?? '',
                                terms,
                                DurbunType.monoStyle(
                                    size: 11, color: c.textMeta, height: 1.3),
                                c.hlMark),
                            maxLines: 1,
                            softWrap: false,
                            overflow: TextOverflow.ellipsis),
                        _SourceBadge(call),
                        if (gql != null)
                          DBadge(gql, tone: BadgeTone.warning, mono: true),
                        if (call.mocked)
                          DBadge(t.mock,
                              tone: BadgeTone.accent,
                              icon: Icons.theater_comedy_outlined),
                        if (failed)
                          DBadge(t.shortError(shortErrorKey(call.error)),
                              tone: BadgeTone.danger),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(size == null ? '—' : formatBytes(size),
                      style: DurbunType.monoStyle(
                          size: 11, color: c.textMeta, height: 1.3)),
                  const SizedBox(width: 10),
                  SizedBox(
                    width: 56,
                    child: Text(
                      call.state == InspectorCallState.pending
                          ? '···'
                          : formatDuration(call.duration),
                      textAlign: TextAlign.right,
                      style: DurbunType.monoStyle(
                          size: 11.5,
                          color: timeColor,
                          height: 1.3,
                          weight: ms != null && ms >= kSlowMs
                              ? FontWeight.w600
                              : null),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SourceBadge extends StatelessWidget {
  const _SourceBadge(this.call);

  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final s = call.source.toLowerCase();
    final color = s.contains('okhttp')
        ? c.sdkAndroid
        : s.contains('urlsession')
            ? c.sdkIos
            : c.sdkDart;
    return Container(
      height: 16,
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
          border: Border.all(color: color.withValues(alpha: 0.45)),
          borderRadius: BorderRadius.circular(DurbunRadius.sm)),
      child: Text(call.source,
          style: DurbunType.monoStyle(size: 10, color: color, height: 1.4)),
    );
  }
}

/* ───────────────────────────── detail ───────────────────────────── */

class CallDetailPage extends StatefulWidget {
  const CallDetailPage(
      {super.key, required this.call, required this.store, this.bodyQuery});

  final InspectorCall call;
  final DurbunInspectorStore store;

  /// Opens on the body that contains this text, with it found.
  final String? bodyQuery;

  @override
  State<CallDetailPage> createState() => _CallDetailPageState();
}

class _CallDetailPageState extends State<CallDetailPage> {
  late int _tab = _firstTab();

  int _firstTab() {
    final q = widget.bodyQuery;
    if (q == null || q.isEmpty) return 0;
    bool has(InspectorBody? b) => b != null && b.isText && foldText(b.data).contains(q);
    if (has(widget.call.responseBody)) return 2;
    if (has(widget.call.requestBody)) return 1;
    return 0;
  }
  bool _replaying = false;

  InspectorCall get call => widget.call;

  Future<void> _replay() async {
    final t = InspectorStrings.of(context);
    setState(() => _replaying = true);
    final error = await replayCall(call);
    if (!mounted) return;
    setState(() => _replaying = false);
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
          content: Text(error == null ? t.replaySent : t.replayFailed(error)),
          duration: const Duration(seconds: 2)),
    );
  }

  void _copyAs(String format) {
    final t = InspectorStrings.of(context);
    final text = switch (format) {
      'url' => call.url,
      'all' => callAsText(call),
      'response' =>
        call.responseBody?.displayText ?? call.responseBody?.data ?? '',
      _ => copyAs(format, call),
    };
    final notes = format == 'url' || format == 'all' || format == 'response'
        ? const <CopyNote>[]
        : copyNotes(call);
    copyText(context, text,
        note: notes.isEmpty ? null : notes.map(t.copyNote).join(' · '));
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final failed = call.error != null && !call.cancelled;
        final reason = call.statusText?.isNotEmpty == true
            ? call.statusText!
            : (reasonPhrase(call.status) ?? '');
        final meta = <String>[
          if (call.state != InspectorCallState.pending)
            formatDuration(call.duration),
          if (call.responseBody != null) formatBytes(call.responseBody!.size),
          call.source,
          formatClock(call.ts),
        ].join(' · ');
        return Scaffold(
          backgroundColor: c.bgPanel,
          appBar: AppBar(
            backgroundColor: c.bgPanel,
            surfaceTintColor: Colors.transparent,
            foregroundColor: c.text,
            titleSpacing: 0,
            title: Text.rich(
              TextSpan(
                children: <InlineSpan>[
                  TextSpan(
                      text: '${call.method} ',
                      style: TextStyle(color: c.method(call.method))),
                  if (call.error != null)
                    TextSpan(
                        text: call.cancelled
                            ? t.cancelled
                            : t.shortError(shortErrorKey(call.error)),
                        style: TextStyle(
                            color: call.cancelled ? c.textMuted : c.danger))
                  else if (call.status != null)
                    TextSpan(
                        text: '${call.status} $reason',
                        style: TextStyle(color: c.status(call.status)))
                  else
                    TextSpan(
                        text: t.pending, style: TextStyle(color: c.stPending)),
                ],
              ),
              style: DurbunType.monoStyle(size: 14, weight: FontWeight.w700),
            ),
            actions: <Widget>[
              PopupMenuButton<String>(
                tooltip: t.copy,
                icon: Icon(Icons.copy_rounded, size: 19, color: c.textMuted),
                onSelected: _copyAs,
                itemBuilder: (_) => <PopupMenuEntry<String>>[
                  PopupMenuItem<String>(value: 'url', child: Text(t.copyUrl)),
                  const PopupMenuDivider(),
                  for (final f in kCopyFormats)
                    PopupMenuItem<String>(
                        value: f, child: Text(t.copyAsFormat(f))),
                  const PopupMenuDivider(),
                  if (call.responseBody?.isText == true)
                    PopupMenuItem<String>(
                        value: 'response', child: Text(t.copyResponseBody)),
                  PopupMenuItem<String>(value: 'all', child: Text(t.copyAll)),
                ],
              ),
              const SizedBox(width: 4),
            ],
          ),
          // On short screens (landscape) the URL and actions scroll away and
          // the tab content keeps the room.
          body: NestedScrollView(
            headerSliverBuilder: (context, _) => <Widget>[
              SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 0, 8, 0),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Expanded(
                              child: SelectableText(call.url,
                                  style: DurbunType.monoStyle(
                                      size: 12.5, color: c.text))),
                          DIconButton(
                              icon: Icons.copy,
                              tooltip: t.copyUrl,
                              size: 28,
                              onTap: () => _copyAs('url')),
                        ],
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 2, 14, 8),
                      child: Text(meta,
                          style: DurbunType.monoStyle(
                              size: 11.5, color: c.textMeta)),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: <Widget>[
                          if (canReplay)
                            DButton(
                              label: _replaying ? t.replaying : t.replay,
                              icon: Icons.replay,
                              onTap: _replaying ? null : _replay,
                            ),
                          DButton(
                            label: t.compareEllipsis,
                            icon: Icons.compare_arrows,
                            onTap: () => Navigator.of(context).push(
                                MaterialPageRoute<void>(
                                    builder: (_) => DurbunTheme.wrap(
                                        context,
                                        ComparePickerPage(
                                            base: call,
                                            store: widget.store)))),
                          ),
                          PopupMenuButton<String>(
                            tooltip: t.copyAs,
                            onSelected: _copyAs,
                            itemBuilder: (_) => <PopupMenuEntry<String>>[
                              for (final f in kCopyFormats)
                                PopupMenuItem<String>(
                                    value: f, child: Text(t.copyAsFormat(f))),
                            ],
                            child: IgnorePointer(
                                child: DButton(
                                    label: t.copyAs,
                                    icon: Icons.code,
                                    trailingIcon: Icons.expand_more,
                                    onTap: () {})),
                          ),
                          if (call.mocked)
                            DBadge(
                                call.mockRuleId == null
                                    ? t.mock
                                    : '${t.mock} · ${call.mockRuleId}',
                                tone: BadgeTone.accent,
                                icon: Icons.theater_comedy_outlined),
                          if (failed)
                            DBadge(t.shortError(shortErrorKey(call.error)),
                                tone: BadgeTone.danger),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
            body: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                DTabs(
                  labels: <String>[t.general, t.request, t.response, t.timing],
                  counts: <int?>[
                    null,
                    call.requestHeaders.length,
                    call.state == InspectorCallState.done
                        ? call.responseHeaders.length
                        : null,
                    null
                  ],
                  index: _tab,
                  onChanged: (i) => setState(() => _tab = i),
                ),
                Expanded(
                  child: switch (_tab) {
                    0 => _GeneralTab(call: call, store: widget.store),
                    1 => _HttpTab(call: call, request: true, bodyQuery: widget.bodyQuery),
                    2 => call.state == InspectorCallState.pending
                        ? EmptyState(
                            icon: Icons.hourglass_empty,
                            title: t.pending,
                            body: t.waitingResponse)
                        : call.error != null
                            ? _ErrorTab(call: call)
                            : _HttpTab(call: call, request: false, bodyQuery: widget.bodyQuery),
                    _ => _TimingTab(call: call),
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

EdgeInsets _pagePadding(BuildContext context) =>
    EdgeInsets.fromLTRB(14, 12, 14, 20 + MediaQuery.paddingOf(context).bottom);

class _GeneralTab extends StatelessWidget {
  const _GeneralTab({required this.call, required this.store});

  final InspectorCall call;
  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final hello = store.hello;
    final app = hello?['app'] as Map?;
    final device = hello?['device'] as Map?;
    final reason = call.statusText?.isNotEmpty == true
        ? call.statusText!
        : (reasonPhrase(call.status) ?? '');
    final status = call.error != null
        ? (call.cancelled ? t.cancelled : call.error!)
        : call.status == null
            ? t.pending
            : '${call.status} $reason';
    final started =
        DateTime.fromMicrosecondsSinceEpoch((call.ts * 1000).round());
    final gql = graphqlLabel(call);
    final rows = <(String, String, Color?)>[
      ('URL', call.url, null),
      (t.method, call.method, c.method(call.method)),
      (
        t.status,
        status,
        call.cancelled
            ? c.textMuted
            : c.status(call.status, failed: call.error != null)
      ),
      if (gql != null) ('GraphQL', gql, null),
      if (call.protocol != null) (t.protocol, call.protocol!, null),
      if (call.remoteAddress != null)
        (t.remoteAddress, call.remoteAddress!, null),
      (
        t.source,
        call.native ? '${call.source} · ${t.nativeLayer}' : call.source,
        null
      ),
      if (app != null)
        (
          t.app,
          '${app['name'] ?? ''} ${app['version'] ?? ''} (${app['id'] ?? ''})'
              .trim(),
          null
        ),
      if (device != null)
        (
          t.device,
          '${device['model'] ?? device['name'] ?? ''} · ${device['platform'] == 'ios' ? 'iOS ' : device['platform'] == 'android' ? 'Android ' : ''}${device['osVersion'] ?? ''}',
          null
        ),
      (
        t.started,
        '${started.year}-${_two(started.month)}-${_two(started.day)} ${formatClock(call.ts)}',
        null
      ),
      (
        t.duration,
        call.state == InspectorCallState.pending
            ? t.pending
            : formatDuration(call.duration),
        null
      ),
      if (call.requestBody != null)
        (t.requestSize, formatBytes(call.requestBody!.size), null),
      if (call.responseBody != null)
        (t.responseSize, formatBytes(call.responseBody!.size), null),
      if (call.responseContentType != null)
        (t.contentType, call.responseContentType!, null),
      if (call.mocked) (t.mock, call.mockRuleId ?? '✓', c.badgeAccent),
      ('ID', '${call.native ? 'native' : 'dart'}:${call.id}', null),
    ];
    return ListView(
      padding: _pagePadding(context),
      children: <Widget>[
        if (call.error != null && !call.cancelled) ...<Widget>[
          Callout(
              tone: CalloutTone.danger,
              title: t.shortError(shortErrorKey(call.error)),
              body: call.error),
          const SizedBox(height: 10),
        ],
        if (call.mocked) ...<Widget>[
          Callout(title: t.mockedTitle, body: t.mockedBody),
          const SizedBox(height: 10),
        ],
        if (call.bodiesDropped) ...<Widget>[
          Callout(tone: CalloutTone.warning, title: t.bodiesDropped),
          const SizedBox(height: 10),
        ],
        KeyValueTable(rows: rows),
      ],
    );
  }

  static String _two(int v) => v.toString().padLeft(2, '0');
}

class _ErrorTab extends StatelessWidget {
  const _ErrorTab({required this.call});

  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final (type, message) = splitError(call.error);
    return ListView(
      padding: _pagePadding(context),
      children: <Widget>[
        Callout(
          tone: call.cancelled ? CalloutTone.info : CalloutTone.danger,
          title: call.cancelled
              ? t.cancelled
              : t.shortError(shortErrorKey(call.error)),
          body: t.noResponseBody,
        ),
        const SizedBox(height: 12),
        if (type != null)
          Text(type,
              style: DurbunType.monoStyle(
                  size: 12.5, color: c.danger, weight: FontWeight.w600)),
        SelectableText(message,
            style: DurbunType.monoStyle(size: 12.5, color: c.text)),
      ],
    );
  }
}

class _HttpTab extends StatefulWidget {
  const _HttpTab({required this.call, required this.request, this.bodyQuery});

  final InspectorCall call;
  final bool request;
  final String? bodyQuery;

  @override
  State<_HttpTab> createState() => _HttpTabState();
}

class _HttpTabState extends State<_HttpTab> {
  int _part = 0;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final call = widget.call;
    final headers = widget.request ? call.requestHeaders : call.responseHeaders;
    final cookies =
        widget.request ? requestCookies(headers) : responseCookies(headers);
    final query = widget.request
        ? (call.uri?.queryParametersAll ?? const <String, List<String>>{})
        : const <String, List<String>>{};
    final labels = <String>[
      t.body,
      t.headers,
      t.cookies,
      if (widget.request) t.query
    ];
    final counts = <int?>[
      null,
      headers.length,
      cookies.length,
      if (widget.request) query.values.fold<int>(0, (s, v) => s + v.length)
    ];
    final part = _part.clamp(0, labels.length - 1);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
          child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: DSegmented(
                  labels: labels,
                  counts: counts,
                  index: part,
                  onChanged: (i) => setState(() => _part = i))),
        ),
        Expanded(
          child: switch (part) {
            0 => BodyPane(
                body: widget.request ? call.requestBody : call.responseBody,
                hasBody:
                    widget.request ? call.hasRequestBody : call.hasResponseBody,
                contentType: widget.request
                    ? call.requestContentType
                    : call.responseContentType,
                dropped: call.bodiesDropped,
                initialQuery: widget.bodyQuery ?? '',
              ),
            1 => _PairsList(pairs: headers, empty: t.noHeaders),
            2 => _PairsList(pairs: cookies, empty: t.noCookies),
            _ => _PairsList(pairs: <List<String>>[
                for (final e in query.entries)
                  for (final v in e.value) <String>[e.key, v]
              ], empty: t.noQuery),
          },
        ),
      ],
    );
  }
}

List<List<String>> requestCookies(List<List<String>> headers) => <List<String>>[
      for (final h in headers)
        if (h[0].toLowerCase() == 'cookie')
          for (final part in h[1].split(';'))
            if (part.contains('='))
              <String>[
                part.substring(0, part.indexOf('=')).trim(),
                part.substring(part.indexOf('=') + 1).trim()
              ],
    ];

List<List<String>> responseCookies(List<List<String>> headers) =>
    <List<String>>[
      for (final h in headers)
        if (h[0].toLowerCase() == 'set-cookie' && h[1].contains('='))
          <String>[
            h[1].substring(0, h[1].indexOf('=')).trim(),
            h[1].substring(h[1].indexOf('=') + 1).split(';').first.trim()
          ],
    ];

class _PairsList extends StatelessWidget {
  const _PairsList({required this.pairs, required this.empty});

  final List<List<String>> pairs;
  final String empty;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    if (pairs.isEmpty) return EmptyState(icon: Icons.list_alt, title: empty);
    return ListView(
      padding: _pagePadding(context),
      children: <Widget>[
        KeyValueTable(rows: <(String, String, Color?)>[
          for (final p in pairs) (p[0], p[1], null)
        ]),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: () => copyText(
                context, pairs.map((p) => '${p[0]}: ${p[1]}').join('\n')),
            icon: Icon(Icons.copy, size: 15, color: c.textMuted),
            label: Text(InspectorStrings.of(context).copy,
                style: TextStyle(color: c.textMuted, fontSize: 12.5)),
          ),
        ),
      ],
    );
  }
}

/// A body with Preview (JSON tree, image, form), Code and Hex modes.
class BodyPane extends StatefulWidget {
  const BodyPane(
      {super.key,
      required this.body,
      required this.hasBody,
      this.contentType,
      this.dropped = false,
      this.initialQuery = ''});

  final InspectorBody? body;
  final bool hasBody;
  final String? contentType;
  final bool dropped;

  /// Find text to open with (the list's body search).
  final String initialQuery;

  @override
  State<BodyPane> createState() => _BodyPaneState();
}

class _BodyPaneState extends State<BodyPane> {
  int _mode = 0;
  Object? _json;
  bool _jsonParsed = false;

  /// Kept across Preview and Code.
  late String _query = widget.initialQuery;

  static const int _maxShownChars = 200 * 1024;

  Object? _parsedJson(InspectorBody b) {
    if (_jsonParsed) return _json;
    _jsonParsed = true;
    final s = b.data.trimLeft();
    if (b.isText && (s.startsWith('{') || s.startsWith('['))) {
      try {
        _json = jsonDecode(b.data);
      } catch (_) {
        _json = null;
      }
    }
    return _json;
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final b = widget.body;
    if (b == null) {
      return EmptyState(
        icon: Icons.inbox_outlined,
        title: widget.dropped
            ? t.bodiesDropped
            : (widget.hasBody ? t.bodyNotCaptured : t.noBody),
        body: widget.dropped || widget.hasBody ? null : t.noBodyHint,
      );
    }
    if (b.data.isEmpty) {
      return EmptyState(
          icon: Icons.inbox_outlined,
          title: b.size > 0 ? t.bodyNotCaptured : t.noBody,
          body: b.size > 0 ? t.bodyNotCapturedHint : null);
    }
    final kind = bodyKindLabel(widget.contentType, b);
    final json = _parsedJson(b);
    final isImage =
        (widget.contentType ?? '').toLowerCase().startsWith('image/') &&
            !b.isText;
    final modes = <String>[t.preview, t.code, if (!b.isText || isImage) t.hex];
    final mode = _mode.clamp(0, modes.length - 1);
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 8, 0),
      child: Row(
        children: <Widget>[
          Flexible(
            flex: 0,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: DSegmented(
                  labels: modes,
                  index: mode,
                  onChanged: (i) => setState(() => _mode = i)),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              <String>[
                kind,
                formatBytes(b.size),
                if (widget.contentType != null)
                  widget.contentType!.split(';').first
              ].join(' · '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DurbunType.monoStyle(size: 11, color: c.textMeta),
            ),
          ),
          if (b.isText)
            DIconButton(
                icon: Icons.copy,
                tooltip: t.copy,
                size: 28,
                onTap: () => copyText(context, b.displayText ?? b.data)),
        ],
      ),
    );
    final Widget content;
    if (mode == 0 && json != null) {
      content = JsonTreeView(
          value: json,
          initialQuery: _query,
          onQueryChanged: (v) => _query = v,
          padding: _pagePadding(context).copyWith(top: 4, left: 8));
    } else if (mode == 0 && isImage) {
      content = ListView(
        padding: _pagePadding(context),
        children: <Widget>[
          Container(
            decoration: BoxDecoration(
                color: c.bgSunken,
                borderRadius: BorderRadius.circular(DurbunRadius.md),
                border: Border.all(color: c.border)),
            padding: const EdgeInsets.all(12),
            child: b.truncated
                ? Text(t.truncated(formatBytes(b.size)),
                    style: TextStyle(color: c.textMuted))
                : Image.memory(b.bytes,
                    errorBuilder: (_, __, ___) => Text(t.imageUnreadable,
                        style: TextStyle(color: c.textMuted))),
          ),
        ],
      );
    } else if (mode == 0 &&
        (widget.contentType ?? '').contains('form-urlencoded') &&
        b.isText) {
      final pairs = <List<String>>[
        for (final e in Uri.splitQueryString(b.data).entries)
          <String>[e.key, e.value],
      ];
      content = _PairsList(pairs: pairs, empty: t.noBody);
    } else if ((mode == 2 || (mode == 0 && !b.isText)) ||
        (mode == 1 && !b.isText)) {
      content = ListView(
        padding: _pagePadding(context),
        children: <Widget>[
          SelectableText(hexDump(b.bytes),
              style: DurbunType.monoStyle(size: 11.5, color: c.textMuted))
        ],
      );
    } else {
      var text = mode == 1 ? (b.displayText ?? b.data) : b.data;
      final cut = text.length > _maxShownChars;
      if (cut) text = text.substring(0, _maxShownChars);
      final rows = codeRows(text);
      final style = DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.35);
      final numStyle = DurbunType.monoStyle(size: 10.5, color: c.textSubtle, height: 1.55);
      final gutter = 8.0 + 7.0 * '${rows.isEmpty ? 1 : rows.last.$1}'.length;
      content = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (cut || b.truncated)
            Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
                child: Callout(tone: CalloutTone.warning, title: t.truncated(formatBytes(b.size)))),
          Expanded(
            child: FindableLines(
              initialQuery: _query,
              onQueryChanged: (v) => _query = v,
              padding: _pagePadding(context).copyWith(left: 4, top: 2),
              buildLines: (_) => <SearchLine>[for (final r in rows) SearchLine(<(String, TextStyle)>[(r.$2, style)])],
              // Line numbers on the left (only on a line's first piece).
              rowBuilder: (context, i, spans, _) => Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  SizedBox(
                      width: gutter,
                      child: Text(rows[i].$3 ? '${rows[i].$1}' : '', textAlign: TextAlign.right, style: numStyle)),
                  const SizedBox(width: 8),
                  Expanded(child: SelectableText.rich(spans)),
                ],
              ),
            ),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        header,
        Expanded(child: content),
      ],
    );
  }
}

/// [text] as code rows: (1-based line number, piece, first piece of the
/// line). Long lines (minified JSON) are cut into pieces of a few screen
/// lines, so a row is cheap to lay out and a found match is on screen.
List<(int, String, bool)> codeRows(String text, {int piece = 400}) {
  final out = <(int, String, bool)>[];
  final lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.length > 1 && lines.last.isEmpty) lines.removeLast();
  for (var n = 0; n < lines.length; n++) {
    final l = lines[n];
    if (l.length <= piece) {
      out.add((n + 1, l, true));
      continue;
    }
    for (var at = 0; at < l.length; at += piece) {
      out.add((n + 1, l.substring(at, at + piece > l.length ? l.length : at + piece), at == 0));
    }
  }
  return out;
}

/// Classic 16-byte hex dump (first 8 KB).
String hexDump(List<int> bytes, {int limit = 8192}) {
  final b = StringBuffer();
  final n = bytes.length < limit ? bytes.length : limit;
  for (var off = 0; off < n; off += 16) {
    b.write(off.toRadixString(16).padLeft(8, '0'));
    b.write('  ');
    final end = off + 16 < n ? off + 16 : n;
    for (var i = off; i < off + 16; i++) {
      b.write(i < end ? bytes[i].toRadixString(16).padLeft(2, '0') : '  ');
      b.write(i == off + 7 ? '  ' : ' ');
    }
    b.write(' ');
    for (var i = off; i < end; i++) {
      final ch = bytes[i];
      b.write(ch >= 0x20 && ch < 0x7f ? String.fromCharCode(ch) : '.');
    }
    b.writeln();
  }
  if (bytes.length > limit) b.write('…');
  return b.toString();
}

class _TimingTab extends StatelessWidget {
  const _TimingTab({required this.call});

  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final b = timingBreakdown(call);
    final total = b.total;
    Color phaseColor(String p) => switch (p) {
          'queue' => c.textSubtle.withValues(alpha: 0.55),
          'dns' => c.st3xx,
          'connect' => c.pickOrange,
          'tls' => c.pickViolet,
          'send' => c.pickYellow,
          'wait' => c.pickGreen,
          _ => c.pickBlue,
        };
    return ListView(
      padding: _pagePadding(context),
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(t.totalTime,
                  style: TextStyle(color: c.textMuted, fontSize: 12.5)),
            ),
            Text(total == null ? t.pending : formatDuration(call.duration),
                style: DurbunType.monoStyle(
                    size: 15, color: c.text, weight: FontWeight.w600)),
          ],
        ),
        const SizedBox(height: 12),
        if (b.known && total != null && total > 0)
          for (final s in b.spans)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                children: <Widget>[
                  Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                          color: phaseColor(s.phase),
                          borderRadius: BorderRadius.circular(2))),
                  const SizedBox(width: 6),
                  SizedBox(
                      width: 112,
                      child: Text(t.phase(s.phase),
                          style: TextStyle(fontSize: 12, color: c.textMuted))),
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, box) => Container(
                        height: 10,
                        decoration: BoxDecoration(
                            color: c.bgSunken,
                            borderRadius: BorderRadius.circular(2)),
                        child: Stack(
                          children: <Widget>[
                            Positioned(
                              left: box.maxWidth * (s.start / total),
                              width: (box.maxWidth * (s.ms / total))
                                  .clamp(2.0, box.maxWidth),
                              top: 0,
                              bottom: 0,
                              child: Container(
                                  decoration: BoxDecoration(
                                      color: phaseColor(s.phase),
                                      borderRadius: BorderRadius.circular(2))),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 58,
                    child: Text(
                        '${s.ms < 10 ? s.ms.toStringAsFixed(1) : s.ms.round()} ms',
                        textAlign: TextAlign.right,
                        style: DurbunType.monoStyle(size: 11.5, color: c.text)),
                  ),
                ],
              ),
            )
        else
          Callout(
            title: t.noPhasesTitle,
            body: call.state == InspectorCallState.pending
                ? t.noPhasesPending
                : t.noPhasesBody(call.source),
          ),
      ],
    );
  }
}
