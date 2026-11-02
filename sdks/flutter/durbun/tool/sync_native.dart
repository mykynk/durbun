// Keeps the plugin's copy of the native iOS core in sync with the original.
//
// The iOS core lives in sdks/ios/Sources/Durbun (native-only apps use it as a Swift package).
// CocoaPods and Swift Package Manager only compile files inside the plugin folder, so the plugin
// carries an exact copy in ios/durbun/Sources/durbun/Core. Android needs no copy: Gradle compiles
// sdks/android/durbun/src/main straight from there (see android/build.gradle).
//
//   cd sdks/flutter/durbun
//   dart run tool/sync_native.dart          # copy (adds, updates, removes files)
//   dart run tool/sync_native.dart --check  # exit code 1 when the copy drifted
//
// test/native_sync_test.dart runs the check, so a forgotten sync fails the unit tests.
import 'dart:io';

/// Original iOS core, relative to the package root (sdks/flutter/durbun).
const String kIosCoreSource = '../../ios/Sources/Durbun';

/// The plugin's copy, relative to the package root.
const String kIosCoreCopy = 'ios/durbun/Sources/durbun/Core';

/// Android core compiled through Gradle sourceSets (no copy), relative to the package root.
const String kAndroidCoreSource = '../../android/durbun/src/main';

/// Differences between the original and the copy as readable lines (empty = in sync).
List<String> nativeSyncDifferences(String packageRoot) {
  final source = Directory(_join(packageRoot, kIosCoreSource));
  final copy = Directory(_join(packageRoot, kIosCoreCopy));
  if (!source.existsSync()) {
    return <String>['original iOS core not found at ${source.path}'];
  }
  final wanted = _swiftFiles(source);
  final present = copy.existsSync() ? _swiftFiles(copy) : <String, File>{};
  final problems = <String>[];
  for (final entry in wanted.entries) {
    final other = present[entry.key];
    if (other == null) {
      problems.add('missing in the plugin: ${entry.key}');
    } else if (!_sameBytes(entry.value, other)) {
      problems.add('differs: ${entry.key}');
    }
  }
  for (final name in present.keys) {
    if (!wanted.containsKey(name)) problems.add('not in the original: $name');
  }
  problems.sort();
  return problems;
}

/// Copies the original over the copy. Returns the number of files written or removed.
int syncNative(String packageRoot) {
  final source = Directory(_join(packageRoot, kIosCoreSource));
  final copy = Directory(_join(packageRoot, kIosCoreCopy));
  if (!source.existsSync()) {
    throw StateError('original iOS core not found at ${source.path}');
  }
  final wanted = _swiftFiles(source);
  final present = copy.existsSync() ? _swiftFiles(copy) : <String, File>{};
  var changes = 0;
  for (final entry in wanted.entries) {
    final target = File(_join(copy.path, entry.key));
    final existing = present[entry.key];
    if (existing != null && _sameBytes(entry.value, existing)) continue;
    target.parent.createSync(recursive: true);
    target.writeAsBytesSync(entry.value.readAsBytesSync(), flush: true);
    changes++;
  }
  for (final entry in present.entries) {
    if (wanted.containsKey(entry.key)) continue;
    entry.value.deleteSync();
    changes++;
  }
  // Drop directories that became empty.
  if (copy.existsSync()) {
    final dirs = copy.listSync(recursive: true).whereType<Directory>().toList()
      ..sort((a, b) => b.path.length.compareTo(a.path.length));
    for (final dir in dirs) {
      if (dir.listSync().isEmpty) dir.deleteSync();
    }
  }
  return changes;
}

Map<String, File> _swiftFiles(Directory root) {
  final files = <String, File>{};
  for (final entity in root.listSync(recursive: true, followLinks: false)) {
    if (entity is! File || !entity.path.endsWith('.swift')) continue;
    final relative = entity.path
        .substring(root.path.length)
        .replaceAll(Platform.pathSeparator, '/')
        .replaceFirst(RegExp('^/+'), '');
    files[relative] = entity;
  }
  return files;
}

bool _sameBytes(File a, File b) {
  final x = a.readAsBytesSync();
  final y = b.readAsBytesSync();
  if (x.length != y.length) return false;
  for (var i = 0; i < x.length; i++) {
    if (x[i] != y[i]) return false;
  }
  return true;
}

String _join(String a, String b) =>
    a.endsWith(Platform.pathSeparator) ? '$a$b' : '$a${Platform.pathSeparator}$b';

String _packageRoot() {
  // tool/sync_native.dart → package root.
  final script = File.fromUri(Platform.script);
  return script.parent.parent.path;
}

void main(List<String> args) {
  final root = _packageRoot();
  if (args.contains('--check')) {
    final problems = nativeSyncDifferences(root);
    if (problems.isEmpty) {
      stdout.writeln('iOS core copy is in sync with $kIosCoreSource.');
      return;
    }
    stderr.writeln('iOS core copy drifted from $kIosCoreSource:');
    for (final p in problems) {
      stderr.writeln('  $p');
    }
    stderr.writeln('Run: dart run tool/sync_native.dart');
    exitCode = 1;
    return;
  }
  final changes = syncNative(root);
  stdout.writeln(
    changes == 0
        ? 'iOS core copy already in sync.'
        : 'iOS core copy updated ($changes file(s)) from $kIosCoreSource.',
  );
}
