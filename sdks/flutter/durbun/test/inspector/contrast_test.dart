// Contrast of the panel's colour pairs (WCAG 2): 4.5:1 for text, 3:1 for
// icons and large figures, in both themes.
import 'dart:math' as math;
import 'dart:ui' show Color;

import 'package:durbun/src/inspector/theme.dart';
import 'package:flutter_test/flutter_test.dart';

double _lum(Color c) {
  double ch(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/// [fg] over [bg]; a translucent colour is blended first.
double contrast(Color fg, Color bg) {
  final b = bg.a < 1 ? Color.alphaBlend(bg, const Color(0xFF000000)) : bg;
  final f = Color.alphaBlend(fg, b);
  final a = _lum(f), z = _lum(b);
  return (math.max(a, z) + 0.05) / (math.min(a, z) + 0.05);
}

/// A tint (alpha) laid over [base].
Color over(Color tint, Color base) => Color.alphaBlend(tint, base);

void main() {
  for (final c in <DurbunColors>[DurbunColors.light, DurbunColors.dark]) {
    final theme = c.isDark ? 'dark' : 'light';
    final pages = <String, Color>{
      'bgApp': c.bgApp,
      'bgPanel': c.bgPanel,
      'cardBg': c.cardBg,
      'fieldBg': c.fieldBg,
      'trackBg': c.trackBg,
    };

    void expectAtLeast(String name, Color fg, Color bg, double min) {
      final r = contrast(fg, bg);
      expect(r, greaterThanOrEqualTo(min), reason: '$theme $name: ${r.toStringAsFixed(2)}:1, needs $min:1');
    }

    test('$theme: the three text roles on every surface', () {
      for (final MapEntry(key: name, value: bg) in pages.entries) {
        expectAtLeast('text on $name', c.text, bg, 4.5);
        expectAtLeast('textMuted on $name', c.textMuted, bg, 4.5);
        expectAtLeast('textSubtle on $name', c.textSubtle, bg, 4.5);
      }
      // A pressed or hovered row.
      expectAtLeast('textMuted on bgHover', c.textMuted, c.bgHover, 4.5);
      expectAtLeast('textMuted on bgActive', c.textMuted, c.bgActive, 4.5);
    });

    test('$theme: accent fill, tint and ink', () {
      expectAtLeast('onAccent on accentFill', c.onAccent, c.accentFill, 4.5);
      expectAtLeast('onDanger on danger', c.onDanger, c.danger, 4.5);
      for (final MapEntry(key: name, value: bg) in pages.entries) {
        expectAtLeast('accentInk on $name', c.accentInk, bg, 4.5);
      }
      expectAtLeast('accentInk on accentSoft (tonal button)', c.accentInk, over(c.accentSoft, c.cardBg), 4.5);
      expectAtLeast('accentInk on accentSoft over the page', c.accentInk, over(c.accentSoft, c.bgPanel), 4.5);
    });

    test('$theme: status, method and level colours as small text', () {
      final tokens = <String, Color>{
        'st2xx': c.st2xx,
        'st3xx': c.st3xx,
        'st4xx': c.st4xx,
        'st5xx': c.st5xx,
        'stPending': c.stPending,
        'GET': c.mGet,
        'POST': c.mPost,
        'PUT': c.mPut,
        'PATCH': c.mPatch,
        'DELETE': c.mDelete,
        'verbose': c.lvVerbose,
        'debug': c.lvDebug,
        'info': c.lvInfo,
        'warn': c.lvWarn,
        'error': c.lvError,
        'fatal': c.lvFatal,
        'success': c.success,
        'warning': c.warning,
        'danger': c.danger,
        'info tone': c.info,
      };
      for (final MapEntry(key: name, value: fg) in tokens.entries) {
        expectAtLeast('$name on bgPanel', fg, c.bgPanel, 4.5);
        expectAtLeast('$name on cardBg', fg, c.cardBg, 4.5);
      }
      // A status token and a tone badge are the colour on its own tint.
      for (final fg in <Color>[c.st2xx, c.st3xx, c.st4xx, c.st5xx, c.stPending, c.success, c.warning, c.danger, c.info, c.sdkAndroid, c.sdkIos, c.sdkDart, c.sdkFlutter]) {
        expectAtLeast('$fg on its tint', fg, over(fg.withValues(alpha: 0.15), c.cardBg), 4.5);
      }
      // A warning, error or crash row is tinted; its level word and text stay readable.
      for (final level in <String>['warn', 'error', 'fatal']) {
        final row = over(c.levelBg(level)!, c.bgPanel);
        expectAtLeast('$level word on its row', c.level(level), row, 4.5);
        expectAtLeast('text on a $level row', c.text, row, 4.5);
        // Meta text on a tinted row uses textMuted (textSubtle is too faint there).
        expectAtLeast('textMuted on a $level row', c.textMuted, row, 4.5);
      }
      // Banners: the text on the tone's tint.
      for (final tint in <Color>[c.infoSoft, c.warningSoft, c.dangerSoft]) {
        expectAtLeast('textMuted on a banner', c.textMuted, over(tint, c.bgPanel), 4.5);
      }
    });

    test('$theme: JSON colours in a body', () {
      final body = c.isDark ? c.bgSunken : c.bgPanel;
      for (final fg in <Color>[c.jsonKey, c.jsonString, c.jsonNumber, c.jsonBool, c.jsonNull]) {
        expectAtLeast('json on body', fg, body, 4.5);
      }
    });
  }
}
