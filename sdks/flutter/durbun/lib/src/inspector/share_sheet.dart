/// "Share request", "Share log line" and "Share message": the share report with its options,
/// a preview, Copy, the system share sheet (through the plugin's own channel,
/// no extra package) and Send to Slack when the app set a webhook.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_snapshot.dart' show panelOpeningOf;
import 'bug_report.dart' show BugAnchor, bugFileStem, isReportedFailure;
import 'bug_report_view.dart' show openBugReport;
import 'filter_ui.dart' show SheetSwitch;
import 'screenshot_attach.dart';
import 'share_report.dart';
import 'slack.dart';
import 'slack_sender.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// The share options last used with this store (per app run).
final Expando<ShareOptions> _lastOptions = Expando<ShareOptions>('durbunShareOptions');

ShareOptions shareOptionsOf(DurbunInspectorStore store) => _lastOptions[store] ?? const ShareOptions();

/// Keeps the masking switch's state for the next share with [store] (one
/// switch for every share of a run: a request, a log line, a bug report).
void rememberShareMask(DurbunInspectorStore store, bool mask) =>
    _lastOptions[store] = shareOptionsOf(store).copyWith(mask: mask);

/// "Shop 2.4.1 (com.example.shop)" from the app's hello, or null.
String? hostAppLabel(DurbunInspectorStore store) {
  final app = store.hello?['app'];
  if (app is! Map) return null;
  final text = '${app['name'] ?? ''} ${app['version'] ?? ''} (${app['id'] ?? ''})'.trim();
  return text == '()' ? null : text;
}

/// The app's device from its hello, or null.
String? hostDeviceLabel(DurbunInspectorStore store) {
  final device = store.hello?['device'];
  return device is Map ? deviceLabel(device) : null;
}

/// "iPhone 16 Pro (iPhone17,1) · iOS 18.2", like the desktop: the name reads
/// better than a model identifier. A simulator's model is its CPU (`arm64`),
/// which says nothing about the device.
String deviceLabel(Map<dynamic, dynamic> device) {
  final name = device['name'] as String?;
  var model = device['model'] as String?;
  if (model == name || const <String>{'arm64', 'arm64e', 'x86_64', 'i386'}.contains(model)) model = null;
  final who = name != null && name.isNotEmpty ? (model != null ? '$name ($model)' : name) : (model ?? '');
  final platform = switch (device['platform']) { 'ios' => 'iOS', 'android' => 'Android', _ => '' };
  final os = [platform, device['osVersion'] ?? ''].where((s) => '$s'.isNotEmpty).join(' ');
  return [who, os].where((s) => s.isNotEmpty).join(' · ');
}

/// The report for [call] with the options last used in this store.
String shareReportFor(BuildContext context, InspectorCall call, DurbunInspectorStore store, [ShareOptions? options]) =>
    buildShareReport(
      shareInputForCall(call, app: hostAppLabel(store), device: hostDeviceLabel(store)),
      options ?? shareOptionsOf(store),
      InspectorStrings.of(context),
    );

/// Android and iOS have a system share sheet behind the plugin channel.
bool get canShareNatively =>
    !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);

const MethodChannel _native = MethodChannel('dev.durbun/native');

/// Opens the system share sheet with [text]; false when it could not open.
Future<bool> shareTextNatively(String text, {String? subject}) async {
  try {
    return await _invokeShare('share', <String, Object?>{'text': text, 'subject': subject});
  } catch (_) {
    return false;
  }
}

/// Opens the system share sheet with the file at [path] (a session export
/// in the cache directory's `durbun-export` folder; the plugin refuses any
/// other path); false when it could not open (no plugin, web, tests).
/// A file, not text: Android cannot pass more than about 1 MB of text.
Future<bool> shareFileNatively(String path, {required String mime, String? subject}) async {
  try {
    return await _native.invokeMethod<bool>('shareFile', <String, Object?>{'path': path, 'mime': mime, 'subject': subject}) ??
        false;
  } catch (_) {
    return false;
  }
}

/// Replaces the native share calls (tests): gets the method and its
/// arguments, returns what the plugin would.
@visibleForTesting
Future<bool?> Function(String method, Map<String, Object?> args)? debugShareHandler;

Future<bool> _invokeShare(String method, Map<String, Object?> args) async {
  final handler = debugShareHandler;
  if (handler != null) return await handler(method, args) ?? false;
  return await _native.invokeMethod<bool>(method, args) ?? false;
}

/// How [shareFilesNatively] went.
enum FilesShareOutcome {
  /// The share sheet opened with the text and the files.
  files,

  /// Only the text went (no files, or a host without `shareFiles`).
  textOnly,

  /// Nothing opened.
  failed,
}

/// Opens one system share sheet with [text] and the files at [paths]
/// (exports in the cache directory's `durbun-export` folder; `mimes[i]` is
/// the type of `paths[i]`). Falls back to the text alone when the host
/// cannot share files (an older plugin build, tests, the web) or refuses
/// them; never throws.
Future<FilesShareOutcome> shareFilesNatively({
  required String text,
  String? subject,
  List<String> paths = const <String>[],
  List<String>? mimes,
  String? textOnly,
}) async {
  if (paths.isNotEmpty) {
    try {
      final opened = await _invokeShare('shareFiles', <String, Object?>{
        'text': text,
        'subject': subject,
        'paths': paths,
        if (mimes != null) 'mimes': mimes,
      });
      if (opened) return FilesShareOutcome.files;
    } catch (_) {
      // MissingPluginException / notImplemented: an older host; the text alone below.
    }
  }
  try {
    if (await _invokeShare('share', <String, Object?>{'text': textOnly ?? text, 'subject': subject})) {
      return FilesShareOutcome.textOnly;
    }
  } catch (_) {}
  return FilesShareOutcome.failed;
}

/// The report for [log] (the app and device from the store's hello); secret
/// values in its data are masked unless the last share turned masking off.
String logShareReportFor(BuildContext context, InspectorLog log, DurbunInspectorStore store, {bool? mask}) {
  final t = InspectorStrings.of(context);
  return buildLogReport(logShareInputFor(log, t, app: hostAppLabel(store), device: hostDeviceLabel(store)), t,
      mask: mask ?? shareOptionsOf(store).mask);
}

Future<void> _showSheet(BuildContext context, Widget sheet) {
  FocusManager.instance.primaryFocus?.unfocus();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: DurbunColors.of(context).bgPanel,
    builder: (routeContext) => DurbunTheme.wrap(routeContext, sheet),
  );
}

Future<void> showShareSheet(BuildContext context, InspectorCall call, DurbunInspectorStore store) => _showSheet(
    context,
    _ShareSheet(
      call: call,
      store: store,
      onBug: isReportedFailure(call) && !store.readOnly ? () => openBugReport(context, store, BugAnchor.request(call)) : null,
    ));

/// "Share log line": the log report with Copy, Share… and Send to Slack.
Future<void> showLogShareSheet(BuildContext context, InspectorLog log, DurbunInspectorStore store) => _showSheet(
    context,
    _LogShareSheet(
      log: log,
      store: store,
      onBug: log.isError && !store.readOnly ? () => openBugReport(context, store, BugAnchor.log(log)) : null,
    ));

/// "Share message": one WebSocket message or event-stream event, masked by
/// default (the switch is the one every share of the run uses).
Future<void> showStreamMessageShareSheet(
        BuildContext context, InspectorCall call, InspectorStreamMessage message, DurbunInspectorStore store) =>
    _showSheet(context, _MessageShareSheet(call: call, message: message, store: store));

class _MessageShareSheet extends StatefulWidget {
  const _MessageShareSheet({required this.call, required this.message, required this.store});

  final InspectorCall call;
  final InspectorStreamMessage message;
  final DurbunInspectorStore store;

  @override
  State<_MessageShareSheet> createState() => _MessageShareSheetState();
}

class _MessageShareSheetState extends State<_MessageShareSheet> {
  late ShareOptions _options = shareOptionsOf(widget.store);

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final m = widget.message;
    final sse = (widget.call.connectionKind ?? StreamKind.webSocket) == StreamKind.sse;
    final path = widget.call.uri?.path ?? widget.call.url;
    return _ReportSheet(
      title: sse ? t.shareEventTitle : t.shareMessageTitle,
      description: t.shareMessageDescription,
      report: buildStreamMessageReport(widget.call, m, t,
          mask: _options.mask, app: hostAppLabel(widget.store), device: hostDeviceLabel(widget.store)),
      subject: '${sse ? 'SSE' : 'WebSocket'} ${path.isEmpty ? '/' : path} · ${sse ? t.eventTitle(m.seq) : t.messageTitle(m.seq)}',
      store: widget.store,
      options: <Widget>[
        SheetSwitch(
            label: t.shareMask,
            hint: t.shareMessageMaskHint,
            icon: Icons.visibility_off_outlined,
            value: _options.mask,
            onChanged: (v) {
              final o = _options.copyWith(mask: v);
              _lastOptions[widget.store] = o;
              setState(() => _options = o);
            }),
      ],
    );
  }
}

class _ShareSheet extends StatefulWidget {
  const _ShareSheet({required this.call, required this.store, this.onBug});

  final InspectorCall call;
  final DurbunInspectorStore store;
  final VoidCallback? onBug;

  @override
  State<_ShareSheet> createState() => _ShareSheetState();
}

class _ShareSheetState extends State<_ShareSheet> {
  late ShareOptions _options = shareOptionsOf(widget.store);

  void _set(ShareOptions o) {
    _lastOptions[widget.store] = o;
    setState(() => _options = o);
  }

  String get _subject {
    final c = widget.call;
    final path = c.uri?.path ?? c.url;
    return '${c.method} ${path.isEmpty ? '/' : path} → ${c.status ?? (c.error != null ? 'error' : '…')}';
  }

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return _ReportSheet(
      title: t.shareTitle,
      description: t.shareDescription,
      report: shareReportFor(context, widget.call, widget.store, _options),
      subject: _subject,
      store: widget.store,
      onBug: widget.onBug,
      screenshot: true,
      options: <Widget>[
        SheetSwitch(
            label: t.shareMask,
            hint: t.shareMaskHint,
            icon: Icons.visibility_off_outlined,
            value: _options.mask,
            onChanged: (v) => _set(_options.copyWith(mask: v))),
        SheetSwitch(
            label: t.shareBodies,
            icon: Icons.data_object_rounded,
            value: _options.bodies,
            onChanged: (v) => _set(_options.copyWith(bodies: v))),
        SheetSwitch(
            label: t.shareCurl,
            icon: Icons.terminal_rounded,
            value: _options.curl,
            onChanged: (v) => _set(_options.copyWith(curl: v))),
      ],
    );
  }
}

class _LogShareSheet extends StatefulWidget {
  const _LogShareSheet({required this.log, required this.store, this.onBug});

  final InspectorLog log;
  final DurbunInspectorStore store;
  final VoidCallback? onBug;

  @override
  State<_LogShareSheet> createState() => _LogShareSheetState();
}

class _LogShareSheetState extends State<_LogShareSheet> {
  late ShareOptions _options = shareOptionsOf(widget.store);

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final log = widget.log;
    final first = log.message.split('\n').first;
    return _ReportSheet(
      title: t.shareLogTitle,
      description: t.shareLogDescription,
      report: logShareReportFor(context, log, widget.store, mask: _options.mask),
      subject: '${log.level.toUpperCase()} ${first.length > 80 ? '${first.substring(0, 80)}…' : first}',
      store: widget.store,
      onBug: widget.onBug,
      screenshot: true,
      // Only structured data has field names to mask.
      options: <Widget>[
        if (log.data != null)
          SheetSwitch(
              label: t.shareMask,
              hint: t.shareLogMaskHint,
              icon: Icons.visibility_off_outlined,
              value: _options.mask,
              onChanged: (v) {
                final o = _options.copyWith(mask: v);
                _lastOptions[widget.store] = o;
                setState(() => _options = o);
              }),
      ],
    );
  }
}

/// Title, options and the preview scroll together (landscape, large text);
/// the buttons stay pinned under them.
class _ReportSheet extends StatefulWidget {
  const _ReportSheet({
    required this.title,
    required this.description,
    required this.report,
    required this.subject,
    required this.store,
    this.options = const <Widget>[],
    this.onBug,
    this.screenshot = false,
  });

  final String title;
  final String description;
  final String report;
  final String subject;
  final DurbunInspectorStore store;
  final List<Widget> options;

  /// Opens "Report a bug" about the same moment (a failure, an error).
  final VoidCallback? onBug;

  /// Offers the app's screenshot from when the panel opened (in by
  /// default, left out with one tap), when there is one.
  final bool screenshot;

  @override
  State<_ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<_ReportSheet> {
  final ScrollController _scroll = ScrollController();

  /// The tester's own message, above the report wherever it goes.
  final TextEditingController _note = TextEditingController();

  /// The report's size, measured again only when the report changes.
  String? _sized;
  int _reportBytes = 0;

  /// A handle of the sheet's own on the opening's picture, and when.
  ui.Image? _shot;
  double? _shotAt;
  bool _withShot = true;

  @override
  void initState() {
    super.initState();
    _note.addListener(_noteChanged);
    if (widget.screenshot) {
      final opening = panelOpeningOf(widget.store);
      _shot = opening?.cloneImage();
      _shotAt = _shot == null ? null : opening!.atMs;
    }
  }

  void _noteChanged() => setState(() {});

  @override
  void dispose() {
    _note.removeListener(_noteChanged);
    _note.dispose();
    _scroll.dispose();
    try {
      _shot?.dispose();
    } catch (_) {}
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final slackUrl = slackWebhookFor(widget.store);
    final slack = slackUrl != null;
    final shot = _shot;
    final note = _note.text.trim();
    final report = withShareNote(widget.report, note);
    if (!identical(_sized, widget.report)) {
      _sized = widget.report;
      _reportBytes = utf8.encode(widget.report).length;
    }
    final added = report.length - widget.report.length;
    final bytes = _reportBytes + (added == 0 ? 0 : utf8.encode(report.substring(0, added)).length);
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
                      child: Text(widget.title, style: DurbunType.heading(color: c.text)),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                      child: Text(widget.description, style: DurbunType.ui(size: DurbunType.body, height: 1.4, color: c.textMuted)),
                    ),
                    if (widget.onBug != null) _BugRow(onTap: () {
                      Navigator.of(context).pop();
                      widget.onBug!();
                    }),
                    ...widget.options,
                    if (shot != null)
                      Container(
                        key: const ValueKey<String>('durbun-share-shot'),
                        margin: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                        decoration: BoxDecoration(
                            color: c.cardBg,
                            borderRadius: BorderRadius.circular(DurbunRadius.lg),
                            border: Border.all(color: c.border)),
                        child: ScreenshotRow(
                          shot: shot,
                          shotAt: _shotAt,
                          included: _withShot,
                          outText: t.shareScreenshotOut,
                          // Slack takes it only with the upload key: said
                          // before sending, Share… still sends it.
                          note: slack && !SlackConnection.parse(slackUrl).uploads ? t.shareShotSlackNoKey : null,
                          onToggle: () => setState(() => _withShot = !_withShot),
                          onEnlarge: () => unawaited(showScreenshotDialog(context, shot)),
                        ),
                      ),
                    // A word from the tester above the report; with Slack,
                    // who sends it (at the message's end).
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                      child: SectionTitle(t.shareNoteLabel),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: PanelTextField(
                        key: const ValueKey<String>('durbun-share-note'),
                        controller: _note,
                        label: t.shareNoteLabel,
                        hint: t.shareNoteHint,
                        minLines: 2,
                        maxLines: 5,
                      ),
                    ),
                    if (slack)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                        child: SlackSenderField(store: widget.store),
                      ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: SectionTitle(t.preview,
                          trailing: Text(shareBytes(bytes), style: DurbunType.monoStyle(size: 11.5, color: c.textSubtle))),
                    ),
                    // What the teammate gets, exactly: the note as a quote,
                    // then the report (its text unchanged while typing).
                    Container(
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                          color: c.cardBg,
                          border: Border.all(color: c.border),
                          borderRadius: BorderRadius.circular(DurbunRadius.lg)),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          if (note.isNotEmpty) ...<Widget>[
                            Text(withShareNote('', note).trimRight(),
                                style: DurbunType.monoStyle(size: 11.5, color: c.accentInk, height: 1.4)),
                            const SizedBox(height: 16),
                          ],
                          Text(widget.report, style: DurbunType.monoStyle(size: 11.5, color: c.text, height: 1.4)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          ShareActions(report: report, subject: widget.subject, store: widget.store, screenshot: _withShot ? shot : null),
        ],
      ),
    );
  }
}

/// "Report a bug…" on a share sheet: the same moment, with the logs around
/// it and the screenshot, as a card of its own above the options.
class _BugRow extends StatelessWidget {
  const _BugRow({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Container(
      key: const ValueKey<String>('durbun-share-bug'),
      margin: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
          color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: ListRow(
        icon: Icons.bug_report_outlined,
        iconColor: c.danger,
        title: t.bugReportEllipsis,
        subtitle: t.bugFromShareHint,
        onTap: onTap,
      ),
    );
  }
}

/// Copy, the system share sheet and, when the app set a Slack webhook, Send
/// to Slack: the buttons pinned under a share preview. With a [screenshot],
/// Share… sends it as a PNG beside the text and Send to Slack uploads it
/// after the report when the connection has the upload key; Copy copies the
/// text (a clipboard holds no picture next to it).
class ShareActions extends StatefulWidget {
  const ShareActions({super.key, required this.report, required this.subject, required this.store, this.screenshot});

  final String report;
  final String subject;
  final DurbunInspectorStore store;

  /// The app's screenshot to send along, or null. The caller owns it.
  final ui.Image? screenshot;

  @override
  State<ShareActions> createState() => _ShareActionsState();
}

class _ShareActionsState extends State<ShareActions> {
  bool _sending = false;

  /// Share… is writing the screenshot file.
  bool _preparing = false;

  /// What the last send said, above the buttons: the title, the tone, a line.
  (String, CalloutTone, String?)? _notice;

  /// `durbun-shot-pati-20261119-165702.png`.
  String get _shotName {
    final app = widget.store.hello?['app'];
    final name = app is Map ? app['name'] : null;
    return '${bugFileStem(name is String ? name : null, DateTime.now(), kind: 'shot')}.png';
  }

  Future<Uint8List?> _shotBytes(ui.Image shot) async {
    try {
      final bytes = await snapshotPng(shot);
      return bytes == null || bytes.isEmpty ? null : bytes;
    } catch (_) {
      return null;
    }
  }

  void _copy() {
    final t = InspectorStrings.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    Clipboard.setData(ClipboardData(text: widget.report));
    Navigator.of(context).pop();
    messenger?.hideCurrentSnackBar();
    messenger?.showSnackBar(SnackBar(content: Text(t.shareCopied), duration: const Duration(milliseconds: 1400)));
  }

  Future<void> _share() async {
    final t = InspectorStrings.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    final shot = widget.screenshot;
    bool opened;
    var textOnly = false;
    if (shot == null) {
      opened = await shareTextNatively(widget.report, subject: widget.subject);
    } else {
      setState(() {
        _preparing = true;
        _notice = null;
      });
      String? path;
      final bytes = await _shotBytes(shot);
      if (bytes != null) {
        try {
          path = await writeSnapshotFile(_shotName, bytes);
        } catch (_) {}
      }
      final outcome = await shareFilesNatively(
        text: widget.report,
        subject: widget.subject,
        paths: <String>[if (path != null) path],
        mimes: <String>[if (path != null) 'image/png'],
      );
      if (!mounted) return;
      setState(() => _preparing = false);
      opened = outcome != FilesShareOutcome.failed;
      textOnly = outcome == FilesShareOutcome.textOnly;
    }
    if (!mounted) return;
    messenger?.hideCurrentSnackBar();
    if (!opened) {
      // No share sheet (old plugin build, an embedder without it): the clipboard still works.
      await Clipboard.setData(ClipboardData(text: widget.report));
      messenger?.showSnackBar(SnackBar(content: Text(t.shareFallback), duration: const Duration(seconds: 3)));
    } else if (textOnly) {
      messenger?.showSnackBar(SnackBar(content: Text(t.shareShotTextOnly), duration: const Duration(seconds: 3)));
    }
    if (navigator.canPop()) navigator.pop();
  }

  /// Posts only on this tap; the sheet stays open when it fails, so the
  /// report can still be copied or shared. The screenshot goes after the
  /// report when the connection has the upload key; when only it failed,
  /// the sheet stays and says why, so Share… can still send it.
  Future<void> _slack(String url) async {
    final t = InspectorStrings.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    setState(() {
      _sending = true;
      _notice = null;
    });
    final connection = SlackConnection.parse(url);
    // The name at the end says who sent it; kept for the next sends.
    final sender = slackSenderFor(widget.store);
    final typed = typedSlackSender.value;
    if (typed != null) setSlackSender(typed, persist: true);
    final footer = slackFooterFor(t, sender);
    // Rich text, as a report pasted into Slack shows; the mrkdwn text is the
    // fallback for a workspace that refuses blocks.
    final error = await sendToSlack(
      connection.webhook,
      markdown: toSlackMarkdown(widget.report, cutNote: t.slackCutNote, footer: footer),
      text: toSlackText(widget.report, cutNote: t.slackCutNote, footer: footer),
    );
    if (!mounted) return;
    if (error != null) {
      setState(() => _sending = false);
      messenger?.hideCurrentSnackBar();
      messenger?.showSnackBar(SnackBar(content: Text(t.slackFailed(error)), duration: const Duration(seconds: 5)));
      return;
    }
    // Without the key the sheet said beforehand that Slack takes text only.
    final shot = connection.uploads ? widget.screenshot : null;
    String? why;
    if (shot != null) {
      final bytes = await _shotBytes(shot);
      final problem = bytes == null
          ? const SlackShotError(SlackShotProblem.rejected, 'PNG')
          : await sendScreenshotToSlack(connection, bytes, title: '${t.bugScreenshot} · ${widget.subject}', fileName: _shotName);
      if (problem != null) why = slackShotReason(problem, t);
    }
    if (!mounted) return;
    setState(() {
      _sending = false;
      if (why != null) _notice = (t.slackShotNotSent, CalloutTone.warning, t.slackShotWhy(why));
    });
    if (why != null) return;
    messenger?.hideCurrentSnackBar();
    if (navigator.canPop()) navigator.pop();
    messenger?.showSnackBar(
        SnackBar(content: Text(shot != null ? t.slackSentWithShot : t.slackSent), duration: const Duration(milliseconds: 1600)));
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final bottom = MediaQuery.paddingOf(context).bottom;
    final webhook = slackWebhookFor(widget.store);
    final busy = _sending || _preparing;
    return Container(
      decoration: BoxDecoration(color: c.bgPanel, border: Border(top: BorderSide(color: c.hairline))),
      padding: EdgeInsets.fromLTRB(16, 10, 16, 12 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (_notice != null) ...<Widget>[
            Callout(title: _notice!.$1, tone: _notice!.$2, body: _notice!.$3),
            const SizedBox(height: 10),
          ],
          if (webhook != null) ...<Widget>[
            DButton(
                large: true,
                primary: true,
                icon: Icons.send_rounded,
                label: _sending ? t.slackSending : t.slackSend,
                onTap: busy ? null : () => _slack(webhook)),
            const SizedBox(height: 10),
          ],
          Row(
            children: <Widget>[
              Expanded(
                child: DButton(
                    large: true,
                    primary: webhook == null && !canShareNatively,
                    icon: Icons.copy_rounded,
                    label: t.copy,
                    onTap: busy ? null : _copy),
              ),
              if (canShareNatively) ...<Widget>[
                const SizedBox(width: 10),
                Expanded(
                  child: DButton(
                      large: true,
                      primary: webhook == null,
                      icon: defaultTargetPlatform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded,
                      label: _preparing ? t.exportPreparing : t.shareSend,
                      onTap: busy ? null : () => unawaited(_share())),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
