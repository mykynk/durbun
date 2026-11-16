/// Design tokens of the in-app inspector: the panel's own SDK design system.
/// Close to the desktop UI (`packages/ui/src/styles/tokens.css`) in spirit:
/// the same dark-first slate surfaces, violet accent and status colours,
/// but tuned for a phone (deeper surfaces, tonal depth and a 1 pt outline
/// instead of shadows, a larger type scale), so it is no longer a
/// value-for-value copy of the desktop.
library;

import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable, visibleForTesting;
import 'package:flutter/material.dart';

import 'panel_prefs.dart';

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
    required this.accent,
    required this.accentSoft,
    required this.accentInk,
    required this.accentFill,
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
  /// Three text roles, as the desktop: [text], [textMuted], [textSubtle].
  final Color text, textMuted, textSubtle;

  /// [accent]: lines and marks. [accentSoft]: the tonal fill (selection
  /// tint, tonal buttons). [accentInk]: accent text and icons on the
  /// panel's surfaces. [accentFill]: filled surfaces (primary button,
  /// selected segment and chip, the active tab) with an [onAccent] label.
  final Color accent, accentSoft, accentInk, accentFill;
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

  /* Surfaces of the panel, derived from the tokens above. */

  /// Search fields and other inputs.
  Color get fieldBg => bgPanel;

  /// Track of a segmented control.
  Color get trackBg => bgPanel;

  /// Cards on the page background (a request, a log line, a group of rows).
  Color get cardBg => bgPanel;

  /// Chips and small boxed buttons: one step above a card.
  Color get chipBg => bgElevated;

  /// Hairline between rows of a list and under a header.
  Color get hairline => isDark ? const Color(0xFF1E2330) : const Color(0xFFE2E8F0);

  /// Label on [accentFill]: dark on the bright violet of the dark theme,
  /// white on the deeper violet of the light one.
  Color get onAccent => isDark ? bgApp : const Color(0xFFFFFFFF);

  /// Label on a [danger] fill (a count of errors, a failed request).
  Color get onDanger => isDark ? bgApp : const Color(0xFFFFFFFF);

  /// Soft shadow under floating things on light (menus, the bubble, the
  /// navigation bar); on dark the outline and the surface step lift them.
  List<BoxShadow> get raised => isDark
      ? const <BoxShadow>[]
      : <BoxShadow>[
          BoxShadow(color: const Color(0xFF0F172A).withValues(alpha: 0.06), blurRadius: 4, offset: const Offset(0, 1)),
        ];

  /// The bubble, toasts and the navigation bar over the content.
  List<BoxShadow> get floating => isDark
      ? const <BoxShadow>[]
      : <BoxShadow>[
          BoxShadow(color: const Color(0xFF0F172A).withValues(alpha: 0.10), blurRadius: 16, offset: const Offset(0, 4)),
          BoxShadow(color: const Color(0xFF0F172A).withValues(alpha: 0.06), blurRadius: 3, offset: const Offset(0, 1)),
        ];

  /// Dark, the panel's first theme: deep slate surfaces in three steps
  /// (page, card, raised), a 1 pt outline, a bright violet with dark
  /// labels on it, and status colours that read on their own tints.
  static const DurbunColors dark = DurbunColors(
    brightness: Brightness.dark,
    bgApp: Color(0xFF0B0D14),
    bgPanel: Color(0xFF12151F),
    bgElevated: Color(0xFF1A1E2B),
    bgSunken: Color(0xFF0B0D14),
    bgHover: Color(0xFF1F2433),
    bgActive: Color(0xFF262C3C),
    bgSelected: Color(0x297C6BFF),
    border: Color(0xFF272D3D),
    borderStrong: Color(0xFF343B4F),
    text: Color(0xFFF1F5F9),
    textMuted: Color(0xFF94A3B8),
    textSubtle: Color(0xFF8391A7),
    accent: Color(0xFF7C6BFF),
    accentSoft: Color(0x2E7C6BFF),
    // Violet text and icons on the dark surfaces (the fill is too dark for
    // small text on a card).
    accentInk: Color(0xFFA193FF),
    accentFill: Color(0xFF7C6BFF),
    lvVerbose: Color(0xFF8B97AB),
    lvDebug: Color(0xFF38BDF8),
    lvInfo: Color(0xFF22C55E),
    lvWarn: Color(0xFFF59E0B),
    lvError: Color(0xFFF64C68),
    lvFatal: Color(0xFFFB7185),
    lvWarnBg: Color(0x14F59E0B),
    lvErrorBg: Color(0x1AF64C68),
    lvFatalBg: Color(0x26F64C68),
    mGet: Color(0xFF38BDF8),
    mPost: Color(0xFF22C55E),
    mPut: Color(0xFFF59E0B),
    mPatch: Color(0xFFA78BFA),
    mDelete: Color(0xFFF64C68),
    mOther: Color(0xFF94A3B8),
    st2xx: Color(0xFF22C55E),
    st3xx: Color(0xFF38BDF8),
    st4xx: Color(0xFFF59E0B),
    // A touch lighter than a pure rose so the red reads on its own tint.
    st5xx: Color(0xFFF64C68),
    stPending: Color(0xFF94A3B8),
    jsonKey: Color(0xFF38BDF8),
    jsonString: Color(0xFF22C55E),
    jsonNumber: Color(0xFFF59E0B),
    jsonBool: Color(0xFFA78BFA),
    jsonNull: Color(0xFF8391A7),
    success: Color(0xFF22C55E),
    warning: Color(0xFFF59E0B),
    danger: Color(0xFFF64C68),
    info: Color(0xFF38BDF8),
    successSoft: Color(0x2422C55E),
    warningSoft: Color(0x24F59E0B),
    dangerSoft: Color(0x24F64C68),
    infoSoft: Color(0x2438BDF8),
    hlMark: Color(0x4DF59E0B),
    inputBg: Color(0xFF12151F),
    pickOrange: Color(0xFFFF9F43),
    pickYellow: Color(0xFFF5D544),
    pickGreen: Color(0xFF22C55E),
    pickBlue: Color(0xFF38BDF8),
    pickViolet: Color(0xFFA78BFA),
    sdkFlutter: Color(0xFF54C5F8),
    sdkAndroid: Color(0xFF3DDC84),
    sdkIos: Color(0xFFC9CFDB),
    sdkDart: Color(0xFF40C4FF),
    tagL: 0.8,
    tagC: 0.11,
    tagBgA: 0.14,
  );

  /// Light: the same surfaces in slate on white, a deeper violet with a
  /// white label, and status, method and level inks dark enough for 4.5:1
  /// on the page and on their own tints (a status badge, an error card).
  static const DurbunColors light = DurbunColors(
    brightness: Brightness.light,
    bgApp: Color(0xFFF8FAFC),
    bgPanel: Color(0xFFFFFFFF),
    bgElevated: Color(0xFFF1F5F9),
    bgSunken: Color(0xFFF1F5F9),
    bgHover: Color(0xFFEEF2F6),
    bgActive: Color(0xFFE2E8F0),
    bgSelected: Color(0x1A5B4BE0),
    border: Color(0xFFCBD5E1),
    borderStrong: Color(0xFFB6C0CE),
    text: Color(0xFF0F172A),
    textMuted: Color(0xFF475569),
    textSubtle: Color(0xFF5B6779),
    accent: Color(0xFF5B4BE0),
    accentSoft: Color(0x1A5B4BE0),
    accentInk: Color(0xFF4B3BD0),
    accentFill: Color(0xFF5B4BE0),
    lvVerbose: Color(0xFF5B6779),
    lvDebug: Color(0xFF0369A1),
    lvInfo: Color(0xFF13703A),
    lvWarn: Color(0xFF9A4A06),
    lvError: Color(0xFFBE123C),
    lvFatal: Color(0xFF9F1239),
    lvWarnBg: Color(0x14B45309),
    lvErrorBg: Color(0x12E11D48),
    lvFatalBg: Color(0x1AE11D48),
    mGet: Color(0xFF0369A1),
    mPost: Color(0xFF13703A),
    mPut: Color(0xFF9A4A06),
    mPatch: Color(0xFF6D28D9),
    mDelete: Color(0xFFBE123C),
    mOther: Color(0xFF475569),
    st2xx: Color(0xFF13703A),
    st3xx: Color(0xFF0369A1),
    st4xx: Color(0xFF9A4A06),
    st5xx: Color(0xFFBE123C),
    stPending: Color(0xFF475569),
    jsonKey: Color(0xFF0369A1),
    jsonString: Color(0xFF13703A),
    jsonNumber: Color(0xFF9A4A06),
    jsonBool: Color(0xFF6D28D9),
    jsonNull: Color(0xFF5B6779),
    success: Color(0xFF13703A),
    warning: Color(0xFF9A4A06),
    danger: Color(0xFFBE123C),
    info: Color(0xFF0369A1),
    successSoft: Color(0x1A16A34A),
    warningSoft: Color(0x1CD97706),
    dangerSoft: Color(0x17E11D48),
    infoSoft: Color(0x170284C7),
    hlMark: Color(0x61FFC400),
    inputBg: Color(0xFFFFFFFF),
    pickOrange: Color(0xFFA3510F),
    pickYellow: Color(0xFF7D6800),
    pickGreen: Color(0xFF13703A),
    pickBlue: Color(0xFF0369A1),
    pickViolet: Color(0xFF6D28D9),
    sdkFlutter: Color(0xFF0A6AA6),
    sdkAndroid: Color(0xFF13703A),
    sdkIos: Color(0xFF3B4252),
    sdkDart: Color(0xFF0A5F90),
    tagL: 0.48,
    tagC: 0.13,
    tagBgA: 0.1,
  );

  /// The panel's theme: the one chosen with its theme switch, else the
  /// phone's setting (dark when unknown).
  static DurbunColors of(BuildContext context) =>
      DurbunTheme.maybeOf(context)?.colors ?? forBrightness(panelBrightness(context));

  static DurbunColors forBrightness(Brightness b) => b == Brightness.light ? light : dark;

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

/// Typography. The panel adds no font to the app: it uses the phone's
/// system face (SF / Roboto) for the UI and the system monospace for data.
///
/// The scale: [caption] (11) small labels, badges, the nav bar; [sm] (12)
/// hints and meta lines; [body] (13) labels of chips, buttons and rows;
/// [bodyMd] (14) running text (a log message); [label] (15) row and tile
/// titles; [title] (18) page and sheet titles; [headline] (22) and
/// [figure] (28) large numbers, bold with tight tracking ([heading],
/// [figureStyle]). Weights 400 to 600, 700 only for figures. Mono is for
/// data only (paths, hosts, statuses, sizes, durations, times, headers,
/// bodies): [monoSm] meta, [monoMd] paths and bodies. Numbers are always
/// tabular.
abstract final class DurbunType {
  static const String mono = 'monospace';
  static const List<String> monoFallback = <String>['Menlo', 'Roboto Mono', 'Courier New', 'Courier'];

  static const double caption = 11;
  static const double sm = 12;
  static const double body = 13;
  static const double bodyMd = 14;
  static const double label = 15;
  static const double title = 18;
  static const double headline = 22;
  static const double figure = 28;
  static const double monoSm = 11;
  static const double monoMd = 13;
  static const double monoRow = 12;
  static const double monoBody = 13;

  // Older names of the scale.
  static const double xs = caption;
  static const double md = body;
  static const double lg = label;
  static const double xl = title;
  static const double logFs = monoBody;

  static const List<FontFeature> tabular = <FontFeature>[FontFeature.tabularFigures()];

  /// The UI face with tabular figures.
  static TextStyle ui(
          {double size = body, Color? color, FontWeight weight = FontWeight.w400, double height = 1.35, double? letterSpacing}) =>
      TextStyle(fontSize: size, color: color, fontWeight: weight, height: height, letterSpacing: letterSpacing, fontFeatures: tabular);

  /// Page, sheet and card titles: semibold, tracked a little tighter the
  /// larger they are.
  static TextStyle heading({double size = title, Color? color, FontWeight weight = FontWeight.w600}) => TextStyle(
        fontSize: size,
        color: color,
        fontWeight: weight,
        height: size >= headline ? 1.27 : (size >= title ? 1.33 : 1.33),
        letterSpacing: size >= headline ? -0.25 : (size >= title ? -0.15 : 0),
        fontFeatures: tabular,
      );

  /// A large number (a stat tile, the FPS): bold, tight, tabular.
  static TextStyle figureStyle({double size = figure, Color? color}) => TextStyle(
        fontSize: size,
        color: color,
        fontWeight: FontWeight.w700,
        height: 1.2,
        letterSpacing: size >= figure ? -0.4 : -0.2,
        fontFeatures: tabular,
      );

  static TextStyle monoStyle({double size = logFs, Color? color, FontWeight? weight, double height = 1.45}) =>
      TextStyle(
        fontFamily: mono,
        fontFamilyFallback: monoFallback,
        fontSize: size,
        color: color,
        fontWeight: weight,
        height: height,
        fontFeatures: tabular,
      );
}

/// Radii: [sm] badges and tokens, [md] inputs, buttons and small tiles,
/// [lg] cards, [xl] sheets, dialogs and the navigation bar, [pill] chips.
/// A part inside another takes the outer radius minus the gap between them.
abstract final class DurbunRadius {
  static const double sm = 6;
  static const double md = 10;
  static const double lg = 12;
  static const double xl = 20;
  static const double pill = 999;
}

/// The 4 pt spacing scale and the page's measures.
abstract final class DurbunSpace {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;

  /// Left and right margin of a page.
  static const double gutter = 16;

  /// Space between two cards of a list (tight: lists are long).
  static const double cardGap = 6;

  /// Lists, sheets and pages stop growing past this width (landscape,
  /// tablets) and sit centred.
  static const double maxContent = 720;
}

/// Motion: mechanical and short. [fast] a state change (press, select,
/// toggle), [medium] a surface (sheet, expand, the theme), [slow] a page.
/// Nothing loops.
abstract final class DurbunMotion {
  static const Duration fast = Duration(milliseconds: 100);
  static const Duration medium = Duration(milliseconds: 200);
  static const Duration slow = Duration(milliseconds: 250);
  static const Curve curve = Curves.easeOut;
  static const Curve enter = Cubic(0.2, 0, 0, 1);

  /// [d], or nothing when the system asks for fewer animations.
  static Duration of(BuildContext context, Duration d) =>
      (MediaQuery.maybeDisableAnimationsOf(context) ?? false) ? Duration.zero : d;
}

/// The theme picked with the panel's theme switch; null follows the phone.
/// Kept for the app's run and, where the panel can keep small values, for
/// later launches too.
final ValueNotifier<Brightness?> _themeChoice = ValueNotifier<Brightness?>(null);
const String _kThemePref = 'panel-theme';
bool _themeLoaded = false;

/// The theme picked with the switch (null: the phone's).
ValueListenable<Brightness?> get panelThemeChoice => _themeChoice;

/// The brightness the panel is drawn in under [context].
Brightness panelBrightness(BuildContext context) =>
    _themeChoice.value ?? MediaQuery.maybePlatformBrightnessOf(context) ?? Brightness.dark;

/// Flips the panel between light and dark. Landing on the phone's own
/// brightness follows the phone again.
void togglePanelTheme(BuildContext context) {
  final system = MediaQuery.maybePlatformBrightnessOf(context) ?? Brightness.dark;
  final next = panelBrightness(context) == Brightness.dark ? Brightness.light : Brightness.dark;
  _themeChoice.value = next == system ? null : next;
  _themeLoaded = true;
  // Fire and forget; a failed write only loses the choice on the next launch.
  writePanelPref(_kThemePref, _themeChoice.value?.name).ignore();
}

/// Reads the kept choice once per run, before the panel's first frame.
/// Returns at once when nothing can be kept (tests, the web).
Future<void> loadPanelTheme() async {
  if (_themeLoaded) return;
  _themeLoaded = true;
  if (!panelPrefsAvailable) return;
  try {
    final kept = await readPanelPref(_kThemePref).timeout(const Duration(milliseconds: 300), onTimeout: () => null);
    if (_themeChoice.value != null) return;
    _themeChoice.value = switch (kept) { 'light' => Brightness.light, 'dark' => Brightness.dark, _ => null };
  } catch (_) {
    // A theme is a nicety: the app never sees its errors.
  }
}

/// Whether [loadPanelTheme] has nothing left to do.
bool get panelThemeLoaded => _themeLoaded || !panelPrefsAvailable;

@visibleForTesting
void debugResetPanelTheme() {
  _themeChoice.value = null;
  _themeLoaded = false;
}

/// Caps [child] at [DurbunSpace.maxContent] and centres it (landscape,
/// tablets); a phone in portrait is narrower and sees no change.
class MaxWidth extends StatelessWidget {
  const MaxWidth({super.key, required this.child, this.width = DurbunSpace.maxContent});

  final Widget child;
  final double width;

  @override
  Widget build(BuildContext context) => Center(
        child: ConstrainedBox(constraints: BoxConstraints(maxWidth: width), child: child),
      );
}

/// Puts the tokens (and a matching Material theme) under the panel.
class DurbunTheme extends InheritedWidget {
  const DurbunTheme({super.key, required this.colors, required super.child});

  final DurbunColors colors;

  static DurbunTheme? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<DurbunTheme>();

  /// The panel's tokens and Material theme over [child]; follows the
  /// theme switch.
  static Widget wrap(BuildContext context, Widget child) => ValueListenableBuilder<Brightness?>(
        valueListenable: _themeChoice,
        child: child,
        builder: (context, _, child) => _build(context, child!),
      );

  static Widget _build(BuildContext context, Widget child) {
    final c = DurbunColors.forBrightness(panelBrightness(context));
    final scheme = ColorScheme(
      brightness: c.brightness,
      primary: c.accentFill,
      onPrimary: c.onAccent,
      secondary: c.accentFill,
      onSecondary: c.onAccent,
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
            backgroundColor: c.bgApp,
            surfaceTintColor: Colors.transparent,
            foregroundColor: c.text,
            elevation: 0,
            scrolledUnderElevation: 0,
            // A hairline under every sub-page's bar, as under the panel's header.
            shape: Border(bottom: BorderSide(color: c.hairline)),
            toolbarHeight: 56,
            titleTextStyle: DurbunType.heading(color: c.text).copyWith(height: 1.2),
            iconTheme: IconThemeData(color: c.text, size: 20),
            actionsIconTheme: IconThemeData(color: c.textMuted, size: 20),
          ),
          actionIconTheme: ActionIconThemeData(
            backButtonIconBuilder: (_) => const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
            closeButtonIconBuilder: (_) => const Icon(Icons.close_rounded, size: 20),
          ),
          snackBarTheme: SnackBarThemeData(
            backgroundColor: c.isDark ? c.bgActive : c.text,
            contentTextStyle: TextStyle(color: c.isDark ? c.text : c.bgPanel, fontSize: DurbunType.body, fontWeight: FontWeight.w500),
            behavior: SnackBarBehavior.floating,
            elevation: 0,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DurbunRadius.md)),
          ),
          bottomSheetTheme: BottomSheetThemeData(
            backgroundColor: c.bgPanel,
            surfaceTintColor: Colors.transparent,
            dragHandleColor: c.border,
            dragHandleSize: const Size(40, 4),
            modalBarrierColor: (c.isDark ? Colors.black : const Color(0xFF0F172A)).withValues(alpha: c.isDark ? 0.6 : 0.35),
            constraints: const BoxConstraints(maxWidth: DurbunSpace.maxContent),
            shape: const RoundedRectangleBorder(
                borderRadius: BorderRadius.vertical(top: Radius.circular(DurbunRadius.xl))),
          ),
          dialogTheme: DialogThemeData(
            backgroundColor: c.bgPanel,
            surfaceTintColor: Colors.transparent,
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(DurbunRadius.xl),
                side: c.isDark ? BorderSide(color: c.border) : BorderSide.none),
            titleTextStyle: DurbunType.heading(color: c.text),
            contentTextStyle: TextStyle(color: c.textMuted, fontSize: DurbunType.bodyMd, height: 1.45),
          ),
          popupMenuTheme: PopupMenuThemeData(
            color: c.isDark ? c.bgElevated : c.bgPanel,
            surfaceTintColor: Colors.transparent,
            elevation: c.isDark ? 0 : 8,
            shadowColor: Colors.black.withValues(alpha: 0.35),
            shape: rounded,
            textStyle: TextStyle(color: c.text, fontSize: DurbunType.label),
          ),
          tooltipTheme: TooltipThemeData(
            decoration: BoxDecoration(
                color: c.isDark ? c.bgActive : c.text,
                borderRadius: BorderRadius.circular(DurbunRadius.sm)),
            textStyle: TextStyle(color: c.isDark ? c.text : c.bgPanel, fontSize: DurbunType.sm),
            waitDuration: const Duration(milliseconds: 500),
          ),
          switchTheme: SwitchThemeData(
            thumbColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? c.onAccent : c.textMuted),
            trackColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? c.accentFill : c.bgElevated),
            trackOutlineColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? c.accentFill : c.border),
            trackOutlineWidth: const WidgetStatePropertyAll<double>(1),
          ),
          checkboxTheme: CheckboxThemeData(
            fillColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected) ? c.accentFill : Colors.transparent),
            checkColor: WidgetStatePropertyAll<Color>(c.onAccent),
            side: BorderSide(color: c.borderStrong, width: 1.5),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DurbunRadius.sm - 2)),
          ),
          textButtonTheme: TextButtonThemeData(
            style: TextButton.styleFrom(
              foregroundColor: c.accentInk,
              minimumSize: const Size(44, 44),
              textStyle: const TextStyle(fontSize: DurbunType.body, fontWeight: FontWeight.w600, letterSpacing: 0.1),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DurbunRadius.md)),
            ),
          ),
          progressIndicatorTheme: ProgressIndicatorThemeData(color: c.accent, linearTrackColor: c.bgActive),
          dividerTheme: DividerThemeData(color: c.hairline, thickness: 1, space: 1),
        ),
        child: DefaultTextStyle.merge(
          style: TextStyle(color: c.text, fontSize: DurbunType.body, height: 1.45),
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

  static const Color _purple = Color(0xFF7C6BFF);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 32, size.height / 32);
    final purple = Paint()..color = _purple;
    final white = Paint()..color = Colors.white;
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(0, 0, 32, 32), const Radius.circular(9)), purple);
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

/// The logo's binoculars as a line drawing: the panel's mark for empty,
/// waiting and disconnected states (no tile, the colour of muted text).
class DurbunMark extends StatelessWidget {
  const DurbunMark({super.key, this.size = 48, this.color});

  final double size;

  /// Defaults to the subtle text colour.
  final Color? color;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: CustomPaint(
          size: Size.square(size),
          painter: _MarkPainter(color ?? DurbunColors.of(context).textSubtle),
        ),
      );
}

class _MarkPainter extends CustomPainter {
  const _MarkPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 32, size.height / 32);
    final line = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    // Eyepieces, barrels and the bridge, then the two lenses.
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(8.4, 5, 4.6, 4.4), const Radius.circular(1.2)), line);
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(19, 5, 4.6, 4.4), const Radius.circular(1.2)), line);
    canvas.drawPath(
      Path()
        ..moveTo(6.2, 19)
        ..lineTo(7.2, 11.6)
        ..quadraticBezierTo(7.4, 9.4, 9.6, 9.4)
        ..lineTo(12.2, 9.4)
        ..quadraticBezierTo(14.2, 9.4, 14.4, 11.6)
        ..lineTo(14.6, 14.2)
        ..lineTo(17.4, 14.2)
        ..lineTo(17.6, 11.6)
        ..quadraticBezierTo(17.8, 9.4, 19.8, 9.4)
        ..lineTo(22.4, 9.4)
        ..quadraticBezierTo(24.6, 9.4, 24.8, 11.6)
        ..lineTo(25.8, 19),
      line,
    );
    canvas.drawCircle(const Offset(10.6, 21.4), 5.6, line);
    canvas.drawCircle(const Offset(21.4, 21.4), 5.6, line);
    canvas.drawCircle(const Offset(10.6, 21.4), 2.2, line);
    canvas.drawCircle(const Offset(21.4, 21.4), 2.2, line);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.color != color;
}
