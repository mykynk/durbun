// Keeps the plugin's copies of the native cores in sync with the originals.
//
// The cores live in sdks/ios/Sources/Durbun and sdks/android/durbun (native-only apps use them
// there). pub.dev publishes only this package folder, and CocoaPods, Swift Package Manager and
// Gradle only build files inside the plugin, so the plugin carries exact copies:
//   - iOS:     ios/durbun/Sources/durbun/Core   (the .swift files)
//   - Android: android/src/core/{kotlin,java}   (the .kt / .java files, see android/build.gradle)
//              android/core-rules.pro           (the core's consumer R8 rules)
//
//   cd sdks/flutter/durbun
//   dart run tool/sync_native.dart          # copy (adds, updates, removes files)
//   dart run tool/sync_native.dart --check  # exit code 1 when a copy drifted
//
// test/native_sync_test.dart runs the check, so a forgotten sync fails the unit tests.
import 'dart:io';

/// Original iOS core, relative to the package root (sdks/flutter/durbun).
const String kIosCoreSource = '../../ios/Sources/Durbun';

/// The plugin's iOS copy, relative to the package root.
const String kIosCoreCopy = 'ios/durbun/Sources/durbun/Core';

/// Original Android core sources (`kotlin/`, `java/`), relative to the package root.
const String kAndroidCoreSource = '../../android/durbun/src/main';

/// The plugin's Android copy, compiled by android/build.gradle.
const String kAndroidCoreCopy = 'android/src/core';

/// Original Android consumer rules and the plugin's copy.
const String kAndroidRulesSource = '../../android/durbun/consumer-rules.pro';
const String kAndroidRulesCopy = 'android/core-rules.pro';

/// One original folder (or file) and the plugin's copy of it.
class NativeMirror {
  const NativeMirror(this.label, this.source, this.copy, {this.extensions = const <String>[]});

  /// Prefix of the drift lines, e.g. `iOS`.
  final String label;

  /// Relative to the package root: a folder (files ending in [extensions]) or a single file.
  final String source;
  final String copy;

  /// File endings copied from a folder; empty for a single-file mirror.
  final List<String> extensions;

  bool get isFile => extensions.isEmpty;
}

const List<NativeMirror> kNativeMirrors = <NativeMirror>[
  NativeMirror('iOS', kIosCoreSource, kIosCoreCopy, extensions: <String>['.swift']),
  NativeMirror('Android', kAndroidCoreSource, kAndroidCoreCopy, extensions: <String>['.kt', '.java']),
  NativeMirror('Android rules', kAndroidRulesSource, kAndroidRulesCopy),
];

/// Differences between the originals and the copies as readable lines (empty = in sync).
List<String> nativeSyncDifferences(String packageRoot, {List<NativeMirror> mirrors = kNativeMirrors}) {
  final problems = <String>[];
  for (final mirror in mirrors) {
    final wanted = _originals(packageRoot, mirror);
    if (wanted == null) {
      problems.add('${mirror.label}: original not found at ${mirror.source}');
      continue;
    }
    final present = _copies(packageRoot, mirror);
    for (final entry in wanted.entries) {
      final other = present[entry.key];
      if (other == null) {
        problems.add('${mirror.label}: missing in the plugin: ${entry.key}');
      } else if (!_sameBytes(entry.value, other)) {
        problems.add('${mirror.label}: differs: ${entry.key}');
      }
    }
    for (final name in present.keys) {
      if (!wanted.containsKey(name)) problems.add('${mirror.label}: not in the original: $name');
    }
  }
  problems.sort();
  return problems;
}

/// Copies the originals over the copies. Returns the number of files written or removed.
int syncNative(String packageRoot, {List<NativeMirror> mirrors = kNativeMirrors}) {
  var changes = 0;
  for (final mirror in mirrors) {
    final wanted = _originals(packageRoot, mirror);
    if (wanted == null) {
      throw StateError('${mirror.label}: original not found at ${mirror.source}');
    }
    final present = _copies(packageRoot, mirror);
    final copyRoot = _join(packageRoot, mirror.copy);
    for (final entry in wanted.entries) {
      final existing = present[entry.key];
      if (existing != null && _sameBytes(entry.value, existing)) continue;
      final target = File(mirror.isFile ? copyRoot : _join(copyRoot, entry.key));
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
    final copy = Directory(copyRoot);
    if (!mirror.isFile && copy.existsSync()) {
      final dirs = copy.listSync(recursive: true).whereType<Directory>().toList()
        ..sort((a, b) => b.path.length.compareTo(a.path.length));
      for (final dir in dirs) {
        if (dir.listSync().isEmpty) dir.deleteSync();
      }
    }
  }
  return changes;
}

/// The original's files by relative path; null when the original is missing.
Map<String, File>? _originals(String packageRoot, NativeMirror mirror) {
  final path = _join(packageRoot, mirror.source);
  if (mirror.isFile) {
    final file = File(path);
    return file.existsSync() ? <String, File>{_baseName(mirror.source): file} : null;
  }
  final dir = Directory(path);
  return dir.existsSync() ? _files(dir, mirror.extensions) : null;
}

Map<String, File> _copies(String packageRoot, NativeMirror mirror) {
  final path = _join(packageRoot, mirror.copy);
  if (mirror.isFile) {
    final file = File(path);
    // Keyed by the original's name, so a present copy pairs with it.
    return file.existsSync() ? <String, File>{_baseName(mirror.source): file} : <String, File>{};
  }
  final dir = Directory(path);
  return dir.existsSync() ? _files(dir, mirror.extensions) : <String, File>{};
}

Map<String, File> _files(Directory root, List<String> extensions) {
  final files = <String, File>{};
  for (final entity in root.listSync(recursive: true, followLinks: false)) {
    if (entity is! File || !extensions.any(entity.path.endsWith)) continue;
    final relative = entity.path
        .substring(root.path.length)
        .replaceAll(Platform.pathSeparator, '/')
        .replaceFirst(RegExp('^/+'), '');
    files[relative] = entity;
  }
  return files;
}

String _baseName(String path) => path.split('/').last;

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
      stdout.writeln('Native core copies are in sync with sdks/ios and sdks/android.');
      return;
    }
    stderr.writeln('Native core copies drifted:');
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
        ? 'Native core copies already in sync.'
        : 'Native core copies updated ($changes file(s)) from sdks/ios and sdks/android.',
  );
}
