import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/filter_ui.dart' show ActiveChip;
import 'package:durbun/src/inspector/json_tree.dart' show JsonTreeView;
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Panel behaviour on a phone: odd traffic, frozen lists, sheets at large
/// text, Android selection, the clear confirmation, the empty states.

const MethodChannel _shake = MethodChannel('dev.durbun/shake');

PendingBody _pending(String text, {String contentType = 'application/json'}) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: contentType);
}

DurbunInspectorStore _newStore({int maxLogs = 2000}) =>
    DurbunInspectorStore(maxLogs: maxLogs, notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;

void _request(DurbunInspectorStore s, String id, String url,
    {String method = 'GET', List<List<String>> headers = const <List<String>>[], PendingBody? body}) {
  s.ingest(buildNetRequest(id: id, ts: 1000, method: method, url: url, headers: headers, body: body));
}

void _respond(DurbunInspectorStore s, String id, {String? text, String contentType = 'application/json'}) {
  s.ingest(buildNetResponse(
      id: id,
      ts: 1100,
      status: 200,
      headers: <List<String>>[
        <String>['Content-Type', contentType]
      ],
      body: text == null ? null : _pending(text, contentType: contentType)));
}

Future<void> _phone(WidgetTester tester, {Size size = const Size(390, 844), double text = 1}) async {
  tester.view.physicalSize = size * 3;
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = text;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearAllTestValues);
}

Future<void> _open(WidgetTester tester, DurbunInspectorStore store,
    {String tab = 'Network', List<String> defaultHosts = const <String>[], List<NavigatorObserver> observers = const <NavigatorObserver>[]}) async {
  await tester.pumpWidget(MaterialApp(
    navigatorObservers: observers,
    builder: (context, child) => DurbunInspector(store: store, defaultHosts: defaultHosts, child: child!),
    home: const Scaffold(body: Text('the app')),
  ));
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip(tab).first);
  await tester.pumpAndSettle();
}

Future<void> _tapTab(WidgetTester tester, String label) async {
  await tester.tap(find.text(label).hitTestable().first);
  await tester.pumpAndSettle();
}

String _jwt(String claims) {
  String part(String json) => base64Url.encode(utf8.encode(json)).replaceAll('=', '');
  return '${part('{"alg":"HS256"}')}.${part(claims)}.c2ln';
}

class _Routes extends NavigatorObserver {
  final List<String?> names = <String?>[];

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => names.add(route.settings.name);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => names.add(route.settings.name);
}

void main() {
  setUp(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, (_) async => true));
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_shake, null));

  group('odd traffic opens without a red screen', () {
    testWidgets('a query with %E7 / a cut escape and a form body with a bare %', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/v1/pay?city=%E7ankaya&cut=%E2%82&ok=%C3%A7',
          method: 'POST',
          body: _pending('discount=50%&code=%FF&name=a+b', contentType: 'application/x-www-form-urlencoded'),
          headers: const <List<String>>[
            <String>['Content-Type', 'application/x-www-form-urlencoded']
          ]);
      _respond(s, '1', text: '{"ok":true}');
      await _open(tester, s);
      await tester.tap(find.textContaining('/v1/pay'));
      await tester.pumpAndSettle();
      await _tapTab(tester, 'Request');
      expect(find.text('50%'), findsOneWidget, reason: 'the form body is listed, its bare % kept');
      expect(find.text('%FF'), findsOneWidget);
      expect(find.text('a b'), findsOneWidget);
      // The parts row scrolls sideways next to the view menu.
      await tester.ensureVisible(find.textContaining('Query').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Query').first);
      await tester.pumpAndSettle();
      expect(find.text('%E7ankaya'), findsOneWidget);
      expect(find.text('%E2%82'), findsOneWidget);
      expect(find.text('ç'), findsOneWidget);
      await tester.tap(find.byTooltip('Share'));
      await tester.pumpAndSettle();
      expect(find.text('Share request'), findsOneWidget, reason: 'the report builds from the same URL');
    });

    testWidgets('a JWT with exp 1e20 and iat 1e400 opens its sheet', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/me', headers: <List<String>>[
        <String>['Authorization', 'Bearer ${_jwt('{"sub":"u1","exp":1e20,"iat":1e400}')}']
      ]);
      _respond(s, '1', text: '{}');
      await _open(tester, s);
      await tester.tap(find.textContaining('/me'));
      await tester.pumpAndSettle();
      await _tapTab(tester, 'Request');
      await tester.tap(find.textContaining('Headers').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Bearer eyJ'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Decode JWT'));
      await tester.pumpAndSettle();
      expect(find.textContaining('u1'), findsWidgets);
      await tester.tap(find.text('Copy as JSON'));
      await tester.pump();
      expect(find.text('Copied'), findsOneWidget, reason: 'infinity is written as text, not thrown');
      await tester.pumpAndSettle();
    });

    testWidgets('a JSON body nested 20000 deep: tree, expand all, code view', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/deep');
      _respond(s, '1', text: '${'[' * 20000}1${']' * 20000}');
      await _open(tester, s);
      await tester.tap(find.textContaining('/deep'));
      await tester.pumpAndSettle();
      await _tapTab(tester, 'Response');
      await tester.tap(find.byTooltip('Expand all'));
      await tester.pumpAndSettle();
      final list = find.descendant(of: find.byType(JsonTreeView), matching: find.byType(ListView));
      await tester.scrollUntilVisible(find.textContaining('[ 1 … ]'), 1000,
          scrollable: find.descendant(of: list, matching: find.byType(Scrollable)).first);
      expect(find.textContaining('[ 1 … ]'), findsOneWidget, reason: 'the level past the cap is summarised, its rows stay on screen');
    });

    testWidgets('an image body is decoded at the width it is shown, not at full size', (tester) async {
      await _phone(tester);
      final s = _newStore();
      final png = base64.decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
      _request(s, '1', 'https://api.example.com/logo.png');
      s.ingest(buildNetResponse(
          id: '1',
          ts: 1100,
          status: 200,
          headers: const <List<String>>[
            <String>['Content-Type', 'image/png']
          ],
          body: PendingBody(bytes: png, size: png.length, truncated: false, limit: 1 << 20, capture: true, contentType: 'image/png')));
      await _open(tester, s);
      await tester.tap(find.textContaining('/logo.png'));
      await tester.pumpAndSettle();
      await _tapTab(tester, 'Response');
      final image = tester.widget<Image>(find.byType(Image));
      expect(image.image, isA<ResizeImage>());
      expect((image.image as ResizeImage).allowUpscaling, isFalse);
    });

    testWidgets('find in a body past the shown 200 KB says where the match is', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/log.txt');
      _respond(s, '1', text: '${'a line of plain text\n' * 12000}the NEEDLE is here', contentType: 'text/plain');
      await _open(tester, s);
      await tester.tap(find.textContaining('/log.txt'));
      await tester.pumpAndSettle();
      await _tapTab(tester, 'Response');
      await tester.enterText(find.byType(TextField).last, 'needle');
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pumpAndSettle();
      expect(find.textContaining('past the shown part'), findsOneWidget);
      await tester.enterText(find.byType(TextField).last, 'plain');
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pumpAndSettle();
      expect(find.textContaining('past the shown part'), findsNothing, reason: 'matches in the shown part: no note');
    });
  });

  group('network list', () {
    testWidgets('a body search waits for typing to stop; a response that arrives later is matched', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/alpha');
      _request(s, '2', 'https://api.example.com/beta');
      _respond(s, '2', text: '{"x":"needle"}');
      await _open(tester, s);
      await tester.tap(find.text('Filters'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Search bodies too'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).first, 'needle');
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.textContaining('/alpha'), findsOneWidget, reason: 'still typing: no body search yet');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      expect(find.textContaining('/alpha'), findsNothing);
      expect(find.textContaining('/beta'), findsOneWidget);

      _respond(s, '1', text: '{"y":"NEEDLE"}');
      await tester.pumpAndSettle();
      expect(find.textContaining('/alpha'), findsOneWidget, reason: 'a changed call is matched again');
    });

    testWidgets('pause holds new requests back until resumed', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/first');
      await _open(tester, s);
      await tester.tap(find.byTooltip('Pause').hitTestable());
      await tester.pumpAndSettle();
      _request(s, '2', 'https://api.example.com/second');
      await tester.pumpAndSettle();
      expect(find.textContaining('/second'), findsNothing);
      await tester.tap(find.byTooltip('Resume').hitTestable());
      await tester.pumpAndSettle();
      expect(find.textContaining('/second'), findsOneWidget);
    });

    testWidgets('only requests to other hosts: says so and shows them on a tap', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://cdn.other.io/img.png');
      await _open(tester, s, defaultHosts: const <String>['api.example.com']);
      expect(find.text('The requests are on other hosts'), findsOneWidget);
      await tester.tap(find.text('Show other hosts'));
      await tester.pumpAndSettle();
      expect(find.textContaining('/img.png'), findsOneWidget);
    });

    testWidgets('no match while others are hidden: the empty state counts them', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/alpha');
      _request(s, '2', 'https://cdn.other.io/img.png');
      await _open(tester, s, defaultHosts: const <String>['api.example.com']);
      await tester.enterText(find.byType(TextField).first, 'zzz');
      await tester.pumpAndSettle();
      expect(find.textContaining('1 more request is on another host, hidden.'), findsOneWidget);
      expect(find.text('Clear filters'), findsOneWidget);
    });

    testWidgets('header and detail buttons are at least 44 pt', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/alpha');
      await _open(tester, s);
      for (final f in <Finder>[find.byTooltip('Close'), find.bySemanticsLabel(RegExp('^Tools, '))]) {
        final size = tester.getSize(f.first);
        expect(size.width, greaterThanOrEqualTo(44));
        expect(size.height, greaterThanOrEqualTo(44));
      }
      await tester.tap(find.textContaining('/alpha'));
      await tester.pumpAndSettle();
      for (final tip in <String>['Share', 'More actions']) {
        expect(tester.getSize(find.byTooltip(tip)).height, greaterThanOrEqualTo(44), reason: tip);
      }
    });
  });

  group('logs list', () {
    testWidgets('frozen: rows evicted from the top do not move the rows in view; clear lets them go', (tester) async {
      await _phone(tester);
      final s = _newStore(maxLogs: 60);
      String msg(int i) => 'msg-${i.toString().padLeft(3, '0')}';
      for (var i = 0; i < 60; i++) {
        s.ingest(buildLog(level: 'info', message: msg(i), tag: 't', ts: 1000.0 + i));
      }
      await _open(tester, s, tab: 'Logs');
      await tester.drag(find.byType(ListView).last, const Offset(0, 600));
      await tester.pumpAndSettle();
      final anchor = <int>[for (var i = 10; i < 60; i++) i].firstWhere((i) => find.textContaining(msg(i)).hitTestable().evaluate().isNotEmpty);
      final before = tester.getTopLeft(find.textContaining(msg(anchor)));

      for (var i = 60; i < 70; i++) {
        s.ingest(buildLog(level: 'info', message: msg(i), tag: 't', ts: 1000.0 + i));
      }
      await tester.pumpAndSettle();
      expect(s.logs.first.message, msg(10), reason: 'the ring dropped ten lines');
      expect(tester.getTopLeft(find.textContaining(msg(anchor))), before, reason: 'the row being read stays put');
      expect(find.text('10 new'), findsOneWidget);

      s.clear();
      await tester.pumpAndSettle();
      expect(find.textContaining(msg(anchor)), findsNothing, reason: 'a clear empties the frozen list too');
    });

    testWidgets('level badges read as words; the logo says what it does', (tester) async {
      final semantics = tester.ensureSemantics();
      await _phone(tester);
      final s = _newStore()..ingest(buildLog(level: 'error', message: 'boom', tag: 't', ts: 1000));
      await _open(tester, s, tab: 'Logs');
      expect(find.bySemanticsLabel(RegExp(r'\bError\b')), findsWidgets);
      expect(find.bySemanticsLabel(RegExp(r'^Tools, ')), findsOneWidget);
      semantics.dispose();
    });
  });

  group('sheets and dialogs', () {
    for (final (name, size, text) in <(String, Size, double)>[
      ('landscape 844x390', const Size(844, 390), 1.0),
      ('text x2 on 390x844', const Size(390, 844), 2.0),
    ]) {
      testWidgets('share sheet, $name: options scroll, buttons stay reachable', (tester) async {
        await _phone(tester, size: size, text: text);
        final s = _newStore();
        _request(s, '1', 'https://api.example.com/v1/orders');
        _respond(s, '1', text: '{"items":[${List<String>.filled(40, '{"id":1}').join(',')}]}');
        await _open(tester, s);
        await tester.tap(find.textContaining('/v1/orders'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Share'));
        await tester.pumpAndSettle();
        final sheet = find.byType(BottomSheet);
        await tester.ensureVisible(find.descendant(of: sheet, matching: find.text('Include cURL')));
        await tester.pumpAndSettle();
        await tester.tap(find.descendant(of: sheet, matching: find.text('Include cURL')));
        await tester.pumpAndSettle();
        await tester.tap(find.descendant(of: sheet, matching: find.text('Copy')).hitTestable());
        await tester.pumpAndSettle();
        expect(find.text('Report copied'), findsOneWidget);
      });
    }

    testWidgets('clearing asks first; the dialog stays on the panel navigator', (tester) async {
      await _phone(tester);
      final s = _newStore()..ingest(buildLog(level: 'info', message: 'keep me', tag: 't', ts: 1000));
      final routes = _Routes();
      await _open(tester, s, tab: 'Logs', observers: <NavigatorObserver>[routes]);
      Future<void> askToClear() async {
        await tester.tap(find.byTooltip('Tools').first);
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Clear captured data'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Clear captured data'));
        await tester.pumpAndSettle();
        expect(find.text('Clear captured data?'), findsOneWidget);
      }

      await askToClear();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(s.logs, isNotEmpty, reason: 'cancel keeps everything');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      await askToClear();
      await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Clear')));
      await tester.pumpAndSettle();
      expect(s.logs, isEmpty);
      expect(routes.names.first, '/', reason: "the app's home");
      expect(routes.names.skip(1).toSet(), <String>{'/durbun'}, reason: 'the sheet and the dialog stay on the panel navigator');
    });

    testWidgets('maxRequests, maxLogs and maxBodyBytes set the SDK store; a store passed in keeps its own', (tester) async {
      final sdk = DurbunInspectorStore(notifyDelay: Duration.zero);
      final previous = DurbunInspectorStore.existing;
      DurbunInspectorStore.instance = sdk;
      addTearDown(() {
        if (previous != null) DurbunInspectorStore.instance = previous;
      });
      await tester.pumpWidget(MaterialApp(
          builder: (c, child) => DurbunInspector(maxRequests: 50, maxLogs: 70, maxBodyBytes: 1000, child: child!), home: const Text('app')));
      expect((sdk.maxCalls, sdk.maxLogs, sdk.maxBodyBytes), (50, 70, 1000));
      final own = DurbunInspectorStore(maxCalls: 5, notifyDelay: Duration.zero);
      await tester.pumpWidget(MaterialApp(builder: (c, child) => DurbunInspector(store: own, child: child!), home: const Text('app')));
      expect(own.maxCalls, 5);
    });

    testWidgets('a long tag chip shrinks with an ellipsis at 1.3x text', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(size: Size(320, 640), textScaler: TextScaler.linear(1.3)),
          child: Scaffold(
            body: Wrap(children: <Widget>[ActiveChip(label: 'a-very-long-tag-name-' * 12, onRemove: () {})]),
          ),
        ),
      ));
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byType(ActiveChip)).width, lessThanOrEqualTo(260));
    });
  });

  group('Android text selection', () {
    testWidgets('a detail page selects text and its tabs still swipe', (tester) async {
      await _phone(tester);
      final s = _newStore();
      _request(s, '1', 'https://api.example.com/v1/answer');
      _respond(s, '1', text: '{"answer":"forty-two"}');
      await _open(tester, s);
      await tester.tap(find.textContaining('/v1/answer'));
      await tester.pumpAndSettle();
      await _tapTab(tester, 'Request');
      expect(find.textContaining('forty-two').hitTestable(), findsNothing);
      await tester.fling(find.byType(TabBarView), const Offset(-300, 0), 1000);
      await tester.pumpAndSettle();
      expect(find.textContaining('forty-two').hitTestable(), findsOneWidget, reason: 'the swipe moved to Response');
      expect(find.ancestor(of: find.textContaining('forty-two'), matching: find.byType(SelectionArea)), findsOneWidget,
          reason: 'the body can be selected');
    }, variant: const TargetPlatformVariant(<TargetPlatform>{TargetPlatform.android, TargetPlatform.iOS}));
  });
}
