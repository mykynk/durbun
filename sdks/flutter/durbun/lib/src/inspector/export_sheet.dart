/// "Export session": the requests the Network list shows (or all of them)
/// as a Markdown report or a HAR file, shared as a file through the system
/// share sheet; copied to the clipboard when that cannot open.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'export_file.dart';
import 'filter_ui.dart' show SheetSwitch;
import 'network_view.dart' show networkListing;
import 'session_export.dart';
import 'share_report.dart' show shareBytes;
import 'share_sheet.dart' show hostAppLabel, hostDeviceLabel, shareFileNatively;
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// Writes an export file and returns its path (null: not written).
typedef ExportWriter = Future<String?> Function(String name, Iterable<String> chunks);

/// Replaces the file writer (tests).
@visibleForTesting
ExportWriter? debugExportWriter;

ExportWriter get _writer => debugExportWriter ?? ((name, chunks) => writeExportFile(name, chunks));

enum ExportOutcome {
  /// The share sheet opened with the file.
  shared,

  /// No share sheet: the export went to the clipboard.
  copied,

  /// No share sheet, and the export is too large for the clipboard.
  tooLarge,

  /// The sheet was closed before the export was ready: nothing opened.
  cancelled,

  /// Something went wrong making it (never expected; never thrown).
  failed,
}

/// Collects what goes through it, up to [limit] characters (the clipboard
/// fallback), and counts all of it.
class _Tee {
  _Tee(this.limit);

  final int limit;
  final StringBuffer _text = StringBuffer();
  int length = 0;
  bool complete = false;

  bool get over => length > limit;

  String get text => _text.toString();

  void add(String chunk) {
    length += chunk.length;
    if (over) {
      _text.clear();
    } else {
      _text.write(chunk);
    }
  }

  Iterable<String> wrap(Iterable<String> chunks) sync* {
    for (final c in chunks) {
      add(c);
      yield c;
    }
    complete = true;
  }

  /// Generates [chunks] again (the writer did not run through them),
  /// stopping once over the limit.
  Future<void> fill(Iterable<String> chunks) async {
    _text.clear();
    length = 0;
    complete = false;
    final slice = Stopwatch()..start();
    for (final c in chunks) {
      add(c);
      if (over) return;
      if (slice.elapsedMilliseconds >= 8) {
        await Future<void>.delayed(Duration.zero);
        slice.reset();
      }
    }
    complete = true;
  }
}

/// Writes the export of [calls], opens the share sheet with it, and falls
/// back to the clipboard. Returns the outcome and the export's size (for
/// "too large"). [cancelled] is asked before anything opens.
Future<(ExportOutcome, String)> runSessionExport({
  required List<InspectorCall> calls,
  required ExportOptions options,
  required InspectorStrings t,
  required ExportContext context,
  required String subject,
  String? appName,
  bool Function()? cancelled,
}) async {
  try {
    return await _runSessionExport(calls, options, t, context, subject, appName, cancelled);
  } catch (_) {
    return (ExportOutcome.failed, '');
  }
}

Future<(ExportOutcome, String)> _runSessionExport(List<InspectorCall> calls, ExportOptions options, InspectorStrings t,
    ExportContext context, String subject, String? appName, bool Function()? cancelled) async {
  final name = exportFileName(options.format, DateTime.fromMillisecondsSinceEpoch(context.nowMs.round()), appName: appName);
  final chunks = sessionExport(calls, options, t, context);
  final tee = _Tee(kMaxClipboardExportChars);
  final path = await _writer(name, tee.wrap(chunks));
  if (cancelled?.call() == true) return (ExportOutcome.cancelled, '');
  if (path != null && await shareFileNatively(path, mime: exportMime(options.format), subject: subject)) {
    return (ExportOutcome.shared, shareBytes(tee.length));
  }
  if (!tee.complete) await tee.fill(chunks);
  if (cancelled?.call() == true) return (ExportOutcome.cancelled, '');
  final size = tee.complete ? shareBytes(tee.length) : '> ${shareBytes(kMaxClipboardExportChars)}';
  if (!tee.complete || tee.over) return (ExportOutcome.tooLarge, size);
  try {
    await Clipboard.setData(ClipboardData(text: tee.text));
  } catch (_) {
    return (ExportOutcome.tooLarge, size);
  }
  return (ExportOutcome.copied, size);
}

/// The export options last used with this store (per app run).
final Expando<ExportOptions> _lastOptions = Expando<ExportOptions>('durbun.export');

Future<void> showExportSheet(BuildContext context, DurbunInspectorStore store) {
  FocusManager.instance.primaryFocus?.unfocus();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: DurbunColors.of(context).bgPanel,
    builder: (routeContext) => DurbunTheme.wrap(routeContext, _ExportSheet(store: store)),
  );
}

class _ExportSheet extends StatefulWidget {
  const _ExportSheet({required this.store});

  final DurbunInspectorStore store;

  @override
  State<_ExportSheet> createState() => _ExportSheetState();
}

class _ExportSheetState extends State<_ExportSheet> {
  late ExportOptions _o = _lastOptions[widget.store] ?? const ExportOptions();

  // What the list showed when the sheet opened: the export does not change
  // while the options are being picked.
  late final List<InspectorCall> _listed = networkListing(widget.store).calls;
  late final List<InspectorCall> _all = widget.store.calls;
  final ScrollController _scroll = ScrollController();
  bool _busy = false;

  /// Why the last try did not share (too large to copy, failed).
  String? _problem;

  List<InspectorCall> get _calls => _o.all ? _all : _listed;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _set(ExportOptions o) {
    _lastOptions[widget.store] = o;
    setState(() {
      _o = o;
      _problem = null;
    });
  }

  Future<void> _export() async {
    final t = InspectorStrings.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    final store = widget.store;
    final calls = _calls;
    setState(() {
      _busy = true;
      _problem = null;
    });
    final app = hostAppLabel(store);
    final appInfo = store.hello?['app'];
    final (outcome, size) = await runSessionExport(
      calls: calls,
      options: _o,
      t: t,
      context: ExportContext(
        nowMs: DateTime.now().microsecondsSinceEpoch / 1000,
        app: app,
        device: hostDeviceLabel(store),
        listed: !_o.all,
        total: _all.length,
      ),
      subject: t.exportSubject(appInfo is Map ? appInfo['name'] as String? : null, calls.length),
      appName: appInfo is Map ? appInfo['name'] as String? : null,
      cancelled: () => !mounted,
    );
    if (!mounted) return;
    switch (outcome) {
      case ExportOutcome.shared || ExportOutcome.cancelled:
        if (navigator.canPop()) navigator.pop();
      case ExportOutcome.copied:
        if (navigator.canPop()) navigator.pop();
        messenger?.hideCurrentSnackBar();
        messenger?.showSnackBar(SnackBar(content: Text(t.exportCopied), duration: const Duration(seconds: 3)));
      case ExportOutcome.tooLarge:
        // Said in the sheet (a toast would be under it), which stays open
        // so bodies can be turned off.
        setState(() {
          _busy = false;
          _problem = t.exportTooLarge(size);
        });
      case ExportOutcome.failed:
        setState(() {
          _busy = false;
          _problem = t.exportFailed;
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final bottom = MediaQuery.paddingOf(context).bottom;
    final calls = _calls;
    Widget label(String text) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Text(text, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.text)),
        );
    Widget hint(String text) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
          child: Text(text, style: TextStyle(fontSize: 11.5, height: 1.35, color: c.textMeta)),
        );
    // Options scroll (landscape, large text); the button stays pinned.
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.9),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Flexible(
            child: Scrollbar(
              controller: _scroll,
              child: SingleChildScrollView(
                controller: _scroll,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                      child: Text(t.exportSession,
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: c.text)),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Text(t.exportDescription, style: TextStyle(fontSize: 12.5, height: 1.35, color: c.textMeta)),
                    ),
                    label(t.exportScope),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: ChoiceSegments(
                        labels: <String>[t.exportListed, t.exportAll],
                        counts: <Object?>[_listed.length, _all.length],
                        index: _o.all ? 1 : 0,
                        onChanged: _busy ? null : (i) => _set(_o.copyWith(all: i == 1)),
                      ),
                    ),
                    hint(_o.all ? t.exportAllHint : t.exportListedHint),
                    label(t.exportFormat),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: ChoiceSegments(
                        labels: <String>[t.exportMarkdown, t.exportHar],
                        index: _o.format == ExportFormat.har ? 1 : 0,
                        onChanged: _busy
                            ? null
                            : (i) => _set(_o.copyWith(format: i == 1 ? ExportFormat.har : ExportFormat.markdown)),
                      ),
                    ),
                    hint(_o.format == ExportFormat.har ? t.exportHarHint : t.exportMarkdownHint),
                    const SizedBox(height: 8),
                    SheetSwitch(
                        label: t.shareMask,
                        hint: t.shareMaskHint,
                        icon: Icons.visibility_off_outlined,
                        value: _o.mask,
                        onChanged: (v) {
                          if (!_busy) _set(_o.copyWith(mask: v));
                        }),
                    SheetSwitch(
                        label: t.shareBodies,
                        hint: t.exportBodiesHint,
                        icon: Icons.data_object_rounded,
                        value: _o.bodies,
                        onChanged: (v) {
                          if (!_busy) _set(_o.copyWith(bodies: v));
                        }),
                  ],
                ),
              ),
            ),
          ),
          Container(
            decoration: BoxDecoration(color: c.bgPanel, border: Border(top: BorderSide(color: c.hairline))),
            padding: EdgeInsets.fromLTRB(12, 10, 12, 12 + bottom),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (_problem != null) ...<Widget>[
                  Callout(title: _problem!, tone: CalloutTone.warning),
                  const SizedBox(height: 10),
                ] else if (calls.isEmpty) ...<Widget>[
                  Text(t.exportNothing, textAlign: TextAlign.center, style: TextStyle(fontSize: 12.5, color: c.textMeta)),
                  const SizedBox(height: 8),
                ],
                DButton(
                  large: true,
                  primary: !_busy && calls.isNotEmpty,
                  icon: defaultTargetPlatform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded,
                  label: _busy ? t.exportPreparing : t.exportSend,
                  onTap: _busy || calls.isEmpty ? null : () => unawaited(_export()),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
