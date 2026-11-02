// The plugin carries the native cores without hand-made copies: Android
// compiles sdks/android/durbun/src/main through Gradle sourceSets, iOS keeps
// an exact copy (CocoaPods / SwiftPM cannot reach outside the plugin) that
// tool/sync_native.dart refreshes. These tests fail when that copy drifts or a
// referenced path moves.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/sync_native.dart';

void main() {
  final root = Directory.current.path;

  test('the iOS core copy matches sdks/ios/Sources/Durbun', () {
    final problems = nativeSyncDifferences(root);
    expect(
      problems,
      isEmpty,
      reason: 'Run `dart run tool/sync_native.dart` in sdks/flutter/durbun.',
    );
  });

  test('the Android core that Gradle compiles is where build.gradle says', () {
    final gradle = File('$root/android/build.gradle').readAsStringSync();
    expect(gradle, contains('file("../../../android/durbun")'));
    for (final path in <String>[
      '$kAndroidCoreSource/kotlin/dev/durbun/Durbun.kt',
      '$kAndroidCoreSource/kotlin/dev/durbun/DurbunInterceptor.kt',
      '$kAndroidCoreSource/kotlin/dev/durbun/internal/HostLink.kt',
      '$kAndroidCoreSource/java/dev/durbun/internal/OkHttpCompat.java',
      '$kAndroidCoreSource/../../consumer-rules.pro',
    ]) {
      expect(File('$root/$path').existsSync(), isTrue, reason: path);
    }
  });

  test('pubspec registers the plugin classes that exist', () {
    final pubspec = File('$root/pubspec.yaml').readAsStringSync();
    expect(pubspec, contains('package: dev.durbun.flutter'));
    expect(pubspec, contains('pluginClass: DurbunFlutterPlugin'));
    expect(
      File(
        '$root/android/src/main/kotlin/dev/durbun/flutter/DurbunFlutterPlugin.kt',
      ).existsSync(),
      isTrue,
    );
    expect(
      File(
        '$root/ios/durbun/Sources/durbun/DurbunFlutterPlugin.swift',
      ).existsSync(),
      isTrue,
    );
  });

  test('the check reports drift', () {
    final temp = Directory.systemTemp.createTempSync('durbun-sync');
    try {
      // A package root whose ../../ios/Sources/Durbun is a one-file core.
      final pkg = Directory('${temp.path}/sdks/flutter/durbun')
        ..createSync(recursive: true);
      final src = Directory('${temp.path}/sdks/ios/Sources/Durbun/Core')
        ..createSync(recursive: true);
      File('${src.path}/A.swift').writeAsStringSync('let a = 1\n');
      expect(nativeSyncDifferences(pkg.path), <String>[
        'missing in the plugin: Core/A.swift',
      ]);
      expect(syncNative(pkg.path), 1);
      expect(nativeSyncDifferences(pkg.path), isEmpty);
      File('${src.path}/A.swift').writeAsStringSync('let a = 2\n');
      File('${pkg.path}/$kIosCoreCopy/Old.swift').writeAsStringSync('');
      expect(nativeSyncDifferences(pkg.path), <String>[
        'differs: Core/A.swift',
        'not in the original: Old.swift',
      ]);
      expect(syncNative(pkg.path), 2);
      expect(nativeSyncDifferences(pkg.path), isEmpty);
    } finally {
      temp.deleteSync(recursive: true);
    }
  });
}
