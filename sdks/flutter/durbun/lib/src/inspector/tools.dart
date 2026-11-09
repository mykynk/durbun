/// The tools sheet: the app and its desktop connection, then Mocks (while
/// connected), Performance, Statistics and Device & SDK (each a page of its own),
/// Export session, Previous run (with `keepPreviousRun`) and Clear.
library;

import 'package:flutter/material.dart';

import '../flutter/durbun.dart' show Durbun, durbunInspectorState;
import 'export_sheet.dart';
import 'info_view.dart';
import 'perf_view.dart';
import 'previous_run_view.dart';
import 'run_log.dart';
import 'stats_view.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';

Future<void> showToolsSheet(BuildContext context, DurbunInspectorStore store) {
  FocusManager.instance.primaryFocus?.unfocus();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: DurbunColors.of(context).bgApp,
    builder: (routeContext) => DurbunTheme.wrap(routeContext, _ToolsSheet(store: store)),
  );
}

/// A page opened from the tools sheet (Mocks, Performance, Device & SDK).
class ToolPage extends StatelessWidget {
  const ToolPage({super.key, required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Scaffold(
      backgroundColor: c.bgApp,
      appBar: AppBar(
        title: Text(title),
        shape: Border(bottom: BorderSide(color: c.border)),
      ),
      body: child,
    );
  }
}

class _ToolsSheet extends StatelessWidget {
  const _ToolsSheet({required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    void open(String title, Widget page) {
      final nav = Navigator.of(context);
      nav.pop();
      nav.push(MaterialPageRoute<void>(
        builder: (routeContext) => DurbunTheme.wrap(routeContext, ToolPage(title: title, child: page)),
      ));
    }

    final journal = RunJournal.of(store);
    return StreamBuilder<Object?>(
      stream: Durbun.connection,
      builder: (context, _) => ListenableBuilder(
        listenable: Listenable.merge(<Listenable>[store, if (journal != null) journal.previous]),
        builder: (context, _) {
          final previous = journal?.previous.value;
          final state = durbunInspectorState();
          final hello = (state?['hello'] as Map?) ?? store.hello;
          final app = hello?['app'] as Map?;
          final device = hello?['device'] as Map?;
          final connected = Durbun.isConnected;
          final via = state?['via'] as String?;
          final rules = state?['mocks'] is List ? (state!['mocks'] as List).length : 0;
          final m = store.lastMetric;
          final platform = switch ('${device?['platform'] ?? ''}') {
            'ios' => 'iOS',
            'android' => 'Android',
            final p => p,
          };
          final os = <String>[if (platform.isNotEmpty) platform, if (device?['osVersion'] != null) '${device!['osVersion']}'].join(' ');
          final perf = m == null
              ? t.noSamplesShort
              : <String>[
                  if (m.fps != null) '${m.fps!.round()} FPS',
                  if (m.memoryMB != null) '${m.memoryMB!.round()} MB',
                ].join(' · ');
          return ListView(
            shrinkWrap: true,
            padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.paddingOf(context).bottom),
            children: <Widget>[
              _Group(children: <Widget>[
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: <Widget>[
                      const DurbunLogo(size: 40),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              '${app?['name'] ?? t.title}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: c.text),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              <String>[
                                if (app?['version'] != null) '${app!['version']}${app['build'] != null ? ' (${app['build']})' : ''}',
                                if (device?['model'] != null || device?['name'] != null) '${device!['model'] ?? device['name']}',
                                if (os.isNotEmpty) os,
                              ].join(' · '),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: DurbunType.monoStyle(size: 11.5, color: c.textMeta, height: 1.35),
                            ),
                            const SizedBox(height: 8),
                            _ConnectionStatus(connected: connected, label: connected ? t.connectedVia(via) : t.onPhoneOnly),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ]),
              const SizedBox(height: 16),
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
                  icon: Icons.speed_rounded,
                  label: t.performance,
                  value: perf,
                  onTap: () => open(t.performance, PerformanceView(store: store)),
                ),
                _ToolRow(
                  icon: Icons.bar_chart_rounded,
                  label: t.statistics,
                  value: t.requestCount(store.calls.length),
                  onTap: () => open(t.statistics, StatsView(store: store)),
                ),
                _ToolRow(
                  icon: Icons.smartphone_rounded,
                  label: t.deviceAndSdk,
                  value: os,
                  onTap: () => open(t.deviceAndSdk, InfoView(store: store)),
                ),
              ]),
              const SizedBox(height: 16),
              _Group(children: <Widget>[
                _ToolRow(
                  icon: Icons.file_upload_outlined,
                  label: t.exportSession,
                  hint: t.exportSessionHint,
                  onTap: () {
                    final nav = Navigator.of(context);
                    nav.pop();
                    showExportSheet(nav.context, store);
                  },
                ),
                if (journal != null && previous != null)
                  _ToolRow(
                    icon: Icons.history_rounded,
                    label: t.previousRun,
                    hint: t.previousRunHint,
                    value: t.spanAgo(t.spanShort(DateTime.now().difference(previous.savedAt))),
                    onTap: () {
                      final nav = Navigator.of(context);
                      nav.pop();
                      nav.push(MaterialPageRoute<void>(
                        builder: (routeContext) =>
                            DurbunTheme.wrap(routeContext, PreviousRunPage(journal: journal, current: store)),
                      ));
                    },
                  ),
              ]),
              const SizedBox(height: 16),
              _Group(children: <Widget>[
                _ToolRow(
                  icon: Icons.cleaning_services_outlined,
                  destructive: true,
                  label: t.clearAll,
                  hint: t.clearAllHint,
                  chevron: false,
                  onTap: () async {
                    // Nothing comes back: ask first.
                    final messenger = ScaffoldMessenger.maybeOf(context);
                    final navigator = Navigator.of(context);
                    if (!await confirmClear(context)) return;
                    store.clear();
                    if (navigator.canPop()) navigator.pop();
                    messenger?.showSnackBar(SnackBar(content: Text(t.cleared), duration: const Duration(milliseconds: 1400)));
                  },
                ),
              ]),
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
          title: Text(t.clearConfirmTitle, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: c.text)),
          content: Text(t.clearConfirmBody, style: TextStyle(fontSize: 14, height: 1.4, color: c.textMuted)),
          actions: <Widget>[
            TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: Text(t.cancel)),
            TextButton(
              onPressed: () => Navigator.of(dialog).pop(true),
              style: TextButton.styleFrom(foregroundColor: c.danger),
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
  const _Group({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      decoration: BoxDecoration(
          color: c.cardBg,
          borderRadius: BorderRadius.circular(DurbunRadius.lg),
          border: Border.all(color: c.border)),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: <Widget>[
          for (var i = 0; i < children.length; i++) ...<Widget>[
            if (i > 0) Padding(padding: const EdgeInsets.only(left: 56), child: Divider(height: 1, color: c.hairline)),
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
    final tone = destructive ? c.danger : c.textMuted;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 52),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Row(
            children: <Widget>[
              // One quiet tile for every tool; only Clear speaks in red.
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                    color: destructive ? c.dangerSoft : c.trackBg,
                    borderRadius: BorderRadius.circular(DurbunRadius.md - 2)),
                child: Icon(icon, size: 18, color: tone),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(label,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: destructive ? c.danger : c.text)),
                    if (hint != null) Text(hint!, style: TextStyle(fontSize: 12, color: c.textMeta)),
                  ],
                ),
              ),
              if (value != null && value!.isNotEmpty)
                // Ends where the others end, next to the chevron.
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 170),
                  child: Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: Text(value!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.right,
                        style: DurbunType.monoStyle(size: 12, color: c.textMeta, height: 1.2)),
                  ),
                ),
              if (chevron) ...<Widget>[
                const SizedBox(width: 4),
                Icon(Icons.chevron_right_rounded, size: 20, color: c.textSubtle),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
