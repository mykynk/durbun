// A 1 MB JSON response: prepared off the main isolate, opened one level
// deep, and the code view shows its start until "Show all".
import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/json_tree.dart';
import 'package:durbun/src/inspector/network_view.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

PendingBody _pending(String text) {
  final bytes = Uint8List.fromList(utf8.encode(text));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: 'application/json');
}

String _megabyteJson() {
  final items = <Object?>[];
  var i = 0;
  var json = '';
  while (true) {
    items.add(<String, Object?>{'id': i, 'name': 'Ürün $i', 'city': i == 4321 ? 'Şanlıurfa' : 'Ankara', 'tags': <String>['a', 'b']});
    i++;
    if (i % 500 == 0) {
      json = jsonEncode(<String, Object?>{'items': items});
      if (utf8.encode(json).length > 1000000) return json;
    }
  }
}

void main() {
  test('prepareBodySync: JSON gets value, pretty text and index; other text nothing', () {
    final p = prepareBodySync('{"a":[1,2]}');
    expect(p.json, {'a': [1, 2]});
    expect(p.pretty, contains('\n  "a": ['));
    expect(p.index!.pathsToMatches('2'), contains(r'$.a'));
    final text = prepareBodySync('plain text');
    expect((text.json, text.pretty, text.index), (null, null, null));
    expect(prepareBodySync('{broken').json, isNull);
  });

  testWidgets('a 1 MB JSON: "Preparing" first, then the tree one level open; Code shows the start until Show all',
      (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final body = _megabyteJson();
    expect(body.length, greaterThan(kLargeBodyChars));
    final store = DurbunInspectorStore(notifyDelay: Duration.zero)
      ..bodyResolver = wireBodyFromPending
      ..ingest(buildNetRequest(id: '1', ts: 1, method: 'GET', url: 'https://api.example.com/v1/products', headers: const []))
      ..ingest(buildNetResponse(
          id: '1', ts: 2, status: 200, headers: const [['Content-Type', 'application/json']], body: _pending(body)));
    await tester.pumpWidget(MaterialApp(home: CallDetailPage(call: store.calls.single, store: store)));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Response').first);
    for (var n = 0; n < 10; n++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Preparing the body…'), findsOneWidget);
    expect(find.byType(JsonTreeView), findsNothing, reason: 'nothing parsed on the main isolate');

    for (var n = 0; n < 200 && find.byType(JsonTreeView).evaluate().isEmpty; n++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    final tree = tester.widget<JsonTreeView>(find.byType(JsonTreeView));
    expect(tree.autoDepth, 1);
    expect(tree.index, isNotNull, reason: 'the search index came with it');
    expect(find.text('Preparing the body…'), findsNothing);
    expect(store.calls.single.responseBody!.displayText, startsWith('{\n  "items"'),
        reason: 'the pretty text is kept, not made again');

    await tester.tap(find.byTooltip('View'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Code'));
    await tester.pumpAndSettle();
    expect(find.textContaining('so the phone stays fast'), findsOneWidget);
    await tester.tap(find.text('Show all'));
    await tester.pumpAndSettle();
    expect(find.textContaining('so the phone stays fast'), findsNothing);
  });
}
