import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart';

import 'export_file_io.dart' show inspectorCacheDir;
import 'run_log.dart';
import 'store.dart';

/// The run logs live in this folder of the app's cache directory.
const String kRunFolder = 'durbun-run';

/// Starts the previous-run log of [store] (once per store, for the life of
/// the app: a panel rebuilt or reopened keeps writing the same run). This
/// run's files from the last launch become the previous run first. Returns
/// at once; the files are opened in the background.
RunJournal? startRunJournal(
  DurbunInspectorStore store, {
  String? baseDir,
  int maxBytes = kRunMaxFileBytes,
  Duration interval = const Duration(seconds: 1),
}) {
  final existing = RunJournal.of(store);
  if (existing != null) return existing;
  final journal = FileRunJournal(store, baseDir: baseDir, maxBytes: maxBytes, interval: interval);
  RunJournal.register(store, journal);
  journal.start();
  return journal;
}

/// The run log in `<cache>/durbun-run`: `run.jsonl` (and `run.1.jsonl`,
/// the part before the last rotation) for this run, `previous.jsonl` /
/// `previous.1.jsonl` for the one before. IO errors stop the log quietly.
class FileRunJournal extends RunJournal {
  FileRunJournal(DurbunInspectorStore store, {this.baseDir, this.maxBytes = kRunMaxFileBytes, Duration interval = const Duration(seconds: 1)}) {
    _recorder = RunRecorder(store, _enqueue, interval: interval);
  }

  final String? baseDir;

  /// The current file is rotated past this size.
  final int maxBytes;

  late final RunRecorder _recorder;
  final ValueNotifier<PreviousRunInfo?> _previous = ValueNotifier<PreviousRunInfo?>(null);
  final Completer<void> _opened = Completer<void>();
  final List<String> _queue = <String>[];

  /// Lines kept while the file is not open yet (or the disk is slow).
  static const int _maxQueued = 20000;

  Future<void>? _writing;
  IOSink? _sink;
  int _size = 0;
  String? _dir;
  bool _ready = false;
  bool _failed = false;

  @override
  ValueListenable<PreviousRunInfo?> get previous => _previous;

  @override
  double get startedAtMs => _recorder.startedAtMs;

  @override
  bool get recording => _recorder.recording;

  @override
  set recording(bool value) => _recorder.recording = value;

  /// Done once the files are open (or failed to).
  @visibleForTesting
  Future<void> get opened => _opened.future;

  /// Done once what is queued now is on disk.
  @visibleForTesting
  Future<void> settle() async {
    await opened;
    while (_writing != null) {
      await _writing;
    }
  }

  void start() {
    _recorder.start();
    unawaited(_open());
  }

  @override
  void flushNow() => _recorder.flushNow();

  String _path(String name) => '$_dir${Platform.pathSeparator}$name';

  Future<void> _open() async {
    try {
      final base = baseDir ?? await inspectorCacheDir();
      if (base.isEmpty) throw const FileSystemException('no cache directory');
      final dir = Directory('$base${Platform.pathSeparator}$kRunFolder');
      await dir.create(recursive: true);
      _dir = dir.path;
      // The last launch's files become the previous run's.
      await _delete(_path('previous.jsonl'));
      await _delete(_path('previous.1.jsonl'));
      await _rename(_path('run.jsonl'), _path('previous.jsonl'));
      await _rename(_path('run.1.jsonl'), _path('previous.1.jsonl'));
      _previous.value = await _previousInfo();
      _sink = File(_path('run.jsonl')).openWrite();
      _ready = true;
    } catch (_) {
      _failed = true;
      _queue.clear();
    } finally {
      _opened.complete();
    }
    _drain();
  }

  Future<PreviousRunInfo?> _previousInfo() async {
    var bytes = 0;
    DateTime? saved;
    for (final name in const <String>['previous.1.jsonl', 'previous.jsonl']) {
      try {
        final stat = await File(_path(name)).stat();
        if (stat.type != FileSystemEntityType.file || stat.size == 0) continue;
        bytes += stat.size;
        if (saved == null || stat.modified.isAfter(saved)) saved = stat.modified;
      } catch (_) {}
    }
    return saved == null ? null : PreviousRunInfo(savedAt: saved, bytes: bytes);
  }

  void _enqueue(List<String> lines) {
    if (_failed) return;
    _queue.addAll(lines);
    if (_queue.length > _maxQueued) _queue.removeRange(0, _queue.length - _maxQueued);
    _drain();
  }

  void _drain() {
    if (!_ready || _failed || _writing != null || _queue.isEmpty) return;
    _writing = _write().whenComplete(() {
      _writing = null;
      _drain();
    });
  }

  Future<void> _write() async {
    final lines = List<String>.of(_queue);
    _queue.clear();
    try {
      final bytes = utf8.encode('${lines.join('\n')}\n');
      if (_size > 0 && _size + bytes.length > maxBytes) await _rotate();
      _sink!.add(bytes);
      _size += bytes.length;
      await _sink!.flush();
    } catch (_) {
      // A full disk, a deleted folder: the log stops, the app goes on.
      _failed = true;
      _queue.clear();
      try {
        await _sink?.close();
      } catch (_) {}
      _sink = null;
    }
  }

  /// `run.jsonl` becomes `run.1.jsonl` (the older part is dropped) and a
  /// new `run.jsonl` starts with the run's header.
  Future<void> _rotate() async {
    await _sink?.close();
    await _delete(_path('run.1.jsonl'));
    await _rename(_path('run.jsonl'), _path('run.1.jsonl'));
    _sink = File(_path('run.jsonl')).openWrite();
    final header = utf8.encode('${_recorder.headerLine}\n');
    _sink!.add(header);
    _size = header.length;
  }

  @override
  Future<List<Map<String, Object?>>?> readPrevious() async {
    await opened;
    if (_dir == null || _previous.value == null) return null;
    final paths = <String>[_path('previous.1.jsonl'), _path('previous.jsonl')];
    try {
      return await _readInBackground(paths);
    } catch (_) {
      // No second isolate: read here.
      try {
        return _readRecords(paths);
      } catch (_) {
        return null;
      }
    }
  }

  static Future<void> _delete(String path) async {
    try {
      await File(path).delete();
    } on FileSystemException {
      // Not there.
    }
  }

  static Future<void> _rename(String from, String to) async {
    try {
      await File(from).rename(to);
    } on FileSystemException {
      // Not there.
    }
  }
}

/// Reads and decodes the log files off the UI isolate (megabytes of JSON).
Future<List<Map<String, Object?>>> _readInBackground(List<String> paths) => Isolate.run(() => _readRecords(paths));

List<Map<String, Object?>> _readRecords(List<String> paths) {
  final out = <Map<String, Object?>>[];
  for (final path in paths) {
    final file = File(path);
    if (!file.existsSync()) continue;
    // A line cut mid-character by the process ending decodes leniently.
    final text = utf8.decode(file.readAsBytesSync(), allowMalformed: true);
    out.addAll(decodeRunLines(const LineSplitter().convert(text)));
  }
  return out;
}
