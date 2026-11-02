/// Detects `hello.app` (AppInfo) and `hello.device` (DeviceHints) without any
/// platform plugin: /proc and system properties on Android, the bundle's
/// Info.plist and sysctl on iOS/macOS, simulator environment variables.
library;

import 'dart:io';

import '../protocol.dart';
import 'native.dart';
import 'plist.dart';

/// `AppInfo` fields.
class DetectedApp {
  const DetectedApp({
    required this.id,
    required this.name,
    this.version,
    this.build,
    this.processName,
  });

  final String id;
  final String name;
  final String? version;
  final String? build;
  final String? processName;

  Map<String, Object?> toJson({required int pid, required bool debug}) =>
      <String, Object?>{
        'name': name,
        'id': id,
        if (version != null) 'version': version,
        if (build != null) 'build': build,
        'pid': pid,
        if (processName != null) 'processName': processName,
        'debug': debug,
      };
}

/// `DeviceHints` fields.
class DetectedDevice {
  const DetectedDevice({
    required this.platform,
    this.model,
    this.manufacturer,
    this.name,
    this.osVersion,
    this.apiLevel,
    this.isPhysical,
    this.simulatorUdid,
  });

  /// `android` | `ios` | `other`.
  final String platform;
  final String? model;
  final String? manufacturer;
  final String? name;
  final String? osVersion;
  final int? apiLevel;
  final bool? isPhysical;
  final String? simulatorUdid;

  bool get isAndroidEmulator => platform == 'android' && isPhysical == false;
  bool get isIosPhysical => platform == 'ios' && isPhysical == true;

  Map<String, Object?> toJson() => <String, Object?>{
    'platform': platform,
    if (model != null) 'model': model,
    if (manufacturer != null) 'manufacturer': manufacturer,
    if (name != null) 'name': name,
    if (osVersion != null) 'osVersion': osVersion,
    if (apiLevel != null) 'apiLevel': apiLevel,
    if (isPhysical != null) 'isPhysical': isPhysical,
    if (simulatorUdid != null) 'simulatorUdid': simulatorUdid,
  };
}

/// Whether the code runs inside `flutter test` (flutter_tester sets this).
bool get isFlutterTestEnvironment {
  try {
    return Platform.environment.containsKey('FLUTTER_TEST');
  } catch (_) {
    return false;
  }
}

/* ────────────────────────────────── app ────────────────────────────────── */

DetectedApp detectApp({String? idOverride, String? nameOverride, String? versionOverride}) {
  DetectedApp app;
  try {
    if (Platform.isAndroid) {
      app = _androidApp();
    } else if (Platform.isIOS || Platform.isMacOS) {
      app = _bundleApp();
    } else {
      app = _executableApp();
    }
  } catch (_) {
    app = _executableApp();
  }
  return DetectedApp(
    id: _nonEmpty(idOverride) ?? app.id,
    name: _nonEmpty(nameOverride) ?? app.name,
    version: _nonEmpty(versionOverride) ?? app.version,
    build: app.build,
    processName: app.processName,
  );
}

DetectedApp _androidApp() {
  String? package;
  try {
    final raw = File('/proc/self/cmdline').readAsBytesSync();
    final end = raw.indexOf(0);
    package = String.fromCharCodes(end < 0 ? raw : raw.sublist(0, end)).trim();
  } catch (_) {}
  if (package == null || package.isEmpty) return _executableApp();
  final processName = package;
  final colon = package.indexOf(':'); // e.g. com.example.app:remote
  if (colon > 0) package = package.substring(0, colon);
  return DetectedApp(
    id: package,
    name: nameFromIdentifier(package),
    processName: processName,
  );
}

DetectedApp _bundleApp() {
  final exe = Platform.resolvedExecutable;
  final exeName = exe.split('/').last;
  // iOS: …/Runner.app/Runner → Runner.app/Info.plist
  // macOS: …/My.app/Contents/MacOS/My → My.app/Contents/Info.plist
  final dir = File(exe).parent;
  final candidates = <String>[
    '${dir.path}/Info.plist',
    '${dir.parent.path}/Info.plist',
  ];
  for (final path in candidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final parsed = parsePlist(file.readAsBytesSync());
    if (parsed is! Map<String, Object?>) continue;
    final id = _string(parsed['CFBundleIdentifier']);
    if (id == null) continue;
    final name =
        _string(parsed['CFBundleDisplayName']) ??
        _string(parsed['CFBundleName']) ??
        exeName;
    return DetectedApp(
      id: id,
      name: name,
      version: _string(parsed['CFBundleShortVersionString']),
      build: _string(parsed['CFBundleVersion']),
      processName: _string(parsed['CFBundleExecutable']) ?? exeName,
    );
  }
  return _executableApp();
}

DetectedApp _executableApp() {
  var name = 'dart';
  try {
    name = Platform.resolvedExecutable.split(Platform.pathSeparator).last;
    final script = Platform.script;
    if (name == 'dart' || name == 'dart.exe' || name == 'dartaotruntime') {
      final segments = script.pathSegments.where((s) => s.isNotEmpty);
      if (segments.isNotEmpty) {
        name = segments.last.replaceAll(RegExp(r'\.(dart|aot|snapshot|dill)$'), '');
      }
    }
  } catch (_) {}
  return DetectedApp(id: name, name: name, processName: name);
}

/// `com.mykynk.pati` → `Pati`; `my_cool_app` → `My cool app`.
String nameFromIdentifier(String id) {
  final last = id.split('.').where((s) => s.isNotEmpty).lastOrNull ?? id;
  final words = last.replaceAll(RegExp(r'[_\-]+'), ' ').trim();
  if (words.isEmpty) return id;
  return words[0].toUpperCase() + words.substring(1);
}

/* ───────────────────────────────── device ───────────────────────────────── */

DetectedDevice detectDevice() {
  try {
    if (Platform.isAndroid) return _androidDevice();
    if (Platform.isIOS) return _iosDevice();
    return _otherDevice();
  } catch (_) {
    return DetectedDevice(
      platform: Platform.isAndroid
          ? 'android'
          : Platform.isIOS
          ? 'ios'
          : 'other',
    );
  }
}

DetectedDevice _androidDevice() {
  String? prop(String name) => androidSystemProperty(name);
  final model = prop('ro.product.model');
  final manufacturer = prop('ro.product.manufacturer');
  final release = prop('ro.build.version.release');
  final sdk = int.tryParse(prop('ro.build.version.sdk') ?? '');
  final hardware = prop('ro.hardware') ?? '';
  final emulator =
      prop('ro.kernel.qemu') == '1' ||
      prop('ro.boot.qemu') == '1' ||
      hardware.contains('ranchu') ||
      hardware.contains('goldfish') ||
      (model ?? '').toLowerCase().contains('sdk_gphone') ||
      (prop('ro.product.device') ?? '').startsWith('emu');
  final deviceName = prop('persist.sys.device_name') ?? model;
  return DetectedDevice(
    platform: 'android',
    model: model,
    manufacturer: manufacturer,
    name: deviceName,
    osVersion: release,
    apiLevel: sdk,
    isPhysical: model == null && manufacturer == null ? null : !emulator,
  );
}

DetectedDevice _iosDevice() {
  final env = Platform.environment;
  final simUdid = env['SIMULATOR_UDID'];
  final osVersion = parseDarwinOsVersion(Platform.operatingSystemVersion);
  if (simUdid != null && simUdid.isNotEmpty) {
    return DetectedDevice(
      platform: 'ios',
      model: env['SIMULATOR_MODEL_IDENTIFIER'],
      manufacturer: 'Apple',
      name: env['SIMULATOR_DEVICE_NAME'],
      osVersion: env['SIMULATOR_RUNTIME_VERSION'] ?? osVersion,
      isPhysical: false,
      simulatorUdid: simUdid,
    );
  }
  String? hostname;
  try {
    hostname = Platform.localHostname;
  } catch (_) {}
  if (hostname != null) {
    hostname = hostname.replaceAll(RegExp(r'\.local$'), '');
    if (hostname.isEmpty || hostname == 'localhost') hostname = null;
  }
  return DetectedDevice(
    platform: 'ios',
    model: darwinSysctlString('hw.machine'),
    manufacturer: 'Apple',
    name: hostname,
    osVersion: osVersion,
    isPhysical: true,
  );
}

DetectedDevice _otherDevice() {
  String? hostname;
  try {
    hostname = Platform.localHostname.replaceAll(RegExp(r'\.local$'), '');
  } catch (_) {}
  return DetectedDevice(
    platform: 'other',
    model: Platform.isMacOS ? darwinSysctlString('hw.model') : null,
    manufacturer: Platform.isMacOS ? 'Apple' : null,
    name: hostname,
    osVersion: Platform.isMacOS
        ? parseDarwinOsVersion(Platform.operatingSystemVersion)
        : Platform.operatingSystemVersion,
    isPhysical: true,
  );
}

/// `Version 17.2 (Build 21C62)` → `17.2`.
String? parseDarwinOsVersion(String raw) {
  final m = RegExp(r'(\d+(?:\.\d+){0,2})').firstMatch(raw);
  return m?.group(1);
}

String? _string(Object? v) => v is String && v.trim().isNotEmpty ? v.trim() : null;

String? _nonEmpty(String? v) => v == null || v.trim().isEmpty ? null : v.trim();

/* ──────────────────────────────── endpoints ──────────────────────────────── */

/// Resolves the Wi-Fi host: option → `--dart-define=DURBUN_HOST` → env var.
String? resolveDesktopHost(String? option) {
  final fromOption = _nonEmpty(option);
  if (fromOption != null) return fromOption;
  const fromDefine = String.fromEnvironment('DURBUN_HOST');
  if (fromDefine.isNotEmpty) return fromDefine;
  try {
    return _nonEmpty(Platform.environment['DURBUN_HOST']);
  } catch (_) {
    return null;
  }
}

/// Splits `host` or `host:port` (IPv6 in brackets) → (host, port).
(String, int) splitHostPort(String value, int defaultPort) {
  var v = value.trim();
  v = v.replaceFirst(RegExp(r'^[a-z]+://', caseSensitive: false), '');
  final slash = v.indexOf('/');
  if (slash >= 0) v = v.substring(0, slash);
  if (v.startsWith('[')) {
    final end = v.indexOf(']');
    if (end > 0) {
      final host = v.substring(1, end);
      final rest = v.substring(end + 1);
      final port = rest.startsWith(':') ? int.tryParse(rest.substring(1)) : null;
      return (host, port ?? defaultPort);
    }
  }
  final colon = v.lastIndexOf(':');
  if (colon > 0 && v.indexOf(':') == colon) {
    final port = int.tryParse(v.substring(colon + 1));
    if (port != null) return (v.substring(0, colon), port);
  }
  return (v, defaultPort);
}

/// Loopback ports for the on-device listener (iOS physical devices).
List<int> deviceListenPorts() => <int>[
  for (var p = kDeviceSdkFirstPort; p <= kDeviceSdkLastPort; p++) p,
];
