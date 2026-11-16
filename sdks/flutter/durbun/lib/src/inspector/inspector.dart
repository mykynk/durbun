/// `DurbunInspector`: the in-app inspector (full-screen panel, opened by
/// shaking the phone) that shows what the SDK captured, on the phone itself.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show kDebugMode, visibleForTesting;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../flutter/durbun.dart' show durbunBackend;
import 'format.dart';
import 'panel.dart';
import 'panel_prefs.dart';
import 'run_file.dart';
import 'run_log.dart';
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'unavailable_view.dart';

/// Builds the panel's page. Set by the SDK when it starts with the
/// inspector on; the panel's pages are reached only through it, so the
/// compiler leaves them out of a build in which the SDK can never start (a
/// release build without `--dart-define=DURBUN=true` and without
/// `DurbunOptions(enabled: true)`).
Widget Function(DurbunInspectorStore store, VoidCallback onClose)? inspectorPanelBuilder;

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
/// The panel opens by shaking the phone ([openOnShake]), from the bubble
/// ([showBubble]) or from your own code with [DurbunInspector.show]. The
/// first launch with the SDK running shows a short "shake to open" hint
/// once ([showHint]).
///
/// When Dürbün is off in a build (`DurbunOptions.enabled`, `DURBUN=false`,
/// `DurbunOptions.inspector: false`) or `Durbun.run` was not called, it
/// only shows [child]: shaking does nothing, [DurbunInspector.show] opens a
/// page that says why and what to do, and a debug build says the same once
/// in the console.
class DurbunInspector extends StatefulWidget {
  /// Puts the inspector around [child] (usually from `MaterialApp.builder`,
  /// see [builder]); the other parameters tune how it opens and what it keeps.
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
    this.showHint = true,
  });

  /// For `MaterialApp.builder` / `CupertinoApp.builder`.
  static Widget builder(BuildContext context, Widget? child) =>
      DurbunInspector(child: child ?? const SizedBox.shrink());

  /// The app, drawn as it is; the panel opens over it on its navigator.
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

  /// On the first launch with the SDK running, shows "Shake the phone to
  /// open the Dürbün panel" at the bottom of the screen for a few seconds,
  /// once per install (kept in the app's cache directory). Only when
  /// [openOnShake] is on and [showBubble] is off. Set false to never show it.
  final bool showHint;

  static final ValueNotifier<int> _openRequests = ValueNotifier<int>(0);

  /// Opens the panel (no-op when no [DurbunInspector] is mounted), e.g. from
  /// a debug menu or a long press of your own. When the SDK does not run it
  /// opens a page that says why (not started, off in this build, panel
  /// turned off) and what to do.
  static void show() => _openRequests.value++;

  /// Tests: lets the once-per-process hint and console line come again.
  @visibleForTesting
  static void debugResetOnce() {
    _DurbunInspectorState._hintChecked = false;
    _DurbunInspectorState._consoleChecked = false;
  }

  @override
  State<DurbunInspector> createState() => _DurbunInspectorState();
}

class _DurbunInspectorState extends State<DurbunInspector> with WidgetsBindingObserver {
  static const MethodChannel _shake = MethodChannel('dev.durbun/shake');
  bool _listening = false;

  bool _open = false;
  Offset? _bubble;
  DurbunInspectorStore? _watched;

  /// Process-wide: the hint and the console line come at most once, also
  /// when the app rebuilds or remounts the inspector.
  static bool _hintChecked = false;
  static bool _consoleChecked = false;
  static const String kHintPref = 'shake-hint-shown';
  Timer? _hintTimer;
  Timer? _hintHide;
  OverlayEntry? _hint;
  Timer? _consoleTimer;

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
    _scheduleConsoleNote();
    _scheduleHint();
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
    _scheduleHint();
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
    _consoleTimer?.cancel();
    _hintTimer?.cancel();
    _removeHint();
    super.dispose();
  }

  /// Debug builds: when the SDK does not feed the panel a few seconds after
  /// start, says why in the console once (the panel would stay closed).
  void _scheduleConsoleNote() {
    if (!kDebugMode || _consoleChecked || widget.store != null) return;
    final backend = durbunBackend();
    if (backend.inFlutterTest) return;
    _consoleChecked = true;
    _consoleTimer = Timer(const Duration(seconds: 3), () {
      if (!mounted || _enabled) return;
      try {
        final text = inspectorUnavailableConsoleText(backend.startState, backend.offReason);
        if (text != null) debugPrint(text);
      } catch (_) {}
    });
  }

  /// Once per install: "shake to open" at the bottom for a few seconds,
  /// when shaking is the only way in.
  void _scheduleHint() {
    if (_hintChecked ||
        !widget.showHint ||
        !widget.openOnShake ||
        widget.showBubble ||
        widget.store != null ||
        !_enabled ||
        !panelPrefsAvailable) {
      return;
    }
    _hintChecked = true;
    _hintTimer = Timer(const Duration(seconds: 2), () => unawaited(_showHint()));
  }

  Future<void> _showHint() async {
    try {
      if (await readPanelPref(kHintPref) != null) return;
      if (!mounted || _open) return;
      // Shown only when it is kept, so it never comes back on every launch.
      if (!await writePanelPref(kHintPref, '1')) return;
      if (!mounted || _open) return;
      final overlay = _navigator()?.overlay;
      if (overlay == null) return;
      final device = _store.hello?['device'];
      final simulator = device is Map && device['isPhysical'] == false;
      _hint = OverlayEntry(
        builder: (context) => ShakeHint(simulator: simulator, onDismiss: _removeHint),
      );
      overlay.insert(_hint!);
      _hintHide = Timer(const Duration(seconds: 8), _removeHint);
    } catch (_) {
      // A hint is a nicety: the app never sees its errors.
    }
  }

  void _removeHint() {
    _hintHide?.cancel();
    _hintHide = null;
    final hint = _hint;
    _hint = null;
    if (hint != null && hint.mounted) hint.remove();
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
    if (_open || !mounted) return;
    _removeHint();
    // A test store opens the panel directly; an app's panel comes from the
    // running SDK, so a build in which the SDK can never start compiles
    // without the panel's pages (see [inspectorPanelBuilder]).
    final panel = widget.store != null ? _testPanel : inspectorPanelBuilder;
    if (!_enabled || panel == null) return _openUnavailable();
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
      builder: (_) => panel(store, () => _close(route)),
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

  static Widget _testPanel(DurbunInspectorStore store, VoidCallback onClose) =>
      InspectorPanelHost(store: store, onClose: onClose);

  /// [DurbunInspector.show] without a running SDK: a page that says why.
  Future<void> _openUnavailable() async {
    final navigator = _navigator();
    if (navigator == null) return;
    setState(() => _open = true);
    late final MaterialPageRoute<void> route;
    route = MaterialPageRoute<void>(
      settings: const RouteSettings(name: kInspectorRouteName),
      fullscreenDialog: true,
      builder: (routeContext) => panelLocalizations(
        routeContext,
        DurbunTheme.wrap(routeContext, InspectorUnavailablePage(onClose: () => _close(route))),
      ),
    );
    try {
      await navigator.push<void>(route);
    } finally {
      if (mounted) setState(() => _open = false);
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
          // Inside the safe area on every side (a notch in landscape too).
          final minX = pad.left + 4;
          final maxX = math.max(minX, w - size - 12 - pad.right);
          final maxY = math.max(pad.top + 4, h - size - pad.bottom - 12);
          final clamped = Offset(
            pos.dx.clamp(minX, maxX),
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
    // Over the app: the phone's light or dark setting picks the tokens.
    final c = DurbunColors.of(context);
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
                  // A soft shadow on light; on dark a hairline sets it off.
                  child: Container(
                    foregroundDecoration: c.isDark
                        ? BoxDecoration(
                            borderRadius: BorderRadius.circular(size * 0.234),
                            border: Border.all(color: const Color(0x40FFFFFF)),
                          )
                        : null,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(size * 0.234),
                      boxShadow: c.isDark
                          ? const <BoxShadow>[BoxShadow(color: Color(0x80000000), blurRadius: 8, offset: Offset(0, 2))]
                          : c.floating,
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
                      constraints: const BoxConstraints(minWidth: 22),
                      height: 22,
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                      decoration: BoxDecoration(
                        color: c.danger,
                        borderRadius: BorderRadius.circular(11),
                        // A ring in the page colour keeps it apart from the logo.
                        border: Border.all(color: c.isDark ? c.bgApp : Colors.white, width: 2),
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        unseen > 99 ? '99+' : '$unseen',
                        style: TextStyle(
                            color: c.onDanger,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            height: 1.1,
                            fontFeatures: DurbunType.tabular,
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

/// "Shake the phone to open the Dürbün panel", over the bottom of the app
/// for a few seconds on the first launch.
class ShakeHint extends StatelessWidget {
  const ShakeHint({super.key, required this.simulator, required this.onDismiss});

  /// Adds how to shake a simulator or an emulator.
  final bool simulator;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Positioned(
      left: 12,
      right: 12,
      bottom: 12 + (MediaQuery.maybeOf(context)?.padding.bottom ?? 0),
      child: panelLocalizations(
        context,
        DurbunTheme.wrap(
          context,
          Builder(builder: (context) {
            final c = DurbunColors.of(context);
            final t = InspectorStrings.of(context);
            return Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                // A quiet note, not an alert: a soft shadow on light, a
                // hairline on dark.
                child: Container(
                  key: const ValueKey<String>('durbun-shake-hint'),
                  decoration: BoxDecoration(
                    color: c.bgElevated,
                    borderRadius: BorderRadius.circular(DurbunRadius.lg),
                    border: c.isDark ? Border.all(color: c.borderStrong) : null,
                    boxShadow: c.floating,
                  ),
                  child: Material(
                    type: MaterialType.transparency,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(14, 10, 4, 10),
                      child: Row(
                        children: <Widget>[
                          const DurbunLogo(size: 28),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Text(t.shakeHint,
                                    style: TextStyle(fontSize: DurbunType.body + 1, fontWeight: FontWeight.w600, color: c.text, height: 1.3)),
                                if (simulator) ...<Widget>[
                                  const SizedBox(height: 2),
                                  Text(t.shakeHintSimulator,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(fontSize: DurbunType.body - 1, color: c.textMuted, height: 1.35)),
                                ],
                              ],
                            ),
                          ),
                          TextButton(onPressed: onDismiss, child: Text(t.gotIt)),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
}
