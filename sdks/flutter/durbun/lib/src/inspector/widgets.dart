/// Shared components of the in-app inspector, modelled on the desktop UI
/// (`packages/ui/src/components`, `styles/components.css`).
library;

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';

/// Smallest tap target where a row has the room (iOS 44 pt).
const double kMinTapTarget = 44;

/// Copies [text] and confirms with a short toast. The toast goes to the
/// panel's own [ScaffoldMessenger] (the nearest one), so the app's snack
/// bars are never hidden or replaced.
void copyText(BuildContext context, String text, {String? note}) {
  Clipboard.setData(ClipboardData(text: text));
  final t = InspectorStrings.of(context);
  final messenger = ScaffoldMessenger.maybeOf(context);
  messenger?.hideCurrentSnackBar();
  messenger?.showSnackBar(
    SnackBar(
      content: Text(note == null ? t.copied : '${t.copied} · $note'),
      duration: const Duration(milliseconds: 1400),
    ),
  );
}

/// A log level as a word in its colour ("Hata", "Uyarı").
class LevelBadge extends StatelessWidget {
  const LevelBadge(this.level, {super.key, this.size = DurbunType.caption + 1});

  final String level;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Text(
      InspectorStrings.of(context).levelName(level),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(fontSize: size, color: c.level(level), fontWeight: FontWeight.w600, height: 1.2),
    );
  }
}

/// A tag / process chip in the tag's stable hue.
class TagChip extends StatelessWidget {
  const TagChip(this.name, {super.key, this.maxWidth = 120, this.onTap});

  final String name;
  final double maxWidth;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final (fg, bg) = DurbunColors.of(context).tag(name);
    final chip = Container(
      constraints: BoxConstraints(maxWidth: maxWidth),
      height: 18,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
          color: bg, borderRadius: BorderRadius.circular(DurbunRadius.sm)),
      child: Align(
          widthFactor: 1,
          child: Text(name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DurbunType.monoStyle(size: 11.5, color: fg, height: 1.2))),
    );
    return onTap == null ? chip : GestureDetector(onTap: onTap, child: chip);
  }
}

enum BadgeTone { neutral, accent, success, warning, danger, info }

/// Small rounded label (source, build, mock, error kind…).
class DBadge extends StatelessWidget {
  const DBadge(this.text,
      {super.key, this.tone = BadgeTone.neutral, this.icon, this.mono = false});

  final String text;
  final BadgeTone tone;
  final IconData? icon;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final (fg, bg) = switch (tone) {
      BadgeTone.neutral => (c.textMuted, c.bgActive),
      BadgeTone.accent => (c.accentInk, c.accentSoft),
      BadgeTone.success => (c.success, c.successSoft),
      BadgeTone.warning => (c.warning, c.warningSoft),
      BadgeTone.danger => (c.danger, c.dangerSoft),
      BadgeTone.info => (c.info, c.infoSoft),
    };
    final style = mono
        ? DurbunType.monoStyle(
            size: 11, color: fg, weight: FontWeight.w600, height: 1.2)
        : TextStyle(
            fontSize: 11.5,
            color: fg,
            fontWeight: FontWeight.w600,
            height: 1.2);
    return Container(
      height: 20,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
          color: bg, borderRadius: BorderRadius.circular(DurbunRadius.sm)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 12, color: fg),
            const SizedBox(width: 4)
          ],
          Flexible(
              child: Text(text,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
        ],
      ),
    );
  }
}

/// Toggle chip of the toolbars (GET, 4xx, "Errors only"…).
class DToggle extends StatelessWidget {
  const DToggle(
      {super.key,
      required this.label,
      required this.selected,
      required this.onTap,
      this.color,
      this.icon,
      this.trailingIcon,
      this.tonal = false,
      this.mono = false});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  /// A dot in this colour before the label (a method, a status class).
  final Color? color;
  final IconData? icon;

  /// After the label: a chevron when the chip opens a menu.
  final IconData? trailingIcon;

  /// On, drawn as an active filter (accent tint) instead of filled: a
  /// toolbar switch, next to a filled segment. Choices in a sheet stay
  /// filled.
  final bool tonal;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final filled = selected && !tonal;
    final fg = filled ? c.onAccent : (selected ? c.accentInk : c.text);
    return ChipFrame(
      look: !selected ? ChipLook.outline : (tonal ? ChipLook.tonal : ChipLook.filled),
      selected: selected,
      onTap: onTap,
      child: ChipLabel(
        label: label,
        color: fg,
        mono: mono,
        icon: icon,
        dot: color == null ? null : (filled ? c.onAccent : color),
        trailing: trailingIcon == null
            ? null
            : Padding(padding: const EdgeInsets.only(left: 2), child: Icon(trailingIcon, size: 18, color: selected ? fg : c.textMuted)),
      ),
    );
  }
}

/// How a chip is drawn: [outline] off, [filled] selected (accent fill,
/// white label), [tonal] an active filter (accent tint).
enum ChipLook { outline, filled, tonal }

/// A chip's frame: 32 pt drawn, 44 pt to tap, darker while pressed.
class ChipFrame extends StatelessWidget {
  const ChipFrame(
      {super.key, required this.look, required this.onTap, required this.child, this.selected, this.semanticLabel, this.maxWidth = 260});

  final ChipLook look;
  final VoidCallback? onTap;
  final Widget child;
  final bool? selected;
  final String? semanticLabel;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final (bg, side) = switch (look) {
      ChipLook.outline => (c.cardBg, c.border),
      ChipLook.filled => (c.accentFill, c.accentFill),
      ChipLook.tonal => (c.accentSoft, c.accent.withValues(alpha: 0.35)),
    };
    return Semantics(
      button: true,
      selected: selected,
      label: semanticLabel,
      child: Pressable(
        onTap: onTap,
        builder: (pressed) => SizedBox(
          height: kMinTapTarget,
          // widthFactor 1: hugs the label inside a Wrap or a Row.
          child: Center(
            widthFactor: 1,
            child: AnimatedContainer(
              duration: DurbunMotion.of(context, DurbunMotion.fast),
              curve: DurbunMotion.curve,
              height: 32,
              constraints: BoxConstraints(maxWidth: maxWidth),
              padding: const EdgeInsets.symmetric(horizontal: 10),
              foregroundDecoration: pressed
                  ? BoxDecoration(
                      color: (look == ChipLook.filled ? Colors.black : c.text).withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(DurbunRadius.pill))
                  : null,
              decoration: BoxDecoration(
                color: bg,
                borderRadius: BorderRadius.circular(DurbunRadius.pill),
                border: Border.all(color: side),
              ),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

/// A chip's content: an optional colour dot or icon, then the label.
class ChipLabel extends StatelessWidget {
  const ChipLabel({super.key, required this.label, required this.color, this.mono = false, this.icon, this.dot, this.trailing});

  final String label;
  final Color color;
  final bool mono;
  final IconData? icon;
  final Color? dot;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final style = mono
        ? DurbunType.monoStyle(size: DurbunType.monoRow, color: color, weight: FontWeight.w600, height: 1.2)
        : TextStyle(fontSize: DurbunType.body, color: color, fontWeight: FontWeight.w500, height: 1.2);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (dot != null) ...<Widget>[
          Container(width: 6, height: 6, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
          const SizedBox(width: 6),
        ] else if (icon != null) ...<Widget>[
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 5),
        ],
        // Shrinks with an ellipsis when wider than the screen (large text).
        Flexible(child: Text(label, style: style, maxLines: 1, overflow: TextOverflow.ellipsis)),
        if (trailing != null) trailing!,
      ],
    );
  }
}

/// Tap target that tells its [builder] whether it is held down: the
/// panel's controls darken while pressed instead of a Material ripple.
class Pressable extends StatefulWidget {
  const Pressable({super.key, required this.onTap, required this.builder, this.onLongPress});

  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Widget Function(bool pressed) builder;

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _pressed = false;

  void _set(bool v) {
    if (_pressed != v && mounted) setState(() => _pressed = v);
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onTap,
      onLongPress: widget.onLongPress,
      onTapDown: enabled ? (_) => _set(true) : null,
      onTapUp: enabled ? (_) => _set(false) : null,
      onTapCancel: enabled ? () => _set(false) : null,
      child: widget.builder(_pressed),
    );
  }
}

/// The search / query field of the toolbars: a clear button while there is
/// text, and an optional help button that lists the query words.
class DSearchField extends StatefulWidget {
  const DSearchField(
      {super.key,
      required this.hint,
      required this.onChanged,
      this.controller,
      this.trailing,
      this.onHelp,
      this.onSubmitted,
      this.autofocus = false});

  final String hint;
  final bool autofocus;
  final ValueChanged<String> onChanged;

  /// Enter on the keyboard (find: next match).
  final ValueChanged<String>? onSubmitted;
  final TextEditingController? controller;
  final Widget? trailing;
  final VoidCallback? onHelp;

  @override
  State<DSearchField> createState() => _DSearchFieldState();
}

class _DSearchFieldState extends State<DSearchField> {
  TextEditingController? _own;

  TextEditingController get _controller =>
      widget.controller ?? (_own ??= TextEditingController());

  @override
  void dispose() {
    _own?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final controller = _controller;
    return Container(
      height: kMinTapTarget,
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(DurbunRadius.md),
        border: c.isDark ? Border.all(color: c.border) : null,
      ),
      child: Row(
        children: <Widget>[
          const SizedBox(width: 12),
          Icon(Icons.search_rounded, size: 18, color: c.textSubtle),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: widget.onChanged,
              onSubmitted: widget.onSubmitted,
              autofocus: widget.autofocus,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.search,
              style: TextStyle(fontSize: DurbunType.label, color: c.text, height: 1.2),
              cursorColor: c.accent,
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: widget.hint,
                hintMaxLines: 1,
                hintStyle: TextStyle(
                    fontSize: DurbunType.label,
                    color: c.textSubtle,
                    height: 1.2,
                    overflow: TextOverflow.ellipsis),
              ),
            ),
          ),
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: controller,
            builder: (context, v, _) => v.text.isEmpty
                ? const SizedBox.shrink()
                : DIconButton(
                    icon: Icons.close_rounded,
                    tooltip: t.clearSearch,
                    onTap: () {
                      controller.clear();
                      widget.onChanged('');
                    },
                  ),
          ),
          if (widget.onHelp != null)
            DIconButton(
                icon: Icons.help_outline_rounded,
                tooltip: t.queryHelp,
                onTap: widget.onHelp),
          if (widget.trailing != null) widget.trailing!,
          const SizedBox(width: 4),
        ],
      ),
    );
  }
}

/// An icon-only button: 44 pt to tap, a tooltip that is also its name for
/// screen readers.
class DIconButton extends StatelessWidget {
  const DIconButton(
      {super.key,
      required this.icon,
      required this.tooltip,
      required this.onTap,
      this.active = false,
      this.color,
      this.size = kMinTapTarget});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  /// Shown on (a filter or a mode that is on): accent icon on a tint.
  final bool active;
  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final fg = onTap == null ? c.textSubtle.withValues(alpha: 0.6) : (active ? c.accentInk : (color ?? c.textMuted));
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        enabled: onTap != null,
        selected: active ? true : null,
        child: Pressable(
          onTap: onTap,
          builder: (pressed) => SizedBox(
            width: size,
            height: size,
            child: Center(
              child: AnimatedContainer(
                duration: DurbunMotion.of(context, DurbunMotion.fast),
                width: size - 8,
                height: size - 8,
                decoration: BoxDecoration(
                  color: pressed ? c.bgActive : (active ? c.accentSoft : Colors.transparent),
                  borderRadius: BorderRadius.circular(DurbunRadius.md),
                ),
                child: Icon(icon, size: size >= 40 ? 20 : 18, color: fg),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Weight of a [DButton]: [primary] the one main action of a screen
/// (accent fill), [tonal] a secondary action (accent tint), [outline] a
/// neutral one, [ghost] a dismissal ("Close", "Cancel"), [danger] a
/// destructive one.
enum DButtonKind { primary, tonal, outline, ghost, danger }

/// A text button with an optional icon.
class DButton extends StatelessWidget {
  const DButton(
      {super.key,
      required this.label,
      required this.onTap,
      this.icon,
      bool primary = false,
      DButtonKind? kind,
      this.trailingIcon,
      this.large = false})
      : kind = kind ?? (primary ? DButtonKind.primary : DButtonKind.outline);

  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final IconData? trailingIcon;
  final DButtonKind kind;

  /// 48 pt, the label centred in the given width (a sheet's footer).
  final bool large;

  bool get primary => kind == DButtonKind.primary;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final enabled = onTap != null;
    final (bg, fg, side) = switch (kind) {
      DButtonKind.primary => (c.accentFill, c.onAccent, null),
      DButtonKind.tonal => (c.accentSoft, c.accentInk, null),
      DButtonKind.outline => (c.cardBg, c.text, c.borderStrong),
      DButtonKind.ghost => (Colors.transparent, c.textMuted, null),
      DButtonKind.danger => (c.dangerSoft, c.danger, null),
    };
    final ink = enabled ? fg : c.textSubtle;
    final radius = BorderRadius.circular(DurbunRadius.md);
    return Semantics(
      button: true,
      enabled: enabled,
      child: Pressable(
        onTap: onTap,
        builder: (pressed) => AnimatedContainer(
          duration: DurbunMotion.of(context, DurbunMotion.fast),
          height: large ? 48 : kMinTapTarget,
          padding: EdgeInsets.symmetric(horizontal: kind == DButtonKind.ghost ? 12 : 16),
          decoration: BoxDecoration(
            color: enabled ? bg : (kind == DButtonKind.ghost ? Colors.transparent : c.bgActive),
            borderRadius: radius,
            border: side == null ? null : Border.all(color: side),
          ),
          foregroundDecoration: pressed
              ? BoxDecoration(
                  color: (kind == DButtonKind.primary ? Colors.black : c.text).withValues(alpha: 0.08), borderRadius: radius)
              : null,
          child: Row(
            mainAxisSize: large ? MainAxisSize.max : MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              if (icon != null) ...<Widget>[
                Icon(icon, size: 18, color: ink),
                const SizedBox(width: 8),
              ],
              // Shrinks with an ellipsis (two sheet buttons, large text).
              Flexible(
                child: Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: large ? DurbunType.label : DurbunType.body + 1,
                        color: ink,
                        fontWeight: primary || large ? FontWeight.w600 : FontWeight.w500,
                        height: 1.2)),
              ),
              if (trailingIcon != null) ...<Widget>[
                const SizedBox(width: 4),
                Icon(trailingIcon, size: 18, color: ink),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// A segmented control's rounded track (36 pt drawn, 44 pt to tap);
/// [children] are its segments.
class SegmentTrack extends StatelessWidget {
  const SegmentTrack({super.key, required this.children, this.stretch = false});

  final List<Widget> children;

  /// Segments share the full width.
  final bool stretch;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return SizedBox(
      height: kMinTapTarget,
      child: Stack(
        children: <Widget>[
          Positioned.fill(
            top: 4,
            bottom: 4,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: c.trackBg,
                borderRadius: BorderRadius.circular(DurbunRadius.md),
                border: c.isDark ? Border.all(color: c.border) : null,
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 3),
            child: Row(
              mainAxisSize: stretch ? MainAxisSize.max : MainAxisSize.min,
              children: <Widget>[
                for (final s in children) stretch ? Expanded(child: s) : s,
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// One segment of a [SegmentTrack]: the selected one is accent-filled.
class Segment extends StatelessWidget {
  const Segment(
      {super.key,
      required this.selected,
      required this.onTap,
      required this.child,
      this.semanticLabel});

  final bool selected;
  final VoidCallback? onTap;
  final Widget child;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label: semanticLabel,
      child: Pressable(
        onTap: onTap,
        builder: (pressed) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: AnimatedContainer(
            duration: DurbunMotion.of(context, DurbunMotion.medium),
            curve: DurbunMotion.curve,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: selected ? c.accentFill : (pressed ? c.bgActive : Colors.transparent),
              // The track's radius minus its 3 pt inset.
              borderRadius: BorderRadius.circular(DurbunRadius.md - 3),
            ),
            child: DefaultTextStyle.merge(
              style: TextStyle(color: selected ? c.onAccent : c.textMuted),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

/// Label with an optional count, as a segment shows it ("Request 7").
Widget _segmentLabel(DurbunColors c, String label, Object? count, bool selected, double size, {int maxLines = 1}) =>
    Text.rich(
      TextSpan(
        children: <InlineSpan>[
          TextSpan(text: label),
          if (count != null)
            TextSpan(
                text: ' $count',
                style: TextStyle(
                    fontSize: size - 1,
                    color: selected ? c.onAccent.withValues(alpha: 0.85) : c.textSubtle,
                    fontWeight: FontWeight.w500,
                    fontFeatures: DurbunType.tabular)),
        ],
      ),
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: size,
        fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
        color: selected ? c.onAccent : c.textMuted,
        height: 1.2,
      ),
    );

/// Segmented control sized to its labels (Preview / Code / Hex).
class DSegmented extends StatelessWidget {
  const DSegmented(
      {super.key,
      required this.labels,
      required this.index,
      required this.onChanged,
      this.counts});

  final List<String> labels;

  /// Shown after a label, dimmed: a count or a size ("Body 2 KB").
  final List<Object?>? counts;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return SegmentTrack(
      children: <Widget>[
        for (var i = 0; i < labels.length; i++)
          Segment(
            selected: i == index,
            onTap: () => onChanged(i),
            child: _segmentLabel(c, labels[i], counts?[i], i == index, DurbunType.body),
          ),
      ],
    );
  }
}

/// A segmented choice that fills its row (sheets, pages): every option
/// gets an equal share, and a label wraps onto a second line instead of
/// overflowing (small phones, large text). [onChanged] null: shown, not
/// changeable.
class ChoiceSegments extends StatelessWidget {
  const ChoiceSegments({super.key, required this.labels, required this.index, required this.onChanged, this.counts});

  final List<String> labels;

  /// Shown after a label, dimmed ("Listed 12").
  final List<Object?>? counts;
  final int index;
  final ValueChanged<int>? onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
          color: c.trackBg,
          borderRadius: BorderRadius.circular(DurbunRadius.md),
          border: c.isDark ? Border.all(color: c.border) : null),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            for (var i = 0; i < labels.length; i++)
              Expanded(
                child: Semantics(
                  button: true,
                  selected: i == index,
                  child: Pressable(
                    onTap: onChanged == null ? null : () => onChanged!(i),
                    builder: (pressed) => AnimatedContainer(
                      duration: DurbunMotion.of(context, DurbunMotion.medium),
                      curve: DurbunMotion.curve,
                      constraints: const BoxConstraints(minHeight: kMinTapTarget - 6),
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: i == index ? c.accentFill : (pressed ? c.bgActive : Colors.transparent),
                        borderRadius: BorderRadius.circular(DurbunRadius.md - 3),
                      ),
                      child: _segmentLabel(c, labels[i], counts?[i], i == index, DurbunType.body, maxLines: 2),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Status of a request as a tinted token: `200`, `404`, `FAIL`, `1.2 s`.
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.text, required this.color, this.width = 44});

  final String text;
  final Color color;
  final double? width;

  @override
  Widget build(BuildContext context) => Container(
        width: width,
        height: 22,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(
            color: color.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(DurbunRadius.sm)),
        // widthFactor 1: without a width the pill hugs its text (a Wrap
        // would stretch an aligned box to the full row).
        child: Center(
          widthFactor: width == null ? 1 : null,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(text,
                maxLines: 1,
                style: DurbunType.monoStyle(size: DurbunType.monoRow, color: color, weight: FontWeight.w600, height: 1.1)),
          ),
        ),
      );
}

/// An HTTP method in its colour, as a word (`GET`, `POST`).
class MethodToken extends StatelessWidget {
  const MethodToken(this.method, {super.key, this.size = DurbunType.monoRow});

  final String method;
  final double size;

  @override
  Widget build(BuildContext context) => Text(
        method.toUpperCase(),
        maxLines: 1,
        style: DurbunType.monoStyle(size: size, color: DurbunColors.of(context).method(method), weight: FontWeight.w600, height: 1.2),
      );
}

/// A row that scrolls sideways when it is wider than the screen, with the
/// cut edge fading out so nothing is clipped without a sign.
class EdgeFadeScroller extends StatefulWidget {
  const EdgeFadeScroller({super.key, required this.child, this.padding = EdgeInsets.zero, this.fade = 24});

  final Widget child;
  final EdgeInsets padding;
  final double fade;

  @override
  State<EdgeFadeScroller> createState() => _EdgeFadeScrollerState();
}

class _EdgeFadeScrollerState extends State<EdgeFadeScroller> {
  final ScrollController _scroll = ScrollController();
  bool _start = false, _end = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_update);
    WidgetsBinding.instance.addPostFrameCallback((_) => _update());
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _update() {
    if (!mounted || !_scroll.hasClients) return;
    final p = _scroll.position;
    final start = p.pixels > 1, end = p.pixels < p.maxScrollExtent - 1;
    if (start == _start && end == _end) return;
    setState(() {
      _start = start;
      _end = end;
    });
  }

  @override
  Widget build(BuildContext context) {
    final list = NotificationListener<ScrollMetricsNotification>(
      onNotification: (_) {
        _update();
        return false;
      },
      child: SingleChildScrollView(
        controller: _scroll,
        scrollDirection: Axis.horizontal,
        padding: widget.padding,
        child: widget.child,
      ),
    );
    if (!_start && !_end) return list;
    return ShaderMask(
      blendMode: BlendMode.dstIn,
      shaderCallback: (rect) {
        final f = (widget.fade / rect.width).clamp(0.0, 0.5);
        return LinearGradient(
          colors: <Color>[
            _start ? Colors.transparent : Colors.black,
            Colors.black,
            Colors.black,
            _end ? Colors.transparent : Colors.black,
          ],
          stops: <double>[0, f, 1 - f, 1],
        ).createShader(rect);
      },
      child: list,
    );
  }
}

/// Mono text in a sunken box with a copy button in its top right corner
/// (a setup snippet, a stack trace).
class CodeBlock extends StatelessWidget {
  const CodeBlock({super.key, required this.text, this.copyNote, this.maxLines});

  final String text;
  final String? copyNote;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return Container(
      decoration: BoxDecoration(
        color: c.isDark ? c.bgSunken : c.bgPanel,
        borderRadius: BorderRadius.circular(DurbunRadius.lg),
        border: Border.all(color: c.border),
      ),
      child: Stack(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, kMinTapTarget + 4, 12),
            child: SelectableText(text,
                maxLines: maxLines,
                style: DurbunType.monoStyle(size: DurbunType.monoBody, color: c.text, height: 1.5)),
          ),
          Positioned(
            top: 2,
            right: 2,
            child: DIconButton(
              icon: Icons.copy_rounded,
              tooltip: t.copy,
              onTap: () => copyText(context, text, note: copyNote),
            ),
          ),
        ],
      ),
    );
  }
}

/// A row of a grouped list: an icon (no tile), a title with an optional
/// subtitle, a value on the right and a chevron when it opens a page.
class ListRow extends StatelessWidget {
  const ListRow(
      {super.key,
      required this.title,
      this.icon,
      this.iconColor,
      this.subtitle,
      this.value,
      this.trailing,
      this.onTap,
      this.chevron,
      this.titleColor});

  final String title;
  final IconData? icon;
  final Color? iconColor;
  final String? subtitle;

  /// Short status on the right ("Bağlı", "3"), UI text.
  final String? value;
  final Widget? trailing;
  final VoidCallback? onTap;

  /// Defaults to shown when the row opens something.
  final bool? chevron;
  final Color? titleColor;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final showChevron = chevron ?? (onTap != null && trailing == null);
    return Semantics(
      button: onTap != null,
      child: Pressable(
        onTap: onTap,
        builder: (pressed) => AnimatedContainer(
          duration: DurbunMotion.of(context, DurbunMotion.fast),
          color: pressed ? c.bgHover : Colors.transparent,
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: DurbunSpace.lg, vertical: 10),
          child: Row(
            children: <Widget>[
              if (icon != null) ...<Widget>[
                Icon(icon, size: 22, color: iconColor ?? c.textMuted),
                const SizedBox(width: 14),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(title,
                        style: TextStyle(fontSize: DurbunType.label, color: titleColor ?? c.text, fontWeight: FontWeight.w500, height: 1.3)),
                    if (subtitle != null) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(subtitle!, style: TextStyle(fontSize: DurbunType.body, color: c.textSubtle, height: 1.35)),
                    ],
                  ],
                ),
              ),
              if (value != null) ...<Widget>[
                const SizedBox(width: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 140),
                  child: Text(value!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DurbunType.ui(size: DurbunType.body, color: c.textMuted)),
                ),
              ],
              if (trailing != null) ...<Widget>[const SizedBox(width: 8), trailing!],
              if (showChevron) ...<Widget>[
                const SizedBox(width: 6),
                Icon(Icons.chevron_right_rounded, size: 20, color: c.textSubtle),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Rows on a rounded card with hairlines between them (the Tools sheet,
/// settings-like pages).
class GroupCard extends StatelessWidget {
  const GroupCard({super.key, required this.children, this.title});

  final List<Widget> children;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (title != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(DurbunSpace.lg + 4, DurbunSpace.xl, DurbunSpace.lg, DurbunSpace.sm),
            child: Text(title!, style: TextStyle(fontSize: DurbunType.body, fontWeight: FontWeight.w600, color: c.textMuted)),
          ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: DurbunSpace.md),
          decoration: BoxDecoration(
            color: c.cardBg,
            borderRadius: BorderRadius.circular(DurbunRadius.lg),
            border: Border.all(color: c.border),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              for (var i = 0; i < children.length; i++) ...<Widget>[
                if (i > 0) Divider(height: 1, indent: DurbunSpace.lg, color: c.hairline),
                children[i],
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// Key / value rows in a rounded card (General, the JWT claims). A tap on a
/// row offers to copy its value.
class KeyValueTable extends StatelessWidget {
  const KeyValueTable({super.key, required this.rows});

  final List<(String, String, Color?)> rows;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      decoration: BoxDecoration(
          color: c.cardBg,
          border: Border.all(color: c.border),
          borderRadius: BorderRadius.circular(DurbunRadius.lg)),
      clipBehavior: Clip.antiAlias,
      child: Material(
        type: MaterialType.transparency,
        child: Column(
          children: <Widget>[
            for (var i = 0; i < rows.length; i++) ...<Widget>[
              if (i > 0) Divider(height: 1, color: c.hairline),
              _KeyValueRow(row: rows[i]),
            ],
          ],
        ),
      ),
    );
  }
}

class _KeyValueRow extends StatefulWidget {
  const _KeyValueRow({required this.row});

  final (String, String, Color?) row;

  @override
  State<_KeyValueRow> createState() => _KeyValueRowState();
}

class _KeyValueRowState extends State<_KeyValueRow> {
  Offset _tapAt = Offset.zero;

  Future<void> _menu() async {
    final t = InspectorStrings.of(context);
    final (name, value, _) = widget.row;
    final choice = await showCopyMenu(context, _tapAt, <(String, IconData, String)>[
      ('value', Icons.copy_rounded, t.copyValue),
      ('line', Icons.notes_rounded, t.copyNameValue),
    ]);
    if (!mounted) return;
    if (choice == 'value') copyText(context, value);
    if (choice == 'line') copyText(context, '$name: $value');
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final (name, value, color) = widget.row;
    return InkWell(
      onTapDown: (d) => _tapAt = d.globalPosition,
      onTap: _menu,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            SizedBox(
              width: 112,
              child: Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Text(name, style: TextStyle(fontSize: DurbunType.body, color: c.textSubtle, height: 1.35)),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(value, style: DurbunType.monoStyle(size: DurbunType.monoBody, color: color ?? c.text, height: 1.45)),
            ),
          ],
        ),
      ),
    );
  }
}

/// A small menu at [at] (a tap's global position); returns the chosen id.
Future<String?> showCopyMenu(BuildContext context, Offset at, List<(String, IconData, String)> items) {
  final overlay = Overlay.of(context).context.findRenderObject()! as RenderBox;
  return showMenu<String>(
    context: context,
    position: RelativeRect.fromRect(at & const Size(1, 1), Offset.zero & overlay.size),
    items: <PopupMenuEntry<String>>[
      for (final (id, icon, label) in items) PopupMenuItem<String>(value: id, child: MenuRow(icon, label)),
    ],
  );
}

/// Icon and label of a menu item.
class MenuRow extends StatelessWidget {
  const MenuRow(this.icon, this.label, {super.key});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Row(
      children: <Widget>[
        Icon(icon, size: 18, color: c.textMuted),
        const SizedBox(width: 12),
        Flexible(child: Text(label, style: TextStyle(fontSize: DurbunType.label, color: c.text))),
      ],
    );
  }
}

/// Whether a [SelectionArea] inside a page of a swipe tab view lets the
/// swipe win. On iOS and macOS it waits for the tab view; elsewhere its
/// drag-to-select wins horizontal drags and the tabs would not move, so
/// there [SwipeTabs] puts one selection area around the whole tab view
/// instead (the tab view, nearer the finger, then wins the horizontal drag,
/// and a long press still selects).
bool get _selectionInsidePages => switch (defaultTargetPlatform) {
      TargetPlatform.iOS || TargetPlatform.macOS => true,
      _ => false,
    };

/// Text selection (long press, handles) for a page's text. Inside a page of
/// a swipe tab view on Android the [SwipeTabs] around it already selects;
/// elsewhere the page gets its own [SelectionArea].
Widget swipeSafeSelection(Widget child) => Builder(
      builder: (context) => _selectionInsidePages || !_SwipeSelection.covers(context)
          ? SelectionArea(child: child)
          : child,
    );

/// Marks pages under a [SwipeTabs] whose selection area is outside the tab
/// view (Android and other touch platforms).
class _SwipeSelection extends InheritedWidget {
  const _SwipeSelection({required super.child});

  static bool covers(BuildContext context) =>
      context.getInheritedWidgetOfExactType<_SwipeSelection>() != null;

  @override
  bool updateShouldNotify(_SwipeSelection old) => false;
}

enum CalloutTone { info, warning, danger }

/// A banner on a page ("why is this missing"): a tinted box with an
/// icon, a short title, an optional line under it and one optional text
/// action in the accent.
class Callout extends StatelessWidget {
  const Callout(
      {super.key,
      required this.title,
      this.body,
      this.tone = CalloutTone.info,
      this.actionLabel,
      this.onAction});

  final String title;
  final String? body;
  final CalloutTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final (fg, bg, icon) = switch (tone) {
      CalloutTone.info => (c.info, c.infoSoft, Icons.info_outline_rounded),
      CalloutTone.warning => (c.warning, c.warningSoft, Icons.warning_amber_rounded),
      CalloutTone.danger => (c.danger, c.dangerSoft, Icons.error_outline_rounded),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(DurbunRadius.md)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(padding: const EdgeInsets.only(top: 1), child: Icon(icon, size: 18, color: fg)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: TextStyle(fontSize: DurbunType.body, fontWeight: FontWeight.w600, color: c.text, height: 1.4)),
                if (body != null) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(body!, style: TextStyle(fontSize: DurbunType.body, color: c.textMuted, height: 1.45)),
                ],
                if (actionLabel != null && onAction != null)
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: TextButton(
                      style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 0),
                          textStyle: const TextStyle(fontSize: DurbunType.body, fontWeight: FontWeight.w600)),
                      onPressed: onAction,
                      child: Text(actionLabel!),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// An empty list or page: the Dürbün mark, one sentence, an optional
/// second line and at most one action.
class EmptyState extends StatelessWidget {
  const EmptyState(
      {super.key,
      required this.title,
      this.body,
      this.actionLabel,
      this.actionIcon,
      this.onAction});

  final String title;
  final String? body;

  /// A tonal button under the text (for example "Clear filters").
  final String? actionLabel;
  final IconData? actionIcon;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    // Scrolls when the space is short (landscape, large text).
    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight.isFinite ? box.maxHeight : 0),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(32, 24, 32, 48),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 320),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const DurbunMark(size: 44),
                    const SizedBox(height: 14),
                    Text(title,
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: DurbunType.label, fontWeight: FontWeight.w600, color: c.text, height: 1.35)),
                    if (body != null) ...<Widget>[
                      const SizedBox(height: 4),
                      Text(body!,
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: DurbunType.body, height: 1.45, color: c.textMuted)),
                    ],
                    if (actionLabel != null && onAction != null) ...<Widget>[
                      const SizedBox(height: 16),
                      DButton(label: actionLabel!, icon: actionIcon, kind: DButtonKind.tonal, onTap: onAction),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// "↓ 12 new" pill shown while the list is paused away from the live end.
class NewItemsPill extends StatelessWidget {
  const NewItemsPill({super.key, required this.text, required this.onTap, this.up = false});

  final String text;
  final VoidCallback onTap;

  /// Points up: the new rows are at the top (a sorted list).
  final bool up;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Semantics(
      button: true,
      child: Pressable(
        onTap: onTap,
        builder: (pressed) => SizedBox(
          height: kMinTapTarget,
          child: Center(
            widthFactor: 1,
            child: Container(
              height: 36,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                color: pressed ? Color.alphaBlend(Colors.black.withValues(alpha: 0.1), c.accentFill) : c.accentFill,
                borderRadius: BorderRadius.circular(DurbunRadius.pill),
                boxShadow: c.floating,
                border: c.isDark ? Border.all(color: c.accentInk.withValues(alpha: 0.6)) : null,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(up ? Icons.arrow_upward_rounded : Icons.arrow_downward_rounded, size: 16, color: c.onAccent),
                  const SizedBox(width: 6),
                  Text(text,
                      style: DurbunType.ui(size: DurbunType.body, color: c.onAccent, weight: FontWeight.w600, height: 1.2)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Section title inside a detail page.
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: DurbunSpace.xl, bottom: DurbunSpace.sm),
      child: Row(
        children: <Widget>[
          Expanded(
              child: Text(text,
                  style: TextStyle(
                      fontSize: DurbunType.body,
                      fontWeight: FontWeight.w600,
                      color: c.textMuted))),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// Text with every case-insensitive occurrence of [query] highlighted.
TextSpan highlightSpan(String text, String query, TextStyle style, Color mark) =>
    highlightTerms(text, query.isEmpty ? const <String>[] : <String>[foldText(query)], style, mark);

/// Says whether a page of the panel's tab view is on screen. Pages kept
/// alive off screen skip the store's updates until they are shown again.
class PageActive extends InheritedWidget {
  const PageActive({super.key, required this.active, required super.child});

  final bool active;

  /// True outside a tab view (detail pages, tests).
  static bool of(BuildContext context, {bool listen = true}) => listen
      ? context.dependOnInheritedWidgetOfExactType<PageActive>()?.active ?? true
      : context.getInheritedWidgetOfExactType<PageActive>()?.active ?? true;

  @override
  bool updateShouldNotify(PageActive old) => old.active != active;
}

/// [ListenableBuilder] that rebuilds only while its page is [PageActive];
/// an update that arrives off screen is applied when the page comes back.
class ActiveListenableBuilder extends StatefulWidget {
  const ActiveListenableBuilder({super.key, required this.listenable, required this.builder});

  final Listenable listenable;
  final WidgetBuilder builder;

  @override
  State<ActiveListenableBuilder> createState() => _ActiveListenableBuilderState();
}

class _ActiveListenableBuilderState extends State<ActiveListenableBuilder> {
  @override
  void initState() {
    super.initState();
    widget.listenable.addListener(_changed);
  }

  @override
  void didUpdateWidget(ActiveListenableBuilder old) {
    super.didUpdateWidget(old);
    if (old.listenable != widget.listenable) {
      old.listenable.removeListener(_changed);
      widget.listenable.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.listenable.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted && PageActive.of(context, listen: false)) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    // Depends on PageActive: coming back on screen rebuilds with what was missed.
    PageActive.of(context);
    return widget.builder(context);
  }
}

/// One tab of a [DTabBar].
class DTab {
  const DTab(this.label, {this.icon, this.count, this.alert = false});

  final String label;
  final IconData? icon;

  /// Shown as a pill when above zero.
  final int? count;

  /// Red count: errors / failed requests.
  final bool alert;
}

/// Segmented tabs driven by a [TabController]: the raised segment follows a
/// swipe of the [TabBarView] under it (the panel, the detail pages).
class DTabBar extends StatelessWidget {
  const DTabBar({super.key, required this.controller, required this.tabs, this.height = kMinTapTarget});

  final TabController controller;
  final List<DTab> tabs;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      height: height,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: c.trackBg,
        borderRadius: BorderRadius.circular(DurbunRadius.md),
        border: c.isDark ? Border.all(color: c.border) : null,
      ),
      child: TabBar(
        controller: controller,
        indicator: BoxDecoration(
          color: c.accentFill,
          borderRadius: BorderRadius.circular(DurbunRadius.md - 3),
        ),
        indicatorSize: TabBarIndicatorSize.tab,
        dividerHeight: 0,
        labelPadding: EdgeInsets.zero,
        splashFactory: NoSplash.splashFactory,
        overlayColor: const WidgetStatePropertyAll<Color>(Colors.transparent),
        labelColor: c.onAccent,
        unselectedLabelColor: c.textMuted,
        labelStyle: const TextStyle(fontSize: DurbunType.body + 1, fontWeight: FontWeight.w600, height: 1.2),
        unselectedLabelStyle: const TextStyle(fontSize: DurbunType.body + 1, fontWeight: FontWeight.w500, height: 1.2),
        tabs: <Widget>[
          for (final tab in tabs)
            Tooltip(
              message: tab.label,
              child: Tab(
                height: height - 6,
                // Tabs share the width; a long label shrinks instead of
                // pushing the others off a narrow phone.
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        if (tab.icon != null) ...<Widget>[
                          Icon(tab.icon, size: 18),
                          const SizedBox(width: 6),
                        ],
                        Text(tab.label),
                        if ((tab.count ?? 0) > 0) ...<Widget>[
                          const SizedBox(width: 6),
                          _TabCount(count: tab.count!, alert: tab.alert),
                        ] else if (tab.alert) ...<Widget>[
                          const SizedBox(width: 6),
                          Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                  color: c.danger, shape: BoxShape.circle, border: Border.all(color: c.onAccent, width: 1.5))),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _TabCount extends StatelessWidget {
  const _TabCount({required this.count, required this.alert});

  final int count;
  final bool alert;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    // The tab bar animates the label colour; the count follows it.
    final fg = DefaultTextStyle.of(context).style.color ?? c.textMuted;
    return Container(
      height: 18,
      constraints: const BoxConstraints(minWidth: 18),
      padding: const EdgeInsets.symmetric(horizontal: 5),
      alignment: Alignment.center,
      decoration: BoxDecoration(
          color: alert ? c.danger : fg.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(DurbunRadius.pill)),
      child: Text(
        count > 999 ? '999+' : '$count',
        style: DurbunType.ui(size: DurbunType.caption, color: alert ? c.onDanger : fg, weight: FontWeight.w600, height: 1.1),
      ),
    );
  }
}

/// A page of a swipeable tab view: keeps its state (search, scroll, open
/// JSON nodes) while another page is shown, and tells its content whether it
/// is on screen ([PageActive]).
class SwipePage extends StatefulWidget {
  const SwipePage({super.key, required this.tabs, required this.index, required this.child});

  final TabController tabs;
  final int index;
  final Widget child;

  @override
  State<SwipePage> createState() => _SwipePageState();
}

class _SwipePageState extends State<SwipePage> with AutomaticKeepAliveClientMixin {
  late bool _active = _visible();

  bool _visible() {
    final at = widget.tabs.animation?.value ?? widget.tabs.index.toDouble();
    return (at - widget.index).abs() < 0.999;
  }

  void _tick() {
    final v = _visible();
    if (v != _active) setState(() => _active = v);
  }

  @override
  void initState() {
    super.initState();
    widget.tabs.animation?.addListener(_tick);
  }

  @override
  void didUpdateWidget(SwipePage old) {
    super.didUpdateWidget(old);
    if (old.tabs != widget.tabs) {
      old.tabs.animation?.removeListener(_tick);
      widget.tabs.animation?.addListener(_tick);
      _active = _visible();
    }
  }

  @override
  void dispose() {
    widget.tabs.animation?.removeListener(_tick);
    super.dispose();
  }

  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return PageActive(active: _active, child: widget.child);
  }
}

/// [DTabBar] over pages that a swipe moves between; each page keeps its
/// state. Changing tabs drops the keyboard (a find field on the other page
/// would keep it up).
class SwipeTabs extends StatefulWidget {
  const SwipeTabs({
    super.key,
    required this.tabs,
    required this.pages,
    this.initialIndex = 0,
    this.onChanged,
    this.barPadding = const EdgeInsets.fromLTRB(12, 2, 12, 8),
  }) : assert(tabs.length == pages.length);

  final List<DTab> tabs;
  final List<Widget> pages;
  final int initialIndex;
  final ValueChanged<int>? onChanged;
  final EdgeInsets barPadding;

  @override
  State<SwipeTabs> createState() => _SwipeTabsState();
}

class _SwipeTabsState extends State<SwipeTabs> with TickerProviderStateMixin {
  late TabController _tabs;
  late int _index;

  @override
  void initState() {
    super.initState();
    _tabs = _make(widget.initialIndex);
    _index = _tabs.index;
  }

  TabController _make(int index) =>
      TabController(length: widget.tabs.length, vsync: this, initialIndex: index.clamp(0, widget.tabs.length - 1))
        ..addListener(_changed);

  void _changed() {
    if (_tabs.index == _index) return;
    _index = _tabs.index;
    FocusManager.instance.primaryFocus?.unfocus();
    widget.onChanged?.call(_index);
  }

  @override
  void didUpdateWidget(SwipeTabs old) {
    super.didUpdateWidget(old);
    if (old.tabs.length != widget.tabs.length) {
      final previous = _tabs;
      _tabs = _make(previous.index);
      _index = _tabs.index;
      WidgetsBinding.instance.addPostFrameCallback((_) => previous.dispose());
    }
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final view = TabBarView(
      controller: _tabs,
      children: <Widget>[
        for (var i = 0; i < widget.pages.length; i++) SwipePage(tabs: _tabs, index: i, child: widget.pages[i]),
      ],
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(padding: widget.barPadding, child: DTabBar(controller: _tabs, tabs: widget.tabs)),
        Expanded(
          child: _selectionInsidePages
              ? view
              : SelectionArea(child: _SwipeSelection(child: view)),
        ),
      ],
    );
  }
}
