// Platform-agnostic: must not import dart:io / package:flutter.
import 'types.dart';

/// Configuration of the Dürbün SDK.
///
/// ```dart
/// await Durbun.run(() async {
///   WidgetsFlutterBinding.ensureInitialized();
///   runApp(const MyApp());
/// }, options: const DurbunOptions(host: '192.168.1.20'));
/// ```
class DurbunOptions {
  const DurbunOptions({
    this.enabled,
    this.host,
    this.port = 9751,
    this.captureNetwork = true,
    this.capturePrint = DurbunPrintCapture.auto,
    this.captureErrors = true,
    this.metrics = true,
    this.maxBufferedMessages = 5000,
    this.redactHeaders = const <String>[],
    this.appId,
    this.appName,
    this.appVersion,
    this.waitForDesktop = Duration.zero,
    this.listenForUsb = true,
    this.useBackgroundIsolate = true,
  });

  /// Whether the SDK runs. `null` (default):
  ///
  /// * debug and profile builds: on;
  /// * release builds: off, unless built with `--dart-define=DURBUN=true`
  ///   (`flutter build apk --release --dart-define=DURBUN=true`,
  ///   `flutter build ipa --release --dart-define=DURBUN=true`); such a build
  ///   runs the SDK wherever it is installed from, stores included;
  /// * `--dart-define=DURBUN=false` turns it off in every build mode;
  /// * inside `flutter test`: off.
  ///
  /// `true` / `false` override all of the above. The plugin's native layer
  /// (Kotlin / Swift) follows this decision: when the SDK is off it opens no
  /// sockets and installs no hooks.
  final bool? enabled;

  /// Desktop address for Wi-Fi (LAN) connections, e.g. `192.168.1.20` or
  /// `192.168.1.20:9751`. Also read from `--dart-define=DURBUN_HOST=…` and the
  /// `DURBUN_HOST` environment variable. USB and simulators need no host.
  final String? host;

  /// Desktop SDK port (default 9751). Used for 127.0.0.1 and for [host].
  final int port;

  /// Capture dart:io `HttpClient` traffic (package:http, Dio's default
  /// adapter, `NetworkImage`, …) and apply the desktop's mock rules.
  final bool captureNetwork;

  /// `print` / `debugPrint` capture policy.
  final DurbunPrintCapture capturePrint;

  /// Report `FlutterError.onError`, `PlatformDispatcher.onError` and zone
  /// errors (crashes).
  final bool captureErrors;

  /// Send FPS, janky frames, frame build/raster times, memory and CPU.
  final bool metrics;

  /// Outgoing messages kept while the desktop is unreachable (oldest dropped).
  final int maxBufferedMessages;

  /// Header names (case-insensitive) whose values are replaced by `••••`
  /// before they leave the device, e.g. `['authorization', 'cookie']`.
  final List<String> redactHeaders;

  /// Override the detected bundle id / package name.
  final String? appId;

  /// Override the detected display name.
  final String? appName;

  /// Override the detected version (Android cannot detect it without plugins).
  final String? appVersion;

  /// [Durbun.run] waits up to this long for the desktop before running the app
  /// body, so mock rules apply to the very first requests. Default: no wait.
  final Duration waitForDesktop;

  /// iOS physical devices: listen on 127.0.0.1:9752–9755 so the desktop can
  /// connect over USB (usbmux).
  final bool listenForUsb;

  /// Run the transport (JSON encoding, socket I/O) on a background isolate.
  final bool useBackgroundIsolate;

  /// Copy with some fields replaced.
  DurbunOptions copyWith({
    bool? enabled,
    String? host,
    int? port,
    bool? captureNetwork,
    DurbunPrintCapture? capturePrint,
    bool? captureErrors,
    bool? metrics,
    int? maxBufferedMessages,
    List<String>? redactHeaders,
    String? appId,
    String? appName,
    String? appVersion,
    Duration? waitForDesktop,
    bool? listenForUsb,
    bool? useBackgroundIsolate,
  }) {
    return DurbunOptions(
      enabled: enabled ?? this.enabled,
      host: host ?? this.host,
      port: port ?? this.port,
      captureNetwork: captureNetwork ?? this.captureNetwork,
      capturePrint: capturePrint ?? this.capturePrint,
      captureErrors: captureErrors ?? this.captureErrors,
      metrics: metrics ?? this.metrics,
      maxBufferedMessages: maxBufferedMessages ?? this.maxBufferedMessages,
      redactHeaders: redactHeaders ?? this.redactHeaders,
      appId: appId ?? this.appId,
      appName: appName ?? this.appName,
      appVersion: appVersion ?? this.appVersion,
      waitForDesktop: waitForDesktop ?? this.waitForDesktop,
      listenForUsb: listenForUsb ?? this.listenForUsb,
      useBackgroundIsolate: useBackgroundIsolate ?? this.useBackgroundIsolate,
    );
  }
}
