import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/durbun.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/share_report.dart';
import 'package:durbun/src/inspector/slack.dart';
import 'package:durbun/src/inspector/slack_sender.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Send to Slack from the in-app panel: the same Markdown, mrkdwn, rich text
/// blocks, parts and fallbacks as the desktop (`packages/ui/src/lib/slack.ts`,
/// `packages/server/test/http/slack.test.ts`), the same log report
/// (`logs/model/shareReport.test.ts`), and the sheet.

const String _hook = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';
const String _token = 'xoxb-1234-5678-abcdEFGH';

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

Future<void> _openLogs(WidgetTester tester, DurbunInspectorStore store, {String? slackSender}) async {
  tester.view.physicalSize = const Size(390, 844) * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => DurbunInspector(store: store, slackSender: slackSender, child: child!),
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

  group('toSlackMarkdown', () {
    test('keeps the Markdown and the language, breaks backtick runs, italic footer', () {
      expect(
        toSlackMarkdown(_report, cutNote: _note, footer: 'Sent with Dürbün · Ayşe'),
        <String>[
          'POST https://api.example.com/login?next=<home>&x=1',
          '→ 500 Internal Server Error · 340 ms',
          '',
          '- Time: 2026-11-10 14:03:22.120 (UTC+03:00)',
          '',
          'Response body:',
          '```json',
          '{',
          '  "md": "`​`​`code`​`​`",',
          '  "html": "<b>&</b>"',
          '}',
          '```',
          '',
          '_Sent with Dürbün · Ayşe_',
        ].join('\n'),
      );
    });

    test('rich text reads no mentions: nothing is escaped', () {
      expect(toSlackMarkdown('<!channel> <@U123> @here', cutNote: _note), '<!channel> <@U123> @here');
    });

    test('cuts long reports like the text version, closing the block and adding the note', () {
      final long = <String>['```http', for (var i = 0; i < 5000; i++) 'h-$i: ${'v' * 20}', '```'].join('\n');
      final md = toSlackMarkdown(long, cutNote: _note);
      expect(md.length, lessThanOrEqualTo(kSlackMaxChars));
      expect(md.startsWith('```http\n'), isTrue);
      expect(md.endsWith('\n```\n_${_note}_'), isTrue);
    });

    test('a longer fence becomes ``` with its language', () {
      final long = <String>['GET https://x.test', '````json', for (var i = 0; i < 5000; i++) 'line $i & more', '````'].join('\n');
      final md = toSlackMarkdown(long, cutNote: _note, footer: 'Sent with Dürbün');
      expect(md.length, lessThanOrEqualTo(kSlackMaxChars));
      expect(md, startsWith('GET https://x.test\n```json\nline 0 & more\n'));
      expect(md.endsWith(<String>['```', '_${_note}_', '', '_Sent with Dürbün_'].join('\n')), isTrue);
    });

    test('the rich text of a prepared report keeps one code block with its language', () {
      final block = markdownToRichText(toSlackMarkdown(_report, cutNote: _note, footer: 'Sent with Dürbün'));
      final elements = (block['elements']! as List<Object?>).cast<Map<String, Object?>>();
      final code = elements.where((e) => e['type'] == 'rich_text_preformatted').toList();
      expect(code, hasLength(1));
      expect(code.single['language'], 'json');
      expect(((code.single['elements']! as List<Object?>).single! as Map<String, Object?>)['text'],
          '{\n  "md": "`​`​`code`​`​`",\n  "html": "<b>&</b>"\n}');
      expect(elements.last, <String, Object?>{
        'type': 'rich_text_section',
        'elements': <Object?>[
          <String, Object?>{'type': 'text', 'text': 'Sent with Dürbün', 'style': <String, Object?>{'italic': true}},
        ],
      });
    });
  });

  group('Markdown parts', () {
    List<String> block(String lang, int lines, [int width = 60]) =>
        <String>['```$lang', for (var i = 0; i < lines; i++) '${'$i'.padLeft(4, '0')} ${'x' * width}', '```'];
    bool balanced(String part) => RegExp(r'^```', multiLine: true).allMatches(part).length.isEven;

    test('keeps a short report in one part, as it is', () {
      final md = <String>['GET https://api.example.com/x', '→ 200 OK · 12 ms', '', '- Time: 10:55', '', ...block('http', 3)].join('\n');
      expect(slackMarkdownChunks(md), <String>[md]);
    });

    test('cuts a long report at line ends, closing and reopening the code block with its language', () {
      final md = <String>['GET https://api.example.com/bank-list', '', 'Response body:', ...block('json', 600)].join('\n');
      final parts = slackMarkdownChunks(md);
      expect(parts.length, greaterThan(1));
      for (final part in parts) {
        expect(part.length, lessThanOrEqualTo(kSlackMarkdownPartChars));
        expect(balanced(part), isTrue);
      }
      for (final part in parts.skip(1)) {
        expect(part.startsWith('```json\n'), isTrue);
      }
      // Nothing is lost: without the added fences the parts are the report again.
      final joined = <String>[];
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (i > 0) part = part.replaceFirst(RegExp(r'^```json\n'), '');
        if (i < parts.length - 1) part = part.replaceFirst(RegExp(r'\n```$'), '');
        joined.add(part);
      }
      expect(joined.join('\n'), md);
    });

    test('cuts a line longer than a part (minified JSON) without splitting a surrogate pair', () {
      final line = '${'a' * 99}😀${'b' * 250}';
      final parts = slackMarkdownChunks(<String>['```json', line, '```'].join('\n'), limit: 100);
      for (final part in parts) {
        expect(part.length, lessThanOrEqualTo(100));
        expect(balanced(part), isTrue);
        expect(RegExp(r'[\ud800-\udbff](?![\udc00-\udfff])').hasMatch(part), isFalse);
      }
      expect(parts.map((p) => p.replaceFirst(RegExp(r'^```json\n'), '').replaceFirst(RegExp(r'\n```$'), '')).join(), line);
    });

    test('starts the next part with a heading rather than ending one with it', () {
      final parts = slackMarkdownChunks(<String>['a' * 50, '', '```http', 'h: 1', '```'].join('\n'), limit: 60);
      expect(parts, <String>['a' * 50, '```http\nh: 1\n```']);
    });

    test('turns the report into rich text: paragraphs, headings, quotes, lists and code with its language', () {
      final md = <String>[
        '## 1 failed request',
        'GET https://api.example.com/a?b=1 (see `x-id`)',
        '→ 500 · 12 ms',
        '',
        '> Tapped **Pay** twice.',
        '> Nothing happened.',
        '- Time: 10:55',
        '- Client: flow',
        '',
        'Response body (application/json):',
        '```json',
        '{ "a": "<b>" }',
        '```',
        '_Secret values are masked._ user_id_x stays',
      ].join('\n');
      expect(markdownToRichText(md), <String, Object?>{
        'type': 'rich_text',
        'elements': <Object?>[
          <String, Object?>{
            'type': 'rich_text_section',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': '1 failed request', 'style': <String, Object?>{'bold': true}},
            ],
          },
          <String, Object?>{
            'type': 'rich_text_section',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': 'GET '},
              <String, Object?>{'type': 'link', 'url': 'https://api.example.com/a?b=1'},
              <String, Object?>{'type': 'text', 'text': ' (see '},
              <String, Object?>{'type': 'text', 'text': 'x-id', 'style': <String, Object?>{'code': true}},
              <String, Object?>{'type': 'text', 'text': ')'},
              <String, Object?>{'type': 'text', 'text': '\n'},
              <String, Object?>{'type': 'text', 'text': '→ 500 · 12 ms'},
              <String, Object?>{'type': 'text', 'text': '\n'},
            ],
          },
          <String, Object?>{
            'type': 'rich_text_quote',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': 'Tapped '},
              <String, Object?>{'type': 'text', 'text': 'Pay', 'style': <String, Object?>{'bold': true}},
              <String, Object?>{'type': 'text', 'text': ' twice.'},
              <String, Object?>{'type': 'text', 'text': '\n'},
              <String, Object?>{'type': 'text', 'text': 'Nothing happened.'},
            ],
          },
          <String, Object?>{
            'type': 'rich_text_list',
            'style': 'bullet',
            'elements': <Object?>[
              <String, Object?>{
                'type': 'rich_text_section',
                'elements': <Object?>[
                  <String, Object?>{'type': 'text', 'text': 'Time: 10:55'},
                ],
              },
              <String, Object?>{
                'type': 'rich_text_section',
                'elements': <Object?>[
                  <String, Object?>{'type': 'text', 'text': 'Client: flow'},
                ],
              },
            ],
          },
          <String, Object?>{
            'type': 'rich_text_section',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': 'Response body (application/json):'},
            ],
          },
          <String, Object?>{
            'type': 'rich_text_preformatted',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': '{ "a": "<b>" }'},
            ],
            'language': 'json',
            'border': 0,
          },
          <String, Object?>{
            'type': 'rich_text_section',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': 'Secret values are masked.', 'style': <String, Object?>{'italic': true}},
              <String, Object?>{'type': 'text', 'text': ' user_id_x stays'},
            ],
          },
        ],
      });
      // An 800-line body stays one block in one message.
      final big = <String>['```json', for (var i = 0; i < 800; i++) '  "k$i": $i,', '```'].join('\n');
      final elements = markdownToRichText(big)['elements']! as List<Object?>;
      expect(elements, hasLength(1));
      expect(elements.single, containsPair('type', 'rich_text_preformatted'));
      expect(elements.single, containsPair('language', 'json'));
    });

    test('rich text: ordered lists, a link in a heading, an empty block and an empty report', () {
      expect(markdownToRichText('# See https://x.example/a).'), <String, Object?>{
        'type': 'rich_text',
        'elements': <Object?>[
          <String, Object?>{
            'type': 'rich_text_section',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': 'See ', 'style': <String, Object?>{'bold': true}},
              <String, Object?>{'type': 'link', 'url': 'https://x.example/a', 'style': <String, Object?>{'bold': true}},
              <String, Object?>{'type': 'text', 'text': ').', 'style': <String, Object?>{'bold': true}},
            ],
          },
        ],
      });
      expect(markdownToRichText('1. one\n2) two'), <String, Object?>{
        'type': 'rich_text',
        'elements': <Object?>[
          <String, Object?>{
            'type': 'rich_text_list',
            'style': 'ordered',
            'elements': <Object?>[
              <String, Object?>{
                'type': 'rich_text_section',
                'elements': <Object?>[
                  <String, Object?>{'type': 'text', 'text': 'one'},
                ],
              },
              <String, Object?>{
                'type': 'rich_text_section',
                'elements': <Object?>[
                  <String, Object?>{'type': 'text', 'text': 'two'},
                ],
              },
            ],
          },
        ],
      });
      expect((markdownToRichText('```\n```')['elements']! as List<Object?>).single, <String, Object?>{
        'type': 'rich_text_preformatted',
        'elements': <Object?>[
          <String, Object?>{'type': 'text', 'text': ' '},
        ],
        'border': 0,
      });
      expect(markdownToRichText('\n\n'), <String, Object?>{
        'type': 'rich_text',
        'elements': <Object?>[
          <String, Object?>{
            'type': 'rich_text_section',
            'elements': <Object?>[
              <String, Object?>{'type': 'text', 'text': ' '},
            ],
          },
        ],
      });
    });

    test('makes a notification line from the first plain line', () {
      expect(notificationText('## GET https://x.example/a?b=<c>&d\n```json\n{}\n```'), 'GET https://x.example/a?b=&lt;c&gt;&amp;d');
      expect(notificationText('```\ncode only\n```'), 'Dürbün');
      expect(notificationText('- *${'y' * 300}*'), hasLength(150));
    });
  });

  group('the connection key', () {
    test('the webhook before #, the key after it, both or neither', () {
      final keyed = SlackConnection.parse('$_hook#token=$_token&channel=C0123ABCD&channel_name=%23qa');
      expect((keyed.webhook, keyed.token, keyed.channelId, keyed.uploads), (_hook, _token, 'C0123ABCD', true));
      expect(SlackConnection.parse('$_hook#token=$_token&channel=D0123ABCD').uploads, isTrue, reason: 'a direct message');
      final plain = SlackConnection.parse(_hook);
      expect((plain.webhook, plain.uploads), (_hook, false));
      for (final bad in <String>[
        '$_hook#token=$_token',
        '$_hook#channel=C0123ABCD',
        '$_hook#token=xoxp-123456789&channel=C0123ABCD',
        '$_hook#token=$_token&channel=X0123ABCD',
        '$_hook#%zz',
      ]) {
        final c = SlackConnection.parse(bad);
        expect((c.webhook, c.uploads), (_hook, false), reason: bad);
      }
    });

    test('the report goes to the webhook alone: the key never reaches it', () async {
      final urls = <String>[];
      debugPostToSlack = (webhook, payload) async {
        urls.add(webhook);
        return (status: 200, answer: 'ok');
      };
      addTearDown(() => debugPostToSlack = null);
      expect(await sendToSlack('$_hook#token=$_token&channel=C0123ABCD', markdown: '# x', text: 'x'), isNull);
      expect(urls, <String>[_hook]);
    });
  });

  group('the screenshot', () {
    final png = Uint8List.fromList(<int>[137, 80, 78, 71]);
    const keyed = SlackConnection(webhook: _hook, token: _token, channelId: 'C0123ABCD');

    /// Slack's Web API and upload host, answering [answers] by method (or
    /// `upload`) and ok otherwise; records every call.
    List<(String, String, Map<String, String>)> fakeSlack([Map<String, SlackAnswer> answers = const <String, SlackAnswer>{}]) {
      final calls = <(String, String, Map<String, String>)>[];
      debugPostSlackForm = (url, token, form) async {
        final method = url.substring('https://slack.com/api/'.length);
        calls.add((method, token, form));
        return answers[method] ??
            switch (method) {
              'files.getUploadURLExternal' => (
                  status: 200,
                  answer: jsonEncode(<String, Object?>{'ok': true, 'upload_url': 'https://files.slack.com/upload/v1/ABC', 'file_id': 'F0456EFGH'}),
                ),
              _ => (status: 200, answer: '{"ok":true}'),
            };
      };
      debugPostSlackBytes = (url, bytes) async {
        calls.add(('upload', url, <String, String>{'bytes': bytes.join(',')}));
        return answers['upload'] ?? (status: 200, answer: 'OK');
      };
      return calls;
    }

    tearDown(() {
      debugPostSlackForm = null;
      debugPostSlackBytes = null;
      debugResetSlackJoins();
    });

    test('joins once, asks for an upload URL, posts the bytes there without the key, shares it in the channel', () async {
      final calls = fakeSlack();
      expect(await sendScreenshotToSlack(keyed, png, title: 'Screenshot · Bug report', fileName: 'durbun-bug.png'), isNull);
      expect(calls.map((c) => c.$1), <String>['conversations.join', 'files.getUploadURLExternal', 'upload', 'files.completeUploadExternal']);
      final [join, getUrl, upload, complete] = calls;
      for (final call in <(String, String, Map<String, String>)>[join, getUrl, complete]) {
        expect(call.$2, _token);
      }
      expect(join.$3, <String, String>{'channel': 'C0123ABCD'});
      expect(getUrl.$3, <String, String>{'filename': 'durbun-bug.png', 'length': '4'});
      expect(upload.$2, 'https://files.slack.com/upload/v1/ABC');
      expect(upload.$3['bytes'], '137,80,78,71');
      expect(complete.$3, <String, String>{
        'files': jsonEncode(<Object?>[
          <String, Object?>{'id': 'F0456EFGH', 'title': 'Screenshot · Bug report'},
        ]),
        'channel_id': 'C0123ABCD',
      });

      calls.clear();
      await sendScreenshotToSlack(keyed, png, title: 'again');
      expect(calls.map((c) => c.$1), isNot(contains('conversations.join')), reason: 'one join per run');
    });

    test('a direct message is not joined; a channel that cannot be joined still gets the upload', () async {
      final calls = fakeSlack();
      expect(await sendScreenshotToSlack(const SlackConnection(webhook: _hook, token: _token, channelId: 'D0123ABCD'), png, title: 't'),
          isNull);
      expect(calls.map((c) => c.$1), <String>['files.getUploadURLExternal', 'upload', 'files.completeUploadExternal']);

      debugResetSlackJoins();
      final private = fakeSlack(<String, SlackAnswer>{
        'conversations.join': (status: 200, answer: '{"ok":false,"error":"missing_scope"}'),
      });
      expect(await sendScreenshotToSlack(keyed, png, title: 't'), isNull, reason: 'a key without channels:join');
      expect(private.map((c) => c.$1).last, 'files.completeUploadExternal');
    });

    test('says why it did not go', () async {
      final cases = <(SlackConnection, Map<String, SlackAnswer>, SlackShotProblem)>[
        (const SlackConnection(webhook: _hook), const <String, SlackAnswer>{}, SlackShotProblem.noKey),
        (keyed, {'files.completeUploadExternal': (status: 200, answer: '{"ok":false,"error":"not_in_channel"}')}, SlackShotProblem.notInChannel),
        (
          const SlackConnection(webhook: _hook, token: _token, channelId: 'D0123ABCD'),
          {'files.completeUploadExternal': (status: 200, answer: '{"ok":false,"error":"not_in_channel"}')},
          SlackShotProblem.notInDm,
        ),
        (keyed, {'files.getUploadURLExternal': (status: 200, answer: '{"ok":false,"error":"token_revoked"}')}, SlackShotProblem.reconnect),
        (keyed, {'files.getUploadURLExternal': (status: 429, answer: '')}, SlackShotProblem.rateLimited),
        (keyed, {'conversations.join': (status: 0, answer: 'timeout')}, SlackShotProblem.unreachable),
        (keyed, {'upload': (status: 500, answer: 'no')}, SlackShotProblem.rejected),
        (keyed, {'files.completeUploadExternal': (status: 200, answer: '{"ok":false,"error":"file_not_found"}')}, SlackShotProblem.rejected),
        (
          keyed,
          {'files.getUploadURLExternal': (status: 200, answer: '{"ok":true,"upload_url":"https://evil.example/up","file_id":"F0456EFGH"}')},
          SlackShotProblem.rejected,
        ),
        (keyed, {'files.getUploadURLExternal': (status: 200, answer: 'not json')}, SlackShotProblem.rejected),
      ];
      for (final (connection, answers, problem) in cases) {
        debugResetSlackJoins();
        final calls = fakeSlack(answers);
        final error = await sendScreenshotToSlack(connection, png, title: 't');
        expect(error?.problem, problem, reason: '$answers');
        if (problem == SlackShotProblem.noKey) expect(calls, isEmpty);
        if (answers.containsKey('files.getUploadURLExternal') && problem != SlackShotProblem.reconnect) {
          expect(calls.map((c) => c.$1), isNot(contains('upload')), reason: 'no bytes to a host that is not Slack');
        }
      }
      debugResetSlackJoins();
      fakeSlack(<String, SlackAnswer>{'files.completeUploadExternal': (status: 200, answer: '{"ok":false,"error":"file_not_found"}')});
      expect((await sendScreenshotToSlack(keyed, png, title: 't'))?.detail, 'file_not_found');
    });
  });

  group('sending', () {
    tearDown(() => debugPostToSlack = null);

    /// A webhook that refuses the block types in [refused] (400
    /// invalid_blocks) and takes the rest. Payloads to another URL are not
    /// recorded.
    List<Map<String, Object?>> refusing(List<String> refused) {
      final sent = <Map<String, Object?>>[];
      debugPostToSlack = (webhook, payload) async {
        // What goes over the wire.
        final json = jsonDecode(jsonEncode(payload)) as Map<String, Object?>;
        if (webhook == _hook) sent.add(json);
        return refused.contains(_typeOf(json)) ? (status: 400, answer: 'invalid_blocks') : (status: 200, answer: 'ok');
      };
      return sent;
    }

    test('posts the report as one rich text message, as a pasted report shows', () async {
      final sent = refusing(const <String>[]);
      const md = 'GET https://a.example/x\n\n- one\n\n```json\n{}\n```';
      expect(await sendToSlack(_hook, markdown: md, text: 'fallback', partGap: Duration.zero), isNull);
      expect(sent, hasLength(1));
      expect(sent.single, <String, Object?>{
        'text': 'GET https://a.example/x',
        'blocks': <Object?>[markdownToRichText(md)],
        'unfurl_links': false,
        'unfurl_media': false,
      });
    });

    test('sends a long report as numbered Markdown parts when Slack refuses the rich text', () async {
      final sent = refusing(const <String>['rich_text']);
      final md = <String>['GET https://a.example/x', '```json', for (var i = 0; i < 500; i++) '"k$i": "${'v' * 50}",', '```'].join('\n');
      expect(await sendToSlack(_hook, markdown: md, text: '', partGap: Duration.zero), isNull);
      final types = sent.map(_typeOf).toList();
      expect(types.first, 'rich_text');
      expect(types.length, greaterThan(2));
      expect(types.skip(1).every((t) => t == 'markdown'), isTrue);
      final parts = sent.skip(1).toList();
      expect(parts.map((b) => b['text']), <String>[for (var i = 0; i < parts.length; i++) 'GET https://a.example/x (${i + 1}/${parts.length})']);
      expect(parts.map((b) => ((b['blocks']! as List<Object?>).single! as Map<String, Object?>)['text']), slackMarkdownChunks(md));
      expect(parts.every((b) => b['unfurl_links'] == false && b['unfurl_media'] == false), isTrue);
    });

    test('falls back to the plain text when the workspace refuses both block kinds', () async {
      final sent = refusing(const <String>['rich_text', 'markdown']);
      expect(await sendToSlack(_hook, markdown: '# x', text: '*x*', partGap: Duration.zero), isNull);
      expect(sent.map(_typeOf), <String>['rich_text', 'markdown', 'text']);
      expect(sent[2], <String, Object?>{'text': '*x*', 'unfurl_links': false, 'unfurl_media': false});
    });

    test('any other refusal or failure is the answer, not a fallback; nothing throws', () async {
      final sent = <Map<String, Object?>>[];
      debugPostToSlack = (webhook, payload) async {
        sent.add(payload);
        return (status: 410, answer: 'channel_is_archived');
      };
      expect(await sendToSlack(_hook, markdown: '# x', text: '*x*'), 'channel_is_archived');
      expect(sent, hasLength(1));

      debugPostToSlack = (webhook, payload) async => (status: 500, answer: '');
      expect(await sendToSlack(_hook, markdown: '# x', text: '*x*'), 'HTTP 500');
      debugPostToSlack = (webhook, payload) async => (status: 0, answer: 'timeout');
      expect(await sendToSlack(_hook, markdown: '# x', text: '*x*'), 'timeout');
      debugPostToSlack = (webhook, payload) async => throw StateError('boom');
      expect(await sendToSlack(_hook, markdown: '# x', text: '*x*'), 'Bad state: boom');

      // A part after the first one that does not go says which one.
      var calls = 0;
      debugPostToSlack = (webhook, payload) async => switch (calls++) {
            0 => (status: 400, answer: 'invalid_blocks'),
            1 => (status: 200, answer: 'ok'),
            _ => (status: 403, answer: 'invalid_token'),
          };
      final md = <String>['GET https://a.example/x', '```json', for (var i = 0; i < 500; i++) '"k$i": "${'v' * 50}",', '```'].join('\n');
      final n = slackMarkdownChunks(md).length;
      expect(await sendToSlack(_hook, markdown: md, text: 'x', partGap: Duration.zero), 'invalid_token (2/$n)');
      expect(calls, 3, reason: 'nothing after the part that failed');

      // No Markdown: the text alone.
      final plain = refusing(const <String>[]);
      expect(await sendToSlack(_hook, markdown: ' ', text: 'just text'), isNull);
      expect(plain.single, <String, Object?>{'text': 'just text', 'unfurl_links': false, 'unfurl_media': false});
    });

    testWidgets('the parts go 1.1 s apart', (tester) async {
      final sent = refusing(const <String>['rich_text']);
      final md = <String>['GET https://a.example/x', '```json', for (var i = 0; i < 500; i++) '"k$i": "${'v' * 50}",', '```'].join('\n');
      String? result = 'pending';
      unawaited(sendToSlack(_hook, markdown: md, text: 'x').then((r) => result = r));
      for (var i = 0; i < 5 && sent.length < 2; i++) {
        await tester.pump();
      }
      expect(sent, hasLength(2), reason: 'the rich text and the first part at once');
      await tester.pump(const Duration(milliseconds: 1099));
      expect(sent, hasLength(2));
      await tester.pump(const Duration(milliseconds: 1));
      expect(sent, hasLength(3));
      for (var i = 0; i < 10 && result == 'pending'; i++) {
        await tester.pump(kSlackPartGap);
      }
      expect(result, isNull);
      expect(sent, hasLength(1 + slackMarkdownChunks(md).length));
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

  group('the tester’s message and name', () {
    tearDown(debugResetSlackSender);
    final en = InspectorStrings.forLanguage('en');
    final tr = InspectorStrings.forLanguage('tr');

    test('the message goes above the report as a quote; nothing typed changes nothing', () {
      expect(withShareNote('GET /a', ''), 'GET /a');
      expect(withShareNote('GET /a', '  \n '), 'GET /a');
      expect(withShareNote('GET /a', ' Login fails \n\non 4G  '), '> Login fails\n>\n> on 4G\n\nGET /a');
      expect(withShareNote('GET /a', 'see:\n  indented'), '> see:\n>   indented\n\nGET /a', reason: 'indents stay');
    });

    test('the footer names who sent it, as the desktop does', () {
      expect(slackFooterFor(en, null), 'Sent with Dürbün (in-app panel)');
      expect(slackFooterFor(en, 'Ayşe'), 'Sent with Dürbün · Ayşe (in-app panel)');
      expect(slackFooterFor(tr, 'Yusuf'), 'Dürbün ile gönderildi · Yusuf (uygulama içi panel)');
    });

    test('the name typed on the phone wins over the app’s; blanks and long names are tidied', () {
      final store = DurbunInspectorStore(notifyDelay: Duration.zero)..configurePanel(slackSender: 'QA team');
      expect(slackSenderFor(store), 'QA team');
      setSlackSender('  Ayşe   Yılmaz ');
      expect(slackSenderFor(store), 'Ayşe Yılmaz');
      setSlackSender('   ');
      expect(slackSenderFor(store), 'QA team', reason: 'an emptied field gives the app’s name back');
      setSlackSender('x' * 200);
      expect(slackSenderFor(store), hasLength(60));
    });
  });

  group('Send to Slack in the panel', () {
    tearDown(() {
      debugPostToSlack = null;
      debugResetSlackSender();
    });

    testWidgets('no webhook: no Slack button', (tester) async {
      await _openLogs(tester, _store());
      await _openShareSheet(tester);
      expect(find.text('Share log line'), findsWidgets);
      expect(find.text('Send to Slack'), findsNothing);
    });

    testWidgets('posts the report as rich text only on tap, then closes', (tester) async {
      final posts = <(String, Map<String, Object?>)>[];
      debugPostToSlack = (webhook, payload) async {
        posts.add((webhook, jsonDecode(jsonEncode(payload)) as Map<String, Object?>));
        return (status: 200, answer: 'ok');
      };
      await _openLogs(tester, _store(webhook: 'https://hooks.slack.com/services/T/B/x'));
      await _openShareSheet(tester);
      expect(posts, isEmpty, reason: 'nothing goes before the tap');
      await tester.tap(find.text('Send to Slack'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(1));
      final (webhook, payload) = posts.single;
      expect(webhook, 'https://hooks.slack.com/services/T/B/x');
      expect(payload['text'], startsWith('ERROR · checkout'));
      expect(payload['unfurl_links'], isFalse);
      expect(payload['unfurl_media'], isFalse);
      final block = (payload['blocks']! as List<Object?>).single! as Map<String, Object?>;
      expect(block['type'], 'rich_text');
      final runs = _texts(block);
      expect(runs.first, startsWith('ERROR · checkout'));
      expect(runs, contains(contains('"orderId": "A-17"')));
      expect(runs.join(), contains('StateError: card declined <@here>'), reason: 'rich text reads no mentions: nothing escaped');
      expect((block['elements']! as List<Object?>).last, <String, Object?>{
        'type': 'rich_text_section',
        'elements': <Object?>[
          <String, Object?>{'type': 'text', 'text': 'Sent with Dürbün (in-app panel)', 'style': <String, Object?>{'italic': true}},
        ],
      }, reason: 'the footer, in italics');
      final code = (block['elements']! as List<Object?>).cast<Map<String, Object?>>().where((e) => e['type'] == 'rich_text_preformatted');
      expect(code.map((e) => e['language']), contains('json'), reason: 'the data block keeps its language');
      expect(find.text('Sent to Slack'), findsOneWidget);
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets('a workspace without blocks gets the mrkdwn text', (tester) async {
      final posts = <Map<String, Object?>>[];
      debugPostToSlack = (webhook, payload) async {
        posts.add(payload);
        return payload.containsKey('blocks') ? (status: 400, answer: 'invalid_blocks') : (status: 200, answer: 'ok');
      };
      await _openLogs(tester, _store(webhook: 'https://hooks.slack.com/services/T/B/x'));
      await _openShareSheet(tester);
      await tester.tap(find.text('Send to Slack'));
      await tester.pumpAndSettle();
      expect(posts.map(_typeOf), <String>['rich_text', 'markdown', 'text']);
      final text = posts.last['text']! as String;
      expect(text, startsWith('ERROR · checkout'));
      expect(text, contains('Error: StateError: card declined &lt;@here&gt;'));
      expect(text, endsWith('Sent with Dürbün (in-app panel)'));
      expect(find.text('Sent to Slack'), findsOneWidget);
    });

    testWidgets('a message and a name: the message heads the post, the name ends it, and is kept', (tester) async {
      final posts = <Map<String, Object?>>[];
      debugPostToSlack = (webhook, payload) async {
        posts.add(jsonDecode(jsonEncode(payload)) as Map<String, Object?>);
        return (status: 200, answer: 'ok');
      };
      await _openLogs(tester, _store(webhook: 'https://hooks.slack.com/services/T/B/x'));
      await _openShareSheet(tester);
      final note = find.byKey(const ValueKey<String>('durbun-share-note'));
      final name = find.byKey(const ValueKey<String>('durbun-slack-sender'));
      await tester.ensureVisible(note);
      await tester.enterText(note, 'Checkout breaks on the second try');
      await tester.ensureVisible(name);
      await tester.enterText(name, 'Ayşe');
      await tester.pumpAndSettle();
      expect(find.text('> Checkout breaks on the second try'), findsOneWidget, reason: 'the preview shows it');

      await tester.ensureVisible(find.text('Send to Slack'));
      await tester.tap(find.text('Send to Slack'));
      await tester.pumpAndSettle();
      final payload = posts.single;
      expect(payload['text'], 'Checkout breaks on the second try', reason: 'the notification reads the message');
      final runs = _texts((payload['blocks']! as List<Object?>).single! as Map<String, Object?>);
      expect(runs.first, 'Checkout breaks on the second try');
      expect(runs, contains(startsWith('ERROR · checkout')));
      expect(runs.last, 'Sent with Dürbün · Ayşe (in-app panel)');
      expect(typedSlackSender.value, 'Ayşe', reason: 'kept for the next message');

      // The next sheet starts with the name and an empty message.
      await _openShareSheet(tester);
      await tester.ensureVisible(name);
      expect(tester.widget<TextField>(find.descendant(of: name, matching: find.byType(TextField))).controller!.text, 'Ayşe');
      expect(tester.widget<TextField>(find.descendant(of: note, matching: find.byType(TextField))).controller!.text, isEmpty);
    });

    testWidgets('the app’s name signs the post when the phone has none; no webhook, no name field', (tester) async {
      final posts = <Map<String, Object?>>[];
      debugPostToSlack = (webhook, payload) async {
        posts.add(jsonDecode(jsonEncode(payload)) as Map<String, Object?>);
        return (status: 200, answer: 'ok');
      };
      final store = _store(webhook: 'https://hooks.slack.com/services/T/B/x');
      await _openLogs(tester, store, slackSender: 'QA team');
      await _openShareSheet(tester);
      await tester.ensureVisible(find.text('Send to Slack'));
      await tester.tap(find.text('Send to Slack'));
      await tester.pumpAndSettle();
      final runs = _texts((posts.single['blocks']! as List<Object?>).single! as Map<String, Object?>);
      expect(runs.last, 'Sent with Dürbün · QA team (in-app panel)');
      expect(runs.first, startsWith('ERROR · checkout'), reason: 'no message: the report starts the post');

      store.slackWebhook = null;
      await tester.pumpAndSettle();
      await _openShareSheet(tester);
      expect(find.byKey(const ValueKey<String>('durbun-share-note')), findsOneWidget, reason: 'the message is for every way out');
      expect(find.byKey(const ValueKey<String>('durbun-slack-sender')), findsNothing);
    });

    testWidgets('a refused message keeps the sheet open and says why', (tester) async {
      debugPostToSlack = (webhook, payload) async => (status: 403, answer: 'invalid_token');
      await _openLogs(tester, _store(webhook: 'https://hooks.slack.com/services/T/B/x'));
      await _openShareSheet(tester);
      await tester.tap(find.text('Send to Slack'));
      await tester.pumpAndSettle();
      expect(find.text('Could not send to Slack: invalid_token'), findsOneWidget);
      expect(find.byType(BottomSheet), findsOneWidget);
    });
  });
}

/// The block kind of a payload: `text` when it has none.
String _typeOf(Map<String, Object?> payload) {
  final blocks = payload['blocks'];
  if (blocks is! List || blocks.isEmpty) return 'text';
  return (blocks.first! as Map<String, Object?>)['type']! as String;
}

/// Every text run of a rich text block, in order.
List<String> _texts(Map<String, Object?> block) {
  final out = <String>[];
  void walk(Object? node) {
    if (node is Map) {
      if (node['type'] == 'text' && node['text'] is String) out.add(node['text']! as String);
      walk(node['elements']);
    } else if (node is List) {
      node.forEach(walk);
    }
  }

  walk(block);
  return out;
}
