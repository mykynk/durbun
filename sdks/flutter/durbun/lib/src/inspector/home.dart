/// The panel shell: a header for the page on screen (the Dürbün mark with
/// the desktop connection, a title, a subtitle, the theme switch, pause and
/// close) over four pages, Network, Logs, Performance and Tools, picked in
/// a floating bar at the bottom. Pages keep their state while another one
/// is shown; detail pages are pushed over the whole shell, bar included.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../core/protocol.dart' show kSdkVersion;
import '../flutter/durbun.dart' show Durbun;
import '../flutter/metrics.dart' show displayRefreshRate;
import 'logs_view.dart';
import 'network_view.dart';
import 'perf_view.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'tools.dart';
import 'widgets.dart';

/// The panel's top-level pages, in the bar's order.
enum PanelTab { network, logs, performance, tools }

/// The tab last shown with a store (one app run): the panel opens there
/// again.
final Expando<PanelTab> _lastTab = Expando<PanelTab>('durbun.tab');

/// What the pages of the shell can ask of it: another tab, closing.
class PanelScope extends InheritedWidget {
  const PanelScope({super.key, required this.open, required this.close, required this.readOnly, required super.child});

  /// Shows [PanelTab] (no-op for a tab the shell does not have).
  final void Function(PanelTab tab) open;
  final VoidCallback close;
  final bool readOnly;

  static PanelScope? maybeOf(BuildContext context) => context.getInheritedWidgetOfExactType<PanelScope>();

  @override
  bool updateShouldNotify(PanelScope old) => old.readOnly != readOnly;
}

class InspectorHome extends StatefulWidget {
  const InspectorHome({super.key, required this.store, this.initialTab, this.onClose, this.banner});

  /// A [DurbunInspectorStore.readOnly] store (a saved run) gets only the
  /// Network and Logs pages and no live controls.
  final DurbunInspectorStore store;

  /// 0: Network, 1: Logs, 2: Performance, 3: Tools; null: the tab last
  /// shown with [store].
  final int? initialTab;

  /// Closes the panel (default: pops this page's route).
  final VoidCallback? onClose;

  /// Shown between the header and the page (the previous run's crash).
  final Widget? banner;

  @override
  State<InspectorHome> createState() => _InspectorHomeState();
}

class _InspectorHomeState extends State<InspectorHome> {
  bool get _readOnly => widget.store.readOnly;

  List<PanelTab> get _tabs => _readOnly
      ? const <PanelTab>[PanelTab.network, PanelTab.logs]
      : PanelTab.values;

  late PanelTab _tab = _initial();

  /// Pages are built on their first visit and kept afterwards.
  late final Set<PanelTab> _built = <PanelTab>{_tab};

  /// Pause of the Network and Logs lists (not kept: the panel opens live).
  final Map<PanelTab, bool> _paused = <PanelTab, bool>{};

  PanelTab _initial() {
    final given = widget.initialTab;
    final tab = given != null && given >= 0 && given < PanelTab.values.length
        ? PanelTab.values[given]
        : (_lastTab[widget.store] ?? PanelTab.network);
    return _tabs.contains(tab) ? tab : PanelTab.network;
  }

  void _open(PanelTab tab) {
    if (!_tabs.contains(tab)) return;
    // A search field on the other page would keep the keyboard up.
    FocusManager.instance.primaryFocus?.unfocus();
    if (tab == _tab) return;
    setState(() {
      _tab = tab;
      _built.add(tab);
    });
    _lastTab[widget.store] = tab;
  }

  void _close() => (widget.onClose ?? () => Navigator.of(context).maybePop())();

  Widget _page(PanelTab tab) {
    final store = widget.store;
    return switch (tab) {
      PanelTab.network => NetworkView(store: store, paused: _paused[tab] ?? false),
      PanelTab.logs => LogsView(store: store, paused: _paused[tab] ?? false),
      PanelTab.performance => PerformanceView(store: store),
      PanelTab.tools => ToolsView(store: store),
    };
  }

  /// The fade above the floating bar.
  static const double _fade = 24;

  /// The destinations with their error counts: the floating bar, or
  /// ([docked]) the row in the header.
  Widget _nav(BuildContext context, List<PanelTab> tabs, {required bool docked}) => ListenableBuilder(
        listenable: widget.store,
        builder: (context, _) {
          final t = InspectorStrings.of(context);
          final destinations = <PanelDestination>[
            for (final tab in tabs)
              switch (tab) {
                PanelTab.network => PanelDestination(t.network, Icons.swap_vert_rounded, badge: listedFailures(widget.store)),
                PanelTab.logs => PanelDestination(t.logs, Icons.notes_rounded, badge: widget.store.errorCount),
                PanelTab.performance => PanelDestination(t.performance, Icons.speed_rounded),
                PanelTab.tools => PanelDestination(t.tools, Icons.grid_view_rounded),
              },
          ];
          return docked
              ? PanelNavRow(destinations: destinations, selected: tabs.indexOf(_tab), onSelect: (i) => _open(tabs[i]))
              : PanelNavBar(destinations: destinations, selected: tabs.indexOf(_tab), onSelect: (i) => _open(tabs[i]));
        },
      );

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final mq = MediaQuery.of(context);
    // The bar steps aside while the keyboard is up (a search field).
    final keyboard = mq.viewInsets.bottom > 0;
    // A short window (landscape phone): the destinations sit in the header.
    final docked = PanelNavBar.docked(context);
    final floating = !keyboard && !docked;
    final barBottom = math.max(mq.padding.bottom, 12.0);
    final barTop = barBottom + PanelNavBar.extent(context);
    // The list ends above the bar's fade, so its last card is fully seen.
    final reserve = floating ? barTop + _fade : mq.padding.bottom;
    final tabs = _tabs;
    return PanelScope(
      open: _open,
      close: _close,
      readOnly: _readOnly,
      child: Scaffold(
        backgroundColor: c.bgApp,
        body: Stack(
          children: <Widget>[
            Column(
              children: <Widget>[
                _Header(
                  tab: _tab,
                  store: widget.store,
                  readOnly: _readOnly,
                  paused: _paused[_tab] ?? false,
                  onPause: () => setState(() => _paused[_tab] = !(_paused[_tab] ?? false)),
                  onClose: _close,
                  onOpen: _open,
                  nav: docked ? _nav(context, tabs, docked: true) : null,
                ),
                if (widget.banner != null) widget.banner!,
                Expanded(
                  // Lists pad their end by the bottom inset: the bar floats
                  // over the page and the last card stays reachable.
                  child: Builder(
                    builder: (context) {
                      final inner = MediaQuery.of(context);
                      return MediaQuery(
                        data: inner.copyWith(padding: inner.padding.copyWith(bottom: reserve)),
                        child: IndexedStack(
                          index: tabs.indexOf(_tab),
                          sizing: StackFit.expand,
                          children: <Widget>[
                            for (final tab in tabs)
                              _built.contains(tab)
                                  ? PageActive(
                                      active: tab == _tab,
                                      child: TickerMode(enabled: tab == _tab, child: _page(tab)),
                                    )
                                  : const SizedBox.shrink(),
                          ],
                        ),
                      );
                    },
                  ),
                ),
              ],
            ),
            if (floating) ...<Widget>[
              // Nothing readable under the bar: the page colour, and above
              // the bar a short fade the list scrolls into.
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: barTop + _fade,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: <Color>[c.bgApp.withValues(alpha: 0), c.bgApp, c.bgApp],
                        stops: <double>[0, _fade / (barTop + _fade), 1],
                      ),
                    ),
                  ),
                ),
              ),
              Positioned(left: 0, right: 0, bottom: barBottom, child: _nav(context, tabs, docked: false)),
            ],
          ],
        ),
      ),
    );
  }
}

/// Failed requests the Network list can show (requests to hosts outside
/// the default list do not count: they are not listed).
int listedFailures(DurbunInspectorStore store) => store.defaultHosts.isEmpty
    ? store.failureCount
    : store.calls.where((x) => x.isFailure && store.isDefaultHost(x.uri?.host ?? '')).length;

/// The header of a top-level page.
class _Header extends StatelessWidget {
  const _Header({
    required this.tab,
    required this.store,
    required this.readOnly,
    required this.paused,
    required this.onPause,
    required this.onClose,
    required this.onOpen,
    this.nav,
  });

  /// The destinations, docked between the title and the buttons (a short
  /// window).
  final Widget? nav;
  final PanelTab tab;
  final DurbunInspectorStore store;
  final bool readOnly;
  final bool paused;
  final VoidCallback onPause;
  final VoidCallback onClose;
  final void Function(PanelTab tab) onOpen;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final live = tab == PanelTab.network || tab == PanelTab.logs;
    // Network and Logs continue into their toolbars; the line is under those.
    final divider = !live;
    return Container(
      decoration: BoxDecoration(
        color: c.bgApp,
        border: divider ? Border(bottom: BorderSide(color: c.hairline)) : null,
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          // 16 pt to the drawn mark and buttons (their tap areas are larger).
          padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, 6, DurbunSpace.gutter - 5, 6),
          child: StreamBuilder<Object?>(
            stream: Durbun.connection,
            builder: (context, _) => ListenableBuilder(
              listenable: store,
              builder: (context, _) {
                final connected = Durbun.isConnected;
                final hello = store.hello;
                final app = hello?['app'] is Map ? hello!['app'] as Map : null;
                final device = hello?['device'] is Map ? hello!['device'] as Map : null;
                final appName = app?['name'] is String && (app!['name'] as String).isNotEmpty ? app['name'] as String : null;
                final platform = switch ('${device?['platform'] ?? ''}') {
                  'ios' => 'iOS',
                  'android' => 'Android',
                  final p => p,
                };
                final os = <String>[if (platform.isNotEmpty) platform, if (device?['osVersion'] != null) '${device!['osVersion']}'].join(' ');
                final link = connected ? t.desktopConnected : t.onPhoneOnly;
                final (String title, Widget? mark, List<String> subtitle) = readOnly
                    ? (tab == PanelTab.logs ? t.logs : t.network, null, <String>[t.previousRun])
                    : switch (tab) {
                        PanelTab.network => (appName ?? t.network, _FpsChip(store: store, onTap: () => onOpen(PanelTab.performance)), <String>[if (os.isNotEmpty) os, link]),
                        PanelTab.logs => (t.logs, _CountBadge(count: store.errorCount), <String>[if (appName != null) appName, paused ? t.pausedStream : t.liveStream]),
                        PanelTab.performance => (t.performance, null, <String>[if (appName != null) appName, t.liveStream]),
                        PanelTab.tools => (t.tools, null, <String>['${t.title} $kSdkVersion']),
                      };
                return Row(
                  children: <Widget>[
                    if (readOnly)
                      // A saved run: a history mark, not the live connection.
                      Semantics(
                        label: t.previousRun,
                        child: Container(
                          width: 32,
                          height: 32,
                          decoration: BoxDecoration(
                            color: c.chipBg,
                            borderRadius: BorderRadius.circular(DurbunRadius.md),
                            border: Border.all(color: c.border),
                          ),
                          child: Icon(Icons.history_rounded, size: 18, color: c.textMuted),
                        ),
                      )
                    else
                      _BrandMark(connected: connected, onTap: () => onOpen(PanelTab.tools)),
                    // The mark's 44 pt target already reaches 10 pt past it.
                    if (readOnly) const SizedBox(width: 10),
                    Expanded(
                      child: Semantics(
                        header: true,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            Row(
                              children: <Widget>[
                                Flexible(
                                  child: Text(
                                    title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: DurbunType.heading(size: 16, color: c.text).copyWith(height: 1.25, letterSpacing: -0.1),
                                  ),
                                ),
                                if (mark != null) ...<Widget>[const SizedBox(width: 8), mark],
                              ],
                            ),
                            const SizedBox(height: 1),
                            // Large text: two lines rather than a cut state;
                            // when even two cannot hold it all, the state
                            // (the last part) alone.
                            LayoutBuilder(builder: (context, box) {
                              final style = DefaultTextStyle.of(context)
                                  .style
                                  .merge(DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.3));
                              final lines = MediaQuery.textScalerOf(context).scale(10) > 13 ? 2 : 1;
                              var text = subtitle.join(' · ');
                              if (subtitle.length > 1 && box.maxWidth.isFinite) {
                                final painter = TextPainter(
                                  text: TextSpan(text: text, style: style),
                                  textDirection: Directionality.of(context),
                                  textScaler: MediaQuery.textScalerOf(context),
                                  maxLines: lines,
                                )..layout(maxWidth: box.maxWidth);
                                if (painter.didExceedMaxLines) text = subtitle.last;
                                painter.dispose();
                              }
                              return Text(text, maxLines: lines, overflow: TextOverflow.ellipsis, style: style);
                            }),
                          ],
                        ),
                      ),
                    ),
                    if (nav != null) ...<Widget>[const SizedBox(width: 8), nav!],
                    const SizedBox(width: 4),
                    if (!readOnly) const ThemeSwitchButton(),
                    if (live && !readOnly)
                      DIconButton(
                        boxed: true,
                        icon: paused ? Icons.play_arrow_rounded : Icons.pause_rounded,
                        tooltip: paused ? t.resume : t.pause,
                        active: paused,
                        onTap: onPause,
                      ),
                    DIconButton(boxed: true, icon: Icons.close_rounded, tooltip: t.close, onTap: onClose),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

/// Light / dark for the panel, starting from the phone's setting.
class ThemeSwitchButton extends StatelessWidget {
  const ThemeSwitchButton({super.key});

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final dark = DurbunColors.of(context).isDark;
    return DIconButton(
      boxed: true,
      icon: Icons.contrast_rounded,
      tooltip: dark ? t.switchToLight : t.switchToDark,
      onTap: () => togglePanelTheme(context),
    );
  }
}

/// The live frame rate next to the app's name; a tap opens Performance.
/// Not drawn without a sample.
class _FpsChip extends StatelessWidget {
  const _FpsChip({required this.store, required this.onTap});

  final DurbunInspectorStore store;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fps = store.lastMetric?.fps;
    if (fps == null) return const SizedBox.shrink();
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final rate = displayRefreshRate(View.maybeOf(context)?.display);
    // The same steps as Performance: green near the display's rate.
    final color = fps >= rate * 0.92 ? c.success : (fps >= rate * 0.67 ? c.warning : c.danger);
    final text = '${fps.round()} FPS';
    return Semantics(
      button: true,
      label: '$text, ${t.openPerformance}',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Container(
            constraints: const BoxConstraints(minHeight: 20),
            padding: const EdgeInsets.symmetric(horizontal: 7),
            decoration: BoxDecoration(
              color: Color.alphaBlend(color.withValues(alpha: 0.12), c.bgApp),
              borderRadius: BorderRadius.circular(DurbunRadius.pill),
              border: Border.all(color: color.withValues(alpha: 0.3)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Container(width: 6, height: 6, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
                const SizedBox(width: 5),
                Text(text, style: DurbunType.monoStyle(size: DurbunType.monoSm, color: color, weight: FontWeight.w600, height: 1.2)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Errors since the last clear, after the Logs title; nothing at zero.
class _CountBadge extends StatelessWidget {
  const _CountBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Semantics(
      label: t.errorCountShort(count),
      excludeSemantics: true,
      child: Container(
        constraints: const BoxConstraints(minWidth: 20, minHeight: 20),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(color: c.danger, borderRadius: BorderRadius.circular(DurbunRadius.pill)),
        child: Center(
          widthFactor: 1,
          heightFactor: 1,
          child: Text(count > 999 ? '999+' : '$count',
              style: DurbunType.monoStyle(size: DurbunType.monoSm, color: c.onDanger, weight: FontWeight.w700, height: 1.1)),
        ),
      ),
    );
  }
}

/// The Dürbün mark with a dot for the desktop connection (green:
/// connected); a tap opens Tools, where the connection is.
class _BrandMark extends StatelessWidget {
  const _BrandMark({required this.connected, required this.onTap});

  final bool connected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final state = connected ? t.desktopConnected : t.onPhoneOnly;
    return Semantics(
      button: true,
      label: '${t.tools}, $state',
      excludeSemantics: true,
      onTap: onTap,
      child: Tooltip(
        message: state,
        excludeFromSemantics: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          // A 44 pt target; the mark sits at its start, on the gutter.
          child: SizedBox(
            width: 44,
            height: 44,
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: SizedBox.square(
                dimension: 32,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: <Widget>[
                    const DurbunLogo(size: 32),
                    Positioned(
                      right: -3,
                      bottom: -3,
                      child: Container(
                        width: 12,
                        height: 12,
                        decoration: BoxDecoration(
                          color: connected ? c.success : c.textSubtle,
                          shape: BoxShape.circle,
                          border: Border.all(color: c.bgApp, width: 2.5),
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
  }
}

/// One destination of the [PanelNavBar].
class PanelDestination {
  const PanelDestination(this.label, this.icon, {this.badge = 0});

  final String label;
  final IconData icon;

  /// Errors to see there (a red count on the icon); none at zero.
  final int badge;
}

/// The floating bar at the bottom of the panel: a rounded bar one step
/// above the page, the current destination a filled violet tile. Labels
/// grow with the text size up to 1.3x and shrink rather than clip; in a
/// short window (landscape) icon and label sit side by side.
class PanelNavBar extends StatelessWidget {
  const PanelNavBar({super.key, required this.destinations, required this.selected, required this.onSelect});

  final List<PanelDestination> destinations;
  final int selected;
  final ValueChanged<int> onSelect;

  static const double _maxScale = 1.3;

  /// A short window: the destinations go into the header ([PanelNavRow]).
  static bool docked(BuildContext context) => MediaQuery.sizeOf(context).height < 500;

  /// The bar's height in [context] (what a page leaves free under it).
  static double extent(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).clamp(maxScaleFactor: _maxScale).scale(DurbunType.caption) / DurbunType.caption;
    final item = docked(context) ? 44.0 : math.max(52.0, 14 + 22 + 3 + DurbunType.caption * scale * 1.3);
    return item + 12 + 2;
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: _maxScale,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: DurbunSpace.gutter),
            child: Semantics(
              container: true,
              explicitChildNodes: true,
              label: t.navigation,
              child: Container(
                padding: const EdgeInsets.all(6),
                decoration: BoxDecoration(
                  color: c.isDark ? c.bgElevated : c.bgPanel,
                  borderRadius: BorderRadius.circular(DurbunRadius.xl),
                  border: Border.all(color: c.border),
                  boxShadow: c.floating,
                ),
                child: Row(
                  children: <Widget>[
                    for (var i = 0; i < destinations.length; i++) ...<Widget>[
                      if (i > 0) const SizedBox(width: 4),
                      Expanded(
                        child: _NavItem(
                          destination: destinations[i],
                          selected: i == selected,
                          compact: false,
                          barColor: c.isDark ? c.bgElevated : c.bgPanel,
                          onTap: () => onSelect(i),
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
    );
  }
}

/// The destinations in the header of a short window: icons in a row, the
/// current one a filled tile with its label. Same counts and names for
/// screen readers as the floating bar.
class PanelNavRow extends StatelessWidget {
  const PanelNavRow({super.key, required this.destinations, required this.selected, required this.onSelect});

  final List<PanelDestination> destinations;
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: PanelNavBar._maxScale,
      child: Semantics(
        container: true,
        explicitChildNodes: true,
        label: InspectorStrings.of(context).navigation,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (var i = 0; i < destinations.length; i++) ...<Widget>[
              if (i > 0) const SizedBox(width: 2),
              _NavItem(
                destination: destinations[i],
                selected: i == selected,
                compact: true,
                barColor: c.bgApp,
                onTap: () => onSelect(i),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem(
      {required this.destination, required this.selected, required this.compact, required this.barColor, required this.onTap});

  final PanelDestination destination;
  final bool selected;
  final bool compact;
  final Color barColor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final fg = selected ? c.onAccent : c.textMuted;
    final badge = destination.badge;
    final bg = selected ? c.accentFill : barColor;
    final icon = Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        Icon(destination.icon, size: 22, color: fg),
        if (badge > 0)
          Positioned(left: 13, top: -5, child: _NavBadge(count: badge, ring: bg)),
      ],
    );
    final label = FittedBox(
      fit: BoxFit.scaleDown,
      child: Text(
        destination.label,
        maxLines: 1,
        style: TextStyle(
          fontSize: DurbunType.caption,
          height: 1.3,
          letterSpacing: 0.2,
          color: fg,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
        ),
      ),
    );
    return Semantics(
      button: true,
      selected: selected,
      label: badge > 0 ? '${destination.label}, ${t.errorCountShort(badge)}' : destination.label,
      excludeSemantics: true,
      onTap: onTap,
      child: Tooltip(
        message: destination.label,
        excludeFromSemantics: true,
        child: Pressable(
          onTap: onTap,
          builder: (pressed) => AnimatedContainer(
            duration: DurbunMotion.of(context, DurbunMotion.fast),
            curve: DurbunMotion.curve,
            constraints: BoxConstraints(minHeight: compact ? 44 : 52, minWidth: compact ? 44 : 0),
            padding: EdgeInsets.symmetric(horizontal: compact ? 10 : 4, vertical: compact ? 4 : 7),
            decoration: BoxDecoration(
              color: selected ? c.accentFill : (pressed ? c.bgActive : Colors.transparent),
              // The bar's radius minus its 6 pt inset.
              borderRadius: BorderRadius.circular(DurbunRadius.xl - 6),
            ),
            child: compact
                ? Row(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    // Docked: the icon, and the current one's label. The
                    // badge reaches past the icon: the label starts after it.
                    children: <Widget>[
                      icon,
                      if (selected) ...<Widget>[SizedBox(width: badge > 0 ? 14 : 6), Flexible(child: label)],
                    ],
                  )
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[icon, const SizedBox(height: 3), label],
                  ),
          ),
        ),
      ),
    );
  }
}

/// The red count on a destination's icon, ringed in the tile's colour so it
/// stands apart from the icon.
class _NavBadge extends StatelessWidget {
  const _NavBadge({required this.count, required this.ring});

  final int count;
  final Color ring;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      height: 18,
      constraints: const BoxConstraints(minWidth: 18),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: c.danger,
        borderRadius: BorderRadius.circular(DurbunRadius.pill),
        border: Border.all(color: ring, width: 2),
      ),
      child: Text(
        count > 99 ? '99+' : '$count',
        textScaler: TextScaler.noScaling,
        style: DurbunType.ui(size: 10, color: c.onDanger, weight: FontWeight.w700, height: 1.1),
      ),
    );
  }
}
