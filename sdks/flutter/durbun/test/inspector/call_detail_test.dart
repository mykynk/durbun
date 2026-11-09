import 'dart:convert';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/jwt.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/widgets.dart' show DIconButton;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody _pending(String text, {String type = 'application/json'}) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: type);
}

String _b64(Object json) => base64Url.encode(utf8.encode(jsonEncode(json))).replaceAll('=', '');

/// A token for user 42 that runs out an hour from now.
String _jwt() {
  final exp = DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000;
  return '${_b64(<String, Object?>{'alg': 'HS256', 'typ': 'JWT'})}.${_b64(<String, Object?>{'sub': '42', 'exp': exp})}.c2ln';
}

/// Three requests, oldest first: a login with a token, a list, a failure.
DurbunInspectorStore _store() => DurbunInspectorStore(notifyDelay: Duration.zero)
  ..bodyResolver = wireBodyFromPending
  ..ingest(buildNetRequest(id: '1', ts: 1000, method: 'POST', url: 'https://api.example.com/v1/login', headers: <List<String>>[
    ['Authorization', 'Bearer ${_jwt()}'],
    ['Content-Type', 'application/json'],
  ], body: _pending('{"user":"ayşe"}')))
  ..ingest(buildNetResponse(id: '1', ts: 1100, status: 200, headers: const [['Content-Type', 'application/json']], body: _pending('{"token":"login-ok"}')))
  ..ingest(buildNetRequest(id: '2', ts: 2000, method: 'GET', url: 'https://api.example.com/v1/branches?city=urfa', headers: const []))
  ..ingest(buildNetResponse(id: '2', ts: 2300, status: 200, headers: const [['Content-Type', 'application/json']], body: _pending('{"branches":["Şanlıurfa"]}')))
  ..ingest(buildNetRequest(id: '3', ts: 3000, method: 'GET', url: 'https://api.example.com/v1/health', headers: const []))
  ..ingest(buildNetResponse(id: '3', ts: 3050, status: 503, headers: const [['Retry-After', '5']], body: _pending('{"error":"db down"}')));

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

/// The panel on Network, then the request whose path contains [path].
Future<void> _open(WidgetTester tester, DurbunInspectorStore store, String path) async {
  await tester.pumpWidget(MaterialApp(
      builder: (c, child) => DurbunInspector(store: store, child: child!), home: const Scaffold(body: Text('app'))));
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.textContaining(path).first);
  await tester.pumpAndSettle();
}

/// Taps a tab of the detail page (General also has sections with these names).
Future<void> _tab(WidgetTester tester, String name) async {
  await tester.tap(find.descendant(of: find.byType(TabBar), matching: find.text(name)));
  await tester.pumpAndSettle();
}

bool _enabled(WidgetTester tester, String tooltip) =>
    tester.widget<DIconButton>(find.byWidgetPredicate((w) => w is DIconButton && w.tooltip == tooltip)).onTap != null;

void main() {
  test('decodeJwt reads Bearer and bare tokens, and nothing else', () {
    final token = _jwt();
    expect(decodeJwt('Bearer $token')?.claims['sub'], '42');
    expect(decodeJwt(token)?.header['alg'], 'HS256');
    expect(decodeJwt('Bearer $token')?.expires?.isAfter(DateTime.now()), isTrue);
    expect(decodeJwt('Bearer abc.def.ghi'), isNull);
    expect(decodeJwt('eyJhbGciOiJIUzI1NiJ9.not-base64!.x'), isNull);
    expect(decodeJwt('application/json'), isNull);
  });

  testWidgets('a swipe moves General → Request → Response → Timing', (tester) async {
    await _phone(tester);
    await _open(tester, _store(), '/v1/login');
    expect(find.text('URL'), findsOneWidget, reason: 'General opens first');
    expect(find.text('Client', skipOffstage: false), findsOneWidget, reason: 'grouped in sections');
    await tester.fling(find.byType(TabBarView), const Offset(-250, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.textContaining('ayşe'), findsWidgets, reason: 'Request body');
    await tester.fling(find.byType(TabBarView), const Offset(-250, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.textContaining('login-ok'), findsWidgets, reason: 'Response body');
    await tester.fling(find.byType(TabBarView), const Offset(-250, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text('Total time'), findsOneWidget);
  });

  testWidgets('the arrows move through the list; the tab and part stay', (tester) async {
    await _phone(tester);
    await _open(tester, _store(), '/v1/login');
    await _tab(tester, 'Response');
    await tester.tap(find.textContaining('Headers').first);
    await tester.pumpAndSettle();
    expect(find.text('Content-Type'), findsOneWidget);
    // Newest on top: the first request is last in the list.
    expect(_enabled(tester, 'Next request'), isFalse, reason: 'last in the list');

    await tester.tap(find.byTooltip('Previous request'));
    await tester.pumpAndSettle();
    expect(find.textContaining('/v1/branches'), findsWidgets);
    expect(find.text('Content-Type'), findsOneWidget, reason: 'still on Response → Headers');

    await tester.tap(find.byTooltip('Previous request'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Service Unavailable'), findsWidgets);
    expect(find.text('Retry-After'), findsOneWidget);
    expect(_enabled(tester, 'Previous request'), isFalse, reason: 'first in the list');

    await tester.tap(find.byTooltip('Next request'));
    await tester.pumpAndSettle();
    expect(find.textContaining('/v1/branches'), findsWidgets);
  });

  testWidgets('the next request opens on the tab read last', (tester) async {
    await _phone(tester);
    final store = _store();
    await _open(tester, store, '/v1/login');
    await _tab(tester, 'Timing');
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('/v1/branches').first);
    await tester.pumpAndSettle();
    expect(find.text('Total time'), findsOneWidget);
  });

  testWidgets('a token in a header: JWT badge, decoded claims from the row menu', (tester) async {
    await _phone(tester);
    await _open(tester, _store(), '/v1/login');
    await _tab(tester, 'Request');
    await tester.tap(find.textContaining('Headers').first);
    await tester.pumpAndSettle();
    expect(find.text('JWT'), findsOneWidget);

    await tester.tap(find.text('Authorization'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Decode JWT'));
    await tester.pumpAndSettle();
    expect(find.text('Claims'), findsOneWidget);
    expect(find.text('sub'), findsOneWidget);
    expect(find.textContaining('Expires in'), findsOneWidget);
  });

  testWidgets('a header row copies its value', (tester) async {
    await _phone(tester);
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await _open(tester, _store(), '/v1/health');
    await _tab(tester, 'Response');
    await tester.tap(find.textContaining('Headers').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Retry-After'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy name and value'));
    await tester.pumpAndSettle();
    expect(copied, 'Retry-After: 5');
  });

  testWidgets('a tap on a JSON value copies it; a General row offers copy', (tester) async {
    await _phone(tester);
    final copied = <String?>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String?);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await _open(tester, _store(), '/v1/login');
    await tester.tap(find.text('Method'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy value'));
    await tester.pumpAndSettle();
    expect(copied.last, 'POST');

    await _tab(tester, 'Response');
    await tester.tap(find.textContaining('login-ok'));
    await tester.pumpAndSettle();
    expect(copied.last, 'login-ok', reason: 'a string without its quotes');
    expect(find.text('Copied · token'), findsOneWidget);
  });

  testWidgets('a failed request: short status row, a timing note that fits the failure', (tester) async {
    await _phone(tester);
    final store = _store()
      ..ingest(buildNetRequest(id: '8', ts: 8000, method: 'GET', url: 'https://api.invalid/v1/ping', headers: const []))
      ..ingest(buildNetError(
          id: '8', ts: 8020, error: "SocketException: Failed host lookup: 'api.invalid' (OS Error: nodename nor servname provided, errno = 8)"));
    await _open(tester, store, '/v1/ping');
    expect(find.text('DNS lookup failed'), findsWidgets);
    expect(find.textContaining('nodename', skipOffstage: false), findsOneWidget, reason: 'the full error only in the callout');
    await _tab(tester, 'Timing');
    expect(find.textContaining('ended without a response'), findsOneWidget);
    expect(find.textContaining('does not report'), findsNothing, reason: 'the source is not to blame');
  });

  testWidgets('Share: masked preview, options, and the clipboard when no share sheet opens', (tester) async {
    await _phone(tester);
    final copied = <String?>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String?);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    // The plugin answers "share": false first (no share sheet), then true.
    const native = MethodChannel('dev.durbun/native');
    final shared = <Map<Object?, Object?>>[];
    var opens = false;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(native, (call) async {
      if (call.method != 'share') return null;
      shared.add(call.arguments as Map<Object?, Object?>);
      return opens;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(native, null));
    final store = _store();
    await _open(tester, store, '/v1/login');
    await tester.tap(find.byTooltip('Share'));
    await tester.pumpAndSettle();
    expect(find.text('Share request'), findsOneWidget);
    expect(find.textContaining('Authorization: Bearer ••••'), findsOneWidget, reason: 'masked by default');

    await tester.tap(find.text('Mask secret values'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Authorization: Bearer eyJ'), findsOneWidget);

    // No share sheet: the report goes to the clipboard instead.
    await tester.tap(find.text('Share…'));
    await tester.pumpAndSettle();
    expect(find.text('Share request'), findsNothing);
    expect(shared.single['subject'], 'POST /v1/login → 200');
    expect(copied.last, startsWith('POST https://api.example.com/v1/login\n→ 200 OK'));
    expect(copied.last, contains('Authorization: Bearer eyJ'));
    expect(find.text('Sharing did not open; the report was copied'), findsOneWidget);

    // The share sheet opens: nothing goes to the clipboard.
    opens = true;
    final before = copied.length;
    await tester.tap(find.byTooltip('Share'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Share…'));
    await tester.pumpAndSettle();
    expect(find.text('Share request'), findsNothing);
    expect(shared.last['text'], contains('"token": "login-ok"'));
    expect(copied.length, before);

    // The menu copies the report with the options last used (masking off).
    await tester.tap(find.byTooltip('More actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy share report'));
    await tester.pumpAndSettle();
    expect(copied.last, contains('Authorization: Bearer eyJ'));
    expect(copied.last, contains('"token": "login-ok"'));
  });

  testWidgets('dragging a page folds the summary; the path moves to the title', (tester) async {
    await _phone(tester);
    final store = _store();
    // A long header list, so the page scrolls.
    store.ingest(buildNetRequest(id: '9', ts: 9000, method: 'GET', url: 'https://api.example.com/v1/long', headers: <List<String>>[
      for (var i = 0; i < 40; i++) <String>['X-Header-$i', 'value $i'],
    ]));
    await _open(tester, store, '/v1/long');
    expect(find.text('https://api.example.com'), findsOneWidget, reason: 'the summary shows the host');
    await _tab(tester, 'Request');
    await tester.tap(find.textContaining('Headers').first);
    await tester.pumpAndSettle();
    await tester.drag(find.text('X-Header-3'), const Offset(0, -300));
    await tester.pumpAndSettle();
    expect(find.text('https://api.example.com'), findsNothing, reason: 'folded');
    expect(find.text('/v1/long'), findsOneWidget, reason: 'the title keeps the path');
  });
}
