import 'package:durbun/src/core/mocks.dart';
import 'package:flutter_test/flutter_test.dart';

MockRule rule({
  String id = 'r1',
  String method = '*',
  required String url,
  String match = 'contains',
  bool enabled = true,
  List<String>? apps,
}) => MockRule(
  id: id,
  enabled: enabled,
  method: method,
  url: url,
  match: match,
  apps: apps,
  action: const MockAction(type: 'respond', status: 200),
);

const usersUrl = 'https://api.example.com/v1/users?page=2';

void main() {
  group('mockRuleMatches · contains', () {
    test('substring anywhere, case-insensitive', () {
      expect(mockRuleMatches(rule(url: '/v1/users'), 'GET', usersUrl), isTrue);
      expect(mockRuleMatches(rule(url: '/V1/USERS'), 'GET', usersUrl), isTrue);
      expect(mockRuleMatches(rule(url: 'page=2'), 'GET', usersUrl), isTrue);
      expect(mockRuleMatches(rule(url: '/v2/'), 'GET', usersUrl), isFalse);
    });

    test('an empty pattern never matches', () {
      expect(mockRuleMatches(rule(url: ''), 'GET', usersUrl), isFalse);
    });
  });

  group('mockRuleMatches · exact', () {
    test('whole url, case-insensitive', () {
      final r = rule(url: 'https://api.example.com/v1/me', match: 'exact');
      expect(mockRuleMatches(r, 'GET', 'https://api.example.com/v1/me'), isTrue);
      expect(mockRuleMatches(r, 'GET', 'HTTPS://API.EXAMPLE.COM/V1/ME'), isTrue);
      expect(mockRuleMatches(r, 'GET', 'https://api.example.com/v1/me?x=1'), isFalse);
    });
  });

  group('mockRuleMatches · glob', () {
    test('* spans slashes and must match the whole url', () {
      final r = rule(url: 'https://api.example.com/v1/*', match: 'glob');
      expect(mockRuleMatches(r, 'GET', 'https://api.example.com/v1/users/42'), isTrue);
      expect(mockRuleMatches(r, 'GET', 'https://api.example.com/v2/users'), isFalse);
      final whole = rule(url: 'https://api.example.com/v1/users', match: 'glob');
      expect(mockRuleMatches(whole, 'GET', usersUrl), isFalse);
    });

    test('? matches exactly one character', () {
      final r = rule(url: '*/users/?', match: 'glob');
      expect(mockRuleMatches(r, 'GET', 'https://x.dev/users/1'), isTrue);
      expect(mockRuleMatches(r, 'GET', 'https://x.dev/users/12'), isFalse);
      expect(mockRuleMatches(r, 'GET', 'https://x.dev/users/'), isFalse);
    });

    test('regex metacharacters are literal', () {
      final dots = rule(url: '*.json', match: 'glob');
      expect(mockRuleMatches(dots, 'GET', 'https://cdn.x.dev/data.json'), isTrue);
      expect(mockRuleMatches(dots, 'GET', 'https://cdn.x.dev/dataxjson'), isFalse);
      final parens = rule(url: '*/v1+(beta)/[a]{2}|x\\y^\$*', match: 'glob');
      expect(
        mockRuleMatches(parens, 'GET', r'https://x.dev/v1+(beta)/[a]{2}|x\y^$/items'),
        isTrue,
      );
    });

    test('case-insensitive', () {
      final r = rule(url: '*/USERS/*', match: 'glob');
      expect(mockRuleMatches(r, 'GET', 'https://x.dev/users/1'), isTrue);
    });
  });

  group('mockRuleMatches · regex', () {
    test('searched anywhere, case-sensitive', () {
      final r = rule(url: r'/users/\d+$', match: 'regex');
      expect(mockRuleMatches(r, 'GET', 'https://x.dev/v1/users/42'), isTrue);
      expect(mockRuleMatches(r, 'GET', 'https://x.dev/v1/users/abc'), isFalse);
      final cased = rule(url: '/Users/', match: 'regex');
      expect(mockRuleMatches(cased, 'GET', 'https://x.dev/users/1'), isFalse);
      expect(mockRuleMatches(rule(url: 'api', match: 'regex'), 'GET', usersUrl), isTrue);
    });

    test('an invalid regex never matches and never throws', () {
      final r = rule(url: '(unclosed', match: 'regex');
      expect(mockRuleMatches(r, 'GET', 'https://x.dev/(unclosed'), isFalse);
    });

    test('unknown match type never matches', () {
      expect(mockRuleMatches(rule(url: 'x', match: 'fuzzy'), 'GET', 'x'), isFalse);
    });
  });

  group('mockRuleMatches · method, apps, enabled', () {
    test('method * matches anything; otherwise case-insensitive equality', () {
      expect(mockRuleMatches(rule(url: 'x'), 'DELETE', 'https://x'), isTrue);
      expect(mockRuleMatches(rule(url: 'x', method: 'post'), 'POST', 'https://x'), isTrue);
      expect(mockRuleMatches(rule(url: 'x', method: 'GET'), 'post', 'https://x'), isFalse);
    });

    test('apps: null/empty = all apps, otherwise must contain the app id', () {
      expect(mockRuleMatches(rule(url: 'x'), 'GET', 'x', 'com.a'), isTrue);
      expect(mockRuleMatches(rule(url: 'x', apps: const []), 'GET', 'x'), isTrue);
      final scoped = rule(url: 'x', apps: const ['com.a']);
      expect(mockRuleMatches(scoped, 'GET', 'x', 'com.a'), isTrue);
      expect(mockRuleMatches(scoped, 'GET', 'x', 'com.b'), isFalse);
      expect(mockRuleMatches(scoped, 'GET', 'x'), isFalse);
    });

    test('disabled rules never match', () {
      expect(mockRuleMatches(rule(url: 'x', enabled: false), 'GET', 'x'), isFalse);
    });
  });

  test('findMockRule: first enabled match wins', () {
    final rules = [
      rule(id: 'off', url: '/users', enabled: false),
      rule(id: 'post-only', url: '/users', method: 'POST'),
      rule(id: 'first', url: '/users'),
      rule(id: 'second', url: '/v1'),
    ];
    expect(findMockRule(rules, 'GET', usersUrl)?.id, 'first');
    expect(findMockRule(rules, 'POST', usersUrl)?.id, 'post-only');
    expect(findMockRule(rules, 'GET', 'https://nothing.dev'), isNull);
  });

  group('MockRule.fromJson', () {
    test('parses the three action types', () {
      final rules = MockRule.listFromJson([
        {
          'id': 'a',
          'enabled': true,
          'name': 'Users mock',
          'method': 'GET',
          'url': '/users',
          'match': 'contains',
          'apps': ['com.mykynk.pati'],
          'action': {
            'type': 'respond',
            'status': 201,
            'headers': [
              ['Content-Type', 'application/json'],
              ['X-Test', '1'],
            ],
            'body': '{"ok":true}',
            'bodyEncoding': 'utf8',
            'delayMs': 250,
          },
          'createdAt': 1767225600000,
        },
        {
          'id': 'b',
          'enabled': true,
          'method': '*',
          'url': '*/slow/*',
          'match': 'glob',
          'action': {'type': 'delay', 'delayMs': 1500},
          'createdAt': 1,
        },
        {
          'id': 'c',
          'enabled': false,
          'method': 'POST',
          'url': r'/pay$',
          'match': 'regex',
          'action': {'type': 'fail', 'error': 'timeout', 'message': 'gateway', 'delayMs': 30000},
          'createdAt': 2,
        },
        {'id': 'bad-action', 'enabled': true, 'action': {'type': 'teleport'}},
        'not a rule',
      ]);
      expect(rules.map((r) => r.id), ['a', 'b', 'c']);
      final a = rules[0];
      expect(a.label, 'Users mock');
      expect(a.apps, ['com.mykynk.pati']);
      expect(a.action.isRespond, isTrue);
      expect(a.action.status, 201);
      expect(a.action.headers, [
        ['Content-Type', 'application/json'],
        ['X-Test', '1'],
      ]);
      expect(a.action.delayMs, 250);
      expect(rules[1].action.isDelay, isTrue);
      expect(rules[1].action.delayMs, 1500);
      expect(rules[2].action.isFail, isTrue);
      expect(rules[2].action.error, 'timeout');
      expect(rules[2].action.message, 'gateway');
      expect(rules[2].enabled, isFalse);
      // Round trip keeps the protocol field names.
      expect(MockRule.fromJson(a.toJson())!.toJson(), a.toJson());
    });
  });
}
