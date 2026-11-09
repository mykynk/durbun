import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/services.dart';

const MethodChannel _native = MethodChannel('dev.durbun/native');

/// Exports go in this folder of the cache directory; on Android the
/// plugin's content provider serves only it.
const String kExportFolder = 'durbun-export';

/// Exports older than this are deleted when the next one is written.
const Duration kExportMaxAge = Duration(days: 1);

bool get canWriteFiles => true;

Future<String>? _cacheDir;

/// The app's cache directory as the plugin reports it (Android
/// `Context.getCacheDir()`, iOS `Library/Caches`), else the system temp
/// directory (no plugin: tests, desktop). Asked once.
Future<String> inspectorCacheDir() => _cacheDir ??= _askCacheDir();

Future<String> _askCacheDir() async {
  try {
    final dir = await _native.invokeMethod<String>('cacheDir');
    if (dir != null && dir.isNotEmpty) return dir;
  } catch (_) {
    // An older plugin build, or none.
  }
  try {
    return Directory.systemTemp.path;
  } catch (_) {
    return '';
  }
}

@visibleForTesting
void debugResetCacheDir() => _cacheDir = null;

/// Writes [chunks] to `<cache>/durbun-export/<name>` and returns its path,
/// or null when it could not be written (a partial file is deleted).
/// Exports older than a day go first. The chunks are generated while they
/// are written, yielding to the frame loop every few milliseconds, so the
/// panel keeps drawing during a large export.
Future<String?> writeExportFile(String name, Iterable<String> chunks, {String? baseDir, DateTime? now}) async {
  IOSink? sink;
  File? file;
  try {
    final base = baseDir ?? await inspectorCacheDir();
    if (base.isEmpty) return null;
    final dir = Directory('$base${Platform.pathSeparator}$kExportFolder');
    await dir.create(recursive: true);
    await pruneExports(dir, now: now);
    file = File('${dir.path}${Platform.pathSeparator}$name');
    final out = file.openWrite();
    sink = out;
    final slice = Stopwatch()..start();
    for (final chunk in chunks) {
      out.write(chunk);
      if (slice.elapsedMilliseconds >= 8) {
        // Lets the disk catch up (the buffer stays small) and a frame draw.
        await out.flush();
        await Future<void>.delayed(Duration.zero);
        slice.reset();
      }
    }
    await out.flush();
    await out.close();
    return file.path;
  } catch (_) {
    try {
      await sink?.close();
    } catch (_) {}
    try {
      await file?.delete();
    } catch (_) {}
    return null;
  }
}

/// Deletes the files in [dir] last written more than [maxAge] before [now].
Future<void> pruneExports(Directory dir, {DateTime? now, Duration maxAge = kExportMaxAge}) async {
  final limit = (now ?? DateTime.now()).subtract(maxAge);
  try {
    await for (final entry in dir.list(followLinks: false)) {
      if (entry is! File) continue;
      try {
        if ((await entry.lastModified()).isBefore(limit)) await entry.delete();
      } catch (_) {
        // Gone already, or not ours to delete.
      }
    }
  } catch (_) {}
}
