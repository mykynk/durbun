/// The panel shell: the desktop's top bar (Logs, Network, Mocks,
/// Performance, Device) and status bar, on the phone.
library;

import 'package:flutter/material.dart';

import '../flutter/durbun.dart' show Durbun;
import 'info_view.dart';
import 'logs_view.dart';
import 'network_view.dart';
import 'perf_view.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

class InspectorHome extends StatefulWidget {
  const InspectorHome({super.key, required this.store, this.initialTab = 0});

  final DurbunInspectorStore store;
  final int initialTab;

  @override
  State<InspectorHome> createState() => _InspectorHomeState();
}

class _InspectorHomeState extends State<InspectorHome> {
  late int _tab = widget.initialTab;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final store = widget.store;
    return Scaffold(
      backgroundColor: c.bgApp,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: <Widget>[
            Container(
              color: c.bgPanel,
              padding: const EdgeInsets.fromLTRB(12, 6, 4, 0),
              child: Row(
                children: <Widget>[
                  const DurbunLogo(size: 24),
                  const SizedBox(width: 8),
                  Text(t.title,
                      style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: c.text)),
                  const SizedBox(width: 8),
                  Expanded(child: _AppLine(store: store)),
                  DIconButton(
                      icon: Icons.cleaning_services_outlined,
                      tooltip: t.clear,
                      onTap: store.clear),
                  DIconButton(
                      icon: Icons.close,
                      tooltip: t.close,
                      onTap: () => Navigator.of(context).maybePop()),
                ],
              ),
            ),
            ListenableBuilder(
              listenable: store,
              builder: (context, _) => _TopTabs(
                index: _tab,
                onChanged: (i) => setState(() => _tab = i),
                errors: store.errorCount,
                failures: store.failureCount,
                calls: store.calls.length,
              ),
            ),
            // The status bar below takes the bottom inset.
            Expanded(
              child: MediaQuery.removePadding(
                context: context,
                removeBottom: true,
                child: IndexedStack(
                  index: _tab,
                  children: <Widget>[
                    LogsView(store: store),
                    NetworkView(store: store),
                    MocksView(store: store),
                    PerformanceView(store: store),
                    InfoView(store: store),
                  ],
                ),
              ),
            ),
            _StatusBar(store: store),
          ],
        ),
      ),
    );
  }
}

class _AppLine extends StatelessWidget {
  const _AppLine({required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final app = store.hello?['app'] as Map?;
        if (app == null) return const SizedBox.shrink();
        return Text(
          '${app['name'] ?? ''} ${app['version'] ?? ''}'.trim(),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: DurbunType.monoStyle(size: 11.5, color: c.textMeta),
        );
      },
    );
  }
}

class _TopTabs extends StatelessWidget {
  const _TopTabs(
      {required this.index,
      required this.onChanged,
      required this.errors,
      required this.failures,
      required this.calls});

  final int index;
  final ValueChanged<int> onChanged;
  final int errors;
  final int failures;
  final int calls;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final tabs = <(IconData, String, int?, bool)>[
      (Icons.notes, t.logs, errors > 0 ? errors : null, true),
      (
        Icons.swap_horiz,
        t.network,
        failures > 0 ? failures : (calls > 0 ? calls : null),
        failures > 0
      ),
      (Icons.theater_comedy_outlined, t.mocks, null, false),
      (Icons.speed, t.performance, null, false),
      (Icons.smartphone, t.device, null, false),
    ];
    return Container(
      decoration: BoxDecoration(
          color: c.bgPanel,
          border: Border(bottom: BorderSide(color: c.border))),
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
      // Every tab stays on screen: the open one shows its name (as on the
      // desktop's top bar), the others their icon and count.
      child: Row(
        children: <Widget>[
          for (var i = 0; i < tabs.length; i++)
            Expanded(
              flex: i == index ? 2 : 1,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1),
                child: Material(
                  color: i == index ? c.bgActive : Colors.transparent,
                  borderRadius: BorderRadius.circular(DurbunRadius.md),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(DurbunRadius.md),
                    onTap: () => onChanged(i),
                    child: Tooltip(
                      message: tabs[i].$2,
                      child: Center(
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                Icon(tabs[i].$1,
                                    size: 17,
                                    color: i == index ? c.text : c.textMuted),
                                if (i == index) ...<Widget>[
                                  const SizedBox(width: 6),
                                  Text(tabs[i].$2,
                                      style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w600,
                                          color: c.text)),
                                ],
                                if (tabs[i].$3 != null) ...<Widget>[
                                  const SizedBox(width: 5),
                                  Container(
                                    height: 17,
                                    constraints:
                                        const BoxConstraints(minWidth: 17),
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 5),
                                    alignment: Alignment.center,
                                    decoration: BoxDecoration(
                                        color:
                                            tabs[i].$4 ? c.danger : c.bgActive,
                                        borderRadius:
                                            BorderRadius.circular(999)),
                                    child: Text(
                                      tabs[i].$3! > 999
                                          ? '999+'
                                          : '${tabs[i].$3}',
                                      style: DurbunType.monoStyle(
                                          size: 10.5,
                                          color: tabs[i].$4
                                              ? Colors.white
                                              : c.textMuted,
                                          weight: FontWeight.w700,
                                          height: 1.1),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _StatusBar extends StatelessWidget {
  const _StatusBar({required this.store});

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
          final connected = Durbun.isConnected;
          final num = DurbunType.monoStyle(
              size: 11, color: c.text, weight: FontWeight.w600, height: 1.2);
          final label = TextStyle(fontSize: 11, color: c.textMeta, height: 1.2);
          return Container(
            decoration: BoxDecoration(
                color: c.bgPanel,
                border: Border(top: BorderSide(color: c.border))),
            padding: EdgeInsets.fromLTRB(
                12, 6, 12, 6 + MediaQuery.paddingOf(context).bottom),
            child: Row(
              children: <Widget>[
                Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                        color: connected ? c.success : c.textSubtle,
                        shape: BoxShape.circle)),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(connected ? t.desktopConnected : t.onPhoneOnly,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: label.copyWith(color: c.textMuted)),
                ),
                const SizedBox(width: 8),
                // Counts shrink instead of overflowing with large text.
                Flexible(
                  flex: 2,
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Row(children: <Widget>[
                        Text('${t.logs} ', style: label),
                        Text('${store.logs.length}', style: num),
                        const SizedBox(width: 10),
                        Text('${t.errors} ', style: label),
                        Text('${store.errorCount}',
                            style: num.copyWith(
                                color:
                                    store.errorCount > 0 ? c.danger : c.text)),
                        const SizedBox(width: 10),
                        Text('${t.requests} ', style: label),
                        Text('${store.calls.length}', style: num),
                      ]),
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
