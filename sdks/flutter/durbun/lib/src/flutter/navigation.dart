import 'package:flutter/widgets.dart';

import '../inspector/panel.dart' show kInspectorRouteName;
import 'durbun.dart';

/// Sends a `navigation` event (`{from, to}`, route names only) each time the
/// screen on top of the navigator changes, so logs and requests can be read
/// next to the screen they happened on. The desktop shows the same event
/// from every Dürbün SDK.
///
/// ```dart
/// MaterialApp(
///   navigatorObservers: [DurbunNavigatorObserver()],
///   builder: DurbunInspector.builder,
/// )
/// // go_router: GoRouter(observers: [DurbunNavigatorObserver()], …)
/// ```
///
/// Only pages count (dialogs and sheets do not change the screen), and only
/// pages with a name: set `RouteSettings(name: …)` on routes you push, use
/// named routes, or pass [routeName]. Route arguments are never sent: they
/// often carry ids, tokens or personal data. One observer serves one
/// navigator; give each nested navigator its own. A no-op when the SDK is off.
class DurbunNavigatorObserver extends NavigatorObserver {
  DurbunNavigatorObserver({this.routeName});

  /// The name shown for [Route]s; return null to skip one. Default: the
  /// route's `settings.name`.
  final String? Function(Route<dynamic> route)? routeName;

  String? _current;

  /// The screen name last reported (null before the first one).
  String? get currentScreen => _current;

  String? _nameOf(Route<dynamic>? route) {
    if (route is! PageRoute) return null;
    try {
      final name = routeName != null ? routeName!(route) : route.settings.name;
      if (name == null || name.isEmpty || name == kInspectorRouteName) return null;
      return name;
    } catch (_) {
      return null;
    }
  }

  void _show(Route<dynamic>? route) {
    final name = _nameOf(route);
    if (name == null || name == _current) return;
    final from = _current;
    _current = name;
    try {
      Durbun.event('navigation', <String, Object?>{
        if (from != null) 'from': from,
        'to': name,
      });
    } catch (_) {}
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      _show(route);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (route is PageRoute) _show(previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    try {
      if (newRoute != null && newRoute.isCurrent) _show(newRoute);
    } catch (_) {}
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    try {
      if (previousRoute != null && previousRoute.isCurrent) _show(previousRoute);
    } catch (_) {}
  }
}
