/// The Tools page of the panel: the app and its desktop connection; Report
/// a bug; tiles for Statistics, Mac connection (once a Mac is in reach),
/// App tools and Device & SDK (each a page of its own); Mocks (while
/// connected), Export session, Previous run (with `keepPreviousRun`) and the
/// dark theme; and Clear in a red card. The app turns each item on or off
/// ([DurbunPanelTools]).
library;

import 'package:flutter/material.dart';

import '../core/connection_report.dart' show ConnectionReport;
import '../flutter/durbun.dart' show Durbun, durbunBackend, durbunInspectorState;
import 'actions_view.dart';
import 'bug_report.dart' show BugAnchor;
import 'bug_report_view.dart';
import 'connection_view.dart';
import 'export_sheet.dart';
import 'info_view.dart';
import 'panel_tools.dart';
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
          final os = <String>[
            if (platform.isNotEmpty) platform,
            if (device?['osVersion'] != null) '${device!['osVersion']}'
          ].join(' ');
          final stats = computeNetworkStats(store.calls, topHosts: 0);
          final finished = stats.requests - stats.pending;
          final version =
              app?['version'] == null ? null : '${app!['version']}${app['build'] != null ? ' (${app['build']})' : ''}';
          final show = store.panelTools;
          final tiles = <_ToolTile>[
            if (show.statistics)
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
            if (showMacConnection(show, report, connected: connected))
              _ToolTile(
                icon: Icons.link_rounded,
                tone: BadgeTone.accent,
                label: t.macConnection,
                value: connectionShortText(t, report),
                onTap: () => open(t.macConnection, ConnectionView(store: store)),
              ),
            if (show.appTools)
              _ToolTile(
                icon: Icons.tune_rounded,
                tone: BadgeTone.warning,
                label: t.appTools,
                value: tools == 0 ? t.appToolsHint : t.toolCount(tools),
                onTap: () => open(t.appTools, const AppToolsView()),
              ),
            if (show.deviceInfo)
              _ToolTile(
                icon: Icons.smartphone_rounded,
                tone: BadgeTone.success,
                label: t.deviceAndSdk,
                value: <String>[if (os.isNotEmpty) os, '${t.title} $kSdkVersion'].join(' · '),
                onTap: () => open(t.deviceAndSdk, InfoView(store: store)),
              ),
          ];
          final rows = _toolRows(context,
              store: store,
              show: show,
              connected: connected,
              rules: rules,
              journal: journal,
              previous: previous,
              open: open);
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
                                  if (device?['model'] != null || device?['name'] != null)
                                    '${device!['model'] ?? device['name']}',
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
              // What a tester came for most: the moment, sent on.
              if (!store.readOnly && show.bugReport) ...<Widget>[
                _ReportCard(onTap: () => openBugReport(context, store, const BugAnchor.now())),
                const SizedBox(height: 12),
              ],
              // Two by two; one column when a tile would be too narrow.
              LayoutBuilder(
                builder: (context, box) {
                  final columns =
                      box.maxWidth / 2 >= 150 + 60 * (MediaQuery.textScalerOf(context).scale(10) / 10 - 1) ? 2 : 1;
                  if (columns == 1) {
                    return Column(children: <Widget>[
                      for (final x in tiles) Padding(padding: const EdgeInsets.only(bottom: 12), child: x)
                    ]);
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
                                // A tile left alone (an odd count, as when
                                // Mac connection is not listed) takes the
                                // row, laid out across it.
                                if (i + 1 == tiles.length)
                                  Expanded(child: tiles[i].across())
                                else ...<Widget>[
                                  Expanded(child: tiles[i]),
                                  const SizedBox(width: 12),
                                  Expanded(child: tiles[i + 1]),
                                ],
                              ],
                            ),
                          ),
                        ),
                    ],
                  );
                },
              ),
              if (rows.isNotEmpty) ...<Widget>[_Group(children: rows), const SizedBox(height: 12)],
              // Nothing comes back from here: a red card of its own.
              if (show.clearData)
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
                        messenger?.showSnackBar(
                            SnackBar(content: Text(t.cleared), duration: const Duration(milliseconds: 1400)));
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

/// Whether Tools lists the Mac connection: as the app set it
/// ([DurbunPanelTools.macConnection]), else once a Mac is in reach (connected
/// now or earlier in this run, or a Wi-Fi address set): a tester without a
/// Mac never sees a tile that only says "not connected".
bool showMacConnection(DurbunPanelTools tools, ConnectionReport? report, {required bool connected}) =>
    tools.macConnection ??
    (connected || (report != null && (report.connected || report.everConnected || report.lanEndpoint != null)));

/// The rows card of Tools (Mocks, Export session, Previous run, the theme)
/// as the app turned them on; [open] pushes a tool's page.
List<Widget> _toolRows(
  BuildContext context, {
  required DurbunInspectorStore store,
  required DurbunPanelTools show,
  required bool connected,
  required int rules,
  required RunJournal? journal,
  required PreviousRunInfo? previous,
  required void Function(String title, Widget page) open,
}) {
  final t = InspectorStrings.of(context);
  return <Widget>[
    // Rules come from the desktop and end with its connection.
    if (connected && show.mocks)
      _ToolRow(
        icon: Icons.theater_comedy_outlined,
        label: t.mocks,
        value: t.ruleCount(rules),
        onTap: () => open(t.mocks, MocksView(store: store)),
      ),
    if (show.exportSession)
      _ToolRow(
        icon: Icons.file_upload_outlined,
        label: t.exportSession,
        hint: t.exportSessionHint,
        onTap: () => showExportSheet(context, store),
      ),
    // Listed also while off: it says so and how to turn it on.
    if (show.previousRun)
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
            builder: (routeContext) =>
                DurbunTheme.wrap(routeContext, PreviousRunPage(journal: journal, current: store)),
          ));
        },
      ),
    if (show.theme) const _ThemeRow(),
  ];
}

/// "Clear captured data?" (or [title] / [body] for one page's data) on the
/// panel's own navigator; true to clear.
Future<bool> confirmClear(BuildContext context, {String? title, String? body}) async {
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
          title: Text(title ?? t.clearConfirmTitle),
          content: Text(body ?? t.clearConfirmBody),
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

/// "Dark theme" with its switch: the panel's own light / dark, starting
/// from the phone's setting and kept for the next launches.
class _ThemeRow extends StatelessWidget {
  const _ThemeRow();

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final dark = c.isDark;
    return MergeSemantics(
      child: Semantics(
        toggled: dark,
        child: ListRow(
          key: const ValueKey<String>('durbun-tools-theme'),
          icon: Icons.dark_mode_outlined,
          iconColor: c.textMuted,
          title: t.darkTheme,
          subtitle: t.darkThemeHint,
          trailing: ExcludeSemantics(child: Switch(value: dark, onChanged: (_) => togglePanelTheme(context))),
          onTap: () => togglePanelTheme(context),
        ),
      ),
    );
  }
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
              style: TextStyle(
                  fontSize: 13, fontWeight: FontWeight.w500, color: connected ? c.text : c.textMuted, height: 1.2)),
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

/// "Report a bug": an accent icon tile, the name, what goes in.
class _ReportCard extends StatelessWidget {
  const _ReportCard({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return MergeSemantics(
      child: Semantics(
        button: true,
        child: Pressable(
          onTap: onTap,
          builder: (pressed) => AnimatedContainer(
            key: const ValueKey<String>('durbun-tools-bug'),
            duration: DurbunMotion.of(context, DurbunMotion.fast),
            padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 12, 14),
            decoration: BoxDecoration(
              color: pressed ? Color.alphaBlend(c.text.withValues(alpha: 0.05), c.cardBg) : c.cardBg,
              borderRadius: BorderRadius.circular(DurbunRadius.lg),
              border: Border.all(color: c.border),
            ),
            child: Row(
              children: <Widget>[
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                      color: Color.alphaBlend(c.dangerSoft, c.cardBg),
                      borderRadius: BorderRadius.circular(DurbunRadius.md)),
                  child: Icon(Icons.bug_report_outlined, size: 22, color: c.danger),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(t.bugReport,
                          style: DurbunType.heading(size: DurbunType.label, color: c.text).copyWith(height: 1.3)),
                      const SizedBox(height: 3),
                      Text(t.bugReportHint,
                          style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.35)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Icon(Icons.chevron_right_rounded, size: 20, color: c.textSubtle),
              ],
            ),
          ),
        ),
      ),
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
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style:
              DurbunType.monoStyle(size: DurbunType.monoSm, color: c.textMuted, weight: FontWeight.w500, height: 1.3)),
    );
  }
}

/// A tool as a tile of the two-by-two grid: its icon on a tint of its
/// colour, the name, and what it holds now.
class _ToolTile extends StatelessWidget {
  const _ToolTile({
    required this.icon,
    required this.tone,
    required this.label,
    required this.value,
    required this.onTap,
    this.wide = false,
  });

  final IconData icon;
  final BadgeTone tone;
  final String label;
  final String value;
  final VoidCallback onTap;

  /// Icon beside the text, with a chevron: a tile that has a row to itself.
  final bool wide;

  _ToolTile across() => _ToolTile(icon: icon, tone: tone, label: label, value: value, onTap: onTap, wide: true);

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
    final badge = Container(
      width: 36,
      height: 36,
      decoration:
          BoxDecoration(color: Color.alphaBlend(tint, c.cardBg), borderRadius: BorderRadius.circular(DurbunRadius.md)),
      child: Icon(icon, size: 20, color: ink),
    );
    final text = <Widget>[
      Text(label, style: DurbunType.heading(size: DurbunType.label, color: c.text).copyWith(height: 1.3)),
      const SizedBox(height: 3),
      Text(value,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.35)),
    ];
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
            child: wide
                ? Row(
                    children: <Widget>[
                      badge,
                      const SizedBox(width: 14),
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: text)),
                      const SizedBox(width: 8),
                      Icon(Icons.chevron_right_rounded, size: 20, color: c.textSubtle),
                    ],
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[badge, const SizedBox(height: 14), ...text],
                  ),
          ),
        ),
      ),
    );
  }
}
