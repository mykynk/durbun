/// Statistics page (Tools → Statistics): Summary (the total with a bar split
/// by outcome, tiles, pending, methods as bars), Duration,
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
    final note = DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.4);
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
          if (scope != null) Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 0), child: scope),
          Expanded(child: EmptyState(title: t.noRequestsTitle, body: t.noRequestsBody)),
        ],
      );
    }
    final pad = EdgeInsets.fromLTRB(16, 4, 16, 16 + MediaQuery.paddingOf(context).bottom);
    // The scope and the live note hold for every tab: above the tabs.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (scope != null) ...<Widget>[scope, const SizedBox(height: 10)],
              Row(
                children: <Widget>[
                  Container(width: 7, height: 7, decoration: BoxDecoration(color: c.success, shape: BoxShape.circle)),
                  const SizedBox(width: 8),
                  Expanded(child: Text(t.statsLive, style: note)),
                ],
              ),
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
                  _TotalCard(stats: s),
                  const SizedBox(height: 12),
                  _Tiles(children: <Widget Function(double)>[
                    (w) => StatTile(width: w, label: t.statsSuccess, value: '${s.success}', color: s.success > 0 ? c.success : null),
                    (w) => StatTile(width: w, label: t.statsClientErrors, value: '${s.clientErrors}', color: s.clientErrors > 0 ? c.st4xx : null),
                    (w) => StatTile(width: w, label: t.statsServerErrors, value: '${s.serverErrors}', color: s.serverErrors > 0 ? c.st5xx : null),
                    (w) => StatTile(
                        width: w,
                        label: t.statsFailed,
                        value: '${s.failed}',
                        sub: s.timeouts > 0 ? t.statsTimeouts(s.timeouts) : null,
                        subBelow: true,
                        color: s.failed > 0 ? c.danger : null),
                  ]),
                  const SizedBox(height: 12),
                  // Still open: a row of its own, not a figure to compare.
                  _Card(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                    child: Row(
                      children: <Widget>[
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(t.statsPending, style: DurbunType.ui(size: DurbunType.bodyMd, color: c.textMuted, weight: FontWeight.w500)),
                              if (s.cancelled > 0)
                                Text(t.statsCancelled(s.cancelled), style: DurbunType.ui(size: DurbunType.sm, color: c.textSubtle)),
                            ],
                          ),
                        ),
                        Text('${s.pending}', style: DurbunType.figureStyle(size: 22, color: c.text)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  _Card(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(t.statsMethods, style: DurbunType.heading(size: DurbunType.label, color: c.text)),
                        const SizedBox(height: 6),
                        for (final (method, n) in s.methods)
                          _BarRow(
                            label: method,
                            labelColor: c.method(method),
                            fraction: s.methods.first.$2 == 0 ? 0 : n / s.methods.first.$2,
                            value: '$n',
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              ListView(
                padding: pad,
                children: <Widget>[
                  StatTile(width: double.infinity, lead: true, label: t.statsMedian, value: ms(s.p50Ms)),
                  const SizedBox(height: 12),
                  _Tiles(children: <Widget Function(double)>[
                    (w) => StatTile(width: w, label: t.statsAverage, value: ms(s.averageMs)),
                    (w) => StatTile(width: w, label: t.statsP95, value: ms(s.p95Ms), color: (s.p95Ms ?? 0) >= 1000 ? c.warning : null),
                    (w) => StatTile(width: w, label: t.statsLongest, value: ms(s.maxMs), color: (s.maxMs ?? 0) >= 3000 ? c.danger : null),
                  ]),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
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
                    padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
                    child: Text(t.statsBytesHint, style: note),
                  ),
                ],
              ),
              ListView(
                padding: pad,
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
                    child: Text(t.statsTopHosts(s.hosts.length), style: note),
                  ),
                  _Card(
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
                      padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
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
        final w = (box.maxWidth - 12 * (columns - 1)) / columns;
        // An odd last tile takes the whole row instead of leaving a hole.
        final odd = children.length % columns == 1 && children.length > 1;
        return Wrap(spacing: 12, runSpacing: 12, children: <Widget>[
          for (var i = 0; i < children.length; i++) children[i](odd && i == children.length - 1 ? box.maxWidth : w),
        ]);
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
    final meta = DurbunType.monoStyle(size: 11.5, color: c.textSubtle, height: 1.3);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
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
          const SizedBox(height: 8),
          _Bar(fraction: max == 0 ? 0 : host.requests / max, color: host.failures > 0 ? c.st4xx : c.accent),
          const SizedBox(height: 6),
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

/// A card of the page.
class _Card extends StatelessWidget {
  const _Card({required this.child, this.padding = EdgeInsets.zero});

  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      padding: padding,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: child,
    );
  }
}

/// A rounded bar on a track.
class _Bar extends StatelessWidget {
  const _Bar({required this.fraction, required this.color});

  static const double height = 6;

  final double fraction;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      height: height,
      decoration: BoxDecoration(color: c.bgActive, borderRadius: BorderRadius.circular(height)),
      alignment: AlignmentDirectional.centerStart,
      child: FractionallySizedBox(
        widthFactor: fraction <= 0 ? 0 : fraction.clamp(0.04, 1.0),
        child: Container(decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(height))),
      ),
    );
  }
}

/// A label, a bar of its share and the count (the methods).
class _BarRow extends StatelessWidget {
  const _BarRow({required this.label, required this.labelColor, required this.fraction, required this.value});

  final String label;
  final Color labelColor;
  final double fraction;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final mono = DurbunType.monoStyle(size: DurbunType.monoMd, color: labelColor, weight: FontWeight.w600, height: 1.3);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: <Widget>[
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 64),
            child: Text(label, style: mono),
          ),
          const SizedBox(width: 12),
          Expanded(child: _Bar(fraction: fraction, color: labelColor)),
          const SizedBox(width: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 24),
            child: Text(value, textAlign: TextAlign.end, style: DurbunType.monoStyle(size: DurbunType.monoMd, color: c.text, height: 1.3)),
          ),
        ],
      ),
    );
  }
}

/// All requests: the total, the share that succeeded, and one bar split by
/// outcome (success, 4xx, 5xx with transport errors, still open).
class _TotalCard extends StatelessWidget {
  const _TotalCard({required this.stats});

  final NetworkStats stats;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final s = stats;
    final finished = s.requests - s.pending;
    final parts = <(int, Color)>[
      (s.success, c.success),
      (s.clientErrors, c.st4xx),
      // 5xx and transport errors share the red: both are failures.
      (s.serverErrors + s.failed, c.danger),
      (s.requests - s.success - s.clientErrors - s.serverErrors - s.failed, c.stPending),
    ].where((p) => p.$1 > 0).toList();
    return _Card(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(t.requests, style: DurbunType.ui(size: DurbunType.body, color: c.textMuted, weight: FontWeight.w500)),
                    const SizedBox(height: 2),
                    Text('${s.requests}', style: DurbunType.figureStyle(size: 36, color: c.text).copyWith(height: 1.1)),
                  ],
                ),
              ),
              if (finished > 0)
                Flexible(
                  child: Align(
                    alignment: AlignmentDirectional.topEnd,
                    child: DBadge(
                    t.statsSuccessRate((s.success * 100 / finished).round()),
                    tone: s.success * 10 >= finished * 9
                        ? BadgeTone.success
                        : (s.success * 2 >= finished ? BadgeTone.warning : BadgeTone.danger),
                    mono: true,
                  ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 14),
          SizedBox(
            height: 8,
            child: Row(
              children: <Widget>[
                for (var i = 0; i < parts.length; i++) ...<Widget>[
                  if (i > 0) const SizedBox(width: 3),
                  Expanded(
                    flex: parts[i].$1,
                    child: Container(decoration: BoxDecoration(color: parts[i].$2, borderRadius: BorderRadius.circular(4))),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
