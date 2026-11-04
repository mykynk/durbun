/// Network view of the in-app inspector: the desktop's request table,
/// toolbars and detail panel, laid out for a phone.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import 'body_search.dart';
import 'compare_view.dart';
import 'filter_ui.dart';
import 'format.dart';
import 'json_tree.dart';
import 'jwt.dart';
import 'live_list.dart';
import 'network_model.dart';
import 'replay.dart';
import 'share_sheet.dart';
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
    return ActiveListenableBuilder(
      listenable: widget.store,
      builder: (context) {
        final all = widget.store.calls;
        final shown = all.where(_matches).toList();
        final hosts = (<String>{for (final x in all) hostOf(x)}..remove('')).toList()..sort();
        final terms = freeTerms(_clauses);
        final filtered = _filters.activeCount > 0 || _clauses.isNotEmpty;
        return Column(
          children: <Widget>[
            Container(
              color: c.bgPanel,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
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
                  if (filtered) ...<Widget>[
                    const SizedBox(width: 10),
                    Text('${shown.length}/${all.length}',
                        style: DurbunType.monoStyle(size: 12, color: c.textMeta, weight: FontWeight.w600)),
                  ],
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
                          bodyQuery: _filters.searchBodies && terms.isNotEmpty ? terms.first : null,
                          siblings: () => widget.store.calls.where(_matches).toList()),
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
      this.bodyQuery,
      this.siblings});

  final InspectorCall call;
  final DurbunInspectorStore store;

  /// The list this row is in, as filtered now (the detail's up / down).
  final List<InspectorCall> Function()? siblings;

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
    final mono = DurbunType.monoStyle(size: 13, color: c.text, height: 1.35, weight: FontWeight.w500);
    final meta = DurbunType.monoStyle(size: 11, color: c.textMeta, height: 1.3);
    final edge = switch (cls) {
      '4xx' => c.st4xx,
      '5xx' || 'fail' => c.st5xx,
      _ => Colors.transparent,
    };
    return Material(
      color: tint ?? Colors.transparent,
      child: InkWell(
        onTap: () {
          FocusManager.instance.primaryFocus?.unfocus();
          if (onTap != null) return onTap!();
          Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (routeContext) => DurbunTheme.wrap(
                  routeContext,
                  CallDetailPage(
                      call: call, store: store, bodyQuery: bodyQuery, siblings: siblings))));
        },
        child: Container(
          padding: const EdgeInsets.fromLTRB(11, 9, 14, 9),
          decoration: BoxDecoration(
              border: Border(
                  left: BorderSide(color: edge, width: 3),
                  bottom: BorderSide(color: c.hairline))),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // Status over method: the path gets the width.
              SizedBox(
                width: 46,
                child: Column(
                  children: <Widget>[
                    StatusPill(text: statusText, color: statusColor, width: 46),
                    const SizedBox(height: 4),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(call.method,
                          maxLines: 1,
                          style: DurbunType.monoStyle(
                              size: 10.5,
                              color: c.method(call.method),
                              weight: FontWeight.w700,
                              height: 1.2)),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text.rich(
                      TextSpan(
                        children: <InlineSpan>[
                          highlightTerms(path, terms, mono, c.hlMark),
                          if (q.isNotEmpty)
                            highlightTerms(q, terms,
                                mono.copyWith(color: c.textSubtle, fontWeight: FontWeight.w400), c.hlMark),
                        ],
                      ),
                      // Two lines, so a match deep in a long path is seen.
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 4),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(
                          child: Wrap(
                            spacing: 6,
                            runSpacing: 4,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: <Widget>[
                              // One line: a host broken mid-word is hard to read.
                              Text.rich(highlightTerms(uri?.host ?? '', terms, meta, c.hlMark),
                                  maxLines: 1,
                                  softWrap: false,
                                  overflow: TextOverflow.ellipsis),
                              // dart:io is most requests: only the others are marked.
                              if (call.source != 'dart:io') _SourceBadge(call),
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
                        Text(size == null ? '' : formatBytes(size), style: meta),
                        const SizedBox(width: 8),
                        ConstrainedBox(
                          constraints: const BoxConstraints(minWidth: 48),
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
                                    ? FontWeight.w700
                                    : FontWeight.w500),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
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
      height: 17,
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(DurbunRadius.sm)),
      child: Text(call.source,
          style: DurbunType.monoStyle(size: 10, color: color, weight: FontWeight.w600, height: 1.55)),
    );
  }
}

/* ───────────────────────────── detail ───────────────────────────── */

/// What the detail page remembers for one store (one app run): the tab, the
/// part of Request / Response and the body view, so the next request opens
/// where the last one was read.
class _DetailMemory {
  int tab = 0;
  String requestPart = 'body';
  String responsePart = 'body';
  int bodyMode = 0;
}

final Expando<_DetailMemory> _memories = Expando<_DetailMemory>('durbun.detail');

_DetailMemory _memoryOf(DurbunInspectorStore store) => _memories[store] ??= _DetailMemory();

class CallDetailPage extends StatefulWidget {
  const CallDetailPage(
      {super.key, required this.call, required this.store, this.bodyQuery, this.siblings});

  final InspectorCall call;
  final DurbunInspectorStore store;

  /// Opens on the body that contains this text, with it found.
  final String? bodyQuery;

  /// The list the page was opened from, as filtered now: the arrows in the
  /// title bar move to the request above / below without going back.
  final List<InspectorCall> Function()? siblings;

  @override
  State<CallDetailPage> createState() => _CallDetailPageState();
}

class _CallDetailPageState extends State<CallDetailPage> {
  late InspectorCall _call = widget.call;
  late CallWatch _watch = CallWatch(widget.store, _call);
  late final _DetailMemory _memory = _memoryOf(widget.store);
  late final int _initialTab = _firstTab();
  late String? _bodyQuery = widget.bodyQuery;
  bool _replaying = false;

  /// The summary card is folded away while the user reads down a page.
  bool _folded = false;

  InspectorCall get call => _call;

  int _firstTab() {
    final q = widget.bodyQuery;
    if (q == null || q.isEmpty) return _memory.tab;
    bool has(InspectorBody? b) => b != null && b.isText && foldText(b.data).contains(q);
    if (has(widget.call.responseBody)) return 2;
    if (has(widget.call.requestBody)) return 1;
    return _memory.tab;
  }

  @override
  void dispose() {
    _watch.dispose();
    super.dispose();
  }

  (InspectorCall?, InspectorCall?) _neighbours() {
    final list = widget.siblings?.call();
    if (list == null) return (null, null);
    final i = list.indexWhere((x) => x.key == _call.key);
    if (i < 0) return (null, null);
    return (i > 0 ? list[i - 1] : null, i + 1 < list.length ? list[i + 1] : null);
  }

  void _show(InspectorCall next) {
    FocusManager.instance.primaryFocus?.unfocus();
    final old = _watch;
    setState(() {
      _call = next;
      _watch = CallWatch(widget.store, next);
      _bodyQuery = null;
      _replaying = false;
      _folded = false;
    });
    // The builder lets go of the old watch in this frame.
    WidgetsBinding.instance.addPostFrameCallback((_) => old.dispose());
  }

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

  void _compare() => Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (routeContext) => DurbunTheme.wrap(routeContext, ComparePickerPage(base: call, store: widget.store))));

  void _menu(String action) {
    if (action == 'replay') return unawaited(_replay());
    if (action == 'compare') return _compare();
    _copyAs(action);
  }

  void _copyAs(String format) {
    final t = InspectorStrings.of(context);
    final text = switch (format) {
      'url' => call.url,
      'all' => shareReportFor(context, call, widget.store),
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

  /// Folds the summary when a page is dragged down, opens it again when one
  /// is pulled at its top. Jumps (find) carry no drag and change nothing.
  bool _onScroll(ScrollNotification n) {
    if (n.metrics.axis != Axis.vertical) return false;
    if (n is ScrollUpdateNotification && n.dragDetails != null) {
      final d = n.scrollDelta ?? 0;
      if (d > 0 && n.metrics.pixels > 16 && !_folded) setState(() => _folded = true);
      if (d < 0 && n.metrics.pixels <= 0 && _folded) setState(() => _folded = false);
    } else if (n is OverscrollNotification && n.dragDetails != null && n.overscroll < 0 && _folded) {
      setState(() => _folded = false);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    // Only this call's changes rebuild the page: a store notification for an
    // unrelated log line rebuilt the bodies and ran the search again.
    return ListenableBuilder(
      listenable: _watch,
      builder: (context, _) {
        final failed = call.error != null && !call.cancelled;
        final reason = call.statusText?.isNotEmpty == true
            ? call.statusText!
            : (reasonPhrase(call.status) ?? '');
        final statusText = call.error != null
            ? (call.cancelled ? t.cancelledShort : 'FAIL')
            : (call.status?.toString() ?? '···');
        final statusColor = call.cancelled ? c.textSubtle : c.status(call.status, failed: failed);
        final statusWord = call.error != null
            ? (call.cancelled ? t.cancelled : t.shortError(shortErrorKey(call.error)))
            : call.status != null
                ? reason
                : t.pending;
        final (prev, next) = _neighbours();
        // The summary needs the height: not with the keyboard up, in
        // landscape or with very large text.
        final mq = MediaQuery.of(context);
        final roomy = mq.size.height >= 600 * mq.textScaler.scale(1).clamp(1.0, 3.0) && mq.viewInsets.bottom == 0;
        final summary = roomy && !_folded;
        final uri = call.uri;
        final pathLabel = decodeUrl(uri == null
            ? call.url
            : '${uri.path.isEmpty ? '/' : uri.path}${uri.hasQuery ? '?${uri.query}' : ''}');
        final k = call.key;
        // Narrow phones: Replay goes into the menu so the title keeps room.
        // Share stays in the bar; on phones Replay moves into the menu.
        final replayInMenu = canReplay && mq.size.width < 420;
        return Scaffold(
          backgroundColor: c.bgPanel,
          appBar: AppBar(
            titleSpacing: 0,
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                LayoutBuilder(
                  builder: (context, box) => Row(
                    children: <Widget>[
                      // At most 60 % of the title; shrinks rather than
                      // overflows on a narrow phone.
                      ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: box.maxWidth * 0.6),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Row(
                            children: <Widget>[
                              Text('${call.method} ',
                                  style: DurbunType.monoStyle(size: 14.5, color: c.method(call.method), weight: FontWeight.w700, height: 1.2)),
                              StatusPill(text: statusText, color: statusColor, width: null),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(statusWord,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: failed ? c.danger : c.text)),
                      ),
                    ],
                  ),
                ),
                // With the summary away, the path stays in sight here.
                if (!summary)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(pathLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DurbunType.monoStyle(size: 11, color: c.textMeta, height: 1.2)),
                  ),
              ],
            ),
            actions: <Widget>[
              if (widget.siblings != null) ...<Widget>[
                DIconButton(
                    icon: Icons.keyboard_arrow_up_rounded,
                    tooltip: t.prevRequest,
                    size: 36,
                    onTap: prev == null ? null : () => _show(prev)),
                DIconButton(
                    icon: Icons.keyboard_arrow_down_rounded,
                    tooltip: t.nextRequest,
                    size: 36,
                    onTap: next == null ? null : () => _show(next)),
              ],
              DIconButton(
                  icon: Theme.of(context).platform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded,
                  tooltip: t.share,
                  size: 36,
                  onTap: () => unawaited(showShareSheet(context, call, widget.store))),
              if (canReplay && !replayInMenu)
                _replaying
                    ? const SizedBox(
                        width: 36,
                        child: Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))))
                    : DIconButton(icon: Icons.replay_rounded, tooltip: t.replay, size: 36, onTap: _replay),
              PopupMenuButton<String>(
                tooltip: t.moreActions,
                icon: Icon(Icons.more_horiz_rounded, size: 22, color: c.textMuted),
                onSelected: _menu,
                itemBuilder: (_) => <PopupMenuEntry<String>>[
                  if (replayInMenu)
                    PopupMenuItem<String>(
                        value: 'replay',
                        enabled: !_replaying,
                        child: MenuRow(Icons.replay_rounded, _replaying ? t.replaying : t.replay)),
                  PopupMenuItem<String>(value: 'compare', child: MenuRow(Icons.compare_arrows_rounded, t.compareEllipsis)),
                  const PopupMenuDivider(),
                  PopupMenuItem<String>(value: 'url', child: MenuRow(Icons.link_rounded, t.copyUrl)),
                  for (final f in kCopyFormats)
                    PopupMenuItem<String>(value: f, child: MenuRow(Icons.code_rounded, '${t.copyAs}: ${t.copyAsFormat(f)}')),
                  const PopupMenuDivider(),
                  if (call.responseBody?.isText == true)
                    PopupMenuItem<String>(value: 'response', child: MenuRow(Icons.south_rounded, t.copyResponseBody)),
                  PopupMenuItem<String>(value: 'all', child: MenuRow(Icons.notes_rounded, t.copyReport)),
                ],
              ),
              const SizedBox(width: 4),
            ],
          ),
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              AnimatedSize(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOut,
                alignment: Alignment.topCenter,
                child: summary
                    ? _Summary(call: call, onCopyUrl: () => _copyAs('url'))
                    : const SizedBox(width: double.infinity),
              ),
              Expanded(
                child: NotificationListener<ScrollNotification>(
                  onNotification: _onScroll,
                  child: SwipeTabs(
                    initialIndex: _initialTab,
                    onChanged: (i) => _memory.tab = i,
                    tabs: <DTab>[
                      DTab(t.general),
                      DTab(t.request),
                      DTab(t.response, alert: failed),
                      DTab(t.timing),
                    ],
                    pages: <Widget>[
                      _GeneralTab(key: ValueKey<String>('g$k'), call: call, store: widget.store),
                      _HttpTab(key: ValueKey<String>('q$k'), call: call, request: true, memory: _memory, bodyQuery: _bodyQuery),
                      call.state == InspectorCallState.pending
                          ? EmptyState(icon: Icons.hourglass_empty, title: t.pending, body: t.waitingResponse)
                          : call.error != null
                              ? _ErrorTab(key: ValueKey<String>('e$k'), call: call)
                              : _HttpTab(key: ValueKey<String>('r$k'), call: call, request: false, memory: _memory, bodyQuery: _bodyQuery),
                      _TimingTab(key: ValueKey<String>('t$k'), call: call),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Host, path and the numbers of the request in one card over the tabs.
class _Summary extends StatelessWidget {
  const _Summary({required this.call, required this.onCopyUrl});

  final InspectorCall call;
  final VoidCallback onCopyUrl;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final uri = call.uri;
    final host = uri == null ? '' : '${uri.scheme}://${uri.host}${uri.hasPort && uri.port != 443 && uri.port != 80 ? ':${uri.port}' : ''}';
    final path = uri == null ? call.url : decodeUrl(uri.path.isEmpty ? '/' : uri.path);
    final query = uri != null && uri.hasQuery ? decodeUrl('?${uri.query}') : '';
    final ms = call.duration?.inMilliseconds ?? 0;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 10),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 9, 4, 10),
        decoration: BoxDecoration(
            color: c.cardBg,
            borderRadius: BorderRadius.circular(DurbunRadius.lg),
            border: Border.all(color: c.border)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      if (host.isNotEmpty)
                        Text(host,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DurbunType.monoStyle(size: 11.5, color: c.textMeta, height: 1.3)),
                      const SizedBox(height: 2),
                      // The whole URL is on General and in the menu.
                      Text.rich(
                        TextSpan(children: <InlineSpan>[
                          TextSpan(text: path),
                          if (query.isNotEmpty) TextSpan(text: query, style: TextStyle(color: c.textMuted, fontWeight: FontWeight.w400)),
                        ]),
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: DurbunType.monoStyle(size: 13.5, color: c.text, weight: FontWeight.w500, height: 1.35),
                      ),
                    ],
                  ),
                ),
                DIconButton(icon: Icons.copy_rounded, tooltip: t.copyUrl, size: 30, onTap: onCopyUrl),
              ],
            ),
            const SizedBox(height: 9),
            // One row that scrolls: wrapped chips pushed the tabs off short
            // screens.
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.only(right: 8),
              child: Row(
                spacing: 6,
                children: <Widget>[
                  if (call.state != InspectorCallState.pending)
                    _Stat(icon: Icons.timer_outlined, text: formatDuration(call.duration),
                        color: ms >= 3000 ? c.danger : ms >= kSlowMs ? c.warning : null),
                  if (call.responseBody != null)
                    _Stat(icon: Icons.south_rounded, text: formatBytes(call.responseBody!.size)),
                  if (call.requestBody != null && call.requestBody!.size > 0)
                    _Stat(icon: Icons.north_rounded, text: formatBytes(call.requestBody!.size)),
                  if (call.mocked)
                    _Stat(icon: Icons.theater_comedy_outlined, text: t.mock, color: c.badgeAccent),
                  _Stat(icon: Icons.hub_outlined, text: call.source),
                  _Stat(icon: Icons.schedule_rounded, text: formatClock(call.ts)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A number of the request (time, size, source) as a small chip.
class _Stat extends StatelessWidget {
  const _Stat({required this.icon, required this.text, this.color});

  final IconData icon;
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final fg = color ?? c.textMuted;
    return Container(
      height: 24,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
          color: c.trackBg, borderRadius: BorderRadius.circular(DurbunRadius.pill)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 13, color: fg),
          const SizedBox(width: 4),
          Flexible(
            child: Text(text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DurbunType.monoStyle(size: 11.5, color: color ?? c.text, weight: FontWeight.w500, height: 1.2)),
          ),
        ],
      ),
    );
  }
}

EdgeInsets _pagePadding(BuildContext context) =>
    EdgeInsets.fromLTRB(14, 12, 14, 20 + MediaQuery.paddingOf(context).bottom);

/// The row over a Request / Response part: the part switch on the left,
/// the body's view and copy on the right. One height for every part, so
/// nothing jumps when the part changes.
Widget _partsRow(Widget leading, [List<Widget> trailing = const <Widget>[]]) => Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 8, 4),
      child: SizedBox(
        height: 34,
        child: Row(
          children: <Widget>[
            Flexible(child: Align(alignment: Alignment.centerLeft, child: leading)),
            ...trailing,
          ],
        ),
      ),
    );

class _GeneralTab extends StatelessWidget {
  const _GeneralTab({super.key, required this.call, required this.store});

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
    // The full error is in the callout above; the row keeps the short kind.
    final status = call.error != null
        ? (call.cancelled ? t.cancelled : t.shortError(shortErrorKey(call.error)))
        : call.status == null
            ? t.pending
            : '${call.status} $reason';
    final started =
        DateTime.fromMicrosecondsSinceEpoch((call.ts * 1000).round());
    final gql = graphqlLabel(call);
    final ms = call.duration?.inMilliseconds ?? 0;
    final requestRows = <(String, String, Color?)>[
      ('URL', call.url, null),
      (t.method, call.method, c.method(call.method)),
      if (gql != null) ('GraphQL', gql, null),
      if (call.requestContentType != null) (t.contentType, call.requestContentType!, null),
      if (call.requestBody != null) (t.requestSize, formatBytes(call.requestBody!.size), null),
    ];
    final responseRows = <(String, String, Color?)>[
      (
        t.status,
        status,
        call.cancelled
            ? c.textMuted
            : c.status(call.status, failed: call.error != null)
      ),
      if (call.responseContentType != null) (t.contentType, call.responseContentType!, null),
      if (call.responseBody != null) (t.responseSize, formatBytes(call.responseBody!.size), null),
      if (call.protocol != null) (t.protocol, call.protocol!, null),
      if (call.remoteAddress != null) (t.remoteAddress, call.remoteAddress!, null),
      if (call.mocked) (t.mock, call.mockRuleId ?? '✓', c.badgeAccent),
    ];
    final timingRows = <(String, String, Color?)>[
      (
        t.started,
        '${started.year}-${_two(started.month)}-${_two(started.day)} ${formatClock(call.ts)}',
        null
      ),
      (
        t.duration,
        call.state == InspectorCallState.pending ? t.pending : formatDuration(call.duration),
        ms >= 3000 ? c.danger : ms >= kSlowMs ? c.warning : null
      ),
    ];
    final clientRows = <(String, String, Color?)>[
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
          deviceLabel(device),
          null
        ),
      ('ID', '${call.native ? 'native' : 'dart'}:${call.id}', null),
    ];
    // Plain text (a SelectableText takes horizontal drags and the tabs would
    // not swipe); rows copy on tap.
    return swipeSafeSelection(
      ListView(
        padding: _pagePadding(context).copyWith(top: 2),
        children: <Widget>[
          if (call.error != null && !call.cancelled) ...<Widget>[
            Callout(
                tone: CalloutTone.danger,
                title: t.shortError(shortErrorKey(call.error)),
                body: call.error),
            const SizedBox(height: 4),
          ],
          if (call.mocked) ...<Widget>[
            Callout(title: t.mockedTitle, body: t.mockedBody),
            const SizedBox(height: 4),
          ],
          if (call.bodiesDropped) ...<Widget>[
            Callout(tone: CalloutTone.warning, title: t.bodiesDropped),
            const SizedBox(height: 4),
          ],
          SectionTitle(t.request),
          KeyValueTable(rows: requestRows),
          SectionTitle(t.response),
          KeyValueTable(rows: responseRows),
          SectionTitle(t.timing),
          KeyValueTable(rows: timingRows),
          SectionTitle(t.client),
          KeyValueTable(rows: clientRows),
        ],
      ),
    );
  }

  static String _two(int v) => v.toString().padLeft(2, '0');
}

class _ErrorTab extends StatelessWidget {
  const _ErrorTab({super.key, required this.call});

  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final (type, message) = splitError(call.error);
    return ListView(
      padding: _pagePadding(context).copyWith(top: 2),
      children: <Widget>[
        Callout(
          tone: call.cancelled ? CalloutTone.info : CalloutTone.danger,
          title: call.cancelled
              ? t.cancelled
              : t.shortError(shortErrorKey(call.error)),
          body: t.noResponseBody,
        ),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
              color: c.cardBg,
              border: Border.all(color: c.border),
              borderRadius: BorderRadius.circular(DurbunRadius.lg)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (type != null) ...<Widget>[
                Text(type,
                    style: DurbunType.monoStyle(
                        size: 12.5, color: c.danger, weight: FontWeight.w600)),
                const SizedBox(height: 4),
              ],
              swipeSafeSelection(
                Text(message,
                    style: DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.4)),
              ),
            ],
          ),
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: () => copyText(context, call.error ?? ''),
            icon: Icon(Icons.copy_rounded, size: 15, color: c.textMuted),
            label: Text(t.copy, style: TextStyle(color: c.textMuted, fontSize: 12.5)),
          ),
        ),
      ],
    );
  }
}

/// Request or Response: Body, Headers, and Cookies / Query when there are
/// any. The part last read opens first.
class _HttpTab extends StatefulWidget {
  const _HttpTab({super.key, required this.call, required this.request, required this.memory, this.bodyQuery});

  final InspectorCall call;
  final bool request;
  final _DetailMemory memory;
  final String? bodyQuery;

  @override
  State<_HttpTab> createState() => _HttpTabState();
}

class _HttpTabState extends State<_HttpTab> {
  late String _part = widget.bodyQuery?.isNotEmpty == true
      ? 'body'
      : (widget.request ? widget.memory.requestPart : widget.memory.responsePart);

  void _set(String part) {
    setState(() => _part = part);
    if (widget.request) {
      widget.memory.requestPart = part;
    } else {
      widget.memory.responsePart = part;
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final call = widget.call;
    final headers = widget.request ? call.requestHeaders : call.responseHeaders;
    final cookies =
        widget.request ? requestCookies(headers) : responseCookies(headers);
    final query = <List<String>>[
      if (widget.request)
        for (final e in (call.uri?.queryParametersAll ?? const <String, List<String>>{}).entries)
          for (final v in e.value) <String>[e.key, v],
    ];
    final body = widget.request ? call.requestBody : call.responseBody;
    final parts = <(String, String, Object?)>[
      ('body', t.body, body == null || body.size == 0 ? null : formatBytes(body.size)),
      ('headers', t.headers, headers.length),
      if (cookies.isNotEmpty) ('cookies', t.cookies, cookies.length),
      if (query.isNotEmpty) ('query', t.query, query.length),
    ];
    final at = parts.indexWhere((p) => p.$1 == _part);
    final index = at < 0 ? 0 : at;
    final switcher = SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: DSegmented(
        labels: <String>[for (final p in parts) p.$2],
        counts: <Object?>[for (final p in parts) p.$3],
        index: index,
        onChanged: (i) => _set(parts[i].$1),
      ),
    );
    final part = parts[index].$1;
    if (part == 'body') {
      return BodyPane(
        leading: switcher,
        body: body,
        hasBody: widget.request ? call.hasRequestBody : call.hasResponseBody,
        contentType: widget.request ? call.requestContentType : call.responseContentType,
        dropped: call.bodiesDropped,
        initialQuery: widget.bodyQuery ?? '',
        initialMode: widget.memory.bodyMode,
        onModeChanged: (m) => widget.memory.bodyMode = m,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _partsRow(switcher),
        Expanded(
          child: switch (part) {
            'headers' => _PairsList(pairs: headers, empty: t.noHeaders),
            'cookies' => _PairsList(pairs: cookies, empty: t.noCookies),
            _ => _PairsList(pairs: query, empty: t.noQuery),
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

/// Name / value pairs (headers, cookies, query) in one card, the name over
/// its value. A tap offers copy, the full value and, for a token, its JWT.
class _PairsList extends StatelessWidget {
  const _PairsList({required this.pairs, required this.empty});

  final List<List<String>> pairs;
  final String empty;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    if (pairs.isEmpty) return EmptyState(icon: Icons.list_alt, title: empty);
    return ListView(
      padding: _pagePadding(context).copyWith(top: 2),
      children: <Widget>[
        Container(
          decoration: BoxDecoration(
              color: c.cardBg,
              border: Border.all(color: c.border),
              borderRadius: BorderRadius.circular(DurbunRadius.lg)),
          clipBehavior: Clip.antiAlias,
          child: Material(
            type: MaterialType.transparency,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                for (var i = 0; i < pairs.length; i++) ...<Widget>[
                  if (i > 0) Divider(height: 1, color: c.hairline),
                  _PairRow(name: pairs[i][0], value: pairs[i][1]),
                ],
              ],
            ),
          ),
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: () => copyText(
                context, pairs.map((p) => '${p[0]}: ${p[1]}').join('\n')),
            icon: Icon(Icons.copy_rounded, size: 15, color: c.textMuted),
            label: Text(t.copyAllShort,
                style: TextStyle(color: c.textMuted, fontSize: 12.5)),
          ),
        ),
      ],
    );
  }
}

class _PairRow extends StatefulWidget {
  const _PairRow({required this.name, required this.value});

  final String name;
  final String value;

  @override
  State<_PairRow> createState() => _PairRowState();
}

class _PairRowState extends State<_PairRow> {
  static const int _maxLines = 8;
  late final DecodedJwt? _jwt = decodeJwt(widget.value);
  Offset _tapAt = Offset.zero;

  bool get _long => widget.value.length > 480 || '\n'.allMatches(widget.value).length >= _maxLines;

  Future<void> _menu() async {
    final t = InspectorStrings.of(context);
    final choice = await showCopyMenu(context, _tapAt, <(String, IconData, String)>[
      if (_jwt != null) ('jwt', Icons.key_rounded, t.decodeJwt),
      ('value', Icons.copy_rounded, t.copyValue),
      ('line', Icons.notes_rounded, t.copyNameValue),
      if (_long) ('full', Icons.open_in_full_rounded, t.showFullValue),
    ]);
    if (!mounted) return;
    switch (choice) {
      case 'jwt':
        unawaited(showJwtSheet(context, _jwt!));
      case 'value':
        copyText(context, widget.value);
      case 'line':
        copyText(context, '${widget.name}: ${widget.value}');
      case 'full':
        unawaited(_showValue(context, widget.name, widget.value));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return InkWell(
      onTapDown: (d) => _tapAt = d.globalPosition,
      onTap: _menu,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Flexible(
                  child: Text(widget.name,
                      style: DurbunType.monoStyle(size: 11.5, color: c.jsonKey, weight: FontWeight.w600, height: 1.3)),
                ),
                if (_jwt != null) ...<Widget>[
                  const SizedBox(width: 6),
                  DBadge('JWT', tone: BadgeTone.accent),
                ],
              ],
            ),
            const SizedBox(height: 3),
            Text(widget.value,
                maxLines: _maxLines,
                overflow: TextOverflow.ellipsis,
                style: DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.4)),
          ],
        ),
      ),
    );
  }
}

/// A long header / cookie value on its own page (JSON values pretty).
Future<void> _showValue(BuildContext context, String name, String value) {
  var text = value;
  final s = value.trimLeft();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      text = const JsonEncoder.withIndent('  ').convert(jsonDecode(value));
    } catch (_) {}
  }
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: DurbunColors.of(context).bgPanel,
    builder: (routeContext) => DurbunTheme.wrap(
      routeContext,
      Builder(builder: (sheet) {
        final c = DurbunColors.of(sheet);
        final t = InspectorStrings.of(sheet);
        return ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(sheet).height * 0.85),
          child: ListView(
            shrinkWrap: true,
            padding: EdgeInsets.fromLTRB(16, 0, 16, 20 + MediaQuery.paddingOf(sheet).bottom),
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(name,
                        style: DurbunType.monoStyle(size: 14, color: c.jsonKey, weight: FontWeight.w700)),
                  ),
                  TextButton.icon(
                    onPressed: () => copyText(sheet, value),
                    icon: Icon(Icons.copy_rounded, size: 15, color: c.textMuted),
                    label: Text(t.copy, style: TextStyle(color: c.textMuted, fontSize: 12.5)),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              SelectableText(text, style: DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.45)),
            ],
          ),
        );
      }),
    ),
  );
}

/// A body with Preview (JSON tree, image, form), Code and Hex views; the
/// view is picked from a menu next to the part switch ([leading]).
class BodyPane extends StatefulWidget {
  const BodyPane(
      {super.key,
      required this.body,
      required this.hasBody,
      this.contentType,
      this.dropped = false,
      this.initialQuery = '',
      this.leading,
      this.initialMode = 0,
      this.onModeChanged});

  final InspectorBody? body;
  final bool hasBody;
  final String? contentType;
  final bool dropped;

  /// Find text to open with (the list's body search).
  final String initialQuery;

  /// Drawn at the left of the view row (the Request / Response part switch).
  final Widget? leading;

  /// 0 Preview, 1 Code, 2 Hex.
  final int initialMode;
  final ValueChanged<int>? onModeChanged;

  @override
  State<BodyPane> createState() => _BodyPaneState();
}

class _BodyPaneState extends State<BodyPane> {
  late int _mode = widget.initialMode;
  Object? _json;
  bool _jsonParsed = false;

  /// Kept across Preview and Code.
  late String _query = widget.initialQuery;

  String? _codeText;
  List<SearchLine> _codeLines = const <SearchLine>[];

  /// The code view's lines, built once per text (not on every rebuild).
  List<SearchLine> _codeLinesFor(String text, TextStyle style) {
    if (!identical(text, _codeText) && text != _codeText) {
      _codeText = text;
      final raw = text.replaceAll('\r\n', '\n').split('\n');
      if (raw.length > 1 && raw.last.isEmpty) raw.removeLast();
      _codeLines = <SearchLine>[for (final l in raw) SearchLine(<(String, TextStyle)>[(l, style)])];
    }
    return _codeLines;
  }

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
    final leading = widget.leading ?? const SizedBox.shrink();
    final b = widget.body;
    if (b == null || b.data.isEmpty) {
      final Widget empty;
      if (b == null) {
        empty = EmptyState(
          icon: Icons.inbox_outlined,
          title: widget.dropped
              ? t.bodiesDropped
              : (widget.hasBody ? t.bodyNotCaptured : t.noBody),
          body: widget.dropped || widget.hasBody ? null : t.noBodyHint,
        );
      } else {
        empty = EmptyState(
            icon: Icons.inbox_outlined,
            title: b.size > 0 ? t.bodyNotCaptured : t.noBody,
            body: b.size > 0 ? t.bodyNotCapturedHint : null);
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[_partsRow(leading), Expanded(child: empty)],
      );
    }
    final kind = bodyKindLabel(widget.contentType, b);
    final json = _parsedJson(b);
    final isImage =
        (widget.contentType ?? '').toLowerCase().startsWith('image/') &&
            !b.isText;
    final modes = <(String, IconData)>[
      (t.preview, json != null ? Icons.account_tree_outlined : (isImage ? Icons.image_outlined : Icons.visibility_outlined)),
      (t.code, Icons.code_rounded),
      if (!b.isText || isImage) (t.hex, Icons.memory_rounded),
    ];
    final mode = _mode.clamp(0, modes.length - 1);
    final meta = <String>[
      kind,
      formatBytes(b.size),
      if (widget.contentType != null) widget.contentType!.split(';').first,
    ].join(' · ');
    final viewMenu = PopupMenuButton<int>(
      tooltip: t.view,
      onSelected: (i) {
        setState(() => _mode = i);
        widget.onModeChanged?.call(i);
      },
      itemBuilder: (_) => <PopupMenuEntry<int>>[
        PopupMenuItem<int>(
          enabled: false,
          height: 32,
          child: Text(meta, style: DurbunType.monoStyle(size: 11.5, color: c.textMeta)),
        ),
        const PopupMenuDivider(),
        for (var i = 0; i < modes.length; i++)
          PopupMenuItem<int>(
            value: i,
            child: Row(
              children: <Widget>[
                Icon(modes[i].$2, size: 17, color: i == mode ? c.badgeAccent : c.textMuted),
                const SizedBox(width: 10),
                Expanded(
                    child: Text(modes[i].$1,
                        style: TextStyle(fontSize: 14, color: c.text, fontWeight: i == mode ? FontWeight.w600 : FontWeight.w400))),
                if (i == mode) Icon(Icons.check_rounded, size: 17, color: c.badgeAccent),
              ],
            ),
          ),
      ],
      child: Container(
        height: 30,
        padding: const EdgeInsets.only(left: 9, right: 6),
        decoration: ShapeDecoration(color: c.cardBg, shape: StadiumBorder(side: BorderSide(color: c.border))),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(modes[mode].$2, size: 15, color: c.text),
            const SizedBox(width: 5),
            Text(modes[mode].$1, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.text, height: 1.2)),
            Icon(Icons.expand_more_rounded, size: 16, color: c.textMuted),
          ],
        ),
      ),
    );
    final header = _partsRow(leading, <Widget>[
      const SizedBox(width: 6),
      viewMenu,
      if (b.isText)
        DIconButton(
            icon: Icons.copy_rounded,
            tooltip: t.copy,
            size: 32,
            onTap: () => copyText(context, b.displayText ?? b.data)),
    ]);
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
          swipeSafeSelection(
            Text(hexDump(b.bytes),
                style: DurbunType.monoStyle(size: 11.5, color: c.textMuted)),
          )
        ],
      );
    } else {
      var text = mode == 1 ? (b.displayText ?? b.data) : b.data;
      final cut = text.length > _maxShownChars;
      if (cut) text = text.substring(0, _maxShownChars);
      final style = DurbunType.monoStyle(size: 12.5, color: c.text, height: 1.3);
      final lines = _codeLinesFor(text, style);
      final numStyle = DurbunType.monoStyle(size: 10.5, color: c.textSubtle, height: 1.3);
      final gutter = 8.0 + 7.0 * '${lines.isEmpty ? 1 : lines.length}'.length;
      content = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (cut || b.truncated)
            Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
                child: Callout(tone: CalloutTone.warning, title: t.truncated(formatBytes(b.size)))),
          Expanded(
            child: FindableLines(
              linesKey: identityHashCode(lines),
              initialQuery: _query,
              onQueryChanged: (v) => _query = v,
              padding: _pagePadding(context).copyWith(left: 4, top: 2),
              textStyle: style,
              prefixWidth: gutter + 8,
              buildLines: (_) => lines,
              // Line numbers on the left, on a line's first row only.
              rowBuilder: (context, i, first, spans) => Row(
                children: <Widget>[
                  SizedBox(width: gutter, child: Text(first ? '${i + 1}' : '', textAlign: TextAlign.right, style: numStyle)),
                  const SizedBox(width: 8),
                  Expanded(child: Text.rich(spans, maxLines: 1, softWrap: false, overflow: TextOverflow.clip)),
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
  const _TimingTab({super.key, required this.call});

  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final b = timingBreakdown(call);
    final total = b.total;
    final ms = call.duration?.inMilliseconds ?? 0;
    Color phaseColor(String p) => switch (p) {
          'queue' => c.textSubtle.withValues(alpha: 0.55),
          'dns' => c.st3xx,
          'connect' => c.pickOrange,
          'tls' => c.pickViolet,
          'send' => c.pickYellow,
          'wait' => c.pickGreen,
          _ => c.pickBlue,
        };
    final phases = b.known && total != null && total > 0;
    return ListView(
      padding: _pagePadding(context).copyWith(top: 2),
      children: <Widget>[
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          decoration: BoxDecoration(
              color: c.cardBg,
              border: Border.all(color: c.border),
              borderRadius: BorderRadius.circular(DurbunRadius.lg)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(t.totalTime, style: TextStyle(color: c.textMeta, fontSize: 12, fontWeight: FontWeight.w500)),
              const SizedBox(height: 2),
              Text(total == null ? t.pending : formatDuration(call.duration),
                  style: DurbunType.monoStyle(
                      size: 24,
                      color: ms >= 3000 ? c.danger : ms >= kSlowMs ? c.warning : c.text,
                      weight: FontWeight.w700,
                      height: 1.2)),
              if (phases) ...<Widget>[
                const SizedBox(height: 12),
                // Every phase in one bar, in order.
                ClipRRect(
                  borderRadius: BorderRadius.circular(DurbunRadius.sm),
                  child: SizedBox(
                    height: 10,
                    child: Row(
                      children: <Widget>[
                        for (final s in b.spans)
                          Expanded(
                            flex: (s.ms / total * 1000).round().clamp(1, 1000),
                            child: Container(color: phaseColor(s.phase)),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 10),
        if (phases)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(
                color: c.cardBg,
                border: Border.all(color: c.border),
                borderRadius: BorderRadius.circular(DurbunRadius.lg)),
            child: Column(
              children: <Widget>[
                // Label and time on one line, the waterfall under them at
                // full width: long (TR) labels and large text never squeeze it.
                for (final s in b.spans)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            Container(
                                width: 8,
                                height: 8,
                                decoration: BoxDecoration(
                                    color: phaseColor(s.phase),
                                    borderRadius: BorderRadius.circular(2))),
                            const SizedBox(width: 8),
                            Expanded(
                                child: Text(t.phase(s.phase),
                                    style: TextStyle(fontSize: 12.5, color: c.text))),
                            const SizedBox(width: 8),
                            Text(
                                s.ms < 0.1 ? '<0.1 ms' : '${s.ms < 10 ? s.ms.toStringAsFixed(1) : s.ms.round()} ms',
                                style: DurbunType.monoStyle(size: 11.5, color: c.text)),
                          ],
                        ),
                        const SizedBox(height: 5),
                        LayoutBuilder(
                          builder: (context, box) {
                            final width = (box.maxWidth * (s.ms / total)).clamp(3.0, box.maxWidth);
                            return Container(
                              height: 6,
                              decoration: BoxDecoration(
                                  color: c.trackBg,
                                  borderRadius: BorderRadius.circular(3)),
                              child: Stack(
                                children: <Widget>[
                                  Positioned(
                                    left: (box.maxWidth * (s.start / total)).clamp(0.0, box.maxWidth - width),
                                    width: width,
                                    top: 0,
                                    bottom: 0,
                                    child: Container(
                                        decoration: BoxDecoration(
                                            color: phaseColor(s.phase),
                                            borderRadius: BorderRadius.circular(3))),
                                  ),
                                ],
                              ),
                            );
                          },
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          )
        else
          Callout(
            title: t.noPhasesTitle,
            body: switch (call.state) {
              InspectorCallState.pending => t.noPhasesPending,
              InspectorCallState.failed => t.noPhasesFailed,
              InspectorCallState.done => t.noPhasesBody(call.source),
            },
          ),
      ],
    );
  }
}
