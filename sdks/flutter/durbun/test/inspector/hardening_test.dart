import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/body_search.dart';
import 'package:durbun/src/inspector/json_tree.dart';
import 'package:durbun/src/inspector/jwt.dart';
import 'package:durbun/src/inspector/logs_view.dart';
import 'package:durbun/src/inspector/network_model.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/text_match.dart';
import 'package:durbun/src/inspector/theme.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

/// Inputs from real traffic that used to throw, freeze or drop rows.

PendingBody _pending(List<int> bytes, {String contentType = 'application/json'}) => PendingBody(
    bytes: Uint8List.fromList(bytes), size: bytes.length, truncated: false, limit: 1 << 20, capture: true, contentType: contentType);

DurbunInspectorStore _store({int maxCalls = 1000, int maxBodyBytes = 24 << 20}) =>
    DurbunInspectorStore(maxCalls: maxCalls, maxBodyBytes: maxBodyBytes, notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;

void _call(DurbunInspectorStore s, String id, String url, {List<int>? body, String contentType = 'application/json'}) {
  s
    ..ingest(buildNetRequest(id: id, ts: 1000, method: 'GET', url: url, headers: const []))
    ..ingest(buildNetResponse(
        id: id,
        ts: 1100,
        status: 200,
        headers: <List<String>>[
          <String>['Content-Type', contentType]
        ],
        body: body == null ? null : _pending(body, contentType: contentType)));
}

String _jwt(String claims) {
  String part(String json) => base64Url.encode(utf8.encode(json)).replaceAll('=', '');
  return '${part('{"alg":"HS256"}')}.${part(claims)}.c2ln';
}

double _contrast(Color a, Color b) {
  final x = a.computeLuminance(), y = b.computeLuminance();
  return ((x > y ? x : y) + 0.05) / ((x > y ? y : x) + 0.05);
}

void main() {
  group('percent-encoding never throws', () {
    test('escapes that are not UTF-8 stay as written, the rest is decoded', () {
      expect(lenientPercentDecode('%FF'), '%FF');
      expect(lenientPercentDecode('a%E7b'), 'a%E7b', reason: 'Latin-1 ç');
      expect(lenientPercentDecode('cut %E2%82'), 'cut %E2%82');
      expect(lenientPercentDecode('%C3%A7ay %E2%82%AC'), 'çay €');
      expect(lenientPercentDecode('50% off %zz %4'), '50% off %zz %4');
      expect(lenientPercentDecode('a+b'), 'a+b');
      expect(lenientPercentDecode('a+b', plusToSpace: true), 'a b');
    });

    test('decodeUrl keeps a bad escape and decodes the good ones', () {
      expect(decodeUrl('https://x.io/a?q=%FF&b=%C3%A7'), 'https://x.io/a?q=%FF&b=ç');
      expect(decodeUrl('https://x.io/%E2%82'), 'https://x.io/%E2%82');
      expect(decodeUrl('https://x.io/a%20b'), 'https://x.io/a b');
    });

    test('queryPairs: order, repeats, form bodies with a bare %', () {
      expect(queryPairs('discount=50%&q=%FF&name=%C3%A7ay+bah%C3%A7e&flag&a=1&a=2'), <List<String>>[
        <String>['discount', '50%'],
        <String>['q', '%FF'],
        <String>['name', 'çay bahçe'],
        <String>['flag', ''],
        <String>['a', '1'],
        <String>['a', '2'],
      ]);
      expect(queryPairs(''), isEmpty);
    });

    test('a URL Uri.parse rejects still lists, filters and searches', () {
      final s = _store();
      _call(s, '1', 'https://api.example.com:12ab/v1/orders');
      _call(s, '2', 'https://api.example.com/v1/orders?q=%FF&op=%E7');
      expect(s.calls.first.uri, isNull);
      expect(hostOf(s.calls.first), '');
      for (final c in s.calls) {
        expect(() => callMatchesQuery(c, parseQuery('orders'), bodies: true), returnsNormally);
        expect(() => graphqlLabel(c), returnsNormally);
        expect(() => callMatchesFilters(c, NetFilters()), returnsNormally);
      }
      expect(callMatchesQuery(s.calls.last, parseQuery('%FF')), isTrue);
    });
  });

  group('folding for search', () {
    test('Turkish letters and case fold one unit to one unit', () {
      expect(foldText('İSTANBUL Çay ŞĞÜÖ ıI'), 'istanbul cay sguo ii');
      const mixed = 'Ağaç İĞNE ışık ÇÖP 漢字 😀 Ω';
      expect(foldText(mixed).length, mixed.length);
      expect(foldText(mixed), foldText(foldText(mixed)));
    });

    test('text with nothing to fold is returned as is (no copy)', () {
      const json = '{"id":1,"name":"tea 漢字"}';
      expect(identical(foldText(json), json), isTrue);
    });

    test("a body's folded text is computed once", () {
      final s = _store();
      _call(s, '1', 'https://api.example.com/x', body: utf8.encode('{"Name":"NEEDLE"}'));
      final body = s.calls.single.responseBody!;
      expect(identical(body.folded, body.folded), isTrue);
      expect(bodyContains(body, 'needle'), isTrue);
      expect(bodyContains(null, 'needle'), isFalse);
    });
  });

  group('JWT', () {
    test('times outside DateTime or not finite are not times', () {
      expect(jwtTime(1700000000)?.toUtc().year, 2023);
      expect(jwtTime(1e20), isNull);
      expect(jwtTime(-1e20), isNull);
      expect(jwtTime(double.infinity), isNull);
      expect(jwtTime(double.nan), isNull);
      expect(jwtTime('1700000000'), isNull);
    });

    test('a token with exp 1e20 and iat 1e400 decodes', () {
      final jwt = decodeJwt('Bearer ${_jwt('{"sub":"u1","exp":1e20,"iat":1e400,"nbf":1700000000}')}');
      expect(jwt, isNotNull);
      expect(jwt!.expires, isNull);
      expect(jwt.time('iat'), isNull);
      expect(jwt.time('nbf'), isNotNull);
    });
  });

  group('deeply nested JSON', () {
    Object? nested(int depth) {
      Object? v = 'leaf';
      for (var i = 0; i < depth; i++) {
        v = i.isEven ? <Object?>[v] : <String, Object?>{'k': v};
      }
      return v;
    }

    test('20000 levels: the walks stop at kMaxJsonDepth instead of overflowing the stack', () {
      final root = nested(20000);
      final lines = flattenJson(root, autoDepth: 1 << 30);
      expect(lines.length, kMaxJsonDepth + 1);
      expect(lines.last.tooDeep, isTrue);
      expect(lines.last.expanded, isFalse);
      expect(allContainerPaths(root).length, kMaxJsonDepth + 1);
      expect(JsonSearchIndex(root).pathsToMatches('k'), isNotEmpty);
      expect(pathsToMatches(root, 'leaf'), isEmpty, reason: 'past the cap is not searched');
    });

    test('a decoded body nested 20000 deep does not throw', () {
      final text = '${'[' * 20000}1${']' * 20000}';
      final root = jsonDecode(text);
      expect(() => flattenJson(root, opened: allContainerPaths(root)), returnsNormally);
    });

    test('shallow JSON is unchanged', () {
      final lines = flattenJson(<String, Object?>{
        'a': <Object?>[1, 2]
      });
      expect(lines.map((l) => l.path), <String>[r'$', r'$.a', r'$.a[0]', r'$.a[1]']);
      expect(lines.any((l) => l.tooDeep), isFalse);
    });
  });

  group('wrapping wide characters', () {
    List<VisualRow> wrap(String text, int width) => wrapRows(<SearchLine>[
          SearchLine(<(String, TextStyle)>[(text, const TextStyle())])
        ], (_) => width);

    test('ASCII wraps by width', () {
      expect(wrap('abcdefghij', 4), <VisualRow>[(0, 0, 4), (0, 4, 8), (0, 8, 10)]);
      expect(wrap('', 4), <VisualRow>[(0, 0, 0)]);
    });

    test('CJK takes two columns', () {
      expect(wrap('漢字漢字漢字', 4), <VisualRow>[(0, 0, 2), (0, 2, 4), (0, 4, 6)]);
      expect(wrap('ab漢c', 3), <VisualRow>[(0, 0, 2), (0, 2, 4)]);
    });

    test('an emoji (a surrogate pair) is never cut in two', () {
      expect(wrap('😀😀😀', 4), <VisualRow>[(0, 0, 4), (0, 4, 6)]);
      expect(wrap('😀😀😀', 3), <VisualRow>[(0, 0, 2), (0, 2, 4), (0, 4, 6)]);
      expect(wrap('😀', 1), <VisualRow>[(0, 0, 2)], reason: 'a row narrower than one character still shows it');
    });
  });

  group('log order', () {
    test('lines with the same time keep their arrival order', () {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero);
      // Past List.sort's insertion-sort cut-off (32), where it stops being stable.
      for (var i = 0; i < 300; i++) {
        s.ingest(buildLog(level: 'info', message: 'line $i', tag: 'print', ts: 1000.0 + (i ~/ 100)));
      }
      final shown = buildStream(s, LogFilters(), const <QueryClause>[]).map((x) => x.log!.message).toList();
      expect(shown, <String>[for (var i = 0; i < 300; i++) 'line $i']);
    });
  });

  group('store limits', () {
    test('1000 requests by default, like Alice', () {
      expect(DurbunInspectorStore.kDefaultMaxCalls, 1000);
      expect(DurbunInspectorStore(notifyDelay: Duration.zero).maxCalls, 1000);
    });

    test('lowering maxCalls trims the oldest; maxLogs too', () {
      final s = _store();
      for (var i = 0; i < 10; i++) {
        _call(s, '$i', 'https://api.example.com/$i');
        s.ingest(buildLog(level: 'info', message: 'log $i', tag: 't', ts: 1000.0 + i));
      }
      s
        ..maxCalls = 3
        ..maxLogs = 2;
      expect(s.calls.map((c) => c.id), <String>['7', '8', '9']);
      expect(s.droppedCalls, 7);
      expect(s.logs.map((l) => l.message), <String>['log 8', 'log 9']);
    });

    test('requests to hidden hosts are evicted first', () {
      final s = _store(maxCalls: 3)..defaultHosts = const <String>['api.example.com'];
      _call(s, 'a1', 'https://api.example.com/1');
      _call(s, 'o1', 'https://cdn.other.io/1');
      _call(s, 'a2', 'https://api.example.com/2');
      _call(s, 'o2', 'https://cdn.other.io/2');
      _call(s, 'a3', 'https://api.example.com/3');
      expect(s.calls.map((c) => c.id), <String>['a1', 'a2', 'a3'], reason: 'the listed requests stay');
      expect(s.droppedCalls, 0);
      expect(s.droppedOtherHostCalls, 2);
      _call(s, 'a4', 'https://api.example.com/4');
      expect(s.calls.map((c) => c.id), <String>['a2', 'a3', 'a4']);
      expect(s.droppedCalls, 1);
    });

    test('over the body budget, hidden hosts lose their bodies first', () {
      final s = _store(maxBodyBytes: 100)..defaultHosts = const <String>['api.example.com'];
      _call(s, 'a', 'https://api.example.com/a', body: utf8.encode('{"v":"${'a' * 52}"}'));
      _call(s, 'o', 'https://cdn.other.io/o', body: utf8.encode('{"v":"${'o' * 52}"}'));
      final a = s.calls.first, o = s.calls.last;
      expect(o.bodiesDropped, isTrue);
      expect(a.bodiesDropped, isFalse, reason: 'older, but on a listed host');
      expect(a.responseBody?.data, contains('aaaa'));
    });

    test('a row reads the size without decoding; a decoded body is counted as kept', () {
      final s = _store();
      final bytes = List<int>.generate(300, (i) => i % 256);
      _call(s, '1', 'https://api.example.com/bin', body: bytes, contentType: 'application/octet-stream');
      final c = s.calls.single;
      expect(c.responseSize, 300);
      expect(s.bodyBytes, 300, reason: 'the captured bytes until decoded');
      final body = c.responseBody!;
      expect(body.isText, isFalse);
      expect(s.bodyBytes, body.data.length, reason: 'then the kept text (base64 here)');
      expect(c.responseSize, 300);
    });

    test('an evicted request no longer counts', () {
      final s = _store(maxCalls: 1);
      _call(s, '1', 'https://api.example.com/1', body: List<int>.filled(50, 0x20), contentType: 'application/octet-stream');
      final gone = s.calls.single;
      _call(s, '2', 'https://api.example.com/2');
      expect(s.bodyBytes, 0);
      gone.responseBody;
      expect(s.bodyBytes, 0, reason: 'decoding an evicted body does not touch the budget');
    });

    test('clear() moves the epoch the lists use', () {
      final s = _store();
      final before = s.clears;
      s.clear();
      expect(s.clears, before + 1);
    });
  });

  group('contrast', () {
    test('subtle text reaches 4.5:1 on every background', () {
      for (final (name, c) in <(String, DurbunColors)>[('light', DurbunColors.light), ('dark', DurbunColors.dark)]) {
        for (final bg in <Color>[c.bgApp, c.bgPanel, c.bgElevated, c.bgSunken]) {
          expect(_contrast(c.textSubtle, bg), greaterThanOrEqualTo(4.5), reason: '$name on $bg');
        }
      }
    });
  });
}
