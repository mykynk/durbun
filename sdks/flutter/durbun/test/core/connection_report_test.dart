import 'dart:async';
import 'dart:io';

import 'package:durbun/src/core/connection_report.dart';
import 'package:durbun/src/core/transport/transport_core.dart' show AttemptKind;
import 'package:flutter_test/flutter_test.dart';

ConnectIssue _diagnose(List<ConnectAttempt> attempts, {String platform = 'android', bool physical = true, String? lan}) =>
    diagnoseConnection(attempts: attempts, platform: platform, isPhysical: physical, lanEndpoint: lan);

void main() {
  group('AttemptKind.classify', () {
    test('errno and message pick the kind', () {
      SocketException se(String message, int? errno) =>
          SocketException('Connection failed', osError: errno == null ? null : OSError(message, errno));
      expect(AttemptKind.classify(se('Connection refused', 61)), AttemptKind.refused);
      expect(AttemptKind.classify(se('Connection refused', 111)), AttemptKind.refused);
      expect(AttemptKind.classify(se('Operation timed out', 60)), AttemptKind.timeout);
      expect(AttemptKind.classify(TimeoutException('x')), AttemptKind.timeout);
      expect(AttemptKind.classify(se('No route to host', 65)), AttemptKind.unreachable);
      expect(AttemptKind.classify(se('Network is unreachable', 101)), AttemptKind.unreachable);
      expect(AttemptKind.classify(se('Operation not permitted', 1)), AttemptKind.denied);
      expect(AttemptKind.classify(se('Permission denied', 13)), AttemptKind.denied);
      expect(AttemptKind.classify(const SocketException('Failed host lookup: \'my-mac\'')), AttemptKind.lookup);
      expect(AttemptKind.classify(StateError('odd')), AttemptKind.error);
    });
  });

  group('diagnoseConnection', () {
    test('Android phone: no adb reverse vs. adb reverse without the Mac app', () {
      expect(_diagnose(<ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'refused')]), ConnectIssue.usbNotSetUp);
      expect(_diagnose(<ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'closed')]), ConnectIssue.usbDesktopClosed);
    });

    test('iPhone waits for the Mac over USB; simulator and desktop say the app is not open', () {
      expect(_diagnose(<ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'refused')], platform: 'ios'),
          ConnectIssue.iosUsbWaiting);
      expect(_diagnose(<ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'refused')], platform: 'ios', physical: false),
          ConnectIssue.desktopNotRunning);
      expect(_diagnose(<ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'refused')], platform: 'other'),
          ConnectIssue.desktopNotRunning);
      expect(_diagnose(<ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'no-welcome')], platform: 'other'),
          ConnectIssue.notDurbun);
    });

    test('the Wi-Fi attempt decides when there is one', () {
      const lan = '192.168.1.20:9751';
      List<ConnectAttempt> withLan(String kind) =>
          <ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'refused'), ConnectAttempt(lan, kind)];
      expect(_diagnose(withLan('refused'), lan: lan), ConnectIssue.lanRefused);
      expect(_diagnose(withLan('timeout'), lan: lan), ConnectIssue.lanTimeout);
      expect(_diagnose(withLan('unreachable'), lan: lan), ConnectIssue.lanUnreachable);
      expect(_diagnose(withLan('lookup'), lan: lan), ConnectIssue.lanBadAddress);
      expect(_diagnose(withLan('no-welcome'), lan: lan), ConnectIssue.notDurbun);
      expect(_diagnose(withLan('error'), lan: lan), ConnectIssue.other);
    });

    test('a denied attempt anywhere means a permission', () {
      expect(_diagnose(<ConnectAttempt>[const ConnectAttempt('127.0.0.1:9751', 'denied')]), ConnectIssue.permissionDenied);
    });
  });

  test('the console hint names the next step and what was tried', () {
    const report = ConnectionReport(
      connected: false,
      attempts: <ConnectAttempt>[ConnectAttempt('127.0.0.1:9751', 'refused'), ConnectAttempt('192.168.1.20:9751', 'refused')],
      lanEndpoint: '192.168.1.20:9751',
      issue: ConnectIssue.lanRefused,
    );
    final text = connectionHintForConsole(report, port: 9751);
    expect(text, startsWith('Dürbün: not connected'));
    expect(text, contains('Allow local network'));
    expect(text, contains('192.168.1.20:9751 refused'));
    expect(text, contains('Tools → Mac connection'));
    for (final issue in ConnectIssue.values) {
      expect(connectionHintForConsole(ConnectionReport(connected: false, issue: issue), port: 9751), isNotEmpty);
    }
  });

  group('checkDesktopAddress', () {
    String? ok(String input) {
      final r = checkDesktopAddress(input);
      expect(r.error, isNull, reason: input);
      return r.address;
    }

    DesktopAddressError? bad(String input) {
      final r = checkDesktopAddress(input);
      expect(r.address, isNull, reason: input);
      return r.error;
    }

    test('takes IPv4, names, ports, IPv6 and cleans prefixes', () {
      expect(ok('192.168.1.20'), '192.168.1.20');
      expect(ok('  192.168.1.20:9751 '), '192.168.1.20:9751');
      expect(ok('http://192.168.1.20:9751/'), '192.168.1.20:9751');
      expect(ok('my-mac.local'), 'my-mac.local');
      expect(ok('[fe80::1]:9751'), '[fe80::1]:9751');
      expect(ok('[fe80::1]'), '[fe80::1]');
      expect(ok('fe80::1'), 'fe80::1');
    });

    test('says what is wrong', () {
      expect(bad(''), DesktopAddressError.empty);
      expect(bad('   '), DesktopAddressError.empty);
      expect(bad('192.168.1'), DesktopAddressError.badHost);
      expect(bad('192.168.1.300'), DesktopAddressError.badHost);
      expect(bad('my mac'), DesktopAddressError.badHost);
      expect(bad('mac/path'), DesktopAddressError.badHost);
      expect(bad('-mac'), DesktopAddressError.badHost);
      expect(bad('192.168.1.20:0'), DesktopAddressError.badPort);
      expect(bad('192.168.1.20:70000'), DesktopAddressError.badPort);
      expect(bad('192.168.1.20:abc'), DesktopAddressError.badPort);
      expect(bad('192.168.1.20:'), DesktopAddressError.badPort);
    });
  });
}
