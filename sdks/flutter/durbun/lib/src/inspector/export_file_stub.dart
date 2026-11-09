/// Without dart:io (web) nothing is written: the export falls back to the
/// clipboard.
library;

bool get canWriteFiles => false;

Future<String> inspectorCacheDir() async => '';

Future<String?> writeExportFile(String name, Iterable<String> chunks, {String? baseDir, DateTime? now}) async => null;
