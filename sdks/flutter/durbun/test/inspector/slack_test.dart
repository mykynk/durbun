import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/share_report.dart';
import 'package:durbun/src/inspector/slack.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Send to Slack from the in-app panel: the same mrkdwn and log report as the
/// desktop (`slack.test.ts`, `logs/model/shareReport.test.ts`), and the sheet.

const String _note = '… (shortened to fit Slack)';

const String _report = 'POST https://api.example.com/login?next=<home>&x=1\n'
    '→ 500 Internal Server Error · 340 ms\n'
    '\n'
    '- Time: 2026-11-10 14:03:22.120 (UTC+03:00)\n'
    '\n'
    'Response body:\n'
    '````json\n'
    '{\n'
    '  "md": "```code```",\n'
    '  "html": "<b>&</b>"\n'
    '}\n'
    '````\n';

Future<void> _openLogs(WidgetTester tester, DurbunInspectorStore store) async {
  tester.view.physicalSize = const Size(390, 844) * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => DurbunInspector(store: store, child: child!),
    home: const Scaffold(body: Text('the app')),
  ));
  Durbun.showInspector();
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Logs').first);
  await tester.pumpAndSettle();
}

Future<void> _openShareSheet(WidgetTester tester) async {
  await tester.tap(find.textContaining('Payment failed', findRichText: true).first);
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Share log line'));
  await tester.pumpAndSettle();
}

DurbunInspectorStore _store({String? webhook}) => DurbunInspectorStore(notifyDelay: Duration.zero)
  ..slackWebhook = webhook
  ..ingest(buildLog(
      level: 'error',
      message: 'Payment failed',
      tag: 'checkout',
      ts: 1000,
      data: <String, Object?>{'orderId': 'A-17'},
      error: <String, Object?>{'type': 'StateError', 'message': 'card declined <@here>', 'stack': '#0 pay (pay.dart:12)'}));

void main() {
  group('toSlackText', () {
    test('escapes, plain fences, breaks backtick runs and adds the footer', () {
      expect(
        toSlackText(_report, cutNote: _note, footer: 'Sent with Dürbün · Ayşe'),
        <String>[
          'POST https://api.example.com/login?next=&lt;home&gt;&amp;x=1',
          '→ 500 Internal Server Error · 340 ms',
          '',
          '- Time: 2026-11-10 14:03:22.120 (UTC+03:00)',
          '',
          'Response body:',
          '```',
          '{',
          '  "md": "`​`​`code`​`​`",',
          '  "html": "&lt;b&gt;&amp;&lt;/b&gt;"',
          '}',
          '```',
          '',
          'Sent with Dürbün · Ayşe',
        ].join('\n'),
      );
    });

    test('cannot ping the channel', () {
      expect(toSlackText('<!channel> <@U123> @here', cutNote: _note), '&lt;!channel&gt; &lt;@U123&gt; @here');
    });

    test('cuts long texts, closes the open block and stays within the limit', () {
      final long = <String>['GET https://x.test', '```', for (var i = 0; i < 5000; i++) 'line $i & more', '```'].join('\n');
      final text = toSlackText(long, cutNote: _note, footer: 'Sent with Dürbün');
      expect(text.length, lessThanOrEqualTo(kSlackMaxChars));
      expect(text.endsWith(<String>['```', _note, '', 'Sent with Dürbün'].join('\n')), isTrue);
      expect(RegExp(r'&a?m?p?\n').hasMatch(text), isFalse, reason: 'no half entity at the cut');
    });

    test('never leaves a lone closing fence when the cut falls on a block start', () {
      final text = toSlackText(<String>['a' * 50, '```json', 'b' * 50, '```'].join('\n'), cutNote: 'cut', maxChars: 64);
      expect(text, <String>['a' * 50, 'cut'].join('\n'));
    });

    test('cuts a single huge line inside a block', () {
      final text = toSlackText(<String>['```', 'x' * 200, '```'].join('\n'), cutNote: 'cut', maxChars: 60);
      expect(RegExp(r'^```\nx+\n```\ncut$').hasMatch(text), isTrue);
      expect(text.length, lessThanOrEqualTo(60));
    });
  });

  group('log report', () {
    test('matches the desktop report of the same crash', () {
      final en = InspectorStrings.forLanguage('en');
      final input = LogShareInput(
        level: 'fatal',
        kind: 'Crash',
        tag: 'flutter',
        ts: DateTime.utc(2026, 11, 10, 11, 3, 22, 120).millisecondsSinceEpoch.toDouble(),
        utcOffsetMinutes: 180,
        app: 'Shop 2.4.1 (com.example.shop)',
        device: 'Galaxy A73 (SM-A736B) · Android 14',
        message: 'Null check operator used on a null value',
        errorType: '_TypeError',
        errorMessage: 'Null check operator used on a null value',
        stack: '#0      CartPage.build (package:shop/cart.dart:42:7)\n#1      StatelessElement.build',
      );
      expect(
        buildLogReport(input, en),
        <String>[
          'FATAL · Crash · flutter',
          '',
          '- Time: 2026-11-10 14:03:22.120 (UTC+03:00) · 2026-11-10T11:03:22.120Z',
          '- App: Shop 2.4.1 (com.example.shop)',
          '- Device: Galaxy A73 (SM-A736B) · Android 14',
          '',
          'Message:',
          '```',
          'Null check operator used on a null value',
          '```',
          '',
          'Stack trace:',
          '```',
          '#0      CartPage.build (package:shop/cart.dart:42:7)',
          '#1      StatelessElement.build',
          '```',
        ].join('\n'),
      );
    });

    test('adds the logged data as JSON', () {
      final text = buildLogReport(
        const LogShareInput(level: 'warn', ts: 0, utcOffsetMinutes: 0, message: 'Cart sync slow', data: <String, Object?>{'items': 3, 'ms': 1840}),
        InspectorStrings.forLanguage('en'),
      );
      expect(text.endsWith(<String>['Data:', '```json', '{', '  "items": 3,', '  "ms": 1840', '}', '```'].join('\n')), isTrue);
    });
  });

  group('Send to Slack in the panel', () {
    tearDown(() => debugPostToSlack = null);

    testWidgets('no webhook: no Slack button', (tester) async {
      await _openLogs(tester, _store());
      await _openShareSheet(tester);
      expect(find.text('Share log line'), findsWidgets);
      expect(find.text('Send to Slack'), findsNothing);
    });

    testWidgets('posts the report as mrkdwn only on tap, then closes', (tester) async {
      final posts = <(String, String)>[];
      debugPostToSlack = (webhook, text) async {
        posts.add((webhook, text));
        return null;
      };
      await _openLogs(tester, _store(webhook: 'https://hooks.slack.com/services/T/B/x'));
      await _openShareSheet(tester);
      expect(posts, isEmpty, reason: 'nothing goes before the tap');
      await tester.tap(find.text('Send to Slack'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(1));
      final (webhook, text) = posts.single;
      expect(webhook, 'https://hooks.slack.com/services/T/B/x');
      expect(text, startsWith('ERROR · checkout'));
      expect(text, contains('"orderId": "A-17"'));
      expect(text, contains('Error: StateError: card declined &lt;@here&gt;'));
      expect(text, endsWith('Sent with Dürbün (in-app panel)'));
      expect(find.text('Sent to Slack'), findsOneWidget);
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets('a refused message keeps the sheet open and says why', (tester) async {
      debugPostToSlack = (webhook, text) async => 'invalid_token';
      await _openLogs(tester, _store(webhook: 'https://hooks.slack.com/services/T/B/x'));
      await _openShareSheet(tester);
      await tester.tap(find.text('Send to Slack'));
      await tester.pumpAndSettle();
      expect(find.text('Could not send to Slack: invalid_token'), findsOneWidget);
      expect(find.byType(BottomSheet), findsOneWidget);
    });
  });
}
