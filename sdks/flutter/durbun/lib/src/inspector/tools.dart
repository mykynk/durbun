/// The Tools page of the panel: the app and its desktop connection; tiles
/// for Statistics, Mac connection, App tools and Device & SDK (each a page
/// of its own); Mocks (while connected), Export session and Previous run
/// (with `keepPreviousRun`); and Clear in a red card.
library;

import 'package:flutter/material.dart';

import '../flutter/durbun.dart' show Durbun, durbunBackend, durbunInspectorState;
import 'actions_view.dart';
import 'connection_view.dart';
import 'export_sheet.dart';
import 'info_view.dart';
import 'previous_run_view.dart';
import 'run_log.dart';
import 'stats_view.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import '../core/protocol.dart' show kSdkVersion;
import 'stats.dart' show computeNetworkStats;
import 'widgets.dart' show BadgeTone, CardTone, ListRow, Pressable;

/// A page opened from Tools (Mocks, Statistics, Device & SDK).
class ToolPage extends StatelessWidget {
  const ToolPage({super.key, required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Scaffold(
      backgroundColor: c.bgApp,
      appBar: AppBar(title: Text(title)),
      body: child,
    );
  }
}

class ToolsView extends StatelessWidget {
  const ToolsView({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    void open(String title, Widget page) {
      Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (routeContext) => DurbunTheme.wrap(routeContext, ToolPage(title: title, child: page)),
      ));
    }

    final journal = RunJournal.of(store);
    final backend = durbunBackend();
    return StreamBuilder<Object?>(
      stream: Durbun.connection,
      builder: (context, _) => ListenableBuilder(
        listenable: Listenable.merge(<Listenable>[store, backend.changes, if (journal != null) journal.previous]),
        builder: (context, _) {
          final report = backend.connectionReport;
          final tools = backend.actions.length;
          final previous = journal?.previous.value;
          final state = durbunInspectorState();
          final hello = (state?['hello'] as Map?) ?? store.hello;
          final app = hello?['app'] as Map?;
          final device = hello?['device'] as Map?;
          final connected = Durbun.isConnected;
          final via = state?['via'] as String?;
          final rules = state?['mocks'] is List ? (state!['mocks'] as List).length : 0;
          final platform = switch ('${device?['platform'] ?? ''}') {
            'ios' => 'iOS',
            'android' => 'Android',
            final p => p,
          };
          final os = <String>[if (platform.isNotEmpty) platform, if (device?['osVersion'] != null) '${device!['osVersion']}'].join(' ');
          final stats = computeNetworkStats(store.calls, topHosts: 0);
          final finished = stats.requests - stats.pending;
          final version = app?['version'] == null ? null : '${app!['version']}${app['build'] != null ? ' (${app['build']})' : ''}';
          final tiles = <Widget>[
            _ToolTile(
              icon: Icons.bar_chart_rounded,
              tone: BadgeTone.info,
              label: t.statistics,
              value: <String>[
                t.requestCount(store.calls.length),
                if (finished > 0) t.statsSuccessRate((stats.success * 100 / finished).round()),
              ].join(' · '),
              onTap: () => open(t.statistics, StatsView(store: store)),
            ),
            _ToolTile(
              icon: Icons.link_rounded,
              tone: BadgeTone.accent,
              label: t.macConnection,
              value: connectionShortText(t, report),
              onTap: () => open(t.macConnection, ConnectionView(store: store)),
            ),
            _ToolTile(
              icon: Icons.tune_rounded,
              tone: BadgeTone.warning,
              label: t.appTools,
              value: tools == 0 ? t.appToolsHint : t.toolCount(tools),
              onTap: () => open(t.appTools, const AppToolsView()),
            ),
            _ToolTile(
              icon: Icons.smartphone_rounded,
              tone: BadgeTone.success,
              label: t.deviceAndSdk,
              value: <String>[if (os.isNotEmpty) os, '${t.title} $kSdkVersion'].join(' · '),
              onTap: () => open(t.deviceAndSdk, InfoView(store: store)),
            ),
          ];
          return ListView(
            padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.paddingOf(context).bottom),
            children: <Widget>[
              // The app: mark, name and version, the device, and the
              // connection on a line of its own.
              _Group(children: <Widget>[
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      const DurbunLogo(size: 48),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Row(
                              children: <Widget>[
                                Expanded(
                                  child: Text(
                                    '${app?['name'] ?? t.title}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: DurbunType.heading(color: c.text).copyWith(height: 1.25),
                                  ),
                                ),
                                if (version != null) ...<Widget>[const SizedBox(width: 8), _VersionPill(version)],
                              ],
                            ),
                            const SizedBox(height: 3),
                            if (device?['model'] != null || device?['name'] != null || os.isNotEmpty)
                              Text(
                                <String>[
                                  if (device?['model'] != null || device?['name'] != null) '${device!['model'] ?? device['name']}',
                                  if (os.isNotEmpty) os,
                                ].join(' · '),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.textMuted, height: 1.4),
                              ),
                            const SizedBox(height: 8),
                            _ConnectionStatus(
                              connected: connected,
                              label: connected
                                  ? t.connectedVia(via)
                                  : report != null && (report.trying || report.attempts.isEmpty)
                                      ? t.statusConnecting
                                      : t.onPhoneOnly,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ]),
              const SizedBox(height: 12),
              // Two by two; one column when a tile would be too narrow.
              LayoutBuilder(
                builder: (context, box) {
                  final columns = box.maxWidth / 2 >= 150 + 60 * (MediaQuery.textScalerOf(context).scale(10) / 10 - 1) ? 2 : 1;
                  if (columns == 1) {
                    return Column(children: <Widget>[for (final x in tiles) Padding(padding: const EdgeInsets.only(bottom: 12), child: x)]);
                  }
                  return Column(
                    children: <Widget>[
                      for (var i = 0; i < tiles.length; i += 2)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: IntrinsicHeight(
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: <Widget>[
                                Expanded(child: tiles[i]),
                                const SizedBox(width: 12),
                                Expanded(child: i + 1 < tiles.length ? tiles[i + 1] : const SizedBox.shrink()),
                              ],
                            ),
                          ),
                        ),
                    ],
                  );
                },
              ),
              _Group(children: <Widget>[
                // Rules come from the desktop and end with its connection.
                if (connected)
                  _ToolRow(
                    icon: Icons.theater_comedy_outlined,
                    label: t.mocks,
                    value: t.ruleCount(rules),
                    onTap: () => open(t.mocks, MocksView(store: store)),
                  ),
                _ToolRow(
                  icon: Icons.file_upload_outlined,
                  label: t.exportSession,
                  hint: t.exportSessionHint,
                  onTap: () => showExportSheet(context, store),
                ),
                // Always listed: off, it says so and how to turn it on.
                _ToolRow(
                  icon: Icons.history_rounded,
                  label: t.previousRun,
                  hint: journal == null ? t.previousRunOffHint : t.previousRunHint,
                  value: journal == null
                      ? t.off
                      : previous == null
                          ? t.previousRunNone
                          : t.spanAgo(t.spanShort(DateTime.now().difference(previous.savedAt))),
                  onTap: () {
                    if (journal == null) return open(t.previousRun, const PreviousRunOffView());
                    Navigator.of(context).push(MaterialPageRoute<void>(
                      builder: (routeContext) => DurbunTheme.wrap(routeContext, PreviousRunPage(journal: journal, current: store)),
                    ));
                  },
                ),
              ]),
              const SizedBox(height: 12),
              // Nothing comes back from here: a red card of its own.
              _Group(
                tone: CardTone.danger,
                children: <Widget>[
                  _ToolRow(
                    icon: Icons.delete_sweep_outlined,
                    destructive: true,
                    label: t.clearAll,
                    hint: t.clearAllHint,
                    chevron: false,
                    onTap: () async {
                      final messenger = ScaffoldMessenger.maybeOf(context);
                      if (!await confirmClear(context)) return;
                      store.clear();
                      messenger?.showSnackBar(SnackBar(content: Text(t.cleared), duration: const Duration(milliseconds: 1400)));
                    },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }
}

/// "Clear captured data?" on the panel's own navigator; true to clear.
Future<bool> confirmClear(BuildContext context) async {
  final t = InspectorStrings.of(context);
  final yes = await showDialog<bool>(
    context: context,
    // The panel's navigator: the app's route observers never see it.
    useRootNavigator: false,
    builder: (dialogContext) => DurbunTheme.wrap(
      dialogContext,
      Builder(builder: (dialog) {
        final c = DurbunColors.of(dialog);
        return AlertDialog(
          backgroundColor: c.bgElevated,
          surfaceTintColor: Colors.transparent,
          title: Text(t.clearConfirmTitle),
          content: Text(t.clearConfirmBody),
          actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialog).pop(false),
              style: TextButton.styleFrom(foregroundColor: c.textMuted),
              child: Text(t.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialog).pop(true),
              style: TextButton.styleFrom(
                  foregroundColor: c.danger,
                  textStyle: const TextStyle(fontSize: DurbunType.label, fontWeight: FontWeight.w600)),
              child: Text(t.clear),
            ),
          ],
        );
      }),
    ),
  );
  return yes ?? false;
}

class _ConnectionStatus extends StatelessWidget {
  const _ConnectionStatus({required this.connected, required this.label});

  final bool connected;
  final String label;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    // The same dot as on the header's logo: green while the desktop listens.
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: connected ? c.success : c.textSubtle, shape: BoxShape.circle)),
        const SizedBox(width: 8),
        Flexible(
          child: Text(label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: connected ? c.text : c.textMuted, height: 1.2)),
        ),
      ],
    );
  }
}

/// Rows in one rounded card, hairlines between them (inset grouped list).
class _Group extends StatelessWidget {
  const _Group({required this.children, this.tone = CardTone.normal});

  final List<Widget> children;

  /// [CardTone.danger]: the red card of a row that removes data.
  final CardTone tone;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final danger = tone == CardTone.danger;
    return Container(
      decoration: BoxDecoration(
          color: danger ? Color.alphaBlend(c.lvErrorBg, c.cardBg) : c.cardBg,
          borderRadius: BorderRadius.circular(DurbunRadius.lg),
          border: Border.all(color: danger ? c.danger.withValues(alpha: 0.4) : c.border)),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: <Widget>[
          for (var i = 0; i < children.length; i++) ...<Widget>[
            if (i > 0) Padding(padding: const EdgeInsets.only(left: 52), child: Divider(height: 1, color: c.hairline)),
            children[i],
          ],
        ],
      ),
    );
  }
}

class _ToolRow extends StatelessWidget {
  const _ToolRow(
      {required this.icon,
      required this.label,
      required this.onTap,
      this.value,
      this.hint,
      this.chevron = true,
      this.destructive = false});

  final IconData icon;
  final String label;

  /// Red label and icon: the row removes data.
  final bool destructive;
  final String? value;
  final String? hint;
  final bool chevron;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    // A plain icon, no tile; only Clear speaks in red.
    return ListRow(
      icon: icon,
      iconColor: destructive ? c.danger : c.textMuted,
      title: label,
      titleColor: destructive ? c.danger : null,
      subtitle: hint,
      value: value == null || value!.isEmpty ? null : value,
      chevron: chevron,
      onTap: onTap,
    );
  }
}

/// The app's version as a small outlined pill beside its name.
class _VersionPill extends StatelessWidget {
  const _VersionPill(this.version);

  final String version;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      constraints: const BoxConstraints(maxWidth: 140),
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: c.chipBg,
        borderRadius: BorderRadius.circular(DurbunRadius.pill),
        border: Border.all(color: c.border),
      ),
      child: Text(version,
          maxLines: 1, overflow: TextOverflow.ellipsis, style: DurbunType.monoStyle(size: DurbunType.monoSm, color: c.textMuted, weight: FontWeight.w500, height: 1.3)),
    );
  }
}

/// A tool as a tile of the two-by-two grid: its icon on a tint of its
/// colour, the name, and what it holds now.
class _ToolTile extends StatelessWidget {
  const _ToolTile({required this.icon, required this.tone, required this.label, required this.value, required this.onTap});

  final IconData icon;
  final BadgeTone tone;
  final String label;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final (ink, tint) = switch (tone) {
      BadgeTone.accent => (c.accentInk, c.accentSoft),
      BadgeTone.success => (c.success, c.successSoft),
      BadgeTone.warning => (c.warning, c.warningSoft),
      BadgeTone.danger => (c.danger, c.dangerSoft),
      BadgeTone.info => (c.info, c.infoSoft),
      BadgeTone.neutral => (c.textMuted, c.bgActive),
    };
    return MergeSemantics(
      child: Semantics(
        button: true,
        child: Pressable(
          onTap: onTap,
          builder: (pressed) => AnimatedContainer(
            duration: DurbunMotion.of(context, DurbunMotion.fast),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: pressed ? Color.alphaBlend(c.text.withValues(alpha: 0.05), c.cardBg) : c.cardBg,
              borderRadius: BorderRadius.circular(DurbunRadius.lg),
              border: Border.all(color: c.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(color: Color.alphaBlend(tint, c.cardBg), borderRadius: BorderRadius.circular(DurbunRadius.md)),
                  child: Icon(icon, size: 20, color: ink),
                ),
                const SizedBox(height: 14),
                Text(label, style: DurbunType.heading(size: DurbunType.label, color: c.text).copyWith(height: 1.3)),
                const SizedBox(height: 3),
                Text(value, maxLines: 2, overflow: TextOverflow.ellipsis, style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.35)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
