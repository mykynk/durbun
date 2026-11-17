/// "Send to Slack" from the in-app panel: the share report goes to the
/// channel of `DurbunOptions.slackWebhook` (or
/// `--dart-define=DURBUN_SLACK_WEBHOOK`) when someone taps Send, from the
/// phone itself (dart:io only; the stub keeps the web build compiling).
///
/// The report goes the way the Mac app sends it: as one message of Slack's
/// rich text, the way a report pasted into Slack shows (lists, quotes and
/// code blocks with their language, however long). When the workspace
/// refuses that block it goes as `markdown` blocks, split into numbered
/// messages when longer than one holds; when it refuses those too, as plain
/// mrkdwn text. The Mac app's server builds the same blocks
/// (`packages/server/src/http/slack.ts`); `slack_test.dart` and
/// `slack.test.ts` pin the same output.
///
/// [toSlackMarkdown] and [toSlackText] prepare the report as the desktop UI
/// does (`packages/ui/src/lib/slack.ts`; `slack.test.ts` there pins the same
/// output): a run of backticks inside a block is broken up so it cannot
/// close the block early, and the text is cut below Slack's 40,000-character
/// limit, an open block closed and a note added. The Markdown keeps every
/// fence's language and is not escaped (rich text reads no `<…>` links or
/// mentions); its footer and note are in italics. The mrkdwn text, the plain
/// fallback, escapes `&`, `<` and `>` (Slack reads `<…>` as a link or an
/// @channel mention) and makes every fence plain ```.
library;

import 'package:flutter/foundation.dart';

import 'slack_stub.dart' if (dart.library.io) 'slack_io.dart' as platform;

/// Slack cuts a message's text after 40,000 characters.
const int kSlackMaxChars = 40000;

/// Slack holds at most 12,000 characters of `markdown` blocks in one
/// message; a part stays under that with room for the code fence a split
/// closes and reopens.
const int kSlackMarkdownPartChars = 11000;

/// Between the parts of a long report: Slack takes about one message a
/// second per webhook.
const Duration kSlackPartGap = Duration(milliseconds: 1100);

/// A webhook's answer when the workspace does not take a block kind: the
/// report then goes the next way (Markdown parts, then plain text).
final RegExp _blocksRefused =
    RegExp('invalid_blocks|invalid_payload|no_text|invalid_attachments|msg_too_long|msg_blocks_too_long|too_many_blocks');

const int _notificationChars = 150;

/* ───────────────────── the report, prepared for Slack ───────────────────── */

final RegExp _reportFence = RegExp(r'^(`{3,})([\w+#.-]*)$');
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

/// [report] (the light-Markdown share report) as the Markdown for Slack's
/// rich text: fences keep their language, nothing is escaped, backtick runs
/// inside a block are broken up; [footer] as its last line and [cutNote]
/// added when it had to be cut to [maxChars], both in italics.
String toSlackMarkdown(String report, {required String cutNote, String? footer, int maxChars = kSlackMaxChars}) =>
    _prepare(report, cutNote: cutNote, footer: footer, maxChars: maxChars, mrkdwn: false);

/// [report] as Slack mrkdwn (the plain-text fallback): as [toSlackMarkdown],
/// with `&`, `<` and `>` escaped and every fence plain ```.
String toSlackText(String report, {required String cutNote, String? footer, int maxChars = kSlackMaxChars}) =>
    _prepare(report, cutNote: cutNote, footer: footer, maxChars: maxChars, mrkdwn: true);

String _prepare(String report, {required String cutNote, required String? footer, required int maxChars, required bool mrkdwn}) {
  String plain(String line) => mrkdwn ? _escape(line) : line;
  String quiet(String line) => mrkdwn ? _escape(line) : '_${line}_';
  final foot = footer == null || footer.isEmpty ? const <String>[] : <String>['', quiet(footer)];
  final note = quiet(cutNote);
  // Room for the closing fence, the note and the footer.
  final budget = maxChars - (foot.join('\n').length + note.length + 8);
  final out = <String>[];
  var size = 0;
  String? fence;
  var cut = false;
  for (final raw in report.split('\n')) {
    String line;
    var next = fence;
    if (fence == null) {
      final open = _reportFence.firstMatch(raw);
      if (open != null) next = open.group(1);
      line = open == null ? plain(raw) : (mrkdwn ? '```' : '```${open.group(2)}');
    } else if (raw == fence) {
      next = null;
      line = '```';
    } else {
      line = plain(raw).replaceAllMapped(_backtickRun, (m) => m.group(0)!.split('').join(_zwsp));
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
    out.add(note);
  }
  while (out.isNotEmpty && out.last.trim().isEmpty) {
    out.removeLast();
  }
  return <String>[...out, ...foot].join('\n');
}

/* ───────────────────── Markdown parts and rich text ───────────────────── */

final RegExp _fenceOpen = RegExp(r'^```([\w+#.-]*)\s*$');
final RegExp _carriageReturn = RegExp(r'\r$');

/// [markdown] in parts of at most [limit] characters, cut at line ends. A
/// code block open at a cut is closed at the end of one part and reopened,
/// with its language, at the start of the next, so every part renders on its
/// own. A line longer than a part (a minified JSON body) is cut into pieces,
/// never inside a surrogate pair.
List<String> slackMarkdownChunks(String markdown, {int limit = kSlackMarkdownPartChars}) {
  final parts = <String>[];

  /// The open block's fence line ("```json") where the part being built
  /// ends, or null outside one.
  String? open;
  var cur = <String>[];
  var size = 0;

  /// Whether the part began by reopening the block the previous part closed.
  var reopened = false;
  void add(String line) {
    size += (cur.isNotEmpty ? 1 : 0) + line.length;
    cur.add(line);
  }

  /// Whether the part holds more than a reopened fence (or blank lines).
  bool hasContent() => cur.skip(reopened ? 1 : 0).any((l) => l.trim().isNotEmpty);
  void trimEnd() {
    while (cur.isNotEmpty && cur.last.trim().isEmpty) {
      cur.removeLast();
    }
  }

  void finish() {
    trimEnd();
    var close = open != null;
    // A block opened on the part's last line moves whole to the next part:
    // no empty block at the end of this one.
    if (open != null && cur.length > (reopened ? 1 : 0) && cur.last == open && !(reopened && cur.length == 1)) {
      cur.removeLast();
      trimEnd();
      close = false;
    }
    if (hasContent()) parts.add(close ? '${cur.join('\n')}\n```' : cur.join('\n'));
    reopened = open != null;
    cur = open != null ? <String>[open] : <String>[];
    size = open != null ? open.length : 0;
  }

  for (final raw in markdown.split('\n')) {
    final line = raw.replaceFirst(_carriageReturn, '');
    final closes = open != null && line.trim() == '```';
    final next = open == null ? (_fenceOpen.hasMatch(line) ? line.trim() : null) : (closes ? null : open);
    // Inside a block a part keeps 4 characters for the closing fence; the
    // closing fence itself may use them.
    final max = open != null && !closes ? limit - 4 : limit;
    bool fits(String text) => size + (cur.isNotEmpty ? 1 : 0) + text.length <= max;
    // No blank line opens a part.
    if (line.trim().isEmpty && !hasContent() && open == null) continue;
    if (!fits(line) && hasContent()) finish();
    if (fits(line)) {
      add(line);
    } else {
      // Longer than a whole part: cut it into pieces, each ending a part.
      var rest = line;
      while (rest.isNotEmpty) {
        final free = max - size - (cur.isNotEmpty ? 1 : 0);
        if (rest.length <= free) {
          add(rest);
          break;
        }
        var cut = free < 1 ? 1 : free;
        final code = rest.codeUnitAt(cut - 1);
        if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut--;
        add(rest.substring(0, cut));
        rest = rest.substring(cut);
        finish();
      }
    }
    open = next;
  }
  // The report closes its own blocks; one still open here gets its fence so
  // the last part renders.
  finish();
  return parts;
}

final RegExp _notificationMark = RegExp(r'^(#{1,6}\s+|[-*+]\s+|>\s*)');
final RegExp _inlineMarks = RegExp('[*_`~]');

/// The report's first line as a notification ("GET https://… → 200 OK"): no
/// Markdown marks, mrkdwn-escaped.
String notificationText(String markdown) {
  var inBlock = false;
  for (final raw in markdown.split('\n')) {
    final line = raw.trim();
    if (line.startsWith('```')) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock || line.isEmpty) continue;
    final plain = line.replaceFirst(_notificationMark, '').replaceAll(_inlineMarks, '').trim();
    if (plain.isEmpty) continue;
    var cut = plain;
    if (plain.length > _notificationChars) {
      var end = _notificationChars - 1;
      // Never half an emoji before the ellipsis.
      final code = plain.codeUnitAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
      cut = '${plain.substring(0, end)}…';
    }
    return _escape(cut);
  }
  return 'Dürbün';
}

/// `code`, **bold**, a URL, _italic_ (a whole word or more).
final RegExp _inline = RegExp(
  r'''(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?://[^\s<>`"]+)|((?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))''',
  unicode: true,
);
final RegExp _bullet = RegExp(r'^\s{0,3}[-*+]\s+(.*)$');
final RegExp _ordered = RegExp(r'^\s{0,3}\d{1,3}[.)]\s+(.*)$');
final RegExp _heading = RegExp(r'^#{1,6}\s+(.*)$');
final RegExp _quote = RegExp(r'^>\s?(.*)$');
final RegExp _urlTail = RegExp(r"[).,;:!?'\]]+$");

/// One line of report text as rich text runs: links stay links, the few
/// marks the reports use become styles ([base]: the style of the whole line,
/// such as bold for a heading).
List<Map<String, Object?>> richInline(String line, [Map<String, bool>? base]) {
  final out = <Map<String, Object?>>[];
  void text(String t, [Map<String, bool>? style]) {
    if (t.isEmpty) return;
    final s = <String, bool>{...?base, ...?style};
    out.add(s.isNotEmpty ? <String, Object?>{'type': 'text', 'text': t, 'style': s} : <String, Object?>{'type': 'text', 'text': t});
  }

  var last = 0;
  for (final m in _inline.allMatches(line)) {
    text(line.substring(last, m.start));
    final code = m.group(1);
    final bold = m.group(2);
    final link = m.group(3);
    final italic = m.group(4);
    if (code != null) {
      text(code.substring(1, code.length - 1), const <String, bool>{'code': true});
    } else if (bold != null) {
      text(bold.substring(2, bold.length - 2), const <String, bool>{'bold': true});
    } else if (italic != null) {
      text(italic.substring(1, italic.length - 1), const <String, bool>{'italic': true});
    } else if (link != null) {
      // "(https://x.example/a)." — the closing punctuation is the
      // sentence's, not the URL's.
      final url = link.replaceFirst(_urlTail, '');
      out.add(base != null
          ? <String, Object?>{'type': 'link', 'url': url, 'style': <String, bool>{...base}}
          : <String, Object?>{'type': 'link', 'url': url});
      text(link.substring(url.length));
    }
    last = m.end;
  }
  text(line.substring(last));
  return out;
}

Map<String, Object?> _newline() => <String, Object?>{'type': 'text', 'text': '\n'};

/// The report's light Markdown as one rich text block, the way Slack shows a
/// report pasted into it: paragraphs, `##` headings (bold), `>` quotes,
/// `-` / `1.` lists, and code blocks with their language (Slack highlights
/// them). A blank line ends a paragraph. Plain text runs need no escaping:
/// rich text reads no `<…>` links or mentions.
Map<String, Object?> markdownToRichText(String markdown) {
  final elements = <Map<String, Object?>>[];
  final lines = <String>[for (final l in markdown.split('\n')) l.replaceFirst(_carriageReturn, '')];

  /// Lines of the paragraph being gathered; a blank line after it becomes
  /// its trailing newline.
  var para = <String>[];
  void endPara(bool blankAfter) {
    if (para.isEmpty) return;
    final runs = <Map<String, Object?>>[];
    for (var i = 0; i < para.length; i++) {
      runs.addAll(richInline(para[i]));
      if (i < para.length - 1) runs.add(_newline());
    }
    if (blankAfter) runs.add(_newline());
    if (runs.isNotEmpty) elements.add(<String, Object?>{'type': 'rich_text_section', 'elements': runs});
    para = <String>[];
  }

  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    final fence = _fenceOpen.firstMatch(line);
    if (fence != null) {
      endPara(false);
      final body = <String>[];
      var j = i + 1;
      while (j < lines.length && lines[j].trim() != '```') {
        body.add(lines[j++]);
      }
      // Slack refuses an empty text run: an empty block keeps one space.
      final joined = body.join('\n');
      final code = joined.isEmpty ? ' ' : joined;
      final language = fence.group(1)?.toLowerCase() ?? '';
      elements.add(<String, Object?>{
        'type': 'rich_text_preformatted',
        'elements': <Object?>[
          <String, Object?>{'type': 'text', 'text': code},
        ],
        if (language.isNotEmpty) 'language': language,
        'border': 0,
      });
      i = j;
      continue;
    }
    if (line.trim().isEmpty) {
      endPara(true);
      continue;
    }
    final heading = _heading.firstMatch(line);
    if (heading != null) {
      endPara(false);
      elements.add(<String, Object?>{
        'type': 'rich_text_section',
        'elements': richInline(heading.group(1)!.trim(), const <String, bool>{'bold': true}),
      });
      continue;
    }
    if (_quote.hasMatch(line)) {
      endPara(false);
      final quoted = <String>[];
      while (i < lines.length && _quote.hasMatch(lines[i])) {
        quoted.add(_quote.firstMatch(lines[i++])!.group(1)!);
      }
      i--;
      final runs = <Map<String, Object?>>[];
      for (var k = 0; k < quoted.length; k++) {
        runs.addAll(richInline(quoted[k]));
        if (k < quoted.length - 1) runs.add(_newline());
      }
      if (runs.isNotEmpty) elements.add(<String, Object?>{'type': 'rich_text_quote', 'elements': runs});
      continue;
    }
    final item = _bullet.firstMatch(line) ?? _ordered.firstMatch(line);
    if (item != null) {
      endPara(false);
      final bullet = _bullet.hasMatch(line);
      final pattern = bullet ? _bullet : _ordered;
      final items = <Map<String, Object?>>[];
      while (i < lines.length && pattern.hasMatch(lines[i])) {
        final runs = richInline(pattern.firstMatch(lines[i++])!.group(1)!);
        if (runs.isNotEmpty) items.add(<String, Object?>{'type': 'rich_text_section', 'elements': runs});
      }
      i--;
      if (items.isNotEmpty) {
        elements.add(<String, Object?>{'type': 'rich_text_list', 'style': bullet ? 'bullet' : 'ordered', 'elements': items});
      }
      continue;
    }
    para.add(line);
  }
  endPara(false);
  if (elements.isEmpty) {
    elements.add(<String, Object?>{
      'type': 'rich_text_section',
      'elements': <Object?>[
        <String, Object?>{'type': 'text', 'text': ' '},
      ],
    });
  }
  return <String, Object?>{'type': 'rich_text', 'elements': elements};
}

/* ───────────────────────────── sending ───────────────────────────── */

/// What the webhook answered: its HTTP status and body (at most 200
/// characters), or status 0 and why no answer came (`timeout`, the network
/// error).
typedef SlackAnswer = ({int status, String answer});

/// Whether this platform can post to Slack (dart:io).
bool get canSendToSlack => platform.canSendToSlack;

/// Replaces the HTTP call (tests): gets the webhook and the JSON payload.
@visibleForTesting
Future<SlackAnswer> Function(String webhook, Map<String, Object?> payload)? debugPostToSlack;

/// Posts the report to [webhook]: [markdown] (from [toSlackMarkdown]) as one
/// rich text message; when the workspace refuses that block, as `markdown`
/// blocks in numbered parts [partGap] apart; when it refuses those too, as
/// [text] (from [toSlackText]). Link previews stay off: URLs in a report may
/// be internal. Returns null on success, else what went wrong (Slack's
/// answer such as `invalid_token`, or the network error); never throws.
Future<String?> sendToSlack(
  String webhook, {
  required String markdown,
  required String text,
  Duration partGap = kSlackPartGap,
}) async {
  try {
    if (markdown.trim().isEmpty) return await _postText(webhook, text);
    return await _postRichText(webhook, markdown, text, partGap);
  } catch (e) {
    return '$e';
  }
}

Future<SlackAnswer> _post(String webhook, Map<String, Object?> payload) =>
    (debugPostToSlack ?? platform.postToSlack)(webhook, payload);

bool _refused(SlackAnswer res) => res.status == 400 && _blocksRefused.hasMatch(res.answer);

/// Null for a 2xx answer, else Slack's answer (or the HTTP status) with
/// [part] ("(2/3)") after it.
String? _check(SlackAnswer res, String part) {
  if (res.status >= 200 && res.status < 300) return null;
  final why = res.answer.isNotEmpty ? res.answer : 'HTTP ${res.status}';
  return '$why$part';
}

Future<String?> _postText(String webhook, String text) async =>
    _check(await _post(webhook, <String, Object?>{'text': text, 'unfurl_links': false, 'unfurl_media': false}), '');

Future<String?> _postRichText(String webhook, String markdown, String fallbackText, Duration partGap) async {
  final res = await _post(webhook, <String, Object?>{
    // Notifications and clients without blocks show `text`; the message
    // itself is the block.
    'text': notificationText(markdown),
    'blocks': <Object?>[markdownToRichText(markdown)],
    'unfurl_links': false,
    'unfurl_media': false,
  });
  if (_refused(res)) return _postMarkdown(webhook, markdown, fallbackText, partGap);
  return _check(res, '');
}

Future<String?> _postMarkdown(String webhook, String markdown, String fallbackText, Duration partGap) async {
  final parts = slackMarkdownChunks(markdown);
  final note = notificationText(markdown);
  for (var i = 0; i < parts.length; i++) {
    // About one message a second per webhook: the parts of a long report go
    // just under that pace.
    if (i > 0 && partGap > Duration.zero) await Future<void>.delayed(partGap);
    final of = parts.length > 1 ? ' (${i + 1}/${parts.length})' : '';
    final res = await _post(webhook, <String, Object?>{
      'text': '$note$of',
      'blocks': <Object?>[
        <String, Object?>{'type': 'markdown', 'text': parts[i]},
      ],
      'unfurl_links': false,
      'unfurl_media': false,
    });
    if (i == 0 && fallbackText.trim().isNotEmpty && _refused(res)) return _postText(webhook, fallbackText);
    final error = _check(res, of);
    if (error != null) return error;
  }
  return null;
}
