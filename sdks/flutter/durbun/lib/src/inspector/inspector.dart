/// `DurbunInspector`: the in-app inspector (full-screen panel, opened by
/// shaking the phone) that shows what the SDK captured, on the phone itself.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'format.dart';
import 'store.dart';
import 'strings.dart';
import 'home.dart';
import 'theme.dart';

/// Puts Dürbün's in-app inspector into the app: shake the phone to open a
/// panel with logs, network requests, mocks, performance and device info. It
/// works without the desktop, and shows what the desktop would (Dart, Dio,
/// native OkHttp / URLSession traffic, native logs). Nothing is drawn over
/// the app unless [showBubble] is set.
///
/// ```dart
/// MaterialApp(
///   builder: DurbunInspector.builder,
///   home: const HomePage(),
/// );
/// ```
///
/// When Dürbün is off in a build (`DurbunOptions.enabled`, `DURBUN=false`,
/// `DurbunOptions.inspector: false`) it only shows [child].
class DurbunInspector extends StatefulWidget {
  const DurbunInspector({
    super.key,
    required this.child,
    this.showBubble = false,
    this.openOnShake = true,
    this.navigatorKey,
    this.store,
    this.defaultHosts = const <String>[],
  });

  /// For `MaterialApp.builder` / `CupertinoApp.builder`.
  static Widget builder(BuildContext context, Widget? child) =>
      DurbunInspector(child: child ?? const SizedBox.shrink());

  final Widget child;

  /// Show a small draggable Dürbün button over the app (off by default).
  final bool showBubble;

  /// Shaking the phone opens the panel (simulator: Device → Shake; Android
  /// emulator: Extended controls → Virtual sensors → Shake). The
  /// accelerometer is read only while the app is in the foreground.
  final bool openOnShake;

  /// Navigator the panel opens on. By default the first navigator below this
  /// widget (the app's own, when used as `MaterialApp.builder`).
  final GlobalKey<NavigatorState>? navigatorKey;

  /// Store to show (tests); defaults to the one the SDK feeds.
  final DurbunInspectorStore? store;

  /// Hosts the panel lists by default: exact names or `*.example.com`
  /// (empty: all). Requests to other hosts (analytics, Firebase Storage …)
  /// are still captured and still reach the desktop; on the phone they are
  /// hidden until ticked under Network → Filters → Hosts.
  final List<String> defaultHosts;

  static final ValueNotifier<int> _openRequests = ValueNotifier<int>(0);

  /// Opens the panel (no-op when no [DurbunInspector] is mounted), e.g. from
  /// a debug menu or a long press of your own.
  static void show() => _openRequests.value++;

  @override
  State<DurbunInspector> createState() => _DurbunInspectorState();
}

class _DurbunInspectorState extends State<DurbunInspector> with WidgetsBindingObserver {
  static const MethodChannel _shake = MethodChannel('dev.durbun/shake');
  bool _listening = false;

  bool _open = false;
  Offset? _bubble;

  DurbunInspectorStore get _store =>
      widget.store ?? DurbunInspectorStore.instance;

  bool get _enabled => widget.store != null || _store.attached;

  @override
  void initState() {
    super.initState();
    InspectorBody.prettyJson ??= prettyJsonText;
    _store.defaultHosts = widget.defaultHosts;
    DurbunInspector._openRequests.addListener(_openPanel);
    WidgetsBinding.instance.addObserver(this);
    _syncShake();
  }

  @override
  void didUpdateWidget(DurbunInspector old) {
    super.didUpdateWidget(old);
    _store.defaultHosts = widget.defaultHosts;
    _syncShake();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _syncShake(state);

  @override
  void dispose() {
    DurbunInspector._openRequests.removeListener(_openPanel);
    WidgetsBinding.instance.removeObserver(this);
    _setShake(false);
    super.dispose();
  }

  /// Listens for shakes only while it can open the panel and the app is in front.
  void _syncShake([AppLifecycleState? state]) {
    final s = state ?? WidgetsBinding.instance.lifecycleState;
    final foreground = s == null || s == AppLifecycleState.resumed;
    _setShake(widget.openOnShake && _enabled && foreground);
  }

  void _setShake(bool on) {
    if (on == _listening) return;
    _listening = on;
    try {
      _shake.setMethodCallHandler(on ? _onShakeCall : null);
      _shake.invokeMethod<Object?>('listen', on).catchError((Object _) => null);
    } catch (_) {
      // No plugin (web, tests): shaking just does nothing.
    }
  }

  Future<Object?> _onShakeCall(MethodCall call) async {
    if (call.method == 'shake') unawaited(_openPanel());
    return null;
  }

  NavigatorState? _navigator() {
    final keyed = widget.navigatorKey?.currentState;
    if (keyed != null) return keyed;
    NavigatorState? found;
    void visit(Element e) {
      if (found != null) return;
      if (e is StatefulElement && e.state is NavigatorState) {
        found = e.state as NavigatorState;
        return;
      }
      e.visitChildElements(visit);
    }

    if (mounted) context.visitChildElements(visit);
    return found;
  }

  Future<void> _openPanel() async {
    if (_open || !mounted || !_enabled) return;
    final navigator = _navigator();
    if (navigator == null) return;
    setState(() => _open = true);
    _store.markSeen();
    try {
      await navigator.push<void>(
        MaterialPageRoute<void>(
          settings: const RouteSettings(name: '/durbun'),
          // Rises over the app like a sheet; no edge swipe fighting the tabs.
          fullscreenDialog: true,
          builder: (routeContext) => DurbunTheme.wrap(routeContext, InspectorHome(store: _store)),
        ),
      );
    } finally {
      if (mounted) setState(() => _open = false);
      _store.markSeen();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_enabled || !widget.showBubble) return widget.child;
    return Stack(
      textDirection: TextDirection.ltr,
      children: <Widget>[
        widget.child,
        if (!_open) _positionedBubble(context),
      ],
    );
  }

  /// A full-size layer that only hit-tests the bubble, so taps elsewhere
  /// reach the app.
  Widget _positionedBubble(BuildContext context) {
    const size = 52.0;
    return Positioned.fill(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final pad = MediaQuery.maybeOf(context)?.padding ?? EdgeInsets.zero;
          final w = constraints.maxWidth;
          final h = constraints.maxHeight;
          final pos = _bubble ?? Offset(w - size - 16, h * 0.6);
          final maxX = math.max(4.0, w - size - 12);
          final maxY = math.max(pad.top + 4, h - size - pad.bottom - 12);
          final clamped = Offset(
            pos.dx.clamp(4.0, maxX),
            pos.dy.clamp(pad.top + 4, maxY),
          );
          return Stack(
            children: <Widget>[
              Positioned(
                left: clamped.dx,
                top: clamped.dy,
                child: GestureDetector(
                  onPanUpdate: (d) =>
                      setState(() => _bubble = clamped + d.delta),
                  onTap: _openPanel,
                  child: InspectorBubble(store: _store, size: size),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// The floating button, with a red badge for errors and failed requests
/// that arrived since the panel was last opened.
class InspectorBubble extends StatelessWidget {
  const InspectorBubble({super.key, required this.store, this.size = 52});

  final DurbunInspectorStore store;
  final double size;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final unseen = store.unseenErrors;
        return Semantics(
          button: true,
          label: t.title,
          child: SizedBox(
            width: size + 8,
            height: size + 8,
            child: Stack(
              clipBehavior: Clip.none,
              children: <Widget>[
                Positioned(
                  left: 4,
                  top: 4,
                  child: Container(
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(size * 0.234),
                      boxShadow: const <BoxShadow>[
                        BoxShadow(color: Color(0x66000000), blurRadius: 10, offset: Offset(0, 3)),
                      ],
                    ),
                    child: DurbunLogo(size: size),
                  ),
                ),
                if (unseen > 0)
                  Positioned(
                    right: 0,
                    top: 0,
                    child: Container(
                      key: const ValueKey<String>('durbun-bubble-badge'),
                      constraints: const BoxConstraints(minWidth: 20),
                      height: 20,
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFF6369),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: Colors.white, width: 1.5),
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        unseen > 99 ? '99+' : '$unseen',
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            decoration: TextDecoration.none),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
