/// "Report a bug" (Hata bildir): a tester with only the phone gathers what
/// just happened (the moment, the log lines and failed requests around it,
/// the app's screenshot from when the panel opened, the device and app
/// facts and a note) and sends it through one system share sheet, or
/// straight to Slack when the app has a Slack connection (the screenshot
/// too when the connection carries the upload key). Nothing leaves the
/// phone until one of them is tapped; secret values are masked by default,
/// and the screenshot can be left out.
library;

import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_snapshot.dart';
import 'bug_report.dart';
import 'export_file.dart';
import 'export_sheet.dart' show ExportWriter;
import 'filter_ui.dart' show SheetSwitch;
import 'format.dart' show formatClock;
import 'share_sheet.dart' show FilesShareOutcome, canShareNatively, rememberShareMask, shareFilesNatively, shareOptionsOf;
import 'slack.dart';
import 'screenshot_attach.dart';
import 'slack_sender.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

export 'screenshot_attach.dart' show debugBugBytesWriter, debugSnapshotPng;

/// Opens the report about [anchor] on the panel's navigator.
Future<void> openBugReport(BuildContext context, DurbunInspectorStore store, BugAnchor anchor) {
  FocusManager.instance.primaryFocus?.unfocus();
  return Navigator.of(context).push(MaterialPageRoute<void>(
    builder: (routeContext) => DurbunTheme.wrap(routeContext, BugReportPage(store: store, anchor: anchor)),
  ));
}

/// Writes the report file and returns its path (tests replace it).
@visibleForTesting
ExportWriter? debugBugTextWriter;

/// The note typed and not yet sent, per store (one app run): leaving the
/// page by mistake does not lose it.
final Expando<String> _drafts = Expando<String>('durbun.bugNote');

/// The window last picked with a store.
final Expando<int> _lastBefore = Expando<int>('durbun.bugBefore');

class BugReportPage extends StatefulWidget {
  const BugReportPage({super.key, required this.store, this.anchor = const BugAnchor.now(), this.nowMs, this.utcOffsetMinutes});

  final DurbunInspectorStore store;
  final BugAnchor anchor;

  /// "Now" when the panel's opening is not known (tests).
  final double? nowMs;

  /// Minutes east of UTC for the report's times (tests).
  final int? utcOffsetMinutes;

  @override
  State<BugReportPage> createState() => _BugReportPageState();
}

class _BugReportPageState extends State<BugReportPage> {
  late final TextEditingController _note = TextEditingController(text: _drafts[widget.store] ?? '');
  final ScrollController _scroll = ScrollController();
  late int _before = _lastBefore[widget.store] ?? kBugDefaultBeforeS;
  late bool _mask = shareOptionsOf(widget.store).mask;

  /// A handle of the page's own on the opening's picture.
  ui.Image? _shot;
  double? _shotAt;
  bool _withShot = true;
  late final double _now;

  /// What goes in: every part by default, as on the desktop.
  BugParts _parts = const BugParts();

  /// The report text shown under the parts.
  bool _preview = false;

  bool _busy = false;

  /// The busy send is the Slack one (its button says Sending…).
  bool _sendingSlack = false;

  /// What the last send said (files left out, nothing opened): the title,
  /// the tone and an optional line under it.
  (String, CalloutTone, String?)? _notice;

  @override
  void initState() {
    super.initState();
    final opening = panelOpeningOf(widget.store);
    _shot = opening?.cloneImage();
    _shotAt = _shot == null ? null : opening!.atMs;
    _now = opening?.atMs ?? widget.nowMs ?? DateTime.now().microsecondsSinceEpoch / 1000;
    _note.addListener(() => _drafts[widget.store] = _note.text);
  }

  @override
  void dispose() {
    _note.dispose();
    _scroll.dispose();
    try {
      _shot?.dispose();
    } catch (_) {}
    super.dispose();
  }

  double get _moment => widget.anchor.moment(_now);

  BugWindow get _window => bugWindow(_moment, _before);

  BugReportInput _input(BugContents contents) => bugReportInputFor(
        widget.store,
        note: _note.text,
        anchor: widget.anchor,
        momentMs: _moment,
        window: _window,
        contents: contents,
        mask: _mask,
        parts: _parts,
        utcOffsetMinutes: widget.utcOffsetMinutes,
      );

  /// The full report goes as a file only when the tester keeps it in and the
  /// host has a share sheet that takes files.
  bool get _sendsFile => _parts.file && canShareNatively;

  void _setParts(BugParts parts) => setState(() {
        _parts = parts;
        _notice = null;
      });

  bool get _hasShot => _shot != null;

  bool get _sendsShot => _hasShot && _withShot;

  void _copy(BugContents contents) {
    final t = InspectorStrings.of(context);
    Clipboard.setData(ClipboardData(text: buildBugReportText(_input(contents), t)));
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.hideCurrentSnackBar();
    messenger?.showSnackBar(SnackBar(content: Text(t.shareCopied), duration: const Duration(milliseconds: 1400)));
  }

  Future<void> _send(BugContents contents) async {
    final t = InspectorStrings.of(context);
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _busy = true;
      _notice = null;
    });
    final input = _input(contents);
    final textOnly = buildBugReportText(input, t);
    try {
      final stem = bugFileStem(input.appName, DateTime.fromMicrosecondsSinceEpoch((_now * 1000).round()));
      final fileName = '$stem.md';
      final shotName = '$stem.png';
      final writeText = debugBugTextWriter ?? ((String name, Iterable<String> chunks) => writeExportFile(name, chunks));
      final filePath = _sendsFile ? await writeText(fileName, bugReportFile(input, t)) : null;
      String? shotPath;
      final shot = _sendsShot ? _shot : null;
      if (shot != null) {
        final bytes = await snapshotPng(shot);
        if (bytes != null && bytes.isNotEmpty) {
          shotPath = await writeSnapshotFile(shotName, bytes);
        }
      }
      final paths = <String>[if (filePath != null) filePath, if (shotPath != null) shotPath];
      final text = buildBugReportText(
          input.withAttachments(fileName: filePath == null ? null : fileName, screenshotName: shotPath == null ? null : shotName), t);
      final outcome = await shareFilesNatively(
        text: text,
        textOnly: textOnly,
        subject: bugSubject(input, t),
        paths: paths,
        mimes: <String>[if (filePath != null) 'text/markdown', if (shotPath != null) 'image/png'],
      );
      if (!mounted) return;
      switch (outcome) {
        case FilesShareOutcome.files:
          _drafts[widget.store] = null;
          setState(() => _busy = false);
        case FilesShareOutcome.textOnly:
          _drafts[widget.store] = null;
          setState(() {
            _busy = false;
            // The text went; say so only when files were meant to go along.
            if (paths.isNotEmpty || _sendsShot) _notice = (t.bugTextOnly, CalloutTone.info, null);
          });
        case FilesShareOutcome.failed:
          await _fallBackToClipboard(textOnly, t);
      }
    } catch (_) {
      if (mounted) await _fallBackToClipboard(textOnly, t);
    }
  }

  /// No share sheet: the clipboard keeps the report (the page stays, with
  /// the note).
  Future<void> _fallBackToClipboard(String text, InspectorStrings t) async {
    var copied = false;
    try {
      await Clipboard.setData(ClipboardData(text: text));
      copied = true;
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _busy = false;
      _notice = copied ? (t.shareFallback, CalloutTone.info, null) : (t.bugShareFailed, CalloutTone.warning, null);
    });
  }

  /// Posts the report to Slack, then the screenshot when it is in and the
  /// connection has the upload key. Everything went: the page closes. Only
  /// the screenshot did not: the page stays and says why, so Share can still
  /// send the picture. The report did not go: the page stays as it was.
  Future<void> _slack(BugContents contents, String url) async {
    final t = InspectorStrings.of(context);
    FocusManager.instance.primaryFocus?.unfocus();
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    setState(() {
      _busy = true;
      _sendingSlack = true;
      _notice = null;
    });
    final input = _input(contents);
    final report = buildBugReportText(input, t);
    final connection = SlackConnection.parse(url);
    // The name at the end says who sent it; kept for the next sends.
    final typed = typedSlackSender.value;
    if (typed != null) setSlackSender(typed, persist: true);
    final footer = slackFooterFor(t, slackSenderFor(widget.store));
    final error = await sendToSlack(
      connection.webhook,
      markdown: toSlackMarkdown(report, cutNote: t.slackCutNote, footer: footer),
      text: toSlackText(report, cutNote: t.slackCutNote, footer: footer),
    );
    if (!mounted) return;
    if (error != null) {
      setState(() {
        _busy = false;
        _sendingSlack = false;
        _notice = (t.slackFailed(error), CalloutTone.warning, null);
      });
      return;
    }
    _drafts[widget.store] = null;
    final shot = _sendsShot ? _shot : null;
    String? shotWhy;
    if (shot != null) {
      if (!connection.uploads) {
        shotWhy = t.slackShotNoKey;
      } else {
        Uint8List? bytes;
        try {
          bytes = await snapshotPng(shot);
        } catch (_) {}
        final stem = bugFileStem(input.appName, DateTime.fromMicrosecondsSinceEpoch((_now * 1000).round()));
        final problem = bytes == null || bytes.isEmpty
            ? const SlackShotError(SlackShotProblem.rejected, 'PNG')
            : await sendScreenshotToSlack(connection, bytes,
                title: '${t.bugScreenshot} · ${bugSubject(input, t)}', fileName: '$stem.png');
        if (problem != null) shotWhy = slackShotReason(problem, t);
      }
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _sendingSlack = false;
      if (shotWhy != null) _notice = (t.slackShotNotSent, CalloutTone.warning, t.slackShotWhy(shotWhy));
    });
    if (shotWhy != null) return;
    messenger?.hideCurrentSnackBar();
    messenger?.showSnackBar(SnackBar(
        content: Text(shot != null ? t.slackSentWithShot : t.slackSent), duration: const Duration(milliseconds: 1600)));
    if (navigator.canPop()) navigator.pop();
  }

  void _setBefore(int seconds) {
    _lastBefore[widget.store] = seconds;
    setState(() {
      _before = seconds;
      _notice = null;
    });
  }

  void _setMask(bool v) {
    rememberShareMask(widget.store, v);
    setState(() {
      _mask = v;
      _notice = null;
    });
  }

  Future<void> _enlarge() async {
    final image = _shot;
    if (image == null) return;
    await showScreenshotDialog(context, image);
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Scaffold(
      backgroundColor: c.bgApp,
      appBar: AppBar(title: Text(t.bugReport)),
      body: ListenableBuilder(
        listenable: widget.store,
        builder: (context, _) {
          final contents = collectBugContents(widget.store, _window, anchor: widget.anchor);
          final off = widget.utcOffsetMinutes;
          final range = '${bugClock(_window.fromMs, off)} – ${bugClock(_window.toMs, off)}';
          final slackUrl = slackWebhookFor(widget.store);
          final going = <String>[
            if (_parts.logs) t.bugLogs(contents.totalLines),
            if (_parts.requests) t.bugFailed(contents.totalFailed),
            if (_sendsShot) t.bugScreenshotWord,
          ];
          final summary = going.isEmpty ? t.bugSummaryNoteOnly : going.join(' · ');
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Expanded(
                child: Scrollbar(
                  controller: _scroll,
                  child: ListView(
                    key: const ValueKey<String>('durbun-bug-list'),
                    controller: _scroll,
                    keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                    padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, DurbunSpace.md, DurbunSpace.gutter, DurbunSpace.lg),
                    children: <Widget>[
                      _MomentCard(anchor: widget.anchor, momentMs: _moment, utcOffsetMinutes: off),
                      SectionTitle(t.bugNoteLabel),
                      _NoteField(controller: _note, enabled: !_busy),
                      // Who sends it to Slack (at the message's end).
                      if (slackUrl != null) ...<Widget>[
                        const SizedBox(height: 10),
                        SlackSenderField(store: widget.store, enabled: !_busy),
                      ],
                      SectionTitle(t.bugContents),
                      _WindowChoice(before: _before, range: range, onChanged: _busy ? null : _setBefore),
                      const SizedBox(height: DurbunSpace.md),
                      if (contents.isEmpty) ...<Widget>[
                        Callout(title: t.bugEmptyTitle, body: t.bugEmptyBody),
                        const SizedBox(height: DurbunSpace.md),
                      ],
                      _ContentsCard(
                        store: widget.store,
                        anchor: widget.anchor,
                        contents: contents,
                        parts: _parts,
                        fileOffered: canShareNatively,
                        onParts: _busy ? null : _setParts,
                        shot: _shot,
                        shotAt: _shotAt,
                        withShot: _withShot,
                        onToggleShot: _busy ? null : () => setState(() => _withShot = !_withShot),
                        onEnlarge: _enlarge,
                      ),
                      const SizedBox(height: DurbunSpace.md),
                      _Card(
                        child: SheetSwitch(
                          label: t.shareMask,
                          hint: t.bugMaskHint,
                          icon: Icons.visibility_off_outlined,
                          value: _mask,
                          onChanged: (v) {
                            if (!_busy) _setMask(v);
                          },
                        ),
                      ),
                      const SizedBox(height: DurbunSpace.sm),
                      _PreviewToggle(open: _preview, onTap: () => setState(() => _preview = !_preview)),
                      if (_preview) _Preview(text: buildBugReportText(_input(contents), t)),
                    ],
                  ),
                ),
              ),
              _Footer(
                summary: summary,
                notice: _notice,
                busy: _busy,
                sendingSlack: _sendingSlack,
                slack: slackUrl != null,
                onCopy: _busy ? null : () => _copy(contents),
                onSend: _busy ? null : () => unawaited(_send(contents)),
                onSlack: _busy || slackUrl == null ? null : () => unawaited(_slack(contents, slackUrl)),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// A card of the page: the card surface, a 1 pt outline, the 12 pt radius.
class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
          color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: child,
    );
  }
}

/// What the report is about: the line or request (tinted like its card in
/// the lists), or the panel's opening.
class _MomentCard extends StatelessWidget {
  const _MomentCard({required this.anchor, required this.momentMs, this.utcOffsetMinutes});

  final BugAnchor anchor;
  final double momentMs;
  final int? utcOffsetMinutes;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final log = anchor.log;
    final call = anchor.call;
    final (IconData icon, String label, CardTone tone, Color ink, Color tint) = log != null
        ? log.isCrash
            ? (Icons.bolt_rounded, t.crash, CardTone.crash, c.danger, c.dangerSoft)
            : (Icons.error_outline_rounded, log.kind == 'flutter-error' ? t.reportFlutterError : t.bugMomentLog, CardTone.danger,
                c.danger, c.dangerSoft)
        : call != null
            ? (Icons.swap_vert_rounded, t.bugMomentRequest, CardTone.danger, c.danger, c.dangerSoft)
            : (Icons.schedule_rounded, t.bugMomentNow, CardTone.normal, c.accentInk, c.accentSoft);
    final detail = log != null
        ? log.message.trim().split('\n').first
        : call != null
            ? '${call.method.toUpperCase()} ${call.uri?.path.isNotEmpty == true ? call.uri!.path : call.url} → '
                '${call.status ?? t.bugMdFailedWord}'
            : null;
    // A line or a request to the millisecond, as in its list; the panel's
    // opening to the second.
    final time = anchor.isNow
        ? bugClock(momentMs, utcOffsetMinutes)
        : utcOffsetMinutes == null
            ? formatClock(momentMs)
            : '${bugClock(momentMs, utcOffsetMinutes)}.${(momentMs.round() % 1000).toString().padLeft(3, '0')}';
    return PanelCard(
      tone: tone,
      margin: EdgeInsets.zero,
      padding: const EdgeInsets.all(14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 40,
            height: 40,
            // The tile stands out from the tinted card: the ink at 14 %.
            decoration: BoxDecoration(
                color: Color.alphaBlend(ink.withValues(alpha: 0.14), Color.alphaBlend(tint, c.cardBg)),
                borderRadius: BorderRadius.circular(DurbunRadius.md)),
            child: Icon(icon, size: 22, color: ink),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Wrap(
                  spacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    Text(label, style: DurbunType.heading(size: DurbunType.label, color: c.text).copyWith(height: 1.3)),
                    Text(time, style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.textMuted, height: 1.3)),
                  ],
                ),
                const SizedBox(height: 4),
                if (detail != null)
                  Text(detail,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.text, height: 1.4))
                else
                  Text(t.bugMomentNowBody, style: DurbunType.ui(size: DurbunType.body, color: c.textMuted, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _NoteField extends StatelessWidget {
  const _NoteField({required this.controller, required this.enabled});

  final TextEditingController controller;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    OutlineInputBorder border(Color color, [double width = 1]) => OutlineInputBorder(
          borderRadius: BorderRadius.circular(DurbunRadius.md),
          borderSide: BorderSide(color: color, width: width),
        );
    return Semantics(
      label: t.bugNoteLabel,
      child: TextField(
        key: const ValueKey<String>('durbun-bug-note'),
        controller: controller,
        enabled: enabled,
        minLines: 3,
        maxLines: 8,
        textCapitalization: TextCapitalization.sentences,
        keyboardType: TextInputType.multiline,
        style: TextStyle(fontSize: DurbunType.bodyMd, color: c.text, height: 1.4),
        cursorColor: c.accent,
        decoration: InputDecoration(
          isDense: true,
          filled: true,
          fillColor: c.fieldBg,
          hintText: t.bugNoteHint,
          hintMaxLines: 3,
          hintStyle: TextStyle(fontSize: DurbunType.bodyMd, color: c.textSubtle, height: 1.4),
          contentPadding: const EdgeInsets.all(12),
          border: border(c.border),
          enabledBorder: border(c.border),
          disabledBorder: border(c.border),
          focusedBorder: border(c.accent, 1.5),
        ),
      ),
    );
  }
}

/// "Before the moment: 30 s · 1 min · 2 min · 5 min", what comes after and
/// the clock times the window covers.
class _WindowChoice extends StatelessWidget {
  const _WindowChoice({required this.before, required this.range, required this.onChanged});

  final int before;
  final String range;
  final ValueChanged<int>? onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final index = kBugBeforeChoices.indexOf(before);
    String label(int s) => s % 60 == 0 ? t.bugMinutes(s ~/ 60) : t.bugSeconds(s);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        ChoiceSegments(
          labels: <String>[for (final s in kBugBeforeChoices) label(s)],
          index: index < 0 ? 1 : index,
          onChanged: onChanged == null ? null : (i) => onChanged!(kBugBeforeChoices[i]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
          child: Text.rich(
            TextSpan(children: <InlineSpan>[
              TextSpan(text: '${t.bugWindowLine(label(before), kBugAfterS)} · '),
              TextSpan(text: range, style: DurbunType.monoStyle(size: DurbunType.monoSm, color: c.textMuted, height: 1.35)),
            ]),
            style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.35),
          ),
        ),
      ],
    );
  }
}

/// The parts of the report, one row each: the screenshot (with its
/// thumbnail and the button that leaves it out), the log lines, the failed
/// requests and the device and app facts.
class _ContentsCard extends StatelessWidget {
  const _ContentsCard({
    required this.store,
    required this.anchor,
    required this.contents,
    required this.parts,
    required this.fileOffered,
    required this.onParts,
    required this.shot,
    required this.shotAt,
    required this.withShot,
    required this.onToggleShot,
    required this.onEnlarge,
  });

  final DurbunInspectorStore store;
  final BugAnchor anchor;
  final BugContents contents;
  final BugParts parts;

  /// The .md file row (only where Share… can attach files).
  final bool fileOffered;
  final ValueChanged<BugParts>? onParts;
  final ui.Image? shot;
  final double? shotAt;
  final bool withShot;
  final VoidCallback? onToggleShot;
  final VoidCallback onEnlarge;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final errors = contents.lines.where((l) => l.isError && !l.isCrash).length;
    final crashes = contents.lines.where((l) => l.isCrash).length;
    final shown = contents.lines.length > kBugTextLines ? kBugTextLines : contents.lines.length;
    final logsHint = <String>[
      if (crashes > 0) t.bugCrashCount(crashes),
      if (errors > 0) t.errorCountShort(errors),
      if (contents.lines.length < contents.totalLines)
        t.bugLinesCapped(contents.lines.length, contents.totalLines)
      else if (shown < contents.totalLines)
        fileOffered && parts.file ? t.bugLinesInFile(shown) : t.bugLinesInText(shown),
    ].join(' · ');
    final failedHint = <String>[
      for (final call in contents.failed.reversed.take(2))
        '${call.method.toUpperCase()} ${call.uri?.path.isNotEmpty == true ? call.uri!.path : call.url} ${call.status ?? t.bugMdFailedWord}',
      if (contents.totalFailed > 2) '+${contents.totalFailed - 2}',
    ].join(' · ');
    final hello = store.hello;
    final app = hello?['app'] is Map ? hello!['app'] as Map : null;
    final device = hello?['device'];
    final os = device is Map
        ? <String>[
            switch (device['platform']) { 'ios' => 'iOS', 'android' => 'Android', _ => '' },
            '${device['osVersion'] ?? ''}',
          ].where((s) => s.isNotEmpty).join(' ')
        : '';
    final facts = <String>[
      if (app?['name'] != null) '${app!['name']}${app['version'] != null ? ' ${app['version']}' : ''}',
      if (deviceShortName(device) != null) deviceShortName(device)!,
      if (os.isNotEmpty) os,
      sdkLabel(hello)!.split(' · ').first,
    ].join(' · ');
    final onParts = this.onParts;
    ValueChanged<bool>? set(BugParts Function(bool v) change) => onParts == null ? null : (v) => onParts(change(v));
    Widget divider() => Divider(height: 1, indent: DurbunSpace.lg + 36, color: c.hairline);
    final request = anchor.call != null;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (anchor.log != null || request) ...<Widget>[
            _PartRow(
              key: const ValueKey<String>('durbun-bug-part-moment'),
              icon: request ? Icons.swap_vert_rounded : Icons.my_location_rounded,
              title: request ? t.bugPartMomentRequest : t.bugPartMoment,
              subtitle: request ? t.bugPartMomentRequestHint : t.bugPartMomentHint,
              value: parts.moment,
              onChanged: set((v) => parts.copyWith(moment: v)),
            ),
            divider(),
          ],
          ScreenshotRow(shot: shot, shotAt: shotAt, included: withShot, onToggle: onToggleShot, onEnlarge: onEnlarge),
          divider(),
          _PartRow(
            key: const ValueKey<String>('durbun-bug-part-logs'),
            icon: Icons.notes_rounded,
            title: contents.totalLines == 0 ? t.bugNoLogs : t.bugLogs(contents.totalLines),
            subtitle: logsHint.isEmpty ? null : logsHint,
            value: parts.logs,
            onChanged: set((v) => parts.copyWith(logs: v)),
          ),
          divider(),
          _PartRow(
            key: const ValueKey<String>('durbun-bug-part-requests'),
            icon: Icons.swap_vert_rounded,
            iconColor: contents.totalFailed > 0 ? c.danger : null,
            title: contents.totalFailed == 0 ? t.bugNoFailed : t.bugFailed(contents.totalFailed),
            subtitle: failedHint.isEmpty ? null : failedHint,
            value: parts.requests,
            onChanged: set((v) => parts.copyWith(requests: v)),
          ),
          divider(),
          _PartRow(
            key: const ValueKey<String>('durbun-bug-part-facts'),
            icon: Icons.smartphone_rounded,
            title: t.bugFacts,
            subtitle: facts,
            value: parts.facts,
            onChanged: set((v) => parts.copyWith(facts: v)),
          ),
          if (fileOffered) ...<Widget>[
            divider(),
            _PartRow(
              key: const ValueKey<String>('durbun-bug-part-file'),
              icon: Icons.description_outlined,
              title: t.bugPartFile,
              subtitle: t.bugPartFileHint,
              value: parts.file,
              onChanged: set((v) => parts.copyWith(file: v)),
            ),
          ],
        ],
      ),
    );
  }
}

/// One part of the report with its checkbox: the whole row toggles it; off,
/// it reads muted and says it stays out.
class _PartRow extends StatelessWidget {
  const _PartRow({
    super.key,
    required this.icon,
    required this.title,
    required this.value,
    required this.onChanged,
    this.iconColor,
    this.subtitle,
  });

  final IconData icon;
  final Color? iconColor;
  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final onChanged = this.onChanged;
    final sub = value ? subtitle : t.bugPartOut;
    return MergeSemantics(
      child: Pressable(
        onTap: onChanged == null ? null : () => onChanged(!value),
        builder: (pressed) => AnimatedContainer(
          duration: DurbunMotion.of(context, DurbunMotion.fast),
          color: pressed ? c.bgHover : Colors.transparent,
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsetsDirectional.fromSTEB(DurbunSpace.lg, 10, 6, 10),
          child: Row(
            children: <Widget>[
              Icon(icon, size: 22, color: value ? iconColor ?? c.textMuted : c.textSubtle),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(title,
                        style: TextStyle(
                            fontSize: DurbunType.label,
                            color: value ? c.text : c.textMuted,
                            fontWeight: FontWeight.w500,
                            height: 1.3)),
                    if (sub != null) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(sub, style: TextStyle(fontSize: DurbunType.body, color: c.textSubtle, height: 1.35)),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 4),
              Checkbox(
                value: value,
                onChanged: onChanged == null ? null : (v) => onChanged(v ?? false),
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Show the report": the text Slack and the clipboard get, below the parts.
class _PreviewToggle extends StatelessWidget {
  const _PreviewToggle({required this.open, required this.onTap});

  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: DButton(
        key: const ValueKey<String>('durbun-bug-preview'),
        kind: DButtonKind.ghost,
        icon: open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
        label: open ? t.bugPreviewHide : t.bugPreviewShow,
        onTap: onTap,
      ),
    );
  }
}

class _Preview extends StatelessWidget {
  const _Preview({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 2, 4, 8),
          child: Text(t.bugPreviewHint, style: DurbunType.ui(size: DurbunType.sm, color: c.textSubtle, height: 1.35)),
        ),
        Container(
          key: const ValueKey<String>('durbun-bug-preview-text'),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
              color: c.cardBg, border: Border.all(color: c.border), borderRadius: BorderRadius.circular(DurbunRadius.lg)),
          child: Text(text, style: DurbunType.monoStyle(size: 11.5, color: c.text, height: 1.4)),
        ),
      ],
    );
  }
}

/// Pinned under the page: what goes (counts), a notice from the last try,
/// Copy and the one main action, Share…; with a Slack connection, Send to
/// Slack is the main action, full width above them.
class _Footer extends StatelessWidget {
  const _Footer({
    required this.summary,
    required this.notice,
    required this.busy,
    required this.sendingSlack,
    required this.slack,
    required this.onCopy,
    required this.onSend,
    required this.onSlack,
  });

  final String summary;
  final (String, CalloutTone, String?)? notice;
  final bool busy;
  final bool sendingSlack;
  final bool slack;
  final VoidCallback? onCopy;
  final VoidCallback? onSend;
  final VoidCallback? onSlack;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final bottom = MediaQuery.paddingOf(context).bottom;
    final share = canShareNatively;
    return Container(
      decoration: BoxDecoration(color: c.bgPanel, border: Border(top: BorderSide(color: c.hairline))),
      padding: EdgeInsets.fromLTRB(DurbunSpace.gutter, 10, DurbunSpace.gutter, 12 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (notice != null) ...<Widget>[
            Callout(title: notice!.$1, tone: notice!.$2, body: notice!.$3),
            const SizedBox(height: 10),
          ],
          LayoutBuilder(builder: (context, box) {
            // Wide (landscape, a tablet): the counts beside the buttons, so
            // the page keeps its height for the contents.
            final wide = box.maxWidth >= 600;
            final text = Semantics(
              liveRegion: true,
              child: Text(summary,
                  key: const ValueKey<String>('durbun-bug-summary'),
                  textAlign: wide ? TextAlign.start : TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, weight: FontWeight.w500, height: 1.35)),
            );
            final row = Row(
              children: <Widget>[
                Expanded(
                  child: DButton(large: true, primary: !share && !slack, icon: Icons.copy_rounded, label: t.copy, onTap: onCopy),
                ),
                if (share) ...<Widget>[
                  const SizedBox(width: 10),
                  Expanded(
                    child: DButton(
                      large: true,
                      primary: !slack,
                      icon: defaultTargetPlatform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded,
                      label: busy && !sendingSlack ? t.exportPreparing : t.shareSend,
                      onTap: onSend,
                    ),
                  ),
                ],
              ],
            );
            final Widget buttons = !slack
                ? row
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      DButton(
                        key: const ValueKey<String>('durbun-bug-slack'),
                        large: true,
                        primary: true,
                        icon: Icons.send_rounded,
                        label: sendingSlack ? t.slackSending : t.slackSend,
                        onTap: onSlack,
                      ),
                      const SizedBox(height: 10),
                      row,
                    ],
                  );
            if (wide) {
              return Row(
                children: <Widget>[
                  Expanded(child: text),
                  const SizedBox(width: 16),
                  SizedBox(width: box.maxWidth * 0.5, child: buttons),
                ],
              );
            }
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[text, const SizedBox(height: 8), buttons],
            );
          }),
        ],
      ),
    );
  }
}
