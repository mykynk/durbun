/// Design tokens of the in-app inspector: the same values as the desktop UI
/// (`packages/ui/src/styles/tokens.css`), so the panel on the phone looks
/// like Dürbün on the Mac. Keep both in sync.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

@immutable
class DurbunColors {
  const DurbunColors({
    required this.brightness,
    required this.bgApp,
    required this.bgPanel,
    required this.bgElevated,
    required this.bgSunken,
    required this.bgHover,
    required this.bgActive,
    required this.bgSelected,
    required this.border,
    required this.borderStrong,
    required this.text,
    required this.textMuted,
    required this.textSubtle,
    required this.textMeta,
    required this.accent,
    required this.accentSoft,
    required this.badgeAccent,
    required this.lvVerbose,
    required this.lvDebug,
    required this.lvInfo,
    required this.lvWarn,
    required this.lvError,
    required this.lvFatal,
    required this.lvWarnBg,
    required this.lvErrorBg,
    required this.lvFatalBg,
    required this.mGet,
    required this.mPost,
    required this.mPut,
    required this.mPatch,
    required this.mDelete,
    required this.mOther,
    required this.st2xx,
    required this.st3xx,
    required this.st4xx,
    required this.st5xx,
    required this.stPending,
    required this.jsonKey,
    required this.jsonString,
    required this.jsonNumber,
    required this.jsonBool,
    required this.jsonNull,
    required this.success,
    required this.warning,
    required this.danger,
    required this.info,
    required this.successSoft,
    required this.warningSoft,
    required this.dangerSoft,
    required this.infoSoft,
    required this.hlMark,
    required this.inputBg,
    required this.pickOrange,
    required this.pickYellow,
    required this.pickGreen,
    required this.pickBlue,
    required this.pickViolet,
    required this.sdkFlutter,
    required this.sdkAndroid,
    required this.sdkIos,
    required this.sdkDart,
    required this.tagL,
    required this.tagC,
    required this.tagBgA,
  });

  final Brightness brightness;
  final Color bgApp, bgPanel, bgElevated, bgSunken, bgHover, bgActive, bgSelected;
  final Color border, borderStrong;
  final Color text, textMuted, textSubtle, textMeta;
  final Color accent, accentSoft, badgeAccent;
  final Color lvVerbose, lvDebug, lvInfo, lvWarn, lvError, lvFatal;
  final Color lvWarnBg, lvErrorBg, lvFatalBg;
  final Color mGet, mPost, mPut, mPatch, mDelete, mOther;
  final Color st2xx, st3xx, st4xx, st5xx, stPending;
  final Color jsonKey, jsonString, jsonNumber, jsonBool, jsonNull;
  final Color success, warning, danger, info;
  final Color successSoft, warningSoft, dangerSoft, infoSoft;
  final Color hlMark, inputBg;
  final Color pickOrange, pickYellow, pickGreen, pickBlue, pickViolet;
  final Color sdkFlutter, sdkAndroid, sdkIos, sdkDart;
  final double tagL, tagC, tagBgA;

  bool get isDark => brightness == Brightness.dark;

  /* Phone-only surfaces, derived from the desktop tokens above. */

  /// Search fields and other inputs on a panel.
  Color get fieldBg => isDark ? bgElevated : bgSunken;

  /// Track of a segmented control (the panel's tabs, detail tabs).
  Color get trackBg => bgSunken;

  /// The selected segment, raised from its track.
  Color get thumbBg => isDark ? bgActive : bgPanel;

  /// Grouped cards on the page background.
  Color get cardBg => isDark ? bgElevated : bgPanel;

  /// Hairline between rows of a list.
  Color get hairline => border.withValues(alpha: isDark ? 0.7 : 0.9);

  /// Soft shadow under raised segments, pills and sheets.
  List<BoxShadow> get raised => <BoxShadow>[
        BoxShadow(
            color: Colors.black.withValues(alpha: isDark ? 0.35 : 0.08),
            blurRadius: 6,
            offset: const Offset(0, 1)),
      ];

  static const DurbunColors dark = DurbunColors(
    brightness: Brightness.dark,
    bgApp: Color(0xFF0B0D12),
    bgPanel: Color(0xFF11141B),
    bgElevated: Color(0xFF171B24),
    bgSunken: Color(0xFF0D1016),
    bgHover: Color(0xFF1B2030),
    bgActive: Color(0xFF222839),
    bgSelected: Color(0x297C6CF2),
    border: Color(0xFF232937),
    borderStrong: Color(0xFF2F3647),
    text: Color(0xFFE6E9F0),
    textMuted: Color(0xFF9AA3B5),
    textSubtle: Color(0xFF6B7488),
    textMeta: Color(0xFF858EA2),
    accent: Color(0xFF7C6CF2),
    accentSoft: Color(0x2E7C6CF2),
    badgeAccent: Color(0xFFA397F8),
    lvVerbose: Color(0xFF7D8799),
    lvDebug: Color(0xFF4EA1FF),
    lvInfo: Color(0xFF3DD68C),
    lvWarn: Color(0xFFF5B544),
    lvError: Color(0xFFFF6369),
    lvFatal: Color(0xFFFF4FD8),
    lvWarnBg: Color(0x12F5B544),
    lvErrorBg: Color(0x17FF6369),
    lvFatalBg: Color(0x21FF4FD8),
    mGet: Color(0xFF4EA1FF),
    mPost: Color(0xFF3DD68C),
    mPut: Color(0xFFF5B544),
    mPatch: Color(0xFFB18CFF),
    mDelete: Color(0xFFFF6369),
    mOther: Color(0xFF9AA3B5),
    st2xx: Color(0xFF3DD68C),
    st3xx: Color(0xFF5CC8FF),
    st4xx: Color(0xFFF5B544),
    st5xx: Color(0xFFFF6369),
    stPending: Color(0xFF9AA3B5),
    jsonKey: Color(0xFF9CC2FF),
    jsonString: Color(0xFFA5E3B4),
    jsonNumber: Color(0xFFF5C27A),
    jsonBool: Color(0xFFD7A4FF),
    jsonNull: Color(0xFF8B94A7),
    success: Color(0xFF3DD68C),
    warning: Color(0xFFF5B544),
    danger: Color(0xFFFF6369),
    info: Color(0xFF4EA1FF),
    successSoft: Color(0x1F3DD68C),
    warningSoft: Color(0x1FF5B544),
    dangerSoft: Color(0x1FFF6369),
    infoSoft: Color(0x1F4EA1FF),
    hlMark: Color(0x4DF5B544),
    inputBg: Color(0xFF0D1016),
    pickOrange: Color(0xFFFF9F43),
    pickYellow: Color(0xFFF5D544),
    pickGreen: Color(0xFF3DD68C),
    pickBlue: Color(0xFF4EA1FF),
    pickViolet: Color(0xFFB18CFF),
    sdkFlutter: Color(0xFF54C5F8),
    sdkAndroid: Color(0xFF3DDC84),
    sdkIos: Color(0xFFC9CFDB),
    sdkDart: Color(0xFF40C4FF),
    tagL: 0.8,
    tagC: 0.11,
    tagBgA: 0.14,
  );

  static const DurbunColors light = DurbunColors(
    brightness: Brightness.light,
    bgApp: Color(0xFFF5F6F9),
    bgPanel: Color(0xFFFFFFFF),
    bgElevated: Color(0xFFFFFFFF),
    bgSunken: Color(0xFFEEF0F4),
    bgHover: Color(0xFFF0F2F7),
    bgActive: Color(0xFFE6E9F1),
    bgSelected: Color(0x1A5B4BE0),
    border: Color(0xFFE3E6EE),
    borderStrong: Color(0xFFCDD2DE),
    text: Color(0xFF161A23),
    textMuted: Color(0xFF5B6476),
    textSubtle: Color(0xFF8A93A6),
    textMeta: Color(0xFF5D667A),
    accent: Color(0xFF5B4BE0),
    accentSoft: Color(0x1A5B4BE0),
    badgeAccent: Color(0xFF4A3ACB),
    lvVerbose: Color(0xFF6B7488),
    lvDebug: Color(0xFF1F6FEB),
    lvInfo: Color(0xFF1A7F4B),
    lvWarn: Color(0xFFB7791F),
    lvError: Color(0xFFD93A41),
    lvFatal: Color(0xFFC2188F),
    lvWarnBg: Color(0x14B7791F),
    lvErrorBg: Color(0x12D93A41),
    lvFatalBg: Color(0x17C2188F),
    mGet: Color(0xFF1F6FEB),
    mPost: Color(0xFF1A7F4B),
    mPut: Color(0xFFB7791F),
    mPatch: Color(0xFF7A4CD9),
    mDelete: Color(0xFFD93A41),
    mOther: Color(0xFF5B6476),
    st2xx: Color(0xFF1A7F4B),
    st3xx: Color(0xFF0E7AB8),
    st4xx: Color(0xFFB7791F),
    st5xx: Color(0xFFD93A41),
    stPending: Color(0xFF5B6476),
    jsonKey: Color(0xFF1F4FB8),
    jsonString: Color(0xFF1A7F4B),
    jsonNumber: Color(0xFFA15C00),
    jsonBool: Color(0xFF7A4CD9),
    jsonNull: Color(0xFF6B7488),
    success: Color(0xFF1A7F4B),
    warning: Color(0xFFB7791F),
    danger: Color(0xFFD93A41),
    info: Color(0xFF1F6FEB),
    successSoft: Color(0x1A1A7F4B),
    warningSoft: Color(0x1CB7791F),
    dangerSoft: Color(0x17D93A41),
    infoSoft: Color(0x171F6FEB),
    hlMark: Color(0x61FFC400),
    inputBg: Color(0xFFFFFFFF),
    pickOrange: Color(0xFFC86412),
    pickYellow: Color(0xFFA68A00),
    pickGreen: Color(0xFF1A7F4B),
    pickBlue: Color(0xFF1F6FEB),
    pickViolet: Color(0xFF7A4CD9),
    sdkFlutter: Color(0xFF0277BD),
    sdkAndroid: Color(0xFF1A7F4B),
    sdkIos: Color(0xFF3B4252),
    sdkDart: Color(0xFF0175C2),
    tagL: 0.48,
    tagC: 0.13,
    tagBgA: 0.1,
  );

  /// The desktop default is dark; the panel follows the phone's setting.
  static DurbunColors of(BuildContext context) =>
      DurbunTheme.maybeOf(context)?.colors ??
      ((MediaQuery.maybePlatformBrightnessOf(context) ?? Brightness.dark) ==
              Brightness.light
          ? light
          : dark);

  Color level(String level) => switch (level) {
    'verbose' => lvVerbose,
    'debug' => lvDebug,
    'info' => lvInfo,
    'warn' => lvWarn,
    'error' => lvError,
    'fatal' => lvFatal,
    _ => lvVerbose,
  };

  Color? levelBg(String level) => switch (level) {
    'warn' => lvWarnBg,
    'error' => lvErrorBg,
    'fatal' => lvFatalBg,
    _ => null,
  };

  Color method(String method) => switch (method.toUpperCase()) {
    'GET' => mGet,
    'POST' => mPost,
    'PUT' => mPut,
    'PATCH' => mPatch,
    'DELETE' => mDelete,
    _ => mOther,
  };

  Color status(int? status, {bool failed = false}) {
    if (failed) return st5xx;
    if (status == null) return stPending;
    if (status >= 500) return st5xx;
    if (status >= 400) return st4xx;
    if (status >= 300) return st3xx;
    return st2xx;
  }

  /// Tag / process chip colors: the desktop's `oklch(L C hue)` with the hue
  /// from an FNV-1a hash of the name, so a tag has the same color everywhere.
  (Color fg, Color bg) tag(String name) {
    final key = (name, brightness);
    final cached = _tagCache[key];
    if (cached != null) return cached;
    final fg = oklch(tagL, tagC, hashHue(name).toDouble());
    final result = (fg, fg.withValues(alpha: tagBgA));
    if (_tagCache.length > 2000) _tagCache.clear();
    _tagCache[key] = result;
    return result;
  }

  static final Map<(String, Brightness), (Color, Color)> _tagCache =
      <(String, Brightness), (Color, Color)>{};
}

/// 32-bit FNV-1a over UTF-16 code units, as `packages/ui/src/lib/hash.ts`.
int fnv1a(String input) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < input.length; i++) {
    hash ^= input.codeUnitAt(i);
    hash = (hash * 0x01000193) & 0xFFFFFFFF;
  }
  return hash;
}

int hashHue(String name) => fnv1a(name) % 360;

/// CSS `oklch()` → sRGB (clipped).
Color oklch(double l, double c, double hueDeg) {
  final h = hueDeg * math.pi / 180;
  final a = c * math.cos(h);
  final b = c * math.sin(h);
  final l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  final m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  final s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  final ll = l_ * l_ * l_, mm = m_ * m_ * m_, ss = s_ * s_ * s_;
  final r = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss;
  final g = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss;
  final bl = -0.0041960863 * ll - 0.7034186147 * mm + 1.7076147010 * ss;
  double enc(double x) {
    final v = x <= 0.0031308 ? 12.92 * x : 1.055 * math.pow(x, 1 / 2.4) - 0.055;
    return v.clamp(0.0, 1.0);
  }

  return Color.from(alpha: 1, red: enc(r), green: enc(g), blue: enc(bl));
}

/// Typography: the desktop uses Inter for UI and JetBrains Mono for data.
/// The panel keeps the phone's system font (SF / Roboto, close to Inter) and
/// its monospace (Menlo / Roboto Mono), so it adds no font to the app.
abstract final class DurbunType {
  static const String mono = 'monospace';
  static const List<String> monoFallback = <String>['Menlo', 'Courier New', 'Courier'];

  static const double xs = 11;
  static const double sm = 12;
  static const double md = 13;
  static const double lg = 15;
  static const double xl = 18;
  static const double logFs = 12.5;

  static TextStyle monoStyle({double size = logFs, Color? color, FontWeight? weight, double height = 1.45}) =>
      TextStyle(
        fontFamily: mono,
        fontFamilyFallback: monoFallback,
        fontSize: size,
        color: color,
        fontWeight: weight,
        height: height,
        fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
      );
}

/// Radii. Rounder than the desktop's (4 / 6 / 10): on a phone the panel
/// sits among the system's own rounded controls.
abstract final class DurbunRadius {
  static const double sm = 5;
  static const double md = 9;
  static const double lg = 13;
  static const double xl = 20;
  static const double pill = 999;
}

/// Puts the tokens (and a matching Material theme) under the panel.
class DurbunTheme extends InheritedWidget {
  const DurbunTheme({super.key, required this.colors, required super.child});

  final DurbunColors colors;

  static DurbunTheme? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<DurbunTheme>();

  static Widget wrap(BuildContext context, Widget child) {
    final c = (MediaQuery.maybePlatformBrightnessOf(context) ?? Brightness.dark) ==
            Brightness.light
        ? DurbunColors.light
        : DurbunColors.dark;
    final scheme = ColorScheme(
      brightness: c.brightness,
      primary: c.accent,
      onPrimary: Colors.white,
      secondary: c.accent,
      onSecondary: Colors.white,
      error: c.danger,
      onError: Colors.white,
      surface: c.bgPanel,
      onSurface: c.text,
      onSurfaceVariant: c.textMuted,
      outline: c.borderStrong,
      outlineVariant: c.border,
      surfaceContainerHighest: c.bgElevated,
    );
    final rounded = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(DurbunRadius.lg),
      side: BorderSide(color: c.border),
    );
    return DurbunTheme(
      colors: c,
      child: Theme(
        data: ThemeData(
          useMaterial3: true,
          colorScheme: scheme,
          scaffoldBackgroundColor: c.bgApp,
          canvasColor: c.bgPanel,
          dividerColor: c.border,
          visualDensity: VisualDensity.compact,
          // A press darkens the row instead of a Material ink ripple.
          splashFactory: NoSplash.splashFactory,
          splashColor: Colors.transparent,
          highlightColor: c.bgHover,
          hoverColor: c.bgHover,
          textSelectionTheme: TextSelectionThemeData(
            cursorColor: c.accent,
            selectionColor: c.accent.withValues(alpha: 0.3),
            selectionHandleColor: c.accent,
          ),
          appBarTheme: AppBarTheme(
            backgroundColor: c.bgPanel,
            surfaceTintColor: Colors.transparent,
            foregroundColor: c.text,
            elevation: 0,
            scrolledUnderElevation: 0,
            toolbarHeight: 50,
            titleTextStyle: TextStyle(color: c.text, fontSize: 15.5, fontWeight: FontWeight.w600),
            iconTheme: IconThemeData(color: c.text, size: 20),
            actionsIconTheme: IconThemeData(color: c.textMuted, size: 20),
          ),
          actionIconTheme: ActionIconThemeData(
            backButtonIconBuilder: (_) => const Icon(Icons.arrow_back_ios_new_rounded, size: 19),
            closeButtonIconBuilder: (_) => const Icon(Icons.close_rounded, size: 22),
          ),
          snackBarTheme: SnackBarThemeData(
            backgroundColor: c.isDark ? c.bgActive : c.text,
            contentTextStyle: TextStyle(color: c.isDark ? c.text : c.bgPanel, fontSize: DurbunType.md, fontWeight: FontWeight.w500),
            behavior: SnackBarBehavior.floating,
            elevation: 0,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DurbunRadius.lg)),
          ),
          bottomSheetTheme: BottomSheetThemeData(
            backgroundColor: c.bgPanel,
            surfaceTintColor: Colors.transparent,
            dragHandleColor: c.borderStrong,
            dragHandleSize: const Size(36, 4),
            shape: const RoundedRectangleBorder(
                borderRadius: BorderRadius.vertical(top: Radius.circular(DurbunRadius.xl))),
          ),
          popupMenuTheme: PopupMenuThemeData(
            color: c.bgElevated,
            surfaceTintColor: Colors.transparent,
            elevation: 10,
            shadowColor: Colors.black.withValues(alpha: 0.4),
            shape: rounded,
            textStyle: TextStyle(color: c.text, fontSize: 14),
          ),
          tooltipTheme: TooltipThemeData(
            decoration: BoxDecoration(
                color: c.isDark ? c.bgActive : c.text,
                borderRadius: BorderRadius.circular(DurbunRadius.md)),
            textStyle: TextStyle(color: c.isDark ? c.text : c.bgPanel, fontSize: 12),
            waitDuration: const Duration(milliseconds: 500),
          ),
          switchTheme: SwitchThemeData(
            thumbColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? Colors.white : c.textMuted),
            trackColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? c.accent : c.bgActive),
            trackOutlineColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? c.accent : c.borderStrong),
          ),
          checkboxTheme: CheckboxThemeData(
            fillColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? c.accent : Colors.transparent),
            checkColor: const WidgetStatePropertyAll<Color>(Colors.white),
            side: BorderSide(color: c.borderStrong, width: 1.5),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DurbunRadius.sm)),
          ),
          textButtonTheme: TextButtonThemeData(
            style: TextButton.styleFrom(
              foregroundColor: c.accent,
              textStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DurbunRadius.md)),
            ),
          ),
          dividerTheme: DividerThemeData(color: c.border, thickness: 1, space: 1),
        ),
        child: DefaultTextStyle.merge(
          style: TextStyle(color: c.text, fontSize: DurbunType.md, height: 1.45),
          child: child,
        ),
      ),
    );
  }

  @override
  bool updateShouldNotify(DurbunTheme old) => old.colors != colors;
}

/// The Dürbün logo (`packages/ui/public/icon.svg`), drawn.
class DurbunLogo extends StatelessWidget {
  const DurbunLogo({super.key, this.size = 22});

  final double size;

  @override
  Widget build(BuildContext context) =>
      CustomPaint(size: Size.square(size), painter: const _LogoPainter());
}

class _LogoPainter extends CustomPainter {
  const _LogoPainter();

  static const Color _purple = Color(0xFF7C6CF2);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 32, size.height / 32);
    final purple = Paint()..color = _purple;
    final white = Paint()..color = Colors.white;
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(0, 0, 32, 32), const Radius.circular(7.5)), purple);
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(8.6, 6.2, 4.4, 4.6), const Radius.circular(1.2)), white);
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(19, 6.2, 4.4, 4.6), const Radius.circular(1.2)), white);
    canvas.drawRRect(
      RRect.fromLTRBAndCorners(7.4, 10.2, 14.6, 17.2, topLeft: const Radius.circular(2.4), topRight: const Radius.circular(2.4)),
      white,
    );
    canvas.drawRRect(
      RRect.fromLTRBAndCorners(17.4, 10.2, 24.6, 17.2, topLeft: const Radius.circular(2.4), topRight: const Radius.circular(2.4)),
      white,
    );
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(13.6, 12.6, 4.8, 3.6), const Radius.circular(1)), white);
    canvas.drawCircle(const Offset(11, 20.4), 5.4, white);
    canvas.drawCircle(const Offset(21, 20.4), 5.4, white);
    canvas.drawCircle(const Offset(11, 20.4), 2.9, purple);
    canvas.drawCircle(const Offset(21, 20.4), 2.9, purple);
    final glint = Paint()..color = Colors.white.withValues(alpha: 0.85);
    canvas.drawCircle(const Offset(10, 19.3), 0.9, glint);
    canvas.drawCircle(const Offset(20, 19.3), 0.9, glint);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_LogoPainter oldDelegate) => false;
}
