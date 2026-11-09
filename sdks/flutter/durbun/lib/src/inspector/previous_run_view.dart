/// "Previous run" (tools sheet, with `DurbunInspector(keepPreviousRun:
/// true)`): the last launch's requests and logs, read from its log file
/// when the page opens, shown read-only with the panel's own Network and
/// Logs pages. A crash in that run is named on top and opens in one tap.
library;

import 'package:flutter/material.dart';

import 'home.dart';
import 'logs_view.dart' show LogDetailPage, errorHead;
import 'run_log.dart';
import 'share_sheet.dart' show hostAppLabel;
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

class PreviousRunPage extends StatefulWidget {
  const PreviousRunPage({super.key, required this.journal, required this.current});

  final RunJournal journal;

  /// The live store: its default hosts, and the crashes of the previous run
  /// the native layer reported on this launch.
  final DurbunInspectorStore current;

  @override
  State<PreviousRunPage> createState() => _PreviousRunPageState();
}

class _PreviousRunPageState extends State<PreviousRunPage> {
  late final Future<PreviousRun?> _run = _load();
  PreviousRun? _loaded;
  bool _disposed = false;

  Future<PreviousRun?> _load() async {
    try {
      final records = await widget.journal.readPrevious();
      if (records == null || records.isEmpty) return null;
      final header = records.firstWhere((r) => r['t'] == 'run', orElse: () => const <String, Object?>{});
      final start = header['start'];
      final run = await restoreRun(
        records,
        defaultHosts: widget.current.defaultHosts,
        lateCrashes: lateCrashesOf(widget.current,
            currentStartMs: widget.journal.startedAtMs, previousStartMs: start is num ? start.toDouble() : null),
      );
      if (_disposed) {
        run.store.dispose();
        return null;
      }
      return _loaded = run;
    } catch (_) {
      return null;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _loaded?.store.dispose();
    super.dispose();
  }

  void _close() => Navigator.of(context).maybePop();

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return FutureBuilder<PreviousRun?>(
      future: _run,
      builder: (context, snapshot) {
        final run = snapshot.data;
        if (run != null) {
          return InspectorHome(
            store: run.store,
            // A crash is the reason to look: the Logs, where it is.
            initialTab: run.crashes.isEmpty ? 0 : 1,
            onClose: _close,
            banner: _RunBanner(run: run),
          );
        }
        final loading = snapshot.connectionState != ConnectionState.done;
        return Scaffold(
          backgroundColor: c.bgApp,
          appBar: AppBar(title: Text(t.previousRun), shape: Border(bottom: BorderSide(color: c.border))),
          body: loading
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)),
                      const SizedBox(height: 12),
                      Text(t.previousRunReading, style: TextStyle(fontSize: 13, color: c.textMuted)),
                    ],
                  ),
                )
              : EmptyState(icon: Icons.history_rounded, title: t.previousRunEmptyTitle, body: t.previousRunEmptyBody),
        );
      },
    );
  }
}

/// When the run started, what it is, and its crash.
class _RunBanner extends StatelessWidget {
  const _RunBanner({required this.run});

  final PreviousRun run;

  static String _when(double ms) {
    final d = DateTime.fromMicrosecondsSinceEpoch((ms * 1000).round());
    String two(int v) => v.toString().padLeft(2, '0');
    return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final crashes = run.crashes;
    final app = hostAppLabel(run.store);
    final start = run.startedAtMs;
    final info = <String>[
      t.previousRun,
      if (start != null) t.previousRunStarted(_when(start)),
      if (app != null) app,
    ].join(' · ');
    return Container(
      decoration: BoxDecoration(color: c.bgPanel, border: Border(bottom: BorderSide(color: c.border))),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(info,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.text)),
          const SizedBox(height: 2),
          Text(t.previousRunNote, style: TextStyle(fontSize: 11.5, color: c.textMeta)),
          if (crashes.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            _CrashCallout(crash: crashes.last, count: crashes.length),
          ],
        ],
      ),
    );
  }
}

/// The run's (last) crash: its error line; a tap opens it.
class _CrashCallout extends StatelessWidget {
  const _CrashCallout({required this.crash, required this.count});

  final InspectorLog crash;
  final int count;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final e = crash.error;
    final head = e == null ? crash.message : errorHead(e);
    return Semantics(
      button: true,
      label: '${t.previousRunCrashes(count)}, ${t.previousRunOpenCrash}',
      excludeSemantics: true,
      child: Material(
        color: c.dangerSoft,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DurbunRadius.lg),
          side: BorderSide(color: c.danger.withValues(alpha: 0.3)),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(DurbunRadius.lg),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (routeContext) => DurbunTheme.wrap(routeContext, LogDetailPage(log: crash)))),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: kMinTapTarget),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
              child: Row(
                children: <Widget>[
                  Icon(Icons.error_outline_rounded, size: 18, color: c.danger),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(t.previousRunCrashes(count),
                            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.text)),
                        if (head.isNotEmpty)
                          Text(head,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: DurbunType.monoStyle(size: 11.5, color: c.textMuted, height: 1.35)),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(t.previousRunOpenCrash,
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.danger)),
                  Icon(Icons.chevron_right_rounded, size: 20, color: c.danger),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
