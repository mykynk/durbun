// The README is the setup guide teams copy from: its promises must match the
// code (release builds' init() waits for the store guard; Android recognises
// only Google Play as a store).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final readme = File('README.md').readAsStringSync();
  final flat = readme.replaceAll(RegExp(r'\s+'), ' ');

  test('the no-zone setup awaits Durbun.init() before runApp', () {
    expect(readme, isNot(matches(RegExp(r'(?<!await )Durbun\.init\([^)]*\);\s*runApp'))));
    expect(readme, contains('await Durbun.init();'));
  });

  test('the store switch-off names the stores the guard recognises', () {
    final promises = RegExp(r'kendini kapatır|turns itself off').allMatches(flat).toList();
    expect(promises, isNotEmpty);
    for (final m in promises) {
      final around = flat.substring(
        (m.start - 80).clamp(0, flat.length),
        (m.end + 80).clamp(0, flat.length),
      );
      expect(around, contains('Google Play'), reason: around);
    }
    expect(flat, contains('AppGallery'), reason: 'says which Android stores are not recognised');
  });
}
