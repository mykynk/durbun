/// "Send to Slack" from the in-app panel: the share report goes to the
/// channel of `DurbunOptions.slackWebhook` (or
/// `--dart-define=DURBUN_SLACK_WEBHOOK`) when someone taps Send, from the
/// phone itself (dart:io only; the stub keeps the web build compiling).
///
/// Slack reads "mrkdwn", not Markdown, so [toSlackText] escapes `&`, `<` and
/// `>` (Slack reads `<…>` as a link or an @channel mention), turns every
/// fence into plain ``` and breaks backtick runs inside a block, and cuts the
/// text below Slack's 40,000-character limit. The desktop does the same
/// (`packages/ui/src/lib/slack.ts`); `slack_test.dart` and `slack.test.ts`
/// pin the same output.
library;

import 'package:flutter/foundation.dart';

import 'slack_stub.dart' if (dart.library.io) 'slack_io.dart' as platform;

/// Slack cuts a message's text after 40,000 characters.
const int kSlackMaxChars = 40000;

final RegExp _fenceOpen = RegExp(r'^(`{3,})[\w+#.-]*$');
final RegExp _backtickRun = RegExp('`{3,}');
const String _zwsp = '​';

String _escape(String line) => line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/// [line] cut to [max] characters without splitting a surrogate pair or an
/// `&amp;` entity.
String _cutLine(String line, int max) {
  var cut = max.clamp(0, line.length);
  if (cut > 0) {
    final code = line.codeUnitAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
  }
  var out = line.substring(0, cut);
  final amp = out.lastIndexOf('&');
  if (amp >= 0 && amp > out.length - 5 && !out.substring(amp).contains(';')) out = out.substring(0, amp);
  return out;
}

/// [report] (the light-Markdown share report) as Slack mrkdwn, [footer] as
/// its last line and [cutNote] added when it had to be cut.
String toSlackText(String report, {required String cutNote, String? footer, int maxChars = kSlackMaxChars}) {
  final foot = footer == null || footer.isEmpty ? const <String>[] : <String>['', _escape(footer)];
  // Room for the closing fence, the note and the footer.
  final budget = maxChars - (foot.join('\n').length + _escape(cutNote).length + 8);
  final out = <String>[];
  var size = 0;
  String? fence;
  var cut = false;
  for (final raw in report.split('\n')) {
    String line;
    var next = fence;
    if (fence == null) {
      final open = _fenceOpen.firstMatch(raw);
      if (open != null) next = open.group(1);
      line = open != null ? '```' : _escape(raw);
    } else if (raw == fence) {
      next = null;
      line = '```';
    } else {
      line = _escape(raw).replaceAllMapped(_backtickRun, (m) => m.group(0)!.split('').join(_zwsp));
    }
    final add = (out.isNotEmpty ? 1 : 0) + line.length;
    if (size + add > budget) {
      // A fence line is never cut: the block state stays as it was before it.
      final room = budget - size - (out.isNotEmpty ? 1 : 0);
      if (room > 0 && next == fence) out.add(_cutLine(line, room));
      cut = true;
      break;
    }
    out.add(line);
    size += add;
    fence = next;
  }
  if (cut) {
    if (fence != null) out.add('```');
    out.add(_escape(cutNote));
  }
  while (out.isNotEmpty && out.last.trim().isEmpty) {
    out.removeLast();
  }
  return <String>[...out, ...foot].join('\n');
}

/// Whether this platform can post to Slack (dart:io).
bool get canSendToSlack => platform.canSendToSlack;

/// Replaces the HTTP call (tests).
@visibleForTesting
Future<String?> Function(String webhook, String text)? debugPostToSlack;

/// Posts [text] (Slack mrkdwn) to [webhook]. Returns null on success, else
/// what went wrong (Slack's answer such as `invalid_token`, or the network
/// error).
Future<String?> sendToSlack(String webhook, String text) => (debugPostToSlack ?? platform.postToSlack)(webhook, text);
