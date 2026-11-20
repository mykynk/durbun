/// "Report a bug": what goes into a report about one moment (a log line, a
/// failed request, or the moment the panel opened) and the report itself,
/// a light Markdown text close to the desktop's
/// (`packages/ui/src/features/report/model.ts`). Pure: the page passes the
/// store in, so the counts it shows and the text it sends come from the
/// same code.
///
/// Two texts are made: the share text (the note, the facts, the moment,
/// the failed requests as one line each and the last [kBugTextLines] log
/// lines) and the attached file (every line of the window up to
/// [kBugMaxLines], with stacks and data, and every failed request in full).
library;

import 'dart:convert';

import '../core/protocol.dart' show kSdkVersion;
import 'network_model.dart' show reasonPhrase;
import 'share_report.dart';
import 'share_sheet.dart' show hostAppLabel, hostDeviceLabel;
import 'store.dart';
import 'strings.dart';

/// Seconds before the moment the tester can pick.
const List<int> kBugBeforeChoices = <int>[30, 60, 120, 300];

/// Seconds before the moment a report starts with.
const int kBugDefaultBeforeS = 60;

/// Seconds after the moment that always go in (what the error led to).
const int kBugAfterS = 10;

/// Log lines the attached file holds at most (the newest of the window).
const int kBugMaxLines = 500;

/// Log lines the share text quotes (the newest).
const int kBugTextLines = 50;

/// Failed requests a report lists at most (the newest of the window).
const int kBugMaxRequests = 30;

/// A line of the share text is cut here.
const int kBugLineChars = 240;

/// Where a report starts: a log line, a request, or the panel's opening.
class BugAnchor {
  const BugAnchor.log(InspectorLog this.log) : call = null;
  const BugAnchor.request(InspectorCall this.call) : log = null;
  const BugAnchor.now()
      : log = null,
        call = null;

  final InspectorLog? log;
  final InspectorCall? call;

  bool get isNow => log == null && call == null;

  /// Epoch ms of the moment; [nowMs] for "now".
  double moment(double nowMs) => log?.ts ?? call?.ts ?? nowMs;
}

/// [fromMs, toMs]: the part of the run a report covers.
class BugWindow {
  const BugWindow(this.fromMs, this.toMs);

  final double fromMs;
  final double toMs;

  bool contains(double ts) => ts >= fromMs && ts <= toMs;
}

BugWindow bugWindow(double momentMs, int beforeS, {int afterS = kBugAfterS}) =>
    BugWindow(momentMs - beforeS * 1000, momentMs + afterS * 1000);

/// What the store holds in a window.
class BugContents {
  const BugContents({required this.lines, required this.totalLines, required this.failed, required this.totalFailed});

  /// The newest [kBugMaxLines] log lines of the window, oldest first.
  final List<InspectorLog> lines;

  /// Log lines in the window (before the cap).
  final int totalLines;

  /// The newest [kBugMaxRequests] failed requests that started in the
  /// window, oldest first.
  final List<InspectorCall> failed;

  /// Failed requests in the window (before the cap).
  final int totalFailed;

  bool get isEmpty => totalLines == 0 && totalFailed == 0;
}

/// A failure the tester would call one: an error or a 4xx / 5xx, not a
/// request the app cancelled itself.
bool isReportedFailure(InspectorCall c) => c.isFailure && !c.cancelled;

/// The window's log lines and failed requests. Requests to hosts the panel
/// hides ([DurbunInspectorStore.defaultHosts]) stay out, except [anchor]'s.
BugContents collectBugContents(DurbunInspectorStore store, BugWindow window, {BugAnchor anchor = const BugAnchor.now()}) {
  final lines = <InspectorLog>[];
  for (final l in store.logs) {
    if (window.contains(l.ts)) lines.add(l);
  }
  final failed = <InspectorCall>[];
  for (final c in store.calls) {
    if (!window.contains(c.ts) || !isReportedFailure(c)) continue;
    if (!identical(c, anchor.call) && store.defaultHosts.isNotEmpty && !store.isDefaultHost(c.uri?.host ?? '')) continue;
    failed.add(c);
  }
  failed.sort((a, b) {
    final d = a.ts.compareTo(b.ts);
    return d != 0 ? d : a.seq.compareTo(b.seq);
  });
  return BugContents(
    lines: lines.length > kBugMaxLines ? lines.sublist(lines.length - kBugMaxLines) : lines,
    totalLines: lines.length,
    failed: failed.length > kBugMaxRequests ? failed.sublist(failed.length - kBugMaxRequests) : failed,
    totalFailed: failed.length,
  );
}

/// Which parts the tester sends, each on by default (the desktop's "What
/// goes in"). Off, a part's section is left out of the text and the file.
class BugParts {
  const BugParts({this.moment = true, this.logs = true, this.requests = true, this.facts = true, this.file = true});

  /// The moment's own line or request, in full.
  final bool moment;

  /// The log lines of the window.
  final bool logs;

  /// The failed requests of the window.
  final bool requests;

  /// The device, the app and the SDK (and their names in the title).
  final bool facts;

  /// The full report as a .md file beside the text (Share… only).
  final bool file;

  BugParts copyWith({bool? moment, bool? logs, bool? requests, bool? facts, bool? file}) => BugParts(
        moment: moment ?? this.moment,
        logs: logs ?? this.logs,
        requests: requests ?? this.requests,
        facts: facts ?? this.facts,
        file: file ?? this.file,
      );

  @override
  bool operator ==(Object other) =>
      other is BugParts &&
      other.moment == moment &&
      other.logs == logs &&
      other.requests == requests &&
      other.facts == facts &&
      other.file == file;

  @override
  int get hashCode => Object.hash(moment, logs, requests, facts, file);
}

/// Everything a report says.
class BugReportInput {
  const BugReportInput({
    required this.note,
    required this.anchor,
    required this.momentMs,
    required this.window,
    required this.contents,
    required this.mask,
    this.app,
    this.appName,
    this.device,
    this.deviceName,
    this.sdk,
    this.screenshotName,
    this.fileName,
    this.utcOffsetMinutes,
    this.parts = const BugParts(),
  });

  final String note;
  final BugAnchor anchor;
  final double momentMs;
  final BugWindow window;
  final BugContents contents;
  final bool mask;

  /// "Pati 3.4.0 (app.pati.mobile)"
  final String? app;

  /// "Pati": the title and the subject.
  final String? appName;

  /// "SM-A736B (Galaxy A73) · Android 14"
  final String? device;

  /// "Galaxy A73": the title and the subject.
  final String? deviceName;

  /// "Dürbün 0.2.0 · Flutter · Kotlin"
  final String? sdk;

  /// The attached screenshot and full report (null: not attached).
  final String? screenshotName;
  final String? fileName;

  /// Minutes east of UTC for local times (default: this device's offset).
  final int? utcOffsetMinutes;

  /// What goes in.
  final BugParts parts;

  /// The same report with exactly these attachments (none by default).
  BugReportInput withAttachments({String? fileName, String? screenshotName}) => BugReportInput(
        note: note,
        anchor: anchor,
        momentMs: momentMs,
        window: window,
        contents: contents,
        mask: mask,
        app: app,
        appName: appName,
        device: device,
        deviceName: deviceName,
        sdk: sdk,
        screenshotName: screenshotName,
        fileName: fileName,
        utcOffsetMinutes: utcOffsetMinutes,
        parts: parts,
      );
}

/// "Dürbün 0.2.0 · Flutter · Kotlin" from the app's hello.
String? sdkLabel(Map<String, Object?>? hello) {
  final sdk = hello?['sdk'];
  final version = sdk is Map ? sdk['version'] ?? kSdkVersion : kSdkVersion;
  final layers = <String>[
    if (sdk is Map && sdk['layers'] is List)
      for (final l in sdk['layers'] as List)
        switch ('$l') {
          'flutter' => 'Flutter',
          'dart' => 'Dart',
          'android' => 'Kotlin',
          'ios' => 'Swift',
          final other => other,
        },
  ];
  return <String>['Dürbün $version', ...layers.toSet()].join(' · ');
}

/// The report's input from [store] (app, device and SDK from its hello).
BugReportInput bugReportInputFor(
  DurbunInspectorStore store, {
  required String note,
  required BugAnchor anchor,
  required double momentMs,
  required BugWindow window,
  required BugContents contents,
  required bool mask,
  BugParts parts = const BugParts(),
  int? utcOffsetMinutes,
}) =>
    BugReportInput(
      note: note,
      anchor: anchor,
      momentMs: momentMs,
      window: window,
      contents: contents,
      mask: mask,
      app: hostAppLabel(store),
      appName: _text((store.hello?['app'] as Map?)?['name']),
      device: hostDeviceLabel(store),
      deviceName: deviceShortName(store.hello?['device']),
      sdk: sdkLabel(store.hello),
      parts: parts,
      utcOffsetMinutes: utcOffsetMinutes,
    );

String? _text(Object? v) => v is String && v.trim().isNotEmpty ? v.trim() : null;

/// The name people know a device by, as the Tools page shows it: the
/// model ("Galaxy A73"), or the name when the model is an identifier
/// ("iPhone17,1", a simulator's "arm64").
String? deviceShortName(Object? device) {
  if (device is! Map) return null;
  final model = _text(device['model']);
  final name = _text(device['name']);
  final identifier = model == null ||
      RegExp(r'^[A-Za-z]+\d+,\d+$').hasMatch(model) ||
      const <String>{'arm64', 'arm64e', 'x86_64', 'i386'}.contains(model);
  return identifier ? name ?? model : model;
}

/// "Pati · Galaxy A73": the app's and the device's names, for the title
/// and the subject.
String bugWhat(BugReportInput input) => !input.parts.facts
    ? ''
    : <String?>[input.appName, input.deviceName].whereType<String>().where((s) => s.isNotEmpty).join(' · ');

String bugSubject(BugReportInput input, InspectorStrings t) {
  final what = bugWhat(input);
  return what.isEmpty ? t.bugMdTitle : t.bugMdTitleFor(what);
}

/// `durbun-bug-pati-20261116-122736`: the files' name without extension
/// ([kind] `shot`: a shared request's or log line's screenshot).
String bugFileStem(String? appName, DateTime local, {String kind = 'bug'}) {
  String two(int n) => n.toString().padLeft(2, '0');
  final app = (appName ?? '').toLowerCase().replaceAll(RegExp('[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');
  final stamp = '${local.year}${two(local.month)}${two(local.day)}-${two(local.hour)}${two(local.minute)}${two(local.second)}';
  return <String>['durbun-$kind', if (app.isNotEmpty) app.length > 32 ? app.substring(0, 32) : app, stamp].join('-');
}

/* ───────────── lines ───────────── */

String _pad(int n, [int w = 2]) => n.toString().padLeft(w, '0');

DateTime _local(double ts, int? off) {
  final ms = ts.round();
  final offset = off ?? DateTime.fromMillisecondsSinceEpoch(ms).timeZoneOffset.inMinutes;
  return DateTime.fromMillisecondsSinceEpoch(ms + offset * 60000, isUtc: true);
}

/// "12:27:36" in the report's local time.
String bugClock(double ts, [int? off]) {
  final t = _local(ts, off);
  return '${_pad(t.hour)}:${_pad(t.minute)}:${_pad(t.second)}';
}

String _clockMs(double ts, int? off) => '${bugClock(ts, off)}.${_pad(_local(ts, off).millisecond, 3)}';

const Map<String, String> _letters = <String, String>{
  'verbose': 'V',
  'debug': 'D',
  'info': 'I',
  'warn': 'W',
  'error': 'E',
  'fatal': 'F',
};

String _cut(String s, int max) {
  if (s.length <= max) return s;
  var cut = max;
  final code = s.codeUnitAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return '${s.substring(0, cut)}…';
}

/// One log line, logcat-like: `12:27:36.296 F/cart: Unhandled exception…`.
/// [full] adds the rest of the message, the stack and the data as
/// indented lines; otherwise the first line only, cut at [kBugLineChars].
String bugLogLine(InspectorLog l, ShareMasker m, {int? utcOffsetMinutes, bool full = false}) {
  final head = '${_clockMs(l.ts, utcOffsetMinutes)} ${_letters[l.level] ?? 'I'}/${l.tag == null || l.tag!.isEmpty ? '-' : l.tag}: ';
  final message = m.text(l.message.trimRight());
  final lines = message.split('\n');
  if (!full) {
    final more = lines.length > 1 ? ' …' : '';
    return '$head${_cut(lines.first, kBugLineChars)}$more';
  }
  final out = <String>['$head${_cut(lines.first, 4000)}'];
  for (final rest in lines.skip(1).take(60)) {
    out.add('    $rest');
  }
  if (lines.length > 61) out.add('    …');
  final stack = l.error?['stack'];
  if (stack is String && stack.trim().isNotEmpty && !message.contains(stack.trim().split('\n').first)) {
    final frames = m.text(stack.trimRight()).split('\n');
    for (final f in frames.take(30)) {
      out.add('    $f');
    }
    if (frames.length > 30) out.add('    …');
  }
  if (l.data != null) {
    String json;
    try {
      json = jsonEncode(m.data(l.data));
    } catch (_) {
      json = '${l.data}';
    }
    out.add('    data: ${_cut(m.text(json), 2000)}');
  }
  return out.join('\n');
}

/// One failed request: `12:27:32.300 GET https://… → 500 Internal Server Error · 3.42 s`.
String bugRequestLine(InspectorCall c, ShareMasker m, InspectorStrings t, {int? utcOffsetMinutes}) {
  final method = (c.method.isEmpty || c.method == '?' ? 'GET' : c.method).toUpperCase();
  final String outcome;
  if (c.status != null) {
    final text = c.statusText?.isNotEmpty == true ? c.statusText! : (reasonPhrase(c.status) ?? '');
    outcome = '${c.status} $text'.trim();
  } else {
    final error = c.error?.split('\n').first.trim() ?? '';
    outcome = error.isEmpty ? t.bugMdFailedWord : '${t.bugMdFailedWord}: ${_cut(m.text(error), 160)}';
  }
  final d = c.duration;
  return '${_clockMs(c.ts, utcOffsetMinutes)} $method ${m.url(c.url)} → $outcome'
      '${d == null ? '' : ' · ${shareDuration(d.inMicroseconds / 1000)}'}';
}

/* ───────────── the report ───────────── */

List<String> _head(BugReportInput input, InspectorStrings t) {
  final off = input.utcOffsetMinutes;
  final what = bugWhat(input);
  final out = <String>['# ${what.isEmpty ? t.bugMdTitle : t.bugMdTitleFor(what)}', ''];
  final note = input.note.trim();
  if (note.isNotEmpty) {
    out.addAll(<String>['${t.bugMdNote}:', '', ...note.split('\n').map((l) => l.trim().isEmpty ? '>' : '> ${l.trimRight()}'), '']);
  }
  out.addAll(<String>[
    '## ${t.bugMdEnvironment}',
    '',
    '- ${t.bugMdMoment}: ${shareTime(input.momentMs, off)}',
    '- ${t.bugMdWindow(bugClock(input.window.fromMs, off), bugClock(input.window.toMs, off))}',
    if (input.parts.facts) ...<String>[
      if (input.device != null) '- ${t.reportDevice}: ${input.device}',
      if (input.app != null) '- ${t.reportApp}: ${input.app}',
      if (input.sdk != null) '- ${t.bugMdSdk}: ${input.sdk}',
    ],
    '',
  ]);
  return out;
}

/// The moment's own report: the log line's or the request's share report.
List<String> _moment(BugReportInput input, InspectorStrings t, ShareMasker m, {required bool curl}) {
  final anchor = input.anchor;
  final log = anchor.log;
  final call = anchor.call;
  if ((log == null && call == null) || !input.parts.moment) return const <String>[];
  final text = log != null
      ? buildLogReport(
          LogShareInput(
            level: log.level,
            kind: log.isEvent
                ? t.event
                : switch (log.kind) { 'crash' => t.crash, 'flutter-error' => t.reportFlutterError, _ => null },
            tag: log.tag,
            ts: log.ts,
            utcOffsetMinutes: input.utcOffsetMinutes,
            message: log.message,
            data: log.data,
            errorType: log.error?['type'] is String ? log.error!['type'] as String : null,
            errorMessage: log.error?['message'] is String ? log.error!['message'] as String : null,
            stack: log.error?['stack'] is String ? log.error!['stack'] as String : null,
          ),
          t,
          mask: input.mask,
          maskText: true,
          masker: m,
        )
      : <String>[
          ...shareReportLines(
            _withOffset(shareInputForCall(call!), input.utcOffsetMinutes),
            ShareOptions(mask: input.mask, curl: curl),
            t,
            m,
          ),
          // The attached file carries a connection's messages; the share
          // text stays short.
          if (curl) ...streamExportLines(call, m, t, bodies: true),
        ].join('\n').trimRight();
  return <String>['## ${t.bugMdTheMoment}', '', text, ''];
}

ShareInput _withOffset(ShareInput i, int? off) => off == null
    ? i
    : ShareInput(
        method: i.method,
        url: i.url,
        state: i.state,
        startTs: i.startTs,
        source: i.source,
        requestHeaders: i.requestHeaders,
        status: i.status,
        statusText: i.statusText,
        error: i.error,
        utcOffsetMinutes: off,
        durationMs: i.durationMs,
        graphql: i.graphql,
        mocked: i.mocked,
        mockRule: i.mockRule,
        responseHeaders: i.responseHeaders,
        requestContentType: i.requestContentType,
        responseContentType: i.responseContentType,
        requestBody: i.requestBody,
        responseBody: i.responseBody,
        requestBodyMissing: i.requestBodyMissing,
        responseBodyMissing: i.responseBodyMissing,
      );

/// The share text: the note, the facts, the moment, the failed requests one
/// line each and the last [kBugTextLines] log lines; with the attachments'
/// names when files go along.
String buildBugReportText(BugReportInput input, InspectorStrings t) {
  final m = ShareMasker(input.mask);
  final off = input.utcOffsetMinutes;
  final out = <String>[..._head(input, t), ..._moment(input, t, m, curl: false)];
  final c = input.contents;
  final parts = input.parts;

  if (parts.requests) {
    out.addAll(<String>['## ${t.bugFailed(c.totalFailed)}', '']);
    if (c.totalFailed == 0) {
      out.add(t.bugMdNoFailed);
    } else {
      if (c.totalFailed > c.failed.length) out.add(t.bugMdMoreRequests(c.totalFailed - c.failed.length));
      for (final call in c.failed) {
        out.add('- ${bugRequestLine(call, m, t, utcOffsetMinutes: off)}');
      }
    }
    out.add('');
  }

  if (!parts.logs) {
    // Left out by the tester.
  } else if (c.totalLines == 0) {
    out.addAll(<String>['## ${t.bugMdLogLines(c.totalLines)}', '', t.bugMdNoLogs, '']);
  } else {
    out.addAll(<String>['## ${t.bugMdLogLines(c.totalLines)}', '']);
    final shown = c.lines.length > kBugTextLines ? c.lines.sublist(c.lines.length - kBugTextLines) : c.lines;
    if (shown.length < c.totalLines) out.add(t.bugMdLastLines(shown.length, c.totalLines));
    if (input.fileName != null && shown.length < c.totalLines) out.add(t.bugMdAllInFile(input.fileName!));
    if (shown.length < c.totalLines) out.add('');
    fencedBlock(out, '', shown.map((l) => bugLogLine(l, m, utcOffsetMinutes: off)).join('\n'));
  }

  final attachments = <String>[
    if (input.fileName != null) '- ${input.fileName}: ${t.bugMdAttReport}',
    if (input.screenshotName != null) '- ${input.screenshotName}: ${t.bugMdAttScreenshot}',
  ];
  if (attachments.isNotEmpty) out.addAll(<String>['## ${t.bugMdAttachments}', '', ...attachments, '']);
  out.add('_${input.mask ? t.bugMdMasked : t.bugMdRaw}_');
  return '${out.join('\n').replaceAll(RegExp(r'\n{3,}'), '\n\n').trimRight()}\n';
}

/// The attached file, one piece at a time: the same head and moment (with
/// cURL), every line of the window (up to [kBugMaxLines]) with its stack
/// and data, and every failed request in full (bodies included).
Iterable<String> bugReportFile(BugReportInput input, InspectorStrings t) sync* {
  final m = ShareMasker(input.mask);
  final off = input.utcOffsetMinutes;
  final c = input.contents;
  yield '${<String>[..._head(input, t), ..._moment(input, t, m, curl: true)].join('\n')}\n';

  if (input.parts.logs) {
    final lines = <String>['## ${t.bugMdLogLines(c.totalLines)}', ''];
    if (c.totalLines == 0) {
      lines.addAll(<String>[t.bugMdNoLogs, '']);
    } else {
      if (c.lines.length < c.totalLines) lines.addAll(<String>[t.bugMdLinesCut(c.totalLines - c.lines.length), '']);
      fencedBlock(lines, '', c.lines.map((l) => bugLogLine(l, m, utcOffsetMinutes: off, full: true)).join('\n'));
    }
    yield '${lines.join('\n')}\n';
  }

  if (!input.parts.requests) {
    yield '_${input.mask ? t.bugMdMasked : t.bugMdRaw}_\n';
    return;
  }
  final head = <String>['## ${t.bugFailed(c.totalFailed)}', ''];
  if (c.totalFailed == 0) {
    head.addAll(<String>[t.bugMdNoFailed, '']);
  } else {
    if (c.totalFailed > c.failed.length) head.add(t.bugMdMoreRequests(c.totalFailed - c.failed.length));
    for (final call in c.failed) {
      head.add('- ${bugRequestLine(call, m, t, utcOffsetMinutes: off)}');
    }
    head.addAll(<String>['', '## ${t.bugMdFailedInFull}', '']);
  }
  yield '${head.join('\n')}\n';

  final options = ShareOptions(mask: input.mask, curl: false);
  for (var i = 0; i < c.failed.length; i++) {
    final call = c.failed[i];
    final method = (call.method.isEmpty ? 'GET' : call.method).toUpperCase();
    final path = call.uri?.path ?? '';
    final lines = <String>[
      ...shareReportLines(_withOffset(shareInputForCall(call, peek: true), off), options, t, m),
      ...streamExportLines(call, m, t, bodies: true),
    ];
    yield '### ${i + 1}. $method ${path.isEmpty ? '/' : path}\n\n${lines.join('\n').trimRight()}\n\n';
  }
  yield '_${input.mask ? t.bugMdMasked : t.bugMdRaw}_\n';
}
