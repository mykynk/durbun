// Mock matching v2 (rules limited to a GraphQL operation) against the shared
// vectors in packages/protocol/vectors/mock-graphql.json, generated from the
// protocol's reference functions: these expectations are the TypeScript
// results. Also run by the JavaScript, Kotlin and Swift ports.
import 'dart:convert';
import 'dart:io';

import 'package:durbun/src/core/mock_graphql.dart';
import 'package:durbun/src/core/mocks.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

const String _vectorsPath = '../../../packages/protocol/vectors/mock-graphql.json';

class _Request {
  _Request(Map<String, Object?> json)
    : method = json['method']! as String,
      url = json['url']! as String,
      appId = json['appId'] as String?,
      contentType = json['contentType'] as String?,
      body = json['bodyPattern'] is List
          ? [
              for (final part in (json['bodyPattern']! as List).cast<List<Object?>>())
                (part[0]! as String) * (part[1]! as int),
            ].join()
          : json['body'] as String?;

  final String method;
  final String url;
  final String? appId;
  final String? contentType;
  final String? body;

  MockRequestInput input([void Function()? onRead]) => MockRequestInput(
    method: method,
    url: url,
    appId: appId,
    contentType: contentType,
    body: () {
      onRead?.call();
      return body;
    },
  );
}

List<GraphqlOperation>? _expected(Object? value) => value == null
    ? null
    : [
        for (final op in (value as List).cast<Map<String, Object?>>())
          GraphqlOperation(op['name'] as String?, op['type'] as String?),
      ];

void main() {
  final file = File(_vectorsPath);
  final skip = file.existsSync() ? false : 'shared vectors not found (package used outside the repository)';
  final vectors = file.existsSync()
      ? jsonDecode(file.readAsStringSync()) as Map<String, Object?>
      : const <String, Object?>{};

  test('operations are read exactly like the reference', () {
    expect(vectors['maxChars'], kMockGraphqlMaxChars);
    final cases = (vectors['operations']! as List).cast<Map<String, Object?>>();
    expect(cases.length, greaterThan(80));
    final failures = <String>[];
    for (final c in cases) {
      final r = _Request(c['request']! as Map<String, Object?>);
      final actual = graphqlOperationsOf(method: r.method, url: r.url, contentType: r.contentType, body: r.body);
      final want = _expected(c['expected']);
      if ('$actual' != '$want') failures.add('${c['description']}: expected $want, got $actual');
    }
    expect(failures, isEmpty);
  }, skip: skip);

  test('rules match exactly like the reference', () {
    final failures = <String>[];
    for (final c in (vectors['matches']! as List).cast<Map<String, Object?>>()) {
      final rule = MockRule.fromJson(c['rule']);
      expect(rule, isNotNull, reason: '${c['rule']}');
      final r = _Request(c['request']! as Map<String, Object?>);
      if (mockRuleMatchesRequest(rule!, r.input()) != c['expected']) failures.add('${c['rule']} / ${c['request']}');
      if (mockRuleMatches(rule, r.method, r.url, r.appId) != c['matchesNoBody']) failures.add('no body ${c['rule']}');
    }
    expect(failures, isEmpty);
  }, skip: skip);

  test('the first matching rule wins and the body is read at most once', () {
    final finds = vectors['finds']! as Map<String, Object?>;
    final rules = MockRule.listFromJson(finds['rules']);
    expect(rules, hasLength(4));
    for (final c in (finds['cases']! as List).cast<Map<String, Object?>>()) {
      final r = _Request(c['request']! as Map<String, Object?>);
      var reads = 0;
      expect(findMockRuleForRequest(rules, r.input(() => reads++))?.id, c['expectedId'], reason: '${r.method} ${r.url}');
      expect(reads, lessThanOrEqualTo(1));
    }
  }, skip: skip);

  test('a body is wanted only when the first rule for the URL has a condition', () {
    MockRule rule(String id, {Object? when}) => MockRule.fromJson({
      'id': id,
      'enabled': true,
      'method': 'POST',
      'url': '/graphql',
      'match': 'contains',
      'when': when,
      'action': {'type': 'respond', 'status': 200},
    })!;
    final gql = rule('g', when: {
      'graphql': {'operationName': 'A'},
    });
    final plain = rule('p');
    final unknown = rule('u', when: {'headers': []});
    const url = 'https://api.example.com/graphql';
    expect(mockRuleNeedsBody([gql, plain], 'POST', url), isTrue);
    expect(mockRuleNeedsBody([plain, gql], 'POST', url), isFalse);
    expect(mockRuleNeedsBody([unknown, plain], 'POST', url), isFalse, reason: 'an unknown condition never matches');
    expect(mockRuleNeedsBody([gql], 'GET', url), isFalse, reason: 'method differs');
    expect(gql.toJson()['when'], {
      'graphql': {'operationName': 'A'},
    }, reason: 'kept for the panel and exports');
  });

  test('bodies are strict UTF-8 within the bound', () {
    expect(mockBodyText(<int>[0xEF, 0xBB, 0xBF, 0x7B, 0x7D]), '{}');
    expect(mockBodyText(<int>[0x7B, 0xC3, 0x7D]), isNull);
    expect(mockBodyText(<int>[0xED, 0xA0, 0x80]), isNull);
    expect(mockBodyText(utf8.encode('😀ş')), '😀ş');
    expect(mockBodyText(List<int>.filled(kMockGraphqlMaxBodyBytes + 1, 0x20)), isNull);
  });

  test('the hello declares the GraphQL matcher', () {
    final hello = buildHello(app: const {}, device: const {}, session: 's', capabilities: const [], actions: const []);
    expect((hello['sdk']! as Map)['mockMatchers'], ['graphql']);
  });
}
