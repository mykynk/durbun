import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// The panel is one `/durbun` route on the app's navigator; its pages,
/// sheets, menus and toasts live on its own navigator and messenger, under
/// every kind of app.

const MethodChannel _shake = MethodChannel('dev.durbun/shake');

DurbunInspectorStore _store() {
  final bytes = Uint8List.fromList(utf8.encode('{"ok":true}'));
  return DurbunInspectorStore(notifyDelay: Duration.zero)
    ..bodyResolver = wireBodyFromPending
    ..ingest(buildNetRequest(id: '1', ts: 1000, method: 'GET', url: 'https://api.example.com/v1/orders?q=%FF', headers: const []))
    ..ingest(buildNetResponse(
        id: '1',
        ts: 1100,
        status: 200,
        headers: const [['Content-Type', 'application/json']],
        body: PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: 'application/json')));
}

/// Every route the app's navigator reports.
class _Routes extends NavigatorObserver {
  final List<String?> names = <String?>[];

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => names.add(route.settings.name);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => names.add(route.settings.name);

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) => names.add(route.settings.name);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => names.add(newRoute?.settings.name);
}

/// A minimal `MaterialApp.router` setup (no go_router).
class _Delegate extends RouterDelegate<Object> with ChangeNotifier, PopNavigatorRouterDelegateMixin<Object> {
  _Delegate(this.observer);

  final NavigatorObserver observer;

  @override
  final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

  @override
  Widget build(BuildContext context) => Navigator(
        key: navigatorKey,
        observers: <NavigatorObserver>[observer],
        pages: const <Page<void>>[MaterialPage<void>(child: Scaffold(body: Text('the app')))],
        onDidRemovePage: (_) {},
      );

  @override
  Future<void> setNewRoutePath(Object configuration) async {}
}

typedef _AppBuilder = Widget Function(DurbunInspectorStore store, _Routes routes);

Widget _inspector(DurbunInspectorStore store, Widget? child) => DurbunInspector(store: store, child: child!);

final Map<String, _AppBuilder> _apps = <String, _AppBuilder>{
  'MaterialApp': (store, routes) => MaterialApp(
        navigatorObservers: <NavigatorObserver>[routes],
        builder: (context, child) => _inspector(store, child),
        home: const Scaffold(body: Text('the app')),
      ),
  'MaterialApp.router': (store, routes) => MaterialApp.router(
        routerConfig: RouterConfig<Object>(routerDelegate: _Delegate(routes), backButtonDispatcher: RootBackButtonDispatcher()),
        builder: (context, child) => _inspector(store, child),
      ),
  'CupertinoApp': (store, routes) => CupertinoApp(
        navigatorObservers: <NavigatorObserver>[routes],
        builder: (context, child) => _inspector(store, child),
        home: const CupertinoPageScaffold(child: Center(child: Text('the app'))),
      ),
  'WidgetsApp': (store, routes) => WidgetsApp(
        color: const Color(0xFF7C6CF2),
        navigatorObservers: <NavigatorObserver>[routes],
        pageRouteBuilder: <T>(RouteSettings settings, WidgetBuilder builder) =>
            PageRouteBuilder<T>(settings: settings, pageBuilder: (context, _, __) => builder(context)),
        builder: (context, child) => _inspector(store, child),
        home: const Center(child: Text('the app')),
      ),
};

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (_) async => true));
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null));

  for (final MapEntry(key: name, value: build) in _apps.entries) {
    testWidgets('$name: open, detail, copy, sheet, menu, back twice; only /durbun reaches the app', (tester) async {
      await _phone(tester);
      final store = _store();
      final routes = _Routes();
      await tester.pumpWidget(build(store, routes));
      await tester.pumpAndSettle();
      expect(find.text('the app'), findsOneWidget);
      routes.names.clear();

      Durbun.showInspector();
      await tester.pumpAndSettle();
      expect(find.textContaining('/v1/orders'), findsOneWidget, reason: 'the panel is open on Network');
      // A filter sheet (a TextField and Material texts under any app).
      await tester.tap(find.text('Filters'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'orders');
      await tester.pumpAndSettle();

      await tester.tap(find.textContaining('/v1/orders'));
      await tester.pumpAndSettle();
      // `?q=%FF` is not UTF-8: the Request tab must not throw.
      await tester.tap(find.text('Request').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Query').first);
      await tester.pumpAndSettle();
      expect(find.text('%FF'), findsOneWidget, reason: 'the malformed escape is shown as written');
      await tester.tap(find.byTooltip('Copy URL'));
      await tester.pump();
      expect(find.text('Copied'), findsOneWidget, reason: "the toast shows on the panel's own messenger");
      await tester.pumpAndSettle();
      // A popup menu, on the panel's navigator too.
      await tester.tap(find.byTooltip('More actions'));
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();

      // Back: the detail page first, then the panel.
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.textContaining('/v1/orders'), findsOneWidget, reason: 'back closed the detail, the panel stays');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.textContaining('/v1/orders'), findsNothing, reason: 'the second back closes the panel');
      expect(find.text('the app'), findsOneWidget);

      expect(routes.names, isNotEmpty);
      expect(routes.names.toSet(), <String>{'/durbun'}, reason: 'route observers (analytics, Sentry) see one route');
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets("the app's own snack bar survives a copy in the panel", (tester) async {
    await _phone(tester);
    final messenger = GlobalKey<ScaffoldMessengerState>();
    await tester.pumpWidget(MaterialApp(
      scaffoldMessengerKey: messenger,
      builder: (context, child) => _inspector(_store(), child),
      home: const Scaffold(body: Text('the app')),
    ));
    messenger.currentState!.showSnackBar(const SnackBar(content: Text('app toast'), duration: Duration(hours: 1)));
    await tester.pumpAndSettle();
    expect(find.text('app toast'), findsOneWidget);

    Durbun.showInspector();
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('/v1/orders'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Copy URL'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.text('app toast'), findsOneWidget, reason: "the panel never hides the app's snack bar");
  });

  testWidgets('Durbun.init after runApp: shaking works once the SDK attaches', (tester) async {
    final listen = <Object?>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (call) async {
      if (call.method == 'listen') listen.add(call.arguments);
      return true;
    });
    final store = DurbunInspectorStore(notifyDelay: Duration.zero);
    final previous = DurbunInspectorStore.existing;
    DurbunInspectorStore.instance = store;
    addTearDown(() {
      if (previous != null) DurbunInspectorStore.instance = previous;
    });
    await tester.pumpWidget(MaterialApp(builder: DurbunInspector.builder, home: const Text('the app')));
    expect(listen.where((x) => x == true), isEmpty, reason: 'not fed by the SDK yet');
    store.attached = true;
    await tester.pump();
    expect(listen.last, true, reason: 'listens as soon as the SDK attaches, no resume needed');
    store.attached = false;
    await tester.pump();
    expect(listen.last, false);
  });

  testWidgets('filters, search and tab are kept when the panel opens again', (tester) async {
    await _phone(tester);
    final store = _store();
    await tester.pumpWidget(MaterialApp(builder: (c, child) => _inspector(store, child), home: const Scaffold(body: Text('the app'))));
    Durbun.showInspector();
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'orders');
    await tester.tap(find.text('Errors only'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Logs').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'boom');
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();

    Durbun.showInspector();
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, 'boom'), findsOneWidget, reason: 'opens on Logs, its search kept');
    await tester.tap(find.byTooltip('Network').first);
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, 'orders'), findsOneWidget);
    expect(find.textContaining('/v1/orders'), findsNothing, reason: 'Errors only is still on');
    expect(find.text('Clear filters'), findsOneWidget);
  });
}
