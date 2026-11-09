/// `DurbunInspector`: the in-app inspector (full-screen panel, opened by
/// shaking the phone) that shows what the SDK captured, on the phone itself.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'format.dart';
import 'panel.dart';
import 'run_file.dart';
import 'run_log.dart';
import 'store.dart';
import 'strings.dart';
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
/// Works the same under `MaterialApp.router`, `CupertinoApp` and
/// `WidgetsApp`. The panel is one route named `/durbun` on the app's
/// navigator; its own pages, sheets and toasts stay inside it (route
/// observers and the app's snack bars never see them).
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
    this.maxRequests = DurbunInspectorStore.kDefaultMaxCalls,
    this.maxLogs = DurbunInspectorStore.kDefaultMaxLogs,
    this.maxBodyBytes = DurbunInspectorStore.kDefaultMaxBodyBytes,
    this.keepPreviousRun = false,
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

  /// Navigator the panel's one route (`/durbun`) is pushed on. By default
  /// the first navigator below this widget: the app's own when this is the
  /// app's `builder` (`MaterialApp`, `MaterialApp.router`, `CupertinoApp`).
  /// The panel's pages are on a navigator of its own inside that route.
  final GlobalKey<NavigatorState>? navigatorKey;

  /// Store to show (tests); defaults to the one the SDK feeds. A store
  /// passed here keeps its own limits: [maxRequests], [maxLogs] and
  /// [maxBodyBytes] set the SDK's store.
  final DurbunInspectorStore? store;

  /// Hosts the panel lists by default: exact names or `*.example.com`
  /// (empty: all). Requests to other hosts (analytics, Firebase Storage …)
  /// are still captured and still reach the desktop; on the phone they are
  /// hidden until ticked under Network → Filters → Hosts.
  final List<String> defaultHosts;

  /// Requests kept on the phone (default 1000). When full, requests to
  /// hosts outside [defaultHosts] go first, then the oldest.
  final int maxRequests;

  /// Log lines kept on the phone (default 2000); the oldest go first.
  final int maxLogs;

  /// Request and response bodies kept on the phone, in bytes (default
  /// 24 MB). Past it the oldest bodies are dropped (other hosts' first);
  /// their requests stay in the list.
  final int maxBodyBytes;

  /// Keeps this run's requests, logs and crashes in a file in the app's
  /// cache directory, so the next launch shows them under Tools → Previous
  /// run: what happened before a crash, after the app restarts. Off by
  /// default. Requests are masked like a session export (Authorization,
  /// cookies, token and password fields); each body keeps its first 16 KB.
  /// Written asynchronously at most once a second (a crash at once),
  /// at most two 4 MB files; read only when the page opens. Nothing on the
  /// web.
  final bool keepPreviousRun;

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
  DurbunInspectorStore? _watched;

  DurbunInspectorStore get _store =>
      widget.store ?? DurbunInspectorStore.instance;

  bool get _enabled => widget.store != null || _store.attached;

  @override
  void initState() {
    super.initState();
    InspectorBody.prettyJson ??= prettyJsonText;
    _configure();
    DurbunInspector._openRequests.addListener(_openPanel);
    WidgetsBinding.instance.addObserver(this);
    _syncShake();
  }

  @override
  void didUpdateWidget(DurbunInspector old) {
    super.didUpdateWidget(old);
    _configure();
    _syncShake();
  }

  /// Hands the options to the store and follows whether the SDK feeds it
  /// (`Durbun.init()` can run after `runApp`).
  void _configure() {
    final store = _store..defaultHosts = widget.defaultHosts;
    if (widget.store == null) {
      store
        ..maxCalls = widget.maxRequests
        ..maxLogs = widget.maxLogs
        ..maxBodyBytes = widget.maxBodyBytes;
    }
    if (!identical(store, _watched)) {
      _watched?.attachedListenable.removeListener(_attachedChanged);
      store.attachedListenable.addListener(_attachedChanged);
      _watched = store;
    }
    _syncPreviousRun();
  }

  /// Starts the previous-run log once the SDK feeds the store (it then
  /// lives as long as the store); turning [DurbunInspector.keepPreviousRun]
  /// off stops its writing.
  void _syncPreviousRun() {
    try {
      final store = _store;
      final journal = RunJournal.of(store);
      if (journal != null) {
        journal.recording = widget.keepPreviousRun;
      } else if (widget.keepPreviousRun && _enabled) {
        startRunJournal(store);
      }
    } catch (_) {
      // The log is a convenience: the app never sees its errors.
    }
  }

  void _attachedChanged() {
    if (!mounted) return;
    setState(() {});
    _syncShake();
    _syncPreviousRun();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _syncShake(state);
    // The process may be killed in the background: what is waiting goes now.
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden || state == AppLifecycleState.detached) {
      RunJournal.of(_store)?.flushNow();
    }
  }

  @override
  void dispose() {
    DurbunInspector._openRequests.removeListener(_openPanel);
    _watched?.attachedListenable.removeListener(_attachedChanged);
    WidgetsBinding.instance.removeObserver(this);
    _setShake(false);
    super.dispose();
  }

  /// Listens for shakes only while it can open the panel: the app in front
  /// and the panel closed (no sensor while it is open).
  void _syncShake([AppLifecycleState? state]) {
    final s = state ?? WidgetsBinding.instance.lifecycleState;
    final foreground = s == null || s == AppLifecycleState.resumed;
    _setShake(widget.openOnShake && _enabled && foreground && !_open);
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
    _syncShake();
    final store = _store;
    store.markSeen();
    store.panelOpen.value = true;
    late final MaterialPageRoute<void> route;
    route = MaterialPageRoute<void>(
      settings: const RouteSettings(name: kInspectorRouteName),
      // Rises over the app like a sheet; no edge swipe fighting the tabs.
      fullscreenDialog: true,
      builder: (_) => InspectorPanelHost(store: store, onClose: () => _close(route)),
    );
    try {
      await navigator.push<void>(route);
    } finally {
      if (mounted) {
        setState(() => _open = false);
        _syncShake();
      }
      store.markSeen();
      store.panelOpen.value = false;
    }
  }

  /// Closes the panel's route, also when the app pushed something over it.
  static void _close(Route<void> route) {
    final navigator = route.navigator;
    if (navigator == null || !route.isActive) return;
    if (route.isCurrent) {
      navigator.pop();
    } else {
      navigator.removeRoute(route);
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
