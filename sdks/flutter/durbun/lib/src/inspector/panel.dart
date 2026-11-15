/// What lives inside the one route the panel pushes on the app's navigator
/// (`/durbun`): the panel's own [Navigator] (detail pages, sheets and menus
/// never reach the app's route observers, analytics or Sentry), its own
/// [ScaffoldMessenger] ("Copied" toasts never touch the app's snack bars),
/// the Material / Cupertino texts its widgets need (also under a
/// `CupertinoApp` or a bare `WidgetsApp`) and its theme.
library;

import 'dart:math' as math;

import 'package:flutter/cupertino.dart' show CupertinoLocalizations, DefaultCupertinoLocalizations;
import 'package:flutter/foundation.dart' show SynchronousFuture;
import 'package:flutter/material.dart';

import 'home.dart';
import 'store.dart';
import 'theme.dart';

/// The route name the panel opens under on the app's navigator.
const String kInspectorRouteName = '/durbun';

class InspectorPanelHost extends StatefulWidget {
  const InspectorPanelHost({super.key, required this.store, required this.onClose});

  final DurbunInspectorStore store;

  /// Closes the panel (pops the `/durbun` route).
  final VoidCallback onClose;

  @override
  State<InspectorPanelHost> createState() => _InspectorPanelHostState();
}

class _InspectorPanelHostState extends State<InspectorPanelHost> {
  final GlobalKey<NavigatorState> _navigator = GlobalKey<NavigatorState>(debugLabel: 'durbun.panel');

  @override
  Widget build(BuildContext context) {
    final panel = ScaffoldMessenger(
      // Back (Android button, predictive back, Esc) closes the panel's own
      // pages and sheets first, then the panel.
      child: NavigatorPopHandler<Object?>(
        onPopWithResult: (_) => _navigator.currentState?.maybePop(),
        child: Navigator(
          key: _navigator,
          onGenerateInitialRoutes: (_, __) => <Route<void>>[
            MaterialPageRoute<void>(
              builder: (routeContext) =>
                  DurbunTheme.wrap(routeContext, InspectorHome(store: widget.store, onClose: widget.onClose)),
            ),
          ],
        ),
      ),
    );
    // Landscape and tablets: the panel stops at a readable width, centred
    // on the page colour (which also takes the taps beside it).
    return panelLocalizations(
      context,
      DurbunTheme.wrap(
        context,
        Builder(builder: (context) {
          final mq = MediaQuery.of(context);
          // The margin beside a capped panel already clears a notch: the
          // panel keeps only the part of the side insets it still covers.
          final margin = math.max(0.0, (mq.size.width - DurbunSpace.maxContent) / 2);
          EdgeInsets inset(EdgeInsets p) => p.copyWith(
              left: math.max(0.0, p.left - margin), right: math.max(0.0, p.right - margin));
          return ColoredBox(
            color: DurbunColors.of(context).bgApp,
            child: MaxWidth(
              child: MediaQuery(
                data: mq.copyWith(padding: inset(mq.padding), viewPadding: inset(mq.viewPadding)),
                child: panel,
              ),
            ),
          );
        }),
      ),
    );
  }
}

/// [child] under a [Localizations] that has the Material, Cupertino and
/// widgets texts: the app's own where it has them (a Turkish `MaterialApp`
/// keeps its Turkish texts), the framework's English defaults where it has
/// none (`CupertinoApp`, `WidgetsApp`). Only these three: the app's other
/// delegates are not loaded again.
///
/// The panel speaks Turkish or English only, so in an app in any other
/// language it takes the English defaults (not, say, Arabic tooltips next
/// to English text), and it is always laid out left to right: in a
/// right-to-left app the English text does not run right to left.
Widget panelLocalizations(BuildContext context, Widget child) {
  final appLocale = Localizations.maybeLocaleOf(context) ?? WidgetsBinding.instance.platformDispatcher.locale;
  final own = appLocale.languageCode == 'tr' || appLocale.languageCode == 'en';
  final locale = own ? appLocale : const Locale('en');
  final material = own ? Localizations.of<MaterialLocalizations>(context, MaterialLocalizations) : null;
  final cupertino = own ? Localizations.of<CupertinoLocalizations>(context, CupertinoLocalizations) : null;
  final widgets = own ? Localizations.of<WidgetsLocalizations>(context, WidgetsLocalizations) : null;
  return Localizations(
    locale: locale,
    delegates: <LocalizationsDelegate<dynamic>>[
      _Given<MaterialLocalizations>(material ?? const DefaultMaterialLocalizations()),
      _Given<CupertinoLocalizations>(cupertino ?? const DefaultCupertinoLocalizations()),
      _Given<WidgetsLocalizations>(widgets ?? const DefaultWidgetsLocalizations()),
    ],
    child: Directionality(textDirection: TextDirection.ltr, child: child),
  );
}

/// Hands out a resource that is already loaded, for any locale.
class _Given<T> extends LocalizationsDelegate<T> {
  const _Given(this.value);

  final T value;

  @override
  bool isSupported(Locale locale) => true;

  @override
  Future<T> load(Locale locale) => SynchronousFuture<T>(value);

  @override
  bool shouldReload(_Given<T> old) => !identical(old.value, value);
}
