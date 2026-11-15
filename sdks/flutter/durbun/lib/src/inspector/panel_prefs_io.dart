import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/services.dart';

import '../core/env/environment.dart' show isFlutterTestEnvironment;
import '../flutter/native_bridge.dart' show EarlyBinaryMessenger, kDurbunNativeChannel;

// Works before the app creates its binding: `Durbun.run` reads the kept Mac
// address while starting.
const MethodChannel _native = MethodChannel(kDurbunNativeChannel, StandardMethodCodec(), EarlyBinaryMessenger());

/// The prefs live in this folder of the app's cache directory.
const String kPrefsFolder = 'durbun-prefs';

/// Tests: the folder to use instead of the plugin's cache directory.
@visibleForTesting
String? debugPanelPrefsDir;

Future<String?>? _dir;

/// Only with the plugin's cache directory (a real app): without it (tests,
/// a pure-Dart program) nothing is kept, so a value never leaks between runs
/// of unrelated programs through the system temp directory.
Future<String?> _prefsDir() {
  final override = debugPanelPrefsDir;
  if (override != null) return Future<String?>.value(override);
  // `flutter test` has no plugin; a test sets [debugPanelPrefsDir].
  if (isFlutterTestEnvironment) return Future<String?>.value();
  return _dir ??= () async {
    try {
      final cache = await _native
          .invokeMethod<String>('cacheDir')
          .timeout(const Duration(seconds: 3), onTimeout: () => null);
      if (cache == null || cache.isEmpty) return null;
      return '$cache${Platform.pathSeparator}$kPrefsFolder';
    } catch (_) {
      return null;
    }
  }();
}

/// Whether values can be kept at all (not under `flutter test` unless a
/// test sets [debugPanelPrefsDir]); the cache directory may still be
/// missing.
bool get panelPrefsAvailable => debugPanelPrefsDir != null || !isFlutterTestEnvironment;

@visibleForTesting
void debugResetPanelPrefs() => _dir = null;

/// The kept value of [name], or null.
Future<String?> readPanelPref(String name) async {
  try {
    final dir = await _prefsDir();
    if (dir == null) return null;
    final file = File('$dir${Platform.pathSeparator}$name');
    if (!await file.exists()) return null;
    final text = (await file.readAsString()).trim();
    return text.isEmpty ? null : text;
  } catch (_) {
    return null;
  }
}

/// Keeps [value] under [name] (null removes it). False when it could not.
Future<bool> writePanelPref(String name, String? value) async {
  try {
    final dir = await _prefsDir();
    if (dir == null) return false;
    final file = File('$dir${Platform.pathSeparator}$name');
    if (value == null) {
      if (await file.exists()) await file.delete();
      return true;
    }
    await Directory(dir).create(recursive: true);
    await file.writeAsString(value, flush: true);
    return true;
  } catch (_) {
    return false;
  }
}
