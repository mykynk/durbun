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

    test('$theme: request and log cards, plain and tinted', () {
      final cards = <String, Color>{
        'card': c.cardBg,
        'warning card': over(c.lvWarnBg, c.cardBg),
        'error card': over(c.lvErrorBg, c.cardBg),
        'crash card': over(c.lvFatalBg, c.cardBg),
      };
      // Log cards take every tint; request cards only the error one.
      for (final MapEntry(key: name, value: card) in cards.entries) {
        expectAtLeast('text on a $name', c.text, card, 4.5);
        expectAtLeast('textMuted on a $name', c.textMuted, card, 4.5);
        expectAtLeast('error text on a $name', c.lvError, card, 4.5);
        for (final (ink, tint) in <(Color, Color)>[
          (c.accentInk, c.accentSoft),
          (c.success, c.successSoft),
          (c.info, c.infoSoft),
          (c.warning, c.warningSoft),
        ]) {
          expectAtLeast('level pill $ink on a $name', ink, over(tint, card), 4.5);
        }
      }
      for (final name in <String>['card', 'error card']) {
        final card = cards[name]!;
        for (final m in <String>['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
          expectAtLeast('$m on a $name', c.method(m), card, 4.5);
        }
        // Durations: plain, slow, failed.
        for (final fg in <Color>[c.warning, c.danger]) {
          expectAtLeast('duration $fg on a $name', fg, card, 4.5);
        }
        // The status pill: its colour on a 14 % tint. On an error card (a
        // 5xx or a failure) the pill is solid: onDanger on danger.
        if (name == 'card') {
          for (final fg in <Color>[c.st2xx, c.st3xx, c.st4xx, c.st5xx, c.stPending]) {
            expectAtLeast('status $fg on a $name', fg, over(fg.withValues(alpha: 0.14), card), 4.5);
          }
        }
        // Tags: Mock, GraphQL, the client (its colour on a 12 % tint); the
        // failure reason is outlined, its ink straight on the card.
        for (final (ink, tint) in <(Color, Color)>[
          (c.accentInk, c.accentSoft),
          (c.info, c.infoSoft),
          (c.sdkAndroid, c.sdkAndroid.withValues(alpha: 0.12)),
          (c.sdkIos, c.sdkIos.withValues(alpha: 0.12)),
          (c.sdkDart, c.sdkDart.withValues(alpha: 0.12)),
        ]) {
          expectAtLeast('tag $ink on a $name', ink, over(tint, card), 4.5);
        }
        expectAtLeast('failure reason on a $name', c.danger, card, 4.5);
      }
    });

    test('$theme: bottom bar, header and summary tiles', () {
      final bar = c.isDark ? c.bgElevated : c.bgPanel;
      expectAtLeast('nav label on the bar', c.textMuted, bar, 4.5);
      expectAtLeast('nav label on the active tile', c.onAccent, c.accentFill, 4.5);
      for (final fg in <Color>[c.success, c.warning, c.danger]) {
        expectAtLeast('FPS chip $fg', fg, over(fg.withValues(alpha: 0.12), c.bgApp), 4.5);
      }
      final errors = over(c.dangerSoft, c.bgApp);
      expectAtLeast('Errors tile figure', c.danger, errors, 4.5);
      expectAtLeast('Errors tile label', c.danger, errors, 4.5);
      expectAtLeast('tile label', c.textMuted, c.cardBg, 4.5);
    });

    test('$theme: Tools page, Performance, Statistics and compare', () {
      // Tools tiles: the icon on its tint (an icon: 3:1).
      for (final (ink, tint) in <(Color, Color)>[
        (c.info, c.infoSoft),
        (c.accentInk, c.accentSoft),
        (c.warning, c.warningSoft),
        (c.success, c.successSoft),
      ]) {
        expectAtLeast('tile icon $ink', ink, over(tint, c.cardBg), 3);
      }
      expectAtLeast('version pill', c.textMuted, c.chipBg, 4.5);
      // The red card of Clear, and a crash card of a saved run.
      final danger = over(c.lvErrorBg, c.cardBg);
      expectAtLeast('danger card title', c.danger, danger, 4.5);
      expectAtLeast('danger card hint', c.textMuted, danger, 4.5);
      expectAtLeast('danger card text', c.text, danger, 4.5);
      // Performance: the figure and the ring in their state colour, the
      // janky line, the tile notes and the chart notes (small mono text).
      for (final fg in <Color>[c.success, c.warning, c.danger]) {
        expectAtLeast('FPS figure $fg', fg, c.cardBg, 3);
      }
      expectAtLeast('janky line', c.warning, c.cardBg, 4.5);
      for (final fg in <Color>[c.info, c.pickViolet, c.success, c.pickOrange]) {
        expectAtLeast('note $fg', fg, c.cardBg, 4.5);
      }
      // Statistics: the success badge on its tint, the method labels.
      for (final (ink, tint) in <(Color, Color)>[
        (c.success, c.successSoft),
        (c.warning, c.warningSoft),
        (c.danger, c.dangerSoft),
      ]) {
        expectAtLeast('rate badge $ink', ink, over(tint, c.cardBg), 4.5);
      }
      for (final m in <String>['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        expectAtLeast('method $m', c.method(m), c.cardBg, 4.5);
      }
      // Compare: the hidden-lines bar, the changed rows of a diff.
      expectAtLeast('show hidden lines', c.accentInk, over(c.accentSoft, c.cardBg), 4.5);
      expectAtLeast('removed line', c.text, over(c.danger.withValues(alpha: 0.12), c.cardBg), 4.5);
      expectAtLeast('added line', c.text, over(c.success.withValues(alpha: 0.12), c.cardBg), 4.5);
      expectAtLeast('changed field', c.text, over(c.warningSoft, c.cardBg), 4.5);
      // Code: keywords and inline names.
      expectAtLeast('code keyword', c.accentInk, c.cardBg, 4.5);
      expectAtLeast('inline code', c.accentInk, c.bgApp, 4.5);
      expectAtLeast('log error line', c.lvError, over(c.lvErrorBg, c.cardBg), 4.5);
    });

    test('$theme: Report a bug', () {
      // The moment card: a crash, an error or a failed request tinted like
      // its card in the lists; the panel's opening on the plain card.
      for (final (name, card) in <(String, Color)>[
        ('crash', over(c.lvFatalBg, c.cardBg)),
        ('error', over(c.lvErrorBg, c.cardBg)),
      ]) {
        expectAtLeast('moment kind on a $name card', c.text, card, 4.5);
        expectAtLeast('moment time on a $name card', c.textMuted, card, 4.5);
        expectAtLeast('moment icon on a $name card', c.danger, over(c.dangerSoft, card), 3);
      }
      expectAtLeast('opening icon', c.accentInk, over(c.accentSoft, c.cardBg), 3);
      expectAtLeast('opening body', c.textMuted, c.cardBg, 4.5);
      // The note: typed text, the hint and the window line under the segments.
      expectAtLeast('note text', c.text, c.fieldBg, 4.5);
      expectAtLeast('note hint', c.textSubtle, c.fieldBg, 4.5);
      expectAtLeast('window line', c.textMuted, c.bgApp, 4.5);
      // The contents card: rows, the screenshot's notes, the failed-requests
      // icon, the placeholder of a missing picture, the left-out mark.
      expectAtLeast('row hint', c.textSubtle, c.cardBg, 4.5);
      expectAtLeast('screenshot status', c.textMuted, c.cardBg, 4.5);
      expectAtLeast('failed requests icon', c.danger, c.cardBg, 3);
      expectAtLeast('no picture icon', c.textSubtle, c.bgSunken, 3);
      expectAtLeast('left-out mark', c.textMuted, c.bgPanel, 3);
      // The pinned footer and its notice, the Tools card, the share sheet row.
      expectAtLeast('summary', c.textMuted, c.bgPanel, 4.5);
      for (final tint in <Color>[c.infoSoft, c.warningSoft]) {
        expectAtLeast('notice on its tint', c.text, over(tint, c.bgPanel), 4.5);
      }
      expectAtLeast('Tools card icon', c.danger, over(c.dangerSoft, c.cardBg), 3);
      expectAtLeast('Tools card hint', c.textMuted, c.cardBg, 4.5);
    });

    test('$theme: JSON colours in a body', () {
      final body = c.isDark ? c.bgSunken : c.bgPanel;
      for (final fg in <Color>[c.jsonKey, c.jsonString, c.jsonNumber, c.jsonBool, c.jsonNull]) {
        expectAtLeast('json on body', fg, body, 4.5);
      }
    });

    test('$theme: connections (the WS/SSE chip, message rows, the dropped line)', () {
      // The chip on a request card: open, broken, ended.
      expectAtLeast('success on successSoft', c.success, over(c.successSoft, c.cardBg), 4.5);
      expectAtLeast('danger on dangerSoft', c.danger, over(c.dangerSoft, c.cardBg), 4.5);
      expectAtLeast('textMuted on bgActive (ended chip)', c.textMuted, over(c.bgActive, c.cardBg), 4.5);
      // Direction arrows and the event name, on the messages card.
      expectAtLeast('accentInk (sent) on cardBg', c.accentInk, c.cardBg, 4.5);
      expectAtLeast('info (received) on cardBg', c.info, c.cardBg, 4.5);
      expectAtLeast('warning (close frame) on cardBg', c.warning, c.cardBg, 4.5);
      expectAtLeast('textSubtle (ping/pong) on cardBg', c.textSubtle, c.cardBg, 4.5);
      // The dropped-messages line, plain and pressed.
      expectAtLeast('textMuted on bgSunken', c.textMuted, over(c.bgSunken, c.cardBg), 4.5);
      expectAtLeast('textMuted on bgActive (pressed)', c.textMuted, over(c.bgActive, c.cardBg), 4.5);
      // A search match.
      expectAtLeast('text on hlMark', c.text, over(c.hlMark, c.cardBg), 4.5);
    });
  }
}
