// The plugin carries exact copies of the native cores (pub.dev publishes only
// this folder; CocoaPods, SwiftPM and Gradle build only files inside it) that
// tool/sync_native.dart refreshes from sdks/ios and sdks/android. These tests
// fail when a copy drifts or the build points outside the package.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/sync_native.dart';

void main() {
  final root = Directory.current.path;

  test('the iOS and Android core copies match sdks/ios and sdks/android', () {
    final problems = nativeSyncDifferences(root);
    expect(
      problems,
      isEmpty,
      reason: 'Run `dart run tool/sync_native.dart` in sdks/flutter/durbun.',
    );
  });

  test('Gradle compiles the Android copy inside the package, nothing outside it', () {
    final gradle = File('$root/android/build.gradle').readAsStringSync();
    expect(gradle, isNot(contains('../')), reason: 'a published plugin has no repository around it');
    expect(gradle, contains('"src/core/kotlin"'));
    expect(gradle, contains('"src/core/java"'));
    expect(gradle, contains('consumerProguardFiles("core-rules.pro")'));
    for (final path in <String>[
      '$kAndroidCoreCopy/kotlin/dev/durbun/Durbun.kt',
      '$kAndroidCoreCopy/kotlin/dev/durbun/DurbunInterceptor.kt',
      '$kAndroidCoreCopy/kotlin/dev/durbun/internal/HostLink.kt',
      '$kAndroidCoreCopy/java/dev/durbun/internal/OkHttpCompat.java',
      kAndroidRulesCopy,
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
      // A package root whose ../../ios and ../../android hold one-file cores.
      final pkg = Directory('${temp.path}/sdks/flutter/durbun')
        ..createSync(recursive: true);
      final src = Directory('${temp.path}/sdks/ios/Sources/Durbun/Core')
        ..createSync(recursive: true);
      final kt = Directory('${temp.path}/sdks/android/durbun/src/main/kotlin/dev')
        ..createSync(recursive: true);
      File('${src.path}/A.swift').writeAsStringSync('let a = 1\n');
      File('${kt.path}/B.kt').writeAsStringSync('val b = 1\n');
      File('${kt.parent.parent.path}/AndroidManifest.xml').writeAsStringSync('<manifest/>');
      final rules = File('${temp.path}/sdks/android/durbun/consumer-rules.pro')
        ..writeAsStringSync('-keep class dev.durbun.** { *; }\n');
      expect(nativeSyncDifferences(pkg.path), <String>[
        'Android rules: missing in the plugin: consumer-rules.pro',
        'Android: missing in the plugin: kotlin/dev/B.kt',
        'iOS: missing in the plugin: Core/A.swift',
      ]);
      expect(syncNative(pkg.path), 3);
      expect(nativeSyncDifferences(pkg.path), isEmpty);
      expect(File('${pkg.path}/$kAndroidCoreCopy/kotlin/dev/B.kt').existsSync(), isTrue);
      expect(File('${pkg.path}/$kAndroidRulesCopy').readAsStringSync(), rules.readAsStringSync());
      expect(Directory('${pkg.path}/$kAndroidCoreCopy').listSync(recursive: true).whereType<File>().length, 1,
          reason: 'only sources are copied, not the manifest');

      File('${src.path}/A.swift').writeAsStringSync('let a = 2\n');
      File('${pkg.path}/$kIosCoreCopy/Old.swift').writeAsStringSync('');
      rules.writeAsStringSync('-dontwarn okhttp3.Call\n');
      expect(nativeSyncDifferences(pkg.path), <String>[
        'Android rules: differs: consumer-rules.pro',
        'iOS: differs: Core/A.swift',
        'iOS: not in the original: Old.swift',
      ]);
      expect(syncNative(pkg.path), 3);
      expect(nativeSyncDifferences(pkg.path), isEmpty);

      File('${kt.path}/B.kt').deleteSync();
      expect(nativeSyncDifferences(pkg.path), <String>['Android: not in the original: kotlin/dev/B.kt']);
      expect(syncNative(pkg.path), 1);
      expect(Directory('${pkg.path}/$kAndroidCoreCopy').existsSync() &&
          Directory('${pkg.path}/$kAndroidCoreCopy').listSync(recursive: true).whereType<File>().isNotEmpty, isFalse);
    } finally {
      temp.deleteSync(recursive: true);
    }
  });
}
