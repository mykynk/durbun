/// Tools → Mac connection: whether the desktop is connected, why not and
/// what to do, and the Mac's Wi-Fi address entered on the phone (kept for
/// the next launches).
library;

import 'package:flutter/material.dart';

import '../core/connection_report.dart';
import '../flutter/durbun.dart' show durbunBackend, durbunInspectorState;
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// The device platform from the hello (`android`, `ios`, …).
String inspectorPlatform(DurbunInspectorStore store) {
  final hello = (durbunInspectorState()?['hello'] as Map?) ?? store.hello;
  return '${(hello?['device'] as Map?)?['platform'] ?? ''}';
}

/// Title and body for [report]'s issue (null while connected or before the
/// first failed round).
(String, String)? connectionIssueText(InspectorStrings t, ConnectionReport report, String platform) {
  final issue = report.issue;
  if (report.connected || issue == null) return null;
  final host = report.lanEndpoint ?? '';
  return switch (issue) {
    ConnectIssue.desktopNotRunning => (t.issueDesktopNotRunningTitle, t.issueDesktopNotRunningBody),
    ConnectIssue.usbNotSetUp => (t.issueUsbNotSetUpTitle, t.issueUsbNotSetUpBody),
    ConnectIssue.usbDesktopClosed => (t.issueUsbDesktopClosedTitle, t.issueUsbDesktopClosedBody),
    ConnectIssue.iosUsbWaiting => (t.issueIosUsbTitle, t.issueIosUsbBody),
    ConnectIssue.lanRefused => (t.issueLanRefusedTitle, t.issueLanRefusedBody(host)),
    ConnectIssue.lanTimeout => (t.issueLanTimeoutTitle, t.issueLanTimeoutBody(host)),
    ConnectIssue.lanUnreachable => (t.issueLanUnreachableTitle, t.issueLanUnreachableBody(host, ios: platform == 'ios')),
    ConnectIssue.lanBadAddress => (t.issueLanBadAddressTitle, t.issueLanBadAddressBody(host)),
    ConnectIssue.permissionDenied => (t.issuePermissionTitle, t.issuePermissionBody(platform)),
    ConnectIssue.notDurbun => (t.issueNotDurbunTitle, t.issueNotDurbunBody),
    ConnectIssue.other => (t.issueOtherTitle, t.issueOtherBody),
  };
}

/// One line for the connection: connected, connecting or not connected.
String connectionStatusText(InspectorStrings t, ConnectionReport? report) {
  if (report == null) return t.notConnected;
  if (report.connected) return t.connectedVia(report.via);
  if (report.trying) return t.connectingTo(report.lanEndpoint);
  if (report.attempts.isEmpty) return t.connectingTo(null);
  return t.notConnected;
}

/// A short value for the Tools row.
String connectionShortText(InspectorStrings t, ConnectionReport? report) {
  if (report == null) return t.notConnected;
  if (report.connected) return t.statusConnected;
  if (report.trying || report.attempts.isEmpty) return t.statusConnecting;
  return t.notConnected;
}

class ConnectionView extends StatefulWidget {
  const ConnectionView({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  State<ConnectionView> createState() => _ConnectionViewState();
}

class _ConnectionViewState extends State<ConnectionView> {
  late final TextEditingController _address;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final report = durbunBackend().connectionReport;
    _address = TextEditingController(text: report != null && report.lanFromPanel ? report.lanEndpoint ?? '' : '');
  }

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _connect(InspectorStrings t) async {
    final check = checkDesktopAddress(_address.text);
    final error = switch (check.error) {
      DesktopAddressError.empty => t.addressEmpty,
      DesktopAddressError.badHost => t.addressBadHost,
      DesktopAddressError.badPort => t.addressBadPort,
      null => null,
    };
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _error = null;
      _busy = true;
      _address.text = check.address!;
    });
    try {
      await durbunBackend().setDesktopHost(check.address);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reset() async {
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _error = null;
      _busy = true;
      _address.clear();
    });
    try {
      await durbunBackend().setDesktopHost(null);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final backend = durbunBackend();
    return ListenableBuilder(
      listenable: backend.changes,
      builder: (context, _) {
        final report = backend.connectionReport;
        final platform = inspectorPlatform(widget.store);
        final connected = report?.connected ?? false;
        final issue = report == null ? null : connectionIssueText(t, report, platform);
        final via = report?.via ?? '';
        final overUsb = connected && (via.startsWith('usbmux') || via.startsWith('tcp 127.0.0.1') || via.startsWith('tcp 10.0.2.2'));
        return ListView(
          padding: EdgeInsets.fromLTRB(12, 12, 12, 20 + MediaQuery.paddingOf(context).bottom),
          children: <Widget>[
            _Card(children: <Widget>[
              Row(
                children: <Widget>[
                  Container(
                    width: 9,
                    height: 9,
                    decoration: BoxDecoration(color: connected ? c.success : (issue != null ? c.warning : c.textSubtle), shape: BoxShape.circle),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(connectionStatusText(t, report),
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: connected ? c.text : c.textMuted)),
                  ),
                ],
              ),
              if (issue != null) ...<Widget>[
                const SizedBox(height: 12),
                Text(issue.$1, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.text)),
                const SizedBox(height: 4),
                Text(issue.$2, style: TextStyle(fontSize: 13.5, height: 1.4, color: c.textMuted)),
              ],
              if (!connected && report != null && report.attempts.isNotEmpty) ...<Widget>[
                const SizedBox(height: 12),
                Text(t.attemptsTitle, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.textSubtle)),
                const SizedBox(height: 4),
                for (final a in report.attempts)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text('${a.endpoint} — ${t.attemptKind(a.kind)}', style: DurbunType.monoStyle(size: 12, color: c.textMuted)),
                  ),
              ],
              if (!connected) ...<Widget>[
                const SizedBox(height: 10),
                Text(t.keepsTrying, style: TextStyle(fontSize: 13, color: c.textSubtle)),
              ],
            ]),
            SectionTitle(t.macAddress),
            _Card(children: <Widget>[
              Container(
                height: 44,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                decoration: BoxDecoration(
                  color: c.fieldBg,
                  borderRadius: BorderRadius.circular(DurbunRadius.md),
                  border: Border.all(color: _error != null ? c.danger : (c.isDark ? c.border : Colors.transparent)),
                ),
                alignment: Alignment.centerLeft,
                child: TextField(
                  key: const ValueKey<String>('durbun-mac-address'),
                  controller: _address,
                  enabled: !_busy,
                  autocorrect: false,
                  enableSuggestions: false,
                  keyboardType: TextInputType.url,
                  textInputAction: TextInputAction.go,
                  onSubmitted: (_) => _connect(t),
                  onChanged: (_) {
                    if (_error != null) setState(() => _error = null);
                  },
                  style: DurbunType.monoStyle(size: 14, color: c.text, height: 1.2),
                  cursorColor: c.accent,
                  decoration: InputDecoration(
                    isDense: true,
                    border: InputBorder.none,
                    hintText: t.macAddressHint,
                    hintStyle: DefaultTextStyle.of(context).style.copyWith(inherit: false, fontSize: 14, color: c.textSubtle, height: 1.2),
                  ),
                ),
              ),
              if (_error != null) ...<Widget>[
                const SizedBox(height: 6),
                Text(_error!, style: TextStyle(fontSize: 13, color: c.danger)),
              ],
              const SizedBox(height: 8),
              Text(t.macAddressHelp, style: TextStyle(fontSize: 13, height: 1.4, color: c.textMuted)),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  // The page's main action until connected; then a secondary one.
                  DButton(
                      label: t.connect,
                      kind: connected ? DButtonKind.tonal : DButtonKind.primary,
                      icon: Icons.link_rounded,
                      onTap: _busy ? null : () => _connect(t)),
                  if (report?.lanFromPanel ?? false)
                    DButton(
                      kind: DButtonKind.ghost,
                      label: report?.buildHost != null ? t.useBuildAddress : t.forgetAddress,
                      onTap: _busy ? null : _reset,
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                report == null
                    ? t.addressNone
                    : report.lanFromPanel
                        ? t.addressSaved(report.lanEndpoint ?? '')
                        : report.buildHost != null
                            ? t.addressFromBuild(report.buildHost!)
                            : t.addressNone,
                style: TextStyle(fontSize: 13, color: c.textSubtle),
              ),
              if (overUsb && report?.lanEndpoint != null) ...<Widget>[
                const SizedBox(height: 6),
                Text(t.usbStaysInUse, style: TextStyle(fontSize: 13, color: c.textSubtle)),
              ],
            ]),
          ],
        );
      },
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: c.bgPanel, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}
