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

class InspectorHome extends StatefulWidget {
  const InspectorHome({super.key, required this.store, this.initialTab = 0});

  final DurbunInspectorStore store;

  /// 0: Network, 1: Logs.
  final int initialTab;

  @override
  State<InspectorHome> createState() => _InspectorHomeState();
}

class _InspectorHomeState extends State<InspectorHome> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(
      length: 2, vsync: this, initialIndex: widget.initialTab.clamp(0, 1))
    ..addListener(_onTab);

  /// A search field on the other page would keep the keyboard up.
  void _onTab() => FocusManager.instance.primaryFocus?.unfocus();

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
                onClose: () => Navigator.of(context).maybePop(),
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
                  _TabPage(tabs: _tabs, index: 0, child: NetworkView(store: store)),
                  _TabPage(tabs: _tabs, index: 1, child: LogsView(store: store)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Keeps a tab's state (search, filters, scroll) while the other is shown,
/// and tells it whether it is on screen ([PageActive]).
class _TabPage extends StatefulWidget {
  const _TabPage({required this.tabs, required this.index, required this.child});

  final TabController tabs;
  final int index;
  final Widget child;

  @override
  State<_TabPage> createState() => _TabPageState();
}

class _TabPageState extends State<_TabPage> with AutomaticKeepAliveClientMixin {
  late bool _active = _visible();

  bool _visible() {
    final at = widget.tabs.animation?.value ?? widget.tabs.index.toDouble();
    return (at - widget.index).abs() < 0.999;
  }

  void _tick() {
    final v = _visible();
    if (v != _active) setState(() => _active = v);
  }

  @override
  void initState() {
    super.initState();
    widget.tabs.animation?.addListener(_tick);
  }

  @override
  void dispose() {
    widget.tabs.animation?.removeListener(_tick);
    super.dispose();
  }

  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return PageActive(active: _active, child: widget.child);
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
      padding: const EdgeInsets.fromLTRB(12, 6, 6, 8),
      child: Row(
        children: <Widget>[
          _BrandMark(onTap: onTools),
          const SizedBox(width: 10),
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
                return _PanelTabs(
                  controller: tabs,
                  tabs: <_TabSpec>[
                    _TabSpec(Icons.swap_vert_rounded, t.network,
                        failures > 0 ? failures : listed.length, failures > 0),
                    _TabSpec(Icons.notes_rounded, t.logs,
                        store.errorCount > 0 ? store.errorCount : store.logs.length, store.errorCount > 0),
                  ],
                );
              },
            ),
          ),
          const SizedBox(width: 4),
          DIconButton(icon: Icons.grid_view_rounded, tooltip: t.tools, size: 38, onTap: onTools),
          DIconButton(icon: Icons.close_rounded, tooltip: t.close, size: 38, onTap: onClose),
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
        return Tooltip(
          message: connected ? t.desktopConnected : t.onPhoneOnly,
          child: GestureDetector(
            onTap: onTap,
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
        );
      },
    );
  }
}

class _TabSpec {
  const _TabSpec(this.icon, this.label, this.count, this.alert);

  final IconData icon;
  final String label;

  /// Shown when above zero.
  final int count;

  /// Red count: errors / failed requests.
  final bool alert;
}

/// Network / Logs as a segmented control driven by the tab view, so the
/// raised segment follows a swipe.
class _PanelTabs extends StatelessWidget {
  const _PanelTabs({required this.controller, required this.tabs});

  final TabController controller;
  final List<_TabSpec> tabs;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      height: 38,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: c.trackBg,
        borderRadius: BorderRadius.circular(DurbunRadius.lg - 1),
        border: c.isDark ? Border.all(color: c.border.withValues(alpha: 0.6)) : null,
      ),
      child: TabBar(
        controller: controller,
        indicator: BoxDecoration(
          color: c.thumbBg,
          borderRadius: BorderRadius.circular(DurbunRadius.md),
          boxShadow: c.raised,
        ),
        indicatorSize: TabBarIndicatorSize.tab,
        dividerHeight: 0,
        labelPadding: EdgeInsets.zero,
        splashFactory: NoSplash.splashFactory,
        overlayColor: const WidgetStatePropertyAll<Color>(Colors.transparent),
        labelColor: c.text,
        unselectedLabelColor: c.textMuted,
        labelStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, height: 1.2),
        unselectedLabelStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, height: 1.2),
        tabs: <Widget>[
          for (final tab in tabs)
            Tooltip(
              message: tab.label,
              child: Tab(
                height: 32,
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(tab.icon, size: 16),
                        const SizedBox(width: 6),
                        Text(tab.label),
                        if (tab.count > 0) ...<Widget>[
                          const SizedBox(width: 6),
                          _CountBadge(count: tab.count, alert: tab.alert),
                        ],
                      ],
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

class _CountBadge extends StatelessWidget {
  const _CountBadge({required this.count, required this.alert});

  final int count;
  final bool alert;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      height: 18,
      constraints: const BoxConstraints(minWidth: 18),
      padding: const EdgeInsets.symmetric(horizontal: 5),
      alignment: Alignment.center,
      decoration: BoxDecoration(
          color: alert ? c.danger : c.bgActive, borderRadius: BorderRadius.circular(DurbunRadius.pill)),
      child: Text(
        count > 999 ? '999+' : '$count',
        style: DurbunType.monoStyle(
            size: 10.5, color: alert ? Colors.white : c.textMuted, weight: FontWeight.w700, height: 1.1),
      ),
    );
  }
}
