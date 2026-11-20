import 'dart:ui' as ui;

import 'package:durbun/src/inspector/app_snapshot.dart';
import 'package:durbun/src/inspector/screenshot_attach.dart';
import 'package:durbun/src/inspector/share_sheet.dart';
import 'package:durbun/src/inspector/slack.dart';
import 'package:durbun/src/inspector/slack_sender.dart' show debugResetSlackSender;
import 'package:durbun/src/inspector/store.dart';
import 'package:durbun/src/inspector/theme.dart';
import 'package:durbun/src/inspector/widgets.dart' show Callout;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../gallery/pati_seed.dart';

/// A request's and a log line's share sheet offer the app's screenshot from
/// when the panel opened: in by default, left out with one tap; Share…
/// sends it beside the text, Send to Slack uploads it after the report when
/// the connection has the upload key.

final double _now = DateTime.utc(2026, 11, 19, 13, 57, 2).millisecondsSinceEpoch.toDouble();
const String _hook = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';
const String _keyed = '$_hook#token=xoxb-1234-5678-abcdEFGH&channel=C0123ABCD';

class _Shared {
  final List<(String, Map<String, Object?>)> calls = <(String, Map<String, Object?>)>[];
  final Map<String, List<int>> files = <String, List<int>>{};
  final List<String?> clipboard = <String?>[];
}

/// Fakes the PNG encoder, the file writer, the share channel ([files] and
/// [text] answer `shareFiles` and `share`) and the clipboard.
_Shared _fakeShare(WidgetTester tester, {bool files = true, bool text = true}) {
  final out = _Shared();
  debugSnapshotPng = (_) async => Uint8List.fromList(<int>[137, 80, 78, 71]);
  debugBugBytesWriter = (name, bytes) async {
    out.files[name] = bytes;
    return '/cache/durbun-export/$name';
  };
  debugShareHandler = (method, args) async {
    out.calls.add((method, args));
    return method == 'shareFiles' ? files : text;
  };
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'Clipboard.setData') out.clipboard.add((call.arguments as Map)['text'] as String?);
    return null;
  });
  addTearDown(() {
    debugSnapshotPng = null;
    debugBugBytesWriter = null;
    debugShareHandler = null;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null);
  });
  return out;
}

/// Slack faked: the webhook takes every report; the Web API answers [api]
/// by method (ok otherwise). Records the reports and every API call.
(List<String>, List<String>) _fakeSlack({Map<String, SlackAnswer> api = const <String, SlackAnswer>{}}) {
  final reports = <String>[];
  final calls = <String>[];
  debugPostToSlack = (url, payload) async {
    expect(url, _hook, reason: 'the key never goes to the webhook');
    reports.add(payload['text']! as String);
    return (status: 200, answer: 'ok');
  };
  debugPostSlackForm = (url, token, form) async {
    final method = url.split('/').last;
    calls.add(method == 'files.completeUploadExternal' ? '$method ${form['files']}' : method);
    return api[method] ??
        (method == 'files.getUploadURLExternal'
            ? (status: 200, answer: '{"ok":true,"upload_url":"https://files.slack.com/upload/v1/ABC","file_id":"F0456EFGH"}')
            : (status: 200, answer: '{"ok":true}'));
  };
  debugPostSlackBytes = (url, bytes) async {
    calls.add('upload ${bytes.length}');
    return (status: 200, answer: 'OK');
  };
  addTearDown(() {
    debugPostToSlack = null;
    debugPostSlackForm = null;
    debugPostSlackBytes = null;
    debugResetSlackJoins();
    debugResetSlackSender();
  });
  return (reports, calls);
}

Future<ui.Image> _picture(WidgetTester tester) async =>
    (await tester.runAsync(() => createTestImage(width: 120, height: 260, cache: false)))!;

/// The pati store, its panel opening with a picture unless [shot] is false,
/// and [slack] as its webhook.
Future<DurbunInspectorStore> _store(WidgetTester tester, {bool shot = true, String? slack}) async {
  final s = patiStore(now: _now, withMetrics: false)..slackWebhook = slack;
  setPanelOpening(s, PanelOpening(_now, shot ? await _picture(tester) : null));
  addTearDown(() => setPanelOpening(s, null));
  return s;
}

/// A phone with one button that opens [open]'s sheet.
Future<void> _open(WidgetTester tester, void Function(BuildContext context) open) async {
  tester.view.physicalSize = const Size(390, 844) * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => DurbunTheme.wrap(
        context,
        Scaffold(
            body:
                Center(child: Builder(builder: (inner) => TextButton(onPressed: () => open(inner), child: const Text('open'))))),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Future<void> _openRequest(WidgetTester tester, DurbunInspectorStore s) =>
    _open(tester, (context) => showShareSheet(context, s.calls.firstWhere((c) => c.url.endsWith('/v2/cart/items/77')), s));

Finder _shotCard() => find.byKey(const ValueKey<String>('durbun-share-shot'));

Future<void> _tapVisible(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

void main() {
  group('Share…', () {
    testWidgets('the text and the screenshot as a PNG in one share sheet', (tester) async {
      final out = _fakeShare(tester);
      await _openRequest(tester, await _store(tester));
      expect(_shotCard(), findsOneWidget);
      expect(find.text('Screenshot'), findsOneWidget);
      expect(find.text('Whatever was on the screen goes in; it is not masked.'), findsOneWidget);

      await _tapVisible(tester, find.text('Share…'));
      final (method, args) = out.calls.single;
      expect(method, 'shareFiles');
      expect(args['text'], startsWith('DELETE https://api.pati.app/v2/cart/items/77'));
      expect(args['subject'], 'DELETE /v2/cart/items/77 → 404');
      final name = out.files.keys.single;
      expect(name, matches(RegExp(r'^durbun-shot-pati-\d{8}-\d{6}\.png$')));
      expect(args['paths'], <String>['/cache/durbun-export/$name']);
      expect(args['mimes'], <String>['image/png']);
      expect(find.text('open'), findsOneWidget, reason: 'the sheet closed');
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('left out: the text alone, no file written', (tester) async {
      final out = _fakeShare(tester);
      await _openRequest(tester, await _store(tester));
      await _tapVisible(tester, find.text('Leave the screenshot out'));
      expect(find.text('Not shared'), findsOneWidget);
      expect(find.text('Put it back'), findsOneWidget);

      await _tapVisible(tester, find.text('Share…'));
      expect(out.calls.single.$1, 'share');
      expect(out.files, isEmpty);
    });

    testWidgets('a host that shares text only: the text goes and a line says the picture did not', (tester) async {
      final out = _fakeShare(tester, files: false);
      await _openRequest(tester, await _store(tester));
      await _tapVisible(tester, find.text('Share…'));
      expect(out.calls.map((c) => c.$1), <String>['shareFiles', 'share']);
      expect(find.text('The screenshot could not be attached; only the text was shared.'), findsOneWidget);
    });

    testWidgets('nothing opens: the text is copied', (tester) async {
      final out = _fakeShare(tester, files: false, text: false);
      await _openRequest(tester, await _store(tester));
      await _tapVisible(tester, find.text('Share…'));
      expect(out.clipboard.single, startsWith('DELETE https://api.pati.app/v2/cart/items/77'));
      expect(find.text('Sharing did not open; the report was copied'), findsOneWidget);
    });

    testWidgets('no picture this opening: no screenshot row, Share… sends the text', (tester) async {
      final out = _fakeShare(tester);
      await _openRequest(tester, await _store(tester, shot: false));
      expect(_shotCard(), findsNothing);
      await _tapVisible(tester, find.text('Share…'));
      expect(out.calls.single.$1, 'share');
    });
  });

  group('Send to Slack', () {
    testWidgets('with the key: the report, then the screenshot in the same channel', (tester) async {
      _fakeShare(tester);
      final (reports, calls) = _fakeSlack();
      await _openRequest(tester, await _store(tester, slack: _keyed));
      expect(find.textContaining('sends text only'), findsNothing);

      await _tapVisible(tester, find.text('Send to Slack'));
      expect(reports.single, contains('DELETE https://api.pati.app/v2/cart/items/77'));
      expect(calls.first, 'conversations.join');
      expect(calls[1], 'files.getUploadURLExternal');
      expect(calls[2], 'upload 4');
      expect(calls.last, contains('"title":"Screenshot · DELETE /v2/cart/items/77 → 404"'));
      expect(find.text('Sent to Slack with the screenshot'), findsOneWidget);
      expect(find.text('open'), findsOneWidget, reason: 'the sheet closed');
    });

    testWidgets('left out: the report alone, nothing uploaded', (tester) async {
      _fakeShare(tester);
      final (reports, calls) = _fakeSlack();
      await _openRequest(tester, await _store(tester, slack: _keyed));
      await _tapVisible(tester, find.text('Leave the screenshot out'));
      await _tapVisible(tester, find.text('Send to Slack'));
      expect(reports, hasLength(1));
      expect(calls, isEmpty);
      expect(find.text('Sent to Slack'), findsOneWidget);
    });

    testWidgets('a webhook without the key: said beforehand; the report goes, the sheet closes', (tester) async {
      _fakeShare(tester);
      final (reports, calls) = _fakeSlack();
      await _openRequest(tester, await _store(tester, slack: _hook));
      expect(find.text('This build’s Slack connection sends text only; the screenshot goes with Share….'), findsOneWidget);

      await _tapVisible(tester, find.text('Send to Slack'));
      expect(reports, hasLength(1));
      expect(calls, isEmpty);
      expect(find.text('Sent to Slack'), findsOneWidget);
      expect(find.text('open'), findsOneWidget);
    });

    testWidgets('the upload refused: the sheet stays and says why, Share… can still send it', (tester) async {
      final out = _fakeShare(tester);
      final (reports, _) = _fakeSlack(api: <String, SlackAnswer>{
        'files.completeUploadExternal': (status: 200, answer: '{"ok":false,"error":"not_in_channel"}')
      });
      await _openRequest(tester, await _store(tester, slack: _keyed));
      await _tapVisible(tester, find.text('Send to Slack'));
      expect(reports, hasLength(1));
      expect(find.byType(Callout), findsOneWidget);
      expect(find.text('The report went to Slack, the screenshot did not'), findsOneWidget);

      await _tapVisible(tester, find.text('Share…'));
      expect(out.calls.single.$1, 'shareFiles');
    });
  });

  testWidgets('a log line offers it too', (tester) async {
    _fakeShare(tester);
    final s = await _store(tester);
    await _open(tester, (context) => showLogShareSheet(context, s.logs.firstWhere((l) => l.isError), s));
    expect(_shotCard(), findsOneWidget);
  });
}
