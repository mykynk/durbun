import 'run_log.dart';
import 'store.dart';

/// No files without dart:io: no previous run.
RunJournal? startRunJournal(
  DurbunInspectorStore store, {
  String? baseDir,
  int maxBytes = kRunMaxFileBytes,
  Duration interval = const Duration(seconds: 1),
}) =>
    null;
