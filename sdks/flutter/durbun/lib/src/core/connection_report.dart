// Why the app is not connected to the Dürbün desktop, in words a developer
// (console) and a tester (in-app panel) can act on. Pure Dart: no dart:io,
// no package:flutter.

/// One failed client attempt of the last round.
class ConnectAttempt {
  const ConnectAttempt(this.endpoint, this.kind, [this.detail = '']);

  /// `host:port`.
  final String endpoint;

  /// `refused`, `timeout`, `unreachable`, `denied`, `lookup`, `closed`,
  /// `no-welcome` or `error` (see the transport's `AttemptKind`).
  final String kind;

  /// The operating system's message, for the curious.
  final String detail;

  bool get isLoopback => endpoint.startsWith('127.0.0.1:');

  @override
  String toString() => '$endpoint: $kind';
}

/// What most likely keeps the app from the desktop.
enum ConnectIssue {
  /// Simulator, emulator or desktop app: nothing listens on this computer's
  /// SDK port. Dürbün is not open (or uses another SDK port).
  desktopNotRunning,

  /// Android phone without a Wi-Fi address: no `adb reverse` on the cable
  /// (not plugged in, USB debugging off, or the Mac app is not open).
  usbNotSetUp,

  /// Android phone: `adb reverse` is set up but nothing answers on the Mac.
  usbDesktopClosed,

  /// iPhone without a Wi-Fi address: the Mac app connects over the cable;
  /// it has not come yet.
  iosUsbWaiting,

  /// The Mac answered but its SDK port is closed to the network: Dürbün is
  /// not open, or local network connections are off in its Settings.
  lanRefused,

  /// No answer from the address: wrong address, another network, firewall.
  lanTimeout,

  /// No route to the address (another network); on iOS also the Local
  /// Network permission.
  lanUnreachable,

  /// The address is not a name or IP the phone can resolve.
  lanBadAddress,

  /// The operating system did not allow the connection (Android INTERNET
  /// permission, iOS Local Network permission, macOS sandbox).
  permissionDenied,

  /// Something answered on the port, but not a Dürbün desktop that took
  /// this app (another program, or a Dürbün version that does not accept
  /// this SDK).
  notDurbun,

  /// Any other failure (see the attempts).
  other,
}

/// The connection as the panel and the console explain it.
class ConnectionReport {
  const ConnectionReport({
    required this.connected,
    this.via,
    this.attempts = const <ConnectAttempt>[],
    this.failedRounds = 0,
    this.trying = false,
    this.lanEndpoint,
    this.lanFromPanel = false,
    this.buildHost,
    this.issue,
    this.everConnected = false,
    this.listensForUsb = false,
  });

  final bool connected;
  final String? via;

  /// The last failed round (empty while connected or before the first one).
  final List<ConnectAttempt> attempts;

  /// Failed rounds since the last connection (or the last address change).
  final int failedRounds;

  /// A new address was set and its first round has not ended yet.
  final bool trying;

  /// The Wi-Fi endpoint tried besides the cable (`host:port`), if any.
  final String? lanEndpoint;

  /// [lanEndpoint] was entered in the panel (not built into the app).
  final bool lanFromPanel;

  /// The address built into the app (`DurbunOptions.host`,
  /// `--dart-define=DURBUN_HOST` or the environment), if any.
  final String? buildHost;

  final ConnectIssue? issue;
  final bool everConnected;

  /// The SDK also waits for the Mac to connect over USB (iPhone).
  final bool listensForUsb;
}

/// Picks the most likely [ConnectIssue] for a failed round.
///
/// [platform] is `android`, `ios` or anything else; [isPhysical] is false on
/// simulators and emulators; [lanEndpoint] is the Wi-Fi endpoint in the
/// round, if one was configured.
ConnectIssue diagnoseConnection({
  required List<ConnectAttempt> attempts,
  required String platform,
  required bool isPhysical,
  String? lanEndpoint,
}) {
  ConnectAttempt? find(bool Function(ConnectAttempt a) test) {
    for (final a in attempts) {
      if (test(a)) return a;
    }
    return null;
  }

  if (find((a) => a.kind == 'denied') != null) return ConnectIssue.permissionDenied;
  final lan = lanEndpoint == null ? null : find((a) => a.endpoint == lanEndpoint);
  if (lan != null) {
    return switch (lan.kind) {
      'refused' => ConnectIssue.lanRefused,
      'timeout' => ConnectIssue.lanTimeout,
      'unreachable' => ConnectIssue.lanUnreachable,
      'lookup' => ConnectIssue.lanBadAddress,
      'closed' || 'no-welcome' => ConnectIssue.notDurbun,
      _ => ConnectIssue.other,
    };
  }
  final loopback = find((a) => a.isLoopback);
  final android = platform == 'android';
  if (android && isPhysical) {
    // adb reverse accepts on the phone and closes when nothing listens on the Mac.
    return loopback?.kind == 'closed' ? ConnectIssue.usbDesktopClosed : ConnectIssue.usbNotSetUp;
  }
  if (platform == 'ios' && isPhysical) return ConnectIssue.iosUsbWaiting;
  if (loopback != null && (loopback.kind == 'closed' || loopback.kind == 'no-welcome')) {
    // On the emulator adb reverse behaves like on a phone.
    return android ? ConnectIssue.usbDesktopClosed : ConnectIssue.notDurbun;
  }
  if (loopback == null || loopback.kind == 'refused') return ConnectIssue.desktopNotRunning;
  return ConnectIssue.other;
}

/// One English paragraph for the developer console: what failed and what to
/// do next.
String connectionHintForConsole(ConnectionReport report, {required int port}) {
  final lan = report.lanEndpoint;
  final tried = report.attempts.map((a) => '${a.endpoint} ${a.kind}').join(', ');
  final why = switch (report.issue) {
    ConnectIssue.desktopNotRunning =>
      'Nothing answers on this computer\'s port $port: open the Dürbün Mac app (or check its SDK port).',
    ConnectIssue.usbNotSetUp =>
      'No USB link to the Mac: connect the phone with USB debugging on and open the Dürbün Mac app '
          '(it runs adb reverse tcp:$port by itself). For Wi-Fi, give the Mac\'s address with '
          '--dart-define=DURBUN_HOST=<Mac IP> or in the panel (Tools → Mac connection).',
    ConnectIssue.usbDesktopClosed =>
      'adb reverse is set up, but nothing answers on the Mac: open the Dürbün Mac app.',
    ConnectIssue.iosUsbWaiting =>
      'Waiting for the Mac over USB: open the Dürbün Mac app with this iPhone on the cable (and trusted). '
          'For Wi-Fi, give the Mac\'s address with --dart-define=DURBUN_HOST=<Mac IP> or in the panel.',
    ConnectIssue.lanRefused =>
      'The Mac at $lan refuses the connection: open Dürbün there and turn on Settings → '
          '"Allow local network (Wi-Fi) connections".',
    ConnectIssue.lanTimeout =>
      'No answer from $lan: check the address (Dürbün → Settings lists this Mac\'s addresses), '
          'that the phone and the Mac are on the same Wi-Fi, and the Mac\'s firewall.',
    ConnectIssue.lanUnreachable =>
      'No route to $lan: the phone is on another network than the Mac, or (iOS) Local Network access '
          'is off for this app (Settings → Privacy & Security → Local Network; Info.plist needs '
          'NSLocalNetworkUsageDescription).',
    ConnectIssue.lanBadAddress =>
      'The address $lan cannot be resolved: use the Mac\'s IP address, e.g. 192.168.1.20.',
    ConnectIssue.permissionDenied =>
      'The system did not allow the connection: on Android add <uses-permission '
          'android:name="android.permission.INTERNET"/> to the main AndroidManifest.xml (release and '
          'profile builds); on iOS allow Local Network access; a sandboxed macOS app needs '
          'com.apple.security.network.client.',
    ConnectIssue.notDurbun =>
      'Something answered, but it is not a Dürbün desktop that accepted this app (another program on the '
          'port, or a Dürbün version that does not match this SDK).',
    ConnectIssue.other || null => 'The connection failed.',
  };
  return 'Dürbün: not connected to the desktop. $why Tried: $tried. '
      'The app keeps working and keeps retrying; the in-app panel shows the same under Tools → Mac connection.';
}

/// Why an address typed on the phone was not taken.
enum DesktopAddressError {
  /// Nothing typed.
  empty,

  /// Not an IP address or host name (spaces, a path, odd characters).
  badHost,

  /// The port is not a number from 1 to 65535.
  badPort,
}

/// Checks an address typed in the panel: `192.168.1.20`,
/// `192.168.1.20:9751`, `my-mac.local`, `[fe80::1]:9751`; a leading
/// `http://` and a trailing `/` are dropped. Returns the cleaned address
/// (`host` or `host:port`) or the error.
({String? address, DesktopAddressError? error}) checkDesktopAddress(String input) {
  var v = input.trim();
  if (v.isEmpty) return (address: null, error: DesktopAddressError.empty);
  v = v.replaceFirst(RegExp(r'^[a-z]+://', caseSensitive: false), '');
  while (v.endsWith('/')) {
    v = v.substring(0, v.length - 1);
  }
  if (v.isEmpty || v.contains(RegExp(r'[\s/?#@]'))) {
    return (address: null, error: DesktopAddressError.badHost);
  }
  String host;
  String? port;
  if (v.startsWith('[')) {
    final end = v.indexOf(']');
    if (end < 2) return (address: null, error: DesktopAddressError.badHost);
    host = v.substring(1, end);
    final rest = v.substring(end + 1);
    if (rest.isNotEmpty) {
      if (!rest.startsWith(':')) return (address: null, error: DesktopAddressError.badHost);
      port = rest.substring(1);
    }
    if (!RegExp(r'^[0-9a-fA-F:.%a-zA-Z0-9]+$').hasMatch(host) || !host.contains(':')) {
      return (address: null, error: DesktopAddressError.badHost);
    }
  } else if (':'.allMatches(v).length > 1) {
    // A bare IPv6 address: no port.
    host = v;
    if (!RegExp(r'^[0-9a-fA-F:.%a-zA-Z0-9]+$').hasMatch(host)) {
      return (address: null, error: DesktopAddressError.badHost);
    }
  } else {
    final colon = v.indexOf(':');
    host = colon < 0 ? v : v.substring(0, colon);
    if (colon >= 0) port = v.substring(colon + 1);
    final label = RegExp(r'^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$');
    final labels = host.split('.');
    if (host.isEmpty || host.length > 253 || labels.any((l) => !label.hasMatch(l))) {
      return (address: null, error: DesktopAddressError.badHost);
    }
    // All digits and dots: an IPv4 address, four parts of 0-255.
    if (RegExp(r'^[0-9.]+$').hasMatch(host) &&
        (labels.length != 4 || labels.any((l) => int.parse(l) > 255))) {
      return (address: null, error: DesktopAddressError.badHost);
    }
  }
  if (port != null) {
    final n = int.tryParse(port);
    if (n == null || n < 1 || n > 65535) return (address: null, error: DesktopAddressError.badPort);
    final h = host.contains(':') ? '[$host]' : host;
    return (address: '$h:$n', error: null);
  }
  return (address: host.contains(':') && v.startsWith('[') ? '[$host]' : host, error: null);
}
