/// Mocks and Info views: the mock rules the desktop pushed, and where every
/// piece of data comes from ("Neler görünüyor?").
library;

import 'package:flutter/material.dart';

import '../flutter/durbun.dart' show Durbun, durbunInspectorState;
import 'format.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

EdgeInsets _pad(BuildContext context) => EdgeInsets.fromLTRB(12, 12, 12, 20 + MediaQuery.paddingOf(context).bottom);

class MocksView extends StatelessWidget {
  const MocksView({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return StreamBuilder<Object?>(
      stream: Durbun.connection,
      builder: (context, _) => ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final state = durbunInspectorState();
          final connected = state?['connected'] == true;
          final raw = state?['mocks'];
          final rules = raw is List ? raw.whereType<Map<Object?, Object?>>().toList() : const <Map<Object?, Object?>>[];
          final hits = <String, int>{};
          for (final call in store.calls) {
            if (call.mocked && call.mockRuleId != null) hits[call.mockRuleId!] = (hits[call.mockRuleId!] ?? 0) + 1;
          }
          if (rules.isEmpty) {
            return ListView(
              padding: _pad(context),
              children: <Widget>[
                const SizedBox(height: 24),
                EmptyState(icon: Icons.theater_comedy_outlined, title: t.noMocksTitle, body: connected ? t.noMocksConnected : t.noMocksOffline),
              ],
            );
          }
          return ListView(
            padding: _pad(context),
            children: <Widget>[
              Callout(title: t.mocksFromDesktop, body: t.mocksFromDesktopBody),
              const SizedBox(height: 10),
              for (final r in rules) ...<Widget>[_MockCard(rule: r, hits: hits['${r['id']}'] ?? 0, c: c, t: t), const SizedBox(height: 8)],
            ],
          );
        },
      ),
    );
  }
}

class _MockCard extends StatelessWidget {
  const _MockCard({required this.rule, required this.hits, required this.c, required this.t});

  final Map<Object?, Object?> rule;
  final int hits;
  final DurbunColors c;
  final InspectorStrings t;

  @override
  Widget build(BuildContext context) {
    final enabled = rule['enabled'] != false;
    final method = '${rule['method'] ?? '*'}';
    final action = rule['action'] is Map ? rule['action'] as Map : const <String, Object?>{};
    final actionText = switch (action['type']) {
      'respond' => t.mockRespond('${action['status'] ?? 200}', action['delayMs'] is num ? (action['delayMs'] as num).toInt() : 0),
      'delay' => t.mockDelay(action['delayMs'] is num ? (action['delayMs'] as num).toInt() : 0),
      'fail' => t.mockFail('${action['error'] ?? 'custom'}'),
      _ => '—',
    };
    return Opacity(
      opacity: enabled ? 1 : 0.55,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: c.bgPanel, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text('${rule['name'] ?? rule['url'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: c.text)),
                ),
                DBadge(enabled ? t.on : t.off, tone: enabled ? BadgeTone.success : BadgeTone.neutral),
              ],
            ),
            const SizedBox(height: 6),
            Text.rich(
              TextSpan(
                children: <InlineSpan>[
                  TextSpan(text: method == '*' ? '* ' : '$method ', style: TextStyle(color: c.method(method), fontWeight: FontWeight.w600)),
                  TextSpan(text: '${rule['url'] ?? ''}'),
                ],
              ),
              style: DurbunType.monoStyle(size: 12, color: c.text),
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: <Widget>[
                DBadge('${rule['match'] ?? 'contains'}', mono: true),
                DBadge(actionText, tone: BadgeTone.accent),
                DBadge(t.mockHits(hits), tone: hits > 0 ? BadgeTone.info : BadgeTone.neutral),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class InfoView extends StatelessWidget {
  const InfoView({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return StreamBuilder<Object?>(
      stream: Durbun.connection,
      builder: (context, _) => ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final state = durbunInspectorState();
          final hello = (state?['hello'] as Map?) ?? store.hello;
          final app = hello?['app'] as Map?;
          final device = hello?['device'] as Map?;
          final sdk = hello?['sdk'] as Map?;
          final layers = <String>[for (final l in (sdk?['layers'] as List?) ?? const <Object?>[]) '$l'];
          final caps = <String>{for (final x in (hello?['capabilities'] as List?) ?? const <Object?>[]) '$x'};
          final connected = state?['connected'] == true;
          final via = state?['via'] as String?;
          final config = state?['config'] as Map?;
          final platform = '${device?['platform'] ?? ''}';
          final sources = store.calls.map((x) => x.source.toLowerCase()).toSet();
          final hasAndroid = layers.contains('android');
          final hasIos = layers.contains('ios');
          final rows = <(String, String, bool, String?)>[
            (t.srcDartHttp, 'dart:io · package:http', caps.contains('network'), caps.contains('network') ? null : t.srcNetworkOff),
            (t.srcDio, 'durbun_dio', sources.contains('dio'), sources.contains('dio') ? null : t.srcDioHint),
            if (platform != 'ios') (t.srcOkHttp, 'DurbunInterceptor', hasAndroid && caps.contains('network'), hasAndroid ? t.srcOkHttpHint : t.srcNoNative),
            if (platform != 'android') (t.srcUrlSession, t.srcAutomatic, hasIos && caps.contains('network'), hasIos ? null : t.srcNoNative),
            (t.srcAppLogs, 'Durbun.log · print · debugPrint', true, null),
            (t.srcNativeLogs, hasIos ? 'Swift · os_log' : 'Kotlin · Log', hasAndroid || hasIos, hasAndroid || hasIos ? null : t.srcNoNative),
            (t.srcCrashes, t.srcCrashesDetail, caps.contains('crash'), caps.contains('crash') ? t.srcCrashesHint : t.srcErrorsOff),
            (t.srcMetrics, 'FPS · jank · ${t.memory}', caps.contains('metrics'), caps.contains('metrics') ? null : t.srcMetricsOff),
          ];
          return ListView(
            padding: _pad(context),
            children: <Widget>[
              _Card(
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      const DurbunLogo(size: 30),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text('${app?['name'] ?? t.app}', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.text)),
                            Text(
                              <String>[
                                if (app?['version'] != null) '${app!['version']}${app['build'] != null ? ' (${app['build']})' : ''}',
                                if (app?['id'] != null) '${app!['id']}',
                              ].join(' · '),
                              style: DurbunType.monoStyle(size: 11.5, color: c.textMeta),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: <Widget>[
                      _LayerChip('Flutter', c.sdkFlutter),
                      for (final l in layers)
                        _LayerChip(
                          switch (l) {
                            'dart' => 'Dart',
                            'android' => 'Kotlin',
                            'ios' => 'Swift',
                            _ => l,
                          },
                          switch (l) {
                            'android' => c.sdkAndroid,
                            'ios' => c.sdkIos,
                            _ => c.sdkDart,
                          },
                        ),
                      if (sdk?['version'] != null) DBadge('SDK ${sdk!['version']}', mono: true),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 10),
              _Card(
                children: <Widget>[
                  _InfoRow(t.device, <String>[
                    '${device?['manufacturer'] ?? ''} ${device?['model'] ?? device?['name'] ?? ''}'.trim(),
                    if (device?['osVersion'] != null) '${platform == 'ios' ? 'iOS' : platform == 'android' ? 'Android' : platform} ${device!['osVersion']}',
                    if (device?['apiLevel'] != null) 'API ${device!['apiLevel']}',
                    if (device?['isPhysical'] == false) t.simulator,
                  ].where((s) => s.isNotEmpty).join(' · ')),
                  _InfoRow(
                    t.desktop,
                    connected ? t.connectedVia(via) : t.notConnected,
                    color: connected ? c.success : c.textMuted,
                    dot: connected ? c.success : c.textSubtle,
                  ),
                  if (connected && config != null)
                    _InfoRow(t.bodyCapture, config['captureBodies'] == false ? t.off : '${t.on} · ${formatBytes(((config['maxBodyBytes'] as num?) ?? 0).toInt())}'),
                  _InfoRow(t.kept, '${t.logs} ${store.logs.length} · ${t.network} ${store.calls.length} · ${formatBytes(store.bodyBytes)}'),
                ],
              ),
              if (!connected) ...<Widget>[const SizedBox(height: 10), Callout(title: t.offlineTitle, body: t.offlineBody)],
              SectionTitle(t.whatYouSee),
              _Card(
                padding: EdgeInsets.zero,
                children: <Widget>[
                  for (var i = 0; i < rows.length; i++)
                    Container(
                      padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
                      decoration: BoxDecoration(border: i == 0 ? null : Border(top: BorderSide(color: c.border))),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Icon(rows[i].$3 ? Icons.check_circle : Icons.remove_circle_outline, size: 16, color: rows[i].$3 ? c.success : c.textSubtle),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Text(rows[i].$1, style: TextStyle(fontSize: 13, color: c.text, fontWeight: FontWeight.w500)),
                                Text(rows[i].$2, style: DurbunType.monoStyle(size: 11, color: c.textMeta)),
                                if (rows[i].$4 != null) ...<Widget>[
                                  const SizedBox(height: 2),
                                  Text(rows[i].$4!, style: TextStyle(fontSize: 11.5, color: c.textMuted)),
                                ],
                              ],
                            ),
                          ),
                        ],
                      ),
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

class _Card extends StatelessWidget {
  const _Card({required this.children, this.padding = const EdgeInsets.all(12)});

  final List<Widget> children;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      padding: padding,
      decoration: BoxDecoration(color: c.bgPanel, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow(this.label, this.value, {this.color, this.dot});

  final String label;
  final String value;
  final Color? color;
  final Color? dot;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(width: 104, child: Text(label, style: TextStyle(fontSize: 12.5, color: c.textMuted))),
          if (dot != null) ...<Widget>[
            Padding(padding: const EdgeInsets.only(top: 6), child: Container(width: 7, height: 7, decoration: BoxDecoration(color: dot, shape: BoxShape.circle))),
            const SizedBox(width: 6),
          ],
          Expanded(child: Text(value, style: TextStyle(fontSize: 12.5, color: color ?? c.text))),
        ],
      ),
    );
  }
}

class _LayerChip extends StatelessWidget {
  const _LayerChip(this.label, this.color);

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    height: 20,
    padding: const EdgeInsets.symmetric(horizontal: 7),
    decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(DurbunRadius.sm)),
    child: Text(label, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600, height: 1.7)),
  );
}
