import 'dart:io';
import 'dart:typed_data';

import 'package:durbun/src/core/env/plist.dart';
import 'package:flutter_test/flutter_test.dart';

/// Fixtures: a realistic Runner Info.plist (XML) and the same file converted
/// with `plutil -convert binary1` (what Xcode ships on devices).
Uint8List fixture(String name) =>
    File('test/fixtures/$name').readAsBytesSync();

void expectInfoPlist(Object? parsed) {
  expect(parsed, isA<Map<String, Object?>>());
  final p = parsed! as Map<String, Object?>;
  expect(p['CFBundleIdentifier'], 'com.mykynk.pati');
  expect(p['CFBundleDisplayName'], 'Pati & Dostları');
  expect(p['CFBundleName'], 'pati');
  expect(p['CFBundleExecutable'], 'Runner');
  expect(p['CFBundleShortVersionString'], '2.4.1');
  expect(p['CFBundleVersion'], '87');
  expect(p['NSLocalNetworkUsageDescription'], 'Dürbün geliştirici aracına bağlanmak için');
  expect(p['LSRequiresIPhoneOS'], isTrue);
  expect(p['UIApplicationSupportsIndirectInputEvents'], isFalse);
  expect(p['UIDeviceFamily'], [1, 2]);
  expect(p['CFBundleSupportedPlatforms'], ['iPhoneOS']);
  expect(p['DurbunTestReal'], 1.5);
  expect(p['DurbunTestBig'], 5000000000);
  expect(p['DurbunTestNegative'], -42);
  expect(p['DurbunTestDate'], DateTime.utc(2025, 12, 11, 16, 50, 7));
  expect(p['DurbunTestData'], [0x00, 0x01, 0x02, 0xff]);
  expect(p['NSAppTransportSecurity'], {'NSAllowsLocalNetworking': true});
  expect(p['UISupportedInterfaceOrientations'], [
    'UIInterfaceOrientationPortrait',
    'UIInterfaceOrientationLandscapeLeft',
  ]);
}

void main() {
  test('XML Info.plist', () {
    expectInfoPlist(parsePlist(fixture('Info.xml.plist')));
  });

  test('binary (bplist00) Info.plist', () {
    final bytes = fixture('Info.bin.plist');
    expect(String.fromCharCodes(bytes.sublist(0, 8)), 'bplist00');
    expectInfoPlist(parsePlist(bytes));
  });

  test('XML without prolog, comments and empty elements', () {
    const xml = '''
<plist version="1.0"><!-- generated -->
<dict>
  <key>CFBundleIdentifier</key><string>dev.durbun.example</string>
  <key>Empty</key><string/>
  <key>List</key><array/>
  <key>Nested</key><dict/>
  <key>Escaped</key><string>a &lt;b&gt; &#x131; &#105;</string>
</dict>
</plist>''';
    final p = parsePlist(Uint8List.fromList(xml.codeUnits))! as Map<String, Object?>;
    expect(p['CFBundleIdentifier'], 'dev.durbun.example');
    expect(p['Empty'], '');
    expect(p['List'], isEmpty);
    expect(p['Nested'], isEmpty);
    expect(p['Escaped'], 'a <b> ı i');
  });

  test('malformed input returns null instead of throwing', () {
    expect(parsePlist(Uint8List(0)), isNull);
    expect(parsePlist(Uint8List.fromList('bplist00garbage'.codeUnits)), isNull);
    final truncated = fixture('Info.bin.plist');
    expect(parsePlist(Uint8List.sublistView(truncated, 0, truncated.length - 10)), isNull);
    expect(parsePlist(Uint8List.fromList('<plist><dict><key>a</key>'.codeUnits)), isNull);
  });
}
