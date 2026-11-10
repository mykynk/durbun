/// "Share request" and "Share log line": the share report with its options,
/// a preview, Copy, the system share sheet (through the plugin's own channel,
/// no extra package) and Send to Slack when the app set a webhook.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'filter_ui.dart' show SheetSwitch;
import 'share_report.dart';
import 'slack.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// The share options last used with this store (per app run).
final Expando<ShareOptions> _lastOptions = Expando<ShareOptions>('durbunShareOptions');

ShareOptions shareOptionsOf(DurbunInspectorStore store) => _lastOptions[store] ?? const ShareOptions();

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
    return await _native.invokeMethod<bool>('share', <String, Object?>{'text': text, 'subject': subject}) ?? false;
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

/// The report for [log] (the app and device from the store's hello).
String logShareReportFor(BuildContext context, InspectorLog log, DurbunInspectorStore store) {
  final t = InspectorStrings.of(context);
  return buildLogReport(logShareInputFor(log, t, app: hostAppLabel(store), device: hostDeviceLabel(store)), t);
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

Future<void> showShareSheet(BuildContext context, InspectorCall call, DurbunInspectorStore store) =>
    _showSheet(context, _ShareSheet(call: call, store: store));

/// "Share log line": the log report with Copy, Share… and Send to Slack.
Future<void> showLogShareSheet(BuildContext context, InspectorLog log, DurbunInspectorStore store) =>
    _showSheet(context, _LogShareSheet(log: log, store: store));

class _ShareSheet extends StatefulWidget {
  const _ShareSheet({required this.call, required this.store});

  final InspectorCall call;
  final DurbunInspectorStore store;

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

class _LogShareSheet extends StatelessWidget {
  const _LogShareSheet({required this.log, required this.store});

  final InspectorLog log;
  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final first = log.message.split('\n').first;
    return _ReportSheet(
      title: t.shareLogTitle,
      description: t.shareLogDescription,
      report: logShareReportFor(context, log, store),
      subject: '${log.level.toUpperCase()} ${first.length > 80 ? '${first.substring(0, 80)}…' : first}',
      store: store,
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
  });

  final String title;
  final String description;
  final String report;
  final String subject;
  final DurbunInspectorStore store;
  final List<Widget> options;

  @override
  State<_ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<_ReportSheet> {
  final ScrollController _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
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
                      child: Text(widget.title, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: c.text)),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                      child: Text(widget.description, style: TextStyle(fontSize: 12.5, height: 1.35, color: c.textMeta)),
                    ),
                    ...widget.options,
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: SectionTitle(t.preview,
                          trailing: Text(shareBytes(utf8.encode(widget.report).length), style: DurbunType.monoStyle(size: 11, color: c.textMeta))),
                    ),
                    // What the teammate gets, exactly.
                    Container(
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                          color: c.cardBg, border: Border.all(color: c.border), borderRadius: BorderRadius.circular(DurbunRadius.lg)),
                      child: Text(widget.report, style: DurbunType.monoStyle(size: 11.5, color: c.text, height: 1.4)),
                    ),
                  ],
                ),
              ),
            ),
          ),
          ShareActions(report: widget.report, subject: widget.subject, store: widget.store),
        ],
      ),
    );
  }
}

/// Copy, the system share sheet and, when the app set a Slack webhook, Send
/// to Slack: the buttons pinned under a share preview.
class ShareActions extends StatefulWidget {
  const ShareActions({super.key, required this.report, required this.subject, required this.store});

  final String report;
  final String subject;
  final DurbunInspectorStore store;

  @override
  State<ShareActions> createState() => _ShareActionsState();
}

class _ShareActionsState extends State<ShareActions> {
  bool _sending = false;

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
    final opened = await shareTextNatively(widget.report, subject: widget.subject);
    if (!mounted) return;
    if (!opened) {
      // No share sheet (old plugin build, an embedder without it): the clipboard still works.
      await Clipboard.setData(ClipboardData(text: widget.report));
      messenger?.hideCurrentSnackBar();
      messenger?.showSnackBar(SnackBar(content: Text(t.shareFallback), duration: const Duration(seconds: 3)));
    }
    if (navigator.canPop()) navigator.pop();
  }

  /// Posts only on this tap; the sheet stays open when it fails, so the
  /// report can still be copied or shared.
  Future<void> _slack(String webhook) async {
    final t = InspectorStrings.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    setState(() => _sending = true);
    final error = await sendToSlack(webhook, toSlackText(widget.report, cutNote: t.slackCutNote, footer: t.slackFooter));
    if (!mounted) return;
    setState(() => _sending = false);
    messenger?.hideCurrentSnackBar();
    if (error == null) {
      if (navigator.canPop()) navigator.pop();
      messenger?.showSnackBar(SnackBar(content: Text(t.slackSent), duration: const Duration(milliseconds: 1600)));
    } else {
      messenger?.showSnackBar(SnackBar(content: Text(t.slackFailed(error)), duration: const Duration(seconds: 5)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final bottom = MediaQuery.paddingOf(context).bottom;
    // One webhook per app: a restored previous run's store has none of its own.
    final webhook = canSendToSlack ? widget.store.slackWebhook ?? DurbunInspectorStore.existing?.slackWebhook : null;
    return Container(
      decoration: BoxDecoration(color: c.bgPanel, border: Border(top: BorderSide(color: c.hairline))),
      padding: EdgeInsets.fromLTRB(12, 10, 12, 12 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (webhook != null) ...<Widget>[
            DButton(
                large: true,
                primary: true,
                icon: Icons.send_rounded,
                label: _sending ? t.slackSending : t.slackSend,
                onTap: _sending ? null : () => _slack(webhook)),
            const SizedBox(height: 10),
          ],
          Row(
            children: <Widget>[
              Expanded(
                child: DButton(
                    large: true, primary: webhook == null && !canShareNatively, icon: Icons.copy_rounded, label: t.copy, onTap: _copy),
              ),
              if (canShareNatively) ...<Widget>[
                const SizedBox(width: 10),
                Expanded(
                  child: DButton(
                      large: true,
                      primary: webhook == null,
                      icon: defaultTargetPlatform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded,
                      label: t.shareSend,
                      onTap: _share),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
