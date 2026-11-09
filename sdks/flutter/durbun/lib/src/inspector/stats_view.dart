/// Statistics page (tools → Statistics): Summary (totals, methods), Duration,
/// Data (bytes) and Hosts (the busiest ones) tabs over the captured requests.
/// It follows the store, but computes again at most once a second (requests
/// can arrive by the hundred).
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'format.dart';
import 'network_view.dart' show NetworkListing, networkListing;
import 'perf_view.dart' show StatTile;
import 'stats.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// The tab last shown with a store (one app run): the page opens there again.
final Expando<int> _lastTab = Expando<int>('durbun.statsTab');

class StatsView extends StatefulWidget {
  const StatsView({super.key, required this.store, this.interval = const Duration(seconds: 1)});

  final DurbunInspectorStore store;

  /// Shortest time between two computations.
  final Duration interval;

  @override
  State<StatsView> createState() => _StatsViewState();
}

class _StatsViewState extends State<StatsView> {
  late NetworkListing _listing;
  late NetworkStats _stats;

  /// Every request kept, or only the ones the Network list shows.
  bool _all = false;
  Timer? _timer;
  final Stopwatch _since = Stopwatch();

  @override
  void initState() {
    super.initState();
    _compute();
    widget.store.addListener(_changed);
  }

  @override
  void dispose() {
    widget.store.removeListener(_changed);
    _timer?.cancel();
    super.dispose();
  }

  void _compute() {
    _listing = networkListing(widget.store);
    _stats = computeNetworkStats(_all ? widget.store.calls : _listing.calls);
    _since
      ..reset()
      ..start();
  }

  /// At most once per [StatsView.interval]: the first change after a quiet
  /// spell shows at once, a burst waits for the rest of the interval.
  void _changed() {
    if (_timer != null) return;
    final wait = widget.interval - _since.elapsed;
    _timer = Timer(wait.isNegative ? Duration.zero : wait, () {
      _timer = null;
      if (mounted) setState(_compute);
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final s = _stats;
    String ms(double? v) => v == null ? '—' : formatDuration(Duration(microseconds: (v * 1000).round()));
    final note = TextStyle(fontSize: 11.5, color: c.textMeta);
    final scope = _listing.narrowed
        ? ChoiceSegments(
            labels: <String>[t.exportListed, t.exportAll],
            counts: <Object?>[_listing.calls.length, widget.store.calls.length],
            index: _all ? 1 : 0,
            onChanged: (i) => setState(() {
              _all = i == 1;
              _compute();
            }),
          )
        : null;
    if (s.requests == 0) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (scope != null) Padding(padding: const EdgeInsets.fromLTRB(12, 12, 12, 0), child: scope),
          Expanded(child: EmptyState(icon: Icons.bar_chart_rounded, title: t.noRequestsTitle, body: t.noRequestsBody)),
        ],
      );
    }
    final pad = EdgeInsets.fromLTRB(12, 4, 12, 20 + MediaQuery.paddingOf(context).bottom);
    // The scope and the live note hold for every tab: above the tabs.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (scope != null) ...<Widget>[scope, const SizedBox(height: 10)],
              Text(t.statsLive, style: note),
            ],
          ),
        ),
        Expanded(
          child: SwipeTabs(
            initialIndex: _lastTab[widget.store] ?? 0,
            onChanged: (i) => _lastTab[widget.store] = i,
            tabs: <DTab>[
              DTab(t.statsSummary),
              DTab(t.duration),
              DTab(t.data),
              DTab(t.hostsTitle, count: s.hosts.length + s.otherHosts),
            ],
            pages: <Widget>[
              ListView(
                padding: pad,
                children: <Widget>[
                  _Tiles(children: <Widget Function(double)>[
                    (w) => StatTile(width: w, label: t.requests, value: '${s.requests}'),
                    (w) => StatTile(width: w, label: t.statsSuccess, value: '${s.success}'),
                    (w) => StatTile(width: w, label: t.statsClientErrors, value: '${s.clientErrors}', color: s.clientErrors > 0 ? c.st4xx : null),
                    (w) => StatTile(width: w, label: t.statsServerErrors, value: '${s.serverErrors}', color: s.serverErrors > 0 ? c.st5xx : null),
                    (w) => StatTile(
                        width: w,
                        label: t.statsFailed,
                        value: '${s.failed}',
                        sub: s.timeouts > 0 ? t.statsTimeouts(s.timeouts) : null,
                        color: s.failed > 0 ? c.danger : null),
                    (w) => StatTile(
                        width: w,
                        label: t.statsPending,
                        value: '${s.pending}',
                        sub: s.cancelled > 0 ? t.statsCancelled(s.cancelled) : null),
                  ]),
                  SectionTitle(t.statsMethods),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: <Widget>[
                      for (final (method, n) in s.methods)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                          decoration: BoxDecoration(
                              color: c.bgPanel,
                              borderRadius: BorderRadius.circular(DurbunRadius.md),
                              border: Border.all(color: c.border)),
                          child: Text.rich(TextSpan(children: <InlineSpan>[
                            TextSpan(
                                text: method,
                                style: DurbunType.monoStyle(size: 12, color: c.method(method), weight: FontWeight.w600, height: 1.2)),
                            TextSpan(text: '  $n', style: DurbunType.monoStyle(size: 12, color: c.text, height: 1.2)),
                          ])),
                        ),
                    ],
                  ),
                ],
              ),
              ListView(
                padding: pad,
                children: <Widget>[
                  _Tiles(children: <Widget Function(double)>[
                    (w) => StatTile(width: w, label: t.statsAverage, value: ms(s.averageMs)),
                    (w) => StatTile(width: w, label: t.statsMedian, value: ms(s.p50Ms)),
                    (w) => StatTile(width: w, label: t.statsP95, value: ms(s.p95Ms), color: (s.p95Ms ?? 0) >= 1000 ? c.warning : null),
                    (w) => StatTile(width: w, label: t.statsLongest, value: ms(s.maxMs), color: (s.maxMs ?? 0) >= 3000 ? c.danger : null),
                  ]),
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(t.statsOverResponses(s.timed), style: note),
                  ),
                ],
              ),
              ListView(
                padding: pad,
                children: <Widget>[
                  _Tiles(children: <Widget Function(double)>[
                    (w) => StatTile(width: w, label: t.statsSent, value: formatBytes(s.bytesSent)),
                    (w) => StatTile(width: w, label: t.statsReceived, value: formatBytes(s.bytesReceived)),
                  ]),
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(t.statsBytesHint, style: note),
                  ),
                ],
              ),
              ListView(
                padding: pad,
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(t.statsTopHosts(s.hosts.length), style: note),
                  ),
                  Container(
                    decoration: BoxDecoration(
                        color: c.bgPanel, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
                    clipBehavior: Clip.antiAlias,
                    child: Column(
                      children: <Widget>[
                        for (var i = 0; i < s.hosts.length; i++) ...<Widget>[
                          if (i > 0) Divider(height: 1, color: c.hairline),
                          _HostRow(host: s.hosts[i], max: s.hosts.first.requests),
                        ],
                      ],
                    ),
                  ),
                  if (s.otherHosts > 0)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(t.statsMoreHosts(s.otherHosts), style: note),
                    ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Tiles two to a row (three on a wide screen).
class _Tiles extends StatelessWidget {
  const _Tiles({required this.children});

  final List<Widget Function(double width)> children;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, box) {
        final columns = box.maxWidth >= 600 ? 3 : 2;
        final w = (box.maxWidth - 8 * (columns - 1)) / columns;
        return Wrap(spacing: 8, runSpacing: 8, children: <Widget>[for (final b in children) b(w)]);
      });
}

/// One host: its name, a bar of its share, requests, failures, average
/// time and bytes received.
class _HostRow extends StatelessWidget {
  const _HostRow({required this.host, required this.max});

  final HostStats host;
  final int max;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final avg = host.averageMs;
    final meta = DurbunType.monoStyle(size: 11, color: c.textMeta, height: 1.3);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(host.host.isEmpty ? '—' : host.host,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DurbunType.monoStyle(size: 12.5, color: c.text, weight: FontWeight.w500, height: 1.3)),
              ),
              const SizedBox(width: 8),
              Text('${host.requests}', style: DurbunType.monoStyle(size: 12.5, color: c.text, weight: FontWeight.w600, height: 1.3)),
            ],
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: LinearProgressIndicator(
              value: max == 0 ? 0 : host.requests / max,
              minHeight: 3,
              backgroundColor: c.trackBg,
              color: host.failures > 0 ? c.st4xx : c.accent,
            ),
          ),
          const SizedBox(height: 4),
          Wrap(
            spacing: 10,
            children: <Widget>[
              if (host.failures > 0)
                Text(t.statsFailures(host.failures), style: meta.copyWith(color: c.danger, fontWeight: FontWeight.w600)),
              if (avg != null) Text(t.avg(formatDuration(Duration(microseconds: (avg * 1000).round()))), style: meta),
              Text(formatBytes(host.bytesReceived), style: meta),
            ],
          ),
        ],
      ),
    );
  }
}
