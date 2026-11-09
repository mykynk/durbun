/// The previous run (`DurbunInspector(keepPreviousRun: true)`): this run's
/// requests, logs and crashes are appended as JSON lines to a file in the
/// app's cache directory (`run_file_io.dart`), so the next launch shows
/// them read-only (tools → Previous run). The point is the crash that ended
/// a run: a crash is written at once, everything else at most once a
/// second. Must not import dart:io (the web build compiles it too).
///
/// Requests are masked like a session export (headers, URL credentials,
/// query, form and JSON values); each body keeps its first 16 KB. Records:
///
/// - `{"t":"run","v":1,"start":<ms>}` first in every file;
/// - `{"t":"hello","app":{…},"device":{…}}` when the app's hello changes;
/// - `{"t":"log",…}` per log line, event or crash;
/// - `{"t":"call",…}` when a request is first seen and when it ends. Read
///   back, the last record of a request wins and keeps the fields only an
///   earlier one had.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'share_report.dart' show ShareMasker, isSecretName, kShareMask;
import 'store.dart';

const int kRunLogVersion = 1;

/// Bytes of each body kept.
const int kRunBodyBytes = 16 * 1024;

/// Characters of a log message, its data and its stack kept.
const int kRunTextChars = 16 * 1024;

/// The log file is rotated at this size; the run keeps the current file and
/// the one before it.
const int kRunMaxFileBytes = 4 * 1024 * 1024;

/// The saved previous run, known without reading it.
class PreviousRunInfo {
  const PreviousRunInfo({required this.savedAt, required this.bytes});

  /// When its log was last written (about when it ended).
  final DateTime savedAt;
  final int bytes;
}

/// A store's previous-run log ([of]); the IO backend writes it, tests fake it.
abstract class RunJournal {
  static final Expando<RunJournal> _journals = Expando<RunJournal>('durbun.run');

  /// The log [DurbunInspector] started for [store], if any.
  static RunJournal? of(DurbunInspectorStore store) => _journals[store];

  /// Ties [journal] to [store] (the backend, tests).
  static void register(DurbunInspectorStore store, RunJournal? journal) => _journals[store] = journal;

  /// The run before this one, once it is known to exist; null: none (or
  /// not known yet).
  ValueListenable<PreviousRunInfo?> get previous;

  /// Epoch ms when this run's log started.
  double get startedAtMs;

  /// False: nothing more is written (`keepPreviousRun` turned off).
  bool get recording;
  set recording(bool value);

  /// Writes what is waiting now (the app goes to the background).
  void flushNow();

  /// The previous run's records, a damaged line skipped; null when there
  /// is none or it cannot be read.
  Future<List<Map<String, Object?>>?> readPrevious();
}

String _encode(Map<String, Object?> record) => jsonEncode(record, toEncodable: (Object? o) => '$o');

String _cap(String s, [int max = kRunTextChars]) => s.length <= max ? s : s.substring(0, max);

/// A log's data as it is kept: as it is when its JSON is short, else its
/// JSON cut to a string.
Object? _capData(Object? data) {
  if (data == null) return null;
  try {
    final json = jsonEncode(data);
    return json.length <= kRunTextChars ? data : '${json.substring(0, kRunTextChars)}…';
  } catch (_) {
    return _cap('$data');
  }
}

Map<String, Object?> runLogRecord(InspectorLog l) {
  final e = l.error;
  return <String, Object?>{
    't': 'log',
    'seq': l.seq,
    'ts': l.ts,
    'level': l.level,
    'msg': _cap(l.message),
    if (l.tag != null) 'tag': l.tag,
    if (l.kind != null) 'kind': l.kind,
    if (l.isEvent) 'event': true,
    if (l.native) 'native': true,
    if (l.data != null) 'data': _capData(l.data),
    if (e != null)
      'error': <String, Object?>{
        for (final k in const <String>['type', 'message', 'stack'])
          if (e[k] is String) k: _cap(e[k]! as String),
      },
  };
}

/// A secret JSON value left open at the end of a cut body (`"token":"abc`).
final RegExp _openPair = RegExp(r'"((?:[^"\\]|\\.)*)"\s*:\s*"(?:[^"\\]|\\.)*$');

/// [b]'s record: its text masked (a cut JSON body too, up to its open last
/// value), its size and whether it was cut.
Map<String, Object?> _bodyRecord(InspectorBody b, String? contentType, ShareMasker m) {
  var data = b.data;
  if (b.isText && m.on) {
    final ct = contentType ?? '';
    final start = data.trimLeft();
    // A cut JSON body no longer ends with } or ].
    final json = ct.toLowerCase().contains('json') || start.startsWith('{') || start.startsWith('[');
    data = m.body(data, ct, json);
    if (json && b.truncated) {
      final open = _openPair.firstMatch(data);
      if (open != null && isSecretName(open.group(1)!)) data = '${data.substring(0, open.start)}"${open.group(1)}": "$kShareMask';
    }
  }
  return <String, Object?>{
    'encoding': b.encoding,
    'data': data,
    'size': b.size,
    if (b.truncated) 'truncated': true,
  };
}

/// [c]'s record, masked by [m]; a request that ended carries the start of
/// its bodies.
Map<String, Object?> runCallRecord(InspectorCall c, ShareMasker m) {
  final ended = c.state != InspectorCallState.pending;
  final request = ended ? c.peekRequestStart(kRunBodyBytes) : null;
  final response = ended ? c.peekResponseStart(kRunBodyBytes) : null;
  return <String, Object?>{
    't': 'call',
    'seq': c.seq,
    'id': c.id,
    if (c.native) 'native': true,
    'ts': c.ts,
    'method': c.method,
    'url': m.url(c.url),
    'source': c.source,
    'reqH': m.headers(c.requestHeaders),
    if (request != null) 'reqBody': _bodyRecord(request, c.requestContentType, m),
    if (c.status != null) 'status': c.status,
    if (c.statusText != null) 'statusText': c.statusText,
    if (c.responseHeaders.isNotEmpty) 'resH': m.headers(c.responseHeaders),
    if (response != null) 'resBody': _bodyRecord(response, c.responseContentType, m),
    if (c.endTs != null) 'end': c.endTs,
    if (c.error != null) 'error': _cap(c.error!),
    if (c.cancelled) 'cancelled': true,
    if (c.mocked) 'mocked': true,
    if (c.mockRuleId != null) 'mockRule': c.mockRuleId,
    if (c.protocol != null) 'protocol': c.protocol,
    if (c.remoteAddress != null) 'remote': c.remoteAddress,
    if (c.timings != null) 'timings': c.timings,
  };
}

/// Follows a store and hands its new records to [onLines]: crash lines at
/// once, the rest batched at most once per [interval]. Bodies are read a
/// few milliseconds' worth per batch; what is left waits for the next one.
/// Never throws into the app.
class RunRecorder {
  RunRecorder(this.store, this.onLines, {this.interval = const Duration(seconds: 1), double? startedAtMs})
      : startedAtMs = startedAtMs ?? DateTime.now().microsecondsSinceEpoch / 1000;

  final DurbunInspectorStore store;
  final void Function(List<String> lines) onLines;
  final Duration interval;
  final double startedAtMs;

  /// False: changes are not written.
  bool recording = true;

  final ShareMasker _masker = ShareMasker(true);
  final Expando<String> _written = Expando<String>('durbun.run.written');
  int _logSeq = -1;
  int _errors = 0;
  String? _hello;
  Timer? _timer;
  bool _started = false;
  bool _stopped = false;

  /// The first line of every file.
  String get headerLine => _encode(<String, Object?>{'t': 'run', 'v': kRunLogVersion, 'start': startedAtMs});

  void start() {
    if (_started) return;
    _started = true;
    _errors = store.errorCount;
    _send(<String>[headerLine]);
    store.addListener(_changed);
    _changed();
  }

  void stop() {
    _stopped = true;
    store.removeListener(_changed);
    _timer?.cancel();
    _timer = null;
  }

  void _changed() {
    if (_stopped || !recording) return;
    try {
      final errors = store.errorCount;
      if (errors != _errors) {
        _errors = errors;
        if (_crashArrived()) return flushNow();
      }
    } catch (_) {}
    _timer ??= Timer(interval, () {
      _timer = null;
      _flush();
    });
  }

  /// A crash or fatal line arrived since the last batch.
  bool _crashArrived() {
    final logs = store.logs;
    for (var i = logs.length - 1; i >= 0 && logs[i].seq > _logSeq; i--) {
      if (logs[i].isCrash || logs[i].level == 'fatal') return true;
    }
    return false;
  }

  /// Writes what is waiting now.
  void flushNow() {
    _timer?.cancel();
    _timer = null;
    _flush();
  }

  void _flush() {
    if (_stopped || !recording) return;
    final lines = <String>[];
    var more = false;
    try {
      more = _collect(lines);
    } catch (_) {
      // A record that cannot be built is left out.
    }
    _send(lines);
    if (more) {
      _timer ??= Timer(interval, () {
        _timer = null;
        _flush();
      });
    }
  }

  void _send(List<String> lines) {
    if (lines.isEmpty) return;
    try {
      onLines(lines);
    } catch (_) {}
  }

  /// Adds the new records to [out]; true when requests were left for the
  /// next batch (time budget).
  bool _collect(List<String> out) {
    final hello = store.hello;
    if (hello != null) {
      final line = _encode(<String, Object?>{'t': 'hello', 'app': hello['app'], 'device': hello['device']});
      if (line != _hello) {
        _hello = line;
        out.add(line);
      }
    }
    for (final l in store.logs) {
      if (l.seq <= _logSeq) continue;
      out.add(_encode(runLogRecord(l)));
      _logSeq = l.seq;
    }
    final budget = Stopwatch()..start();
    var wrote = 0;
    for (final c in store.calls) {
      // What a record says changes with these; a body dropped later does not
      // write the request again without it.
      final sig = '${c.state.index}|${c.status}|${c.endTs}|${c.error}|${c.mocked}';
      if (_written[c] == sig) continue;
      if (wrote > 0 && budget.elapsedMilliseconds >= 8) return true;
      out.add(_encode(runCallRecord(c, _masker)));
      _written[c] = sig;
      wrote++;
    }
    return false;
  }
}

/* ───────────────────────────── reading ───────────────────────────── */

/// Decodes log lines; a line that is not a whole JSON object (the last one
/// when the process ended mid-write) is skipped.
List<Map<String, Object?>> decodeRunLines(Iterable<String> lines) {
  final out = <Map<String, Object?>>[];
  for (final line in lines) {
    if (line.trim().isEmpty) continue;
    try {
      final v = jsonDecode(line);
      if (v is Map<String, Object?>) out.add(v);
    } catch (_) {}
  }
  return out;
}

/// A saved run rebuilt as a read-only store.
class PreviousRun {
  PreviousRun(this.store, {this.startedAtMs});

  final DurbunInspectorStore store;

  /// Epoch ms when it started, if its header survived.
  final double? startedAtMs;

  /// Its crash lines, oldest first.
  List<InspectorLog> get crashes => <InspectorLog>[for (final l in store.logs) if (l.isCrash) l];
}

double? _num(Object? v) => v is num ? v.toDouble() : null;

Map<String, Object?> _logMessage(Map<String, Object?> r) => r['event'] == true
    ? <String, Object?>{'type': 'event', 'ts': r['ts'], 'name': r['msg'], 'props': r['data']}
    : <String, Object?>{
        'type': 'log',
        'ts': r['ts'],
        'level': r['level'],
        'message': r['msg'],
        'tag': r['tag'],
        'data': r['data'],
        'error': r['error'],
        'kind': r['kind'],
      };

void _restoreCall(DurbunInspectorStore store, Map<String, Object?> r) {
  final native = r['native'] == true;
  final id = r['id'];
  store.restore(<String, Object?>{
    'type': 'net.request',
    'id': id,
    'ts': r['ts'],
    'method': r['method'],
    'url': r['url'],
    'headers': r['reqH'],
    'source': r['source'],
    'body': r['reqBody'],
  }, native: native);
  if (r['status'] != null) {
    store.restore(<String, Object?>{
      'type': 'net.response',
      'id': id,
      'ts': r['end'],
      'status': r['status'],
      'statusText': r['statusText'],
      'headers': r['resH'],
      'protocol': r['protocol'],
      'remoteAddress': r['remote'],
      'timings': r['timings'],
      'mocked': r['mocked'],
      'mockRuleId': r['mockRule'],
      'body': r['resBody'],
    }, native: native);
  }
  if (r['error'] != null) {
    store.restore(<String, Object?>{
      'type': 'net.error',
      'id': id,
      'ts': r['end'],
      'error': r['error'],
      'cancelled': r['cancelled'],
      'mocked': r['mocked'],
      'mockRuleId': r['mockRule'],
    }, native: native);
  }
}

/// Rebuilds the run in [records] as a read-only store listing
/// [defaultHosts] like the live one. [lateCrashes] (crashes of that run
/// the native layer reported only on this launch) are added at its end.
/// Yields to the frame loop every few milliseconds.
Future<PreviousRun> restoreRun(
  List<Map<String, Object?>> records, {
  List<String> defaultHosts = const <String>[],
  List<InspectorLog> lateCrashes = const <InspectorLog>[],
}) async {
  final store = DurbunInspectorStore(
    maxLogs: 1 << 20,
    maxCalls: 1 << 20,
    maxBodyBytes: 1 << 30,
    notifyDelay: Duration.zero,
  )
    ..readOnly = true
    ..defaultHosts = defaultHosts;
  double? start;
  Map<String, Object?>? hello;
  final entries = <Map<String, Object?>>[];
  final calls = <String, Map<String, Object?>>{};
  for (final r in records) {
    switch (r['t']) {
      case 'run':
        start ??= _num(r['start']);
      case 'hello':
        hello = r;
      case 'log':
        entries.add(r);
      case 'call':
        final key = '${r['native'] == true ? 'n' : 'd'}:${r['id']}';
        final earlier = calls[key];
        if (earlier == null) entries.add(r);
        calls[key] = <String, Object?>{...?earlier, ...r};
    }
  }
  if (hello != null) store.restore(<String, Object?>{'type': 'hello', 'app': hello['app'], 'device': hello['device']}, native: false);
  entries.sort((a, b) => (_num(a['seq']) ?? 0).compareTo(_num(b['seq']) ?? 0));
  final slice = Stopwatch()..start();
  for (final r in entries) {
    if (r['t'] == 'log') {
      store.restore(_logMessage(r), native: r['native'] == true);
    } else {
      final merged = calls['${r['native'] == true ? 'n' : 'd'}:${r['id']}'];
      if (merged != null) _restoreCall(store, merged);
    }
    if (slice.elapsedMilliseconds >= 8) {
      await Future<void>.delayed(Duration.zero);
      slice.reset();
    }
  }
  for (final l in lateCrashes) {
    store.restore(_logMessage(runLogRecord(l)), native: l.native);
  }
  return PreviousRun(store, startedAtMs: start);
}

/// Crashes in [current] that belong to the run before it: the native layer
/// reports a crash that killed the app on the next launch, with the time it
/// happened (before [currentStartMs], after [previousStartMs]).
List<InspectorLog> lateCrashesOf(DurbunInspectorStore current, {required double currentStartMs, double? previousStartMs}) =>
    <InspectorLog>[
      for (final l in current.logs)
        if (l.isCrash && l.ts < currentStartMs && (previousStartMs == null || l.ts >= previousStartMs)) l,
    ];
