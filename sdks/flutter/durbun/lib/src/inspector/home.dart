/// The panel shell: one compact header (logo, Network / Logs tabs, tools,
/// close) over a swipeable tab view. Mocks, Performance and Device open
/// from the tools sheet, so the header stays one row and the keyboard
/// leaves room for the list.
library;

import 'package:flutter/material.dart';

import '../flutter/durbun.dart' show Durbun;
import 'logs_view.dart';
import 'network_view.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'tools.dart';
import 'widgets.dart';

/// The tab last shown with a store (one app run): the panel opens there
/// again.
final Expando<int> _lastTab = Expando<int>('durbun.tab');

class InspectorHome extends StatefulWidget {
  const InspectorHome({super.key, required this.store, this.initialTab, this.onClose});

  final DurbunInspectorStore store;

  /// 0: Network, 1: Logs; null: the tab last shown with [store].
  final int? initialTab;

  /// Closes the panel (default: pops this page's route).
  final VoidCallback? onClose;

  @override
  State<InspectorHome> createState() => _InspectorHomeState();
}

class _InspectorHomeState extends State<InspectorHome> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(
      length: 2, vsync: this, initialIndex: (widget.initialTab ?? _lastTab[widget.store] ?? 0).clamp(0, 1))
    ..addListener(_onTab);

  /// A search field on the other page would keep the keyboard up.
  void _onTab() {
    _lastTab[widget.store] = _tabs.index;
    FocusManager.instance.primaryFocus?.unfocus();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final store = widget.store;
    return Scaffold(
      backgroundColor: c.bgApp,
      body: Column(
        children: <Widget>[
          // The status bar area takes the header's color.
          ColoredBox(
            color: c.bgPanel,
            child: SafeArea(
              bottom: false,
              child: _Header(
                store: store,
                tabs: _tabs,
                onTools: () => showToolsSheet(context, store),
                onClose: widget.onClose ?? () => Navigator.of(context).maybePop(),
              ),
            ),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              bottom: false,
              child: TabBarView(
                controller: _tabs,
                children: <Widget>[
                  SwipePage(tabs: _tabs, index: 0, child: NetworkView(store: store)),
                  SwipePage(tabs: _tabs, index: 1, child: LogsView(store: store)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.store, required this.tabs, required this.onTools, required this.onClose});

  final DurbunInspectorStore store;
  final TabController tabs;
  final VoidCallback onTools;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Container(
      decoration: BoxDecoration(color: c.bgPanel, border: Border(bottom: BorderSide(color: c.border))),
      padding: const EdgeInsets.fromLTRB(6, 3, 4, 5),
      child: Row(
        children: <Widget>[
          _BrandMark(onTap: onTools),
          const SizedBox(width: 4),
          Expanded(
            child: ListenableBuilder(
              listenable: store,
              builder: (context, _) {
                // Requests to hosts outside the default list do not count
                // on the badge (they are not listed).
                final listed = store.defaultHosts.isEmpty
                    ? store.calls
                    : store.calls.where((x) => store.isDefaultHost(x.uri?.host ?? '')).toList();
                final failures = store.defaultHosts.isEmpty
                    ? store.failureCount
                    : listed.where((x) => x.isFailure).length;
                return DTabBar(
                  controller: tabs,
                  tabs: <DTab>[
                    DTab(t.network, icon: Icons.swap_vert_rounded,
                        count: failures > 0 ? failures : listed.length, alert: failures > 0),
                    DTab(t.logs, icon: Icons.notes_rounded,
                        count: store.errorCount > 0 ? store.errorCount : store.logs.length, alert: store.errorCount > 0),
                  ],
                );
              },
            ),
          ),
          const SizedBox(width: 4),
          DIconButton(icon: Icons.grid_view_rounded, tooltip: t.tools, size: kMinTapTarget, onTap: onTools),
          DIconButton(icon: Icons.close_rounded, tooltip: t.close, size: kMinTapTarget, onTap: onClose),
        ],
      ),
    );
  }
}

/// The logo with a dot for the desktop connection (green: connected).
class _BrandMark extends StatelessWidget {
  const _BrandMark({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return StreamBuilder<Object?>(
      stream: Durbun.connection,
      builder: (context, _) {
        final connected = Durbun.isConnected;
        // A 44 pt target around the 32 pt logo; read as a button that
        // opens the tools and says the connection.
        return Semantics(
          button: true,
          label: '${t.tools}, ${connected ? t.desktopConnected : t.onPhoneOnly}',
          excludeSemantics: true,
          onTap: onTap,
          child: Tooltip(
            message: connected ? t.desktopConnected : t.onPhoneOnly,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onTap,
              child: SizedBox.square(
                dimension: kMinTapTarget,
                child: Center(
                  child: SizedBox(
                    width: 32,
                    height: 32,
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: <Widget>[
                        const Positioned(left: 1, top: 1, child: DurbunLogo(size: 30)),
                        Positioned(
                          right: -2,
                          bottom: -2,
                          child: Container(
                            width: 12,
                            height: 12,
                            decoration: BoxDecoration(
                              color: connected ? c.success : c.textSubtle,
                              shape: BoxShape.circle,
                              border: Border.all(color: c.bgPanel, width: 2.5),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
