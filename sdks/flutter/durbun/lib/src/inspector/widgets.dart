/// Shared components of the in-app inspector, modelled on the desktop UI
/// (`packages/ui/src/components`, `styles/components.css`).
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';

/// Copies [text] and confirms with a short toast.
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

/// Level badge: one mono letter on a soft square (V D I W E F).
class LevelBadge extends StatelessWidget {
  const LevelBadge(this.level, {super.key});

  final String level;

  static String letter(String level) => switch (level) {
        'verbose' => 'V',
        'debug' => 'D',
        'info' => 'I',
        'warn' => 'W',
        'error' => 'E',
        'fatal' => 'F',
        _ => '?',
      };

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final color = c.level(level);
    return Container(
      width: 17,
      height: 17,
      alignment: Alignment.center,
      decoration: BoxDecoration(
          color: color.withValues(alpha: 0.16),
          borderRadius: BorderRadius.circular(DurbunRadius.sm)),
      child: Text(letter(level),
          style: DurbunType.monoStyle(
              size: 10, color: color, weight: FontWeight.w700, height: 1)),
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
              style: DurbunType.monoStyle(size: 11, color: fg, height: 1.2))),
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
      BadgeTone.accent => (c.badgeAccent, c.accentSoft),
      BadgeTone.success => (c.success, c.successSoft),
      BadgeTone.warning => (c.warning, c.warningSoft),
      BadgeTone.danger => (c.danger, c.dangerSoft),
      BadgeTone.info => (c.info, c.infoSoft),
    };
    final style = mono
        ? DurbunType.monoStyle(
            size: 10.5, color: fg, weight: FontWeight.w600, height: 1.2)
        : TextStyle(
            fontSize: 10.5,
            color: fg,
            fontWeight: FontWeight.w600,
            height: 1.2);
    return Container(
      height: 18,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
          color: bg, borderRadius: BorderRadius.circular(DurbunRadius.sm)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 11, color: fg),
            const SizedBox(width: 3)
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
      this.mono = false});

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final Color? color;
  final IconData? icon;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final tone = color ?? c.accent;
    final fg = selected ? (color ?? c.text) : (color ?? c.textMuted);
    final style = mono
        ? DurbunType.monoStyle(
            size: 11.5, color: fg, weight: FontWeight.w600, height: 1.2)
        : TextStyle(
            fontSize: 12.5,
            color: fg,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
            height: 1.2);
    return Material(
      color: selected ? tone.withValues(alpha: 0.14) : Colors.transparent,
      shape: StadiumBorder(
        side: BorderSide(color: selected ? tone.withValues(alpha: 0.5) : c.border),
      ),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        // No alignment: an aligned Container would stretch to the full width
        // inside a Wrap (the filter sheet).
        child: Container(
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (icon != null) ...<Widget>[
                Icon(icon, size: 14, color: fg),
                const SizedBox(width: 4)
              ],
              // Shrinks with an ellipsis when wider than the screen (large text).
              Flexible(
                  child: Text(label,
                      style: style,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis)),
            ],
          ),
        ),
      ),
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
      this.onSubmitted});

  final String hint;
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
      height: 38,
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(DurbunRadius.md + 1),
        border: c.isDark ? Border.all(color: c.border) : null,
      ),
      child: Row(
        children: <Widget>[
          const SizedBox(width: 10),
          Icon(Icons.search_rounded, size: 18, color: c.textSubtle),
          const SizedBox(width: 6),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: widget.onChanged,
              onSubmitted: widget.onSubmitted,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.search,
              style:
                  DurbunType.monoStyle(size: 13, color: c.text, height: 1.2),
              cursorColor: c.accent,
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                // In the phone's UI font: a hint text would take the
                // field's mono style.
                hint: Text(widget.hint,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DefaultTextStyle.of(context).style.copyWith(
                        inherit: false, fontSize: 14, color: c.textSubtle, height: 1.2)),
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
                    size: 32,
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
                size: 32,
                onTap: widget.onHelp),
          if (widget.trailing != null) widget.trailing!,
          const SizedBox(width: 3),
        ],
      ),
    );
  }
}

class DIconButton extends StatelessWidget {
  const DIconButton(
      {super.key,
      required this.icon,
      required this.tooltip,
      required this.onTap,
      this.active = false,
      this.color,
      this.size = 32});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool active;
  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Tooltip(
      message: tooltip,
      child: Material(
        color: active ? c.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(DurbunRadius.md),
        child: InkWell(
          borderRadius: BorderRadius.circular(DurbunRadius.md),
          onTap: onTap,
          child: SizedBox(
            width: size,
            height: size,
            child: Icon(icon,
                size: size >= 36 ? 20 : 18,
                color: onTap == null
                    ? c.textSubtle
                    : (active ? c.accent : (color ?? c.textMuted))),
          ),
        ),
      ),
    );
  }
}

/// Text button with an icon (Replay, Copy…).
class DButton extends StatelessWidget {
  const DButton(
      {super.key,
      required this.label,
      required this.onTap,
      this.icon,
      this.primary = false,
      this.trailingIcon,
      this.large = false});

  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final IconData? trailingIcon;
  final bool primary;

  /// Taller, with the label centred in the given width (a sheet's main
  /// button).
  final bool large;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final fg = primary ? Colors.white : (onTap == null ? c.textSubtle : c.text);
    return Material(
      color: primary ? c.accent : c.cardBg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(large ? DurbunRadius.lg : DurbunRadius.md),
        side: primary ? BorderSide.none : BorderSide(color: c.border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(large ? DurbunRadius.lg : DurbunRadius.md),
        onTap: onTap,
        child: Container(
          height: large ? 48 : 34,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            mainAxisSize: large ? MainAxisSize.max : MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              if (icon != null) ...<Widget>[
                Icon(icon, size: 16, color: primary ? fg : c.textMuted),
                const SizedBox(width: 6)
              ],
              Text(label,
                  style: TextStyle(
                      fontSize: large ? 15 : 13,
                      color: fg,
                      fontWeight: large ? FontWeight.w600 : FontWeight.w500)),
              if (trailingIcon != null) ...<Widget>[
                const SizedBox(width: 4),
                Icon(trailingIcon, size: 15, color: c.textMuted)
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// A segmented control's rounded track; [children] are its segments.
class SegmentTrack extends StatelessWidget {
  const SegmentTrack({super.key, required this.children, this.height = 34});

  final List<Widget> children;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      height: height,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
          color: c.trackBg,
          borderRadius: BorderRadius.circular(DurbunRadius.md + 1),
          border: c.isDark ? Border.all(color: c.border.withValues(alpha: 0.6)) : null),
      child: Row(mainAxisSize: MainAxisSize.min, children: children),
    );
  }
}

/// One segment of a [SegmentTrack]: the selected one is raised.
class Segment extends StatelessWidget {
  const Segment(
      {super.key,
      required this.selected,
      required this.onTap,
      required this.child,
      this.semanticLabel});

  final bool selected;
  final VoidCallback onTap;
  final Widget child;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label: semanticLabel,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? c.thumbBg : Colors.transparent,
            borderRadius: BorderRadius.circular(DurbunRadius.md - 2),
            boxShadow: selected ? c.raised : null,
          ),
          child: child,
        ),
      ),
    );
  }
}

/// Label with an optional count, as a segment shows it ("Request 7").
Widget _segmentLabel(DurbunColors c, String label, int? count, bool selected, double size) => Text.rich(
      TextSpan(
        children: <InlineSpan>[
          TextSpan(text: label),
          if (count != null)
            TextSpan(
                text: ' $count',
                style: DurbunType.monoStyle(
                    size: size - 1.5, color: c.textSubtle, weight: FontWeight.w500, height: 1.2)),
        ],
      ),
      maxLines: 1,
      style: TextStyle(
        fontSize: size,
        fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
        color: selected ? c.text : c.textMuted,
        height: 1.2,
      ),
    );

/// The detail pages' tabs (General / Request / Response / Timing): a
/// full-width segmented control, optional counts.
class DTabs extends StatelessWidget {
  const DTabs(
      {super.key,
      required this.labels,
      required this.index,
      required this.onChanged,
      this.counts});

  final List<String> labels;
  final List<int?>? counts;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    // Tabs share the width (no tab slides off a narrow phone); long labels shrink.
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 6),
      child: SegmentTrack(
        children: <Widget>[
          for (var i = 0; i < labels.length; i++)
            Expanded(
              child: Segment(
                selected: i == index,
                onTap: () => onChanged(i),
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: _segmentLabel(c, labels[i], counts?[i], i == index, 13),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Small segmented control (Body / Headers / Cookies, Preview / Code / Hex).
class DSegmented extends StatelessWidget {
  const DSegmented(
      {super.key,
      required this.labels,
      required this.index,
      required this.onChanged,
      this.counts});

  final List<String> labels;
  final List<int?>? counts;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return SegmentTrack(
      height: 30,
      children: <Widget>[
        for (var i = 0; i < labels.length; i++)
          Segment(
            selected: i == index,
            onTap: () => onChanged(i),
            child: _segmentLabel(c, labels[i], counts?[i], i == index, 12),
          ),
      ],
    );
  }
}

/// Status of a request as a tinted pill: `200`, `404`, `FAIL`, `···`.
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.text, required this.color, this.width = 42});

  final String text;
  final Color color;
  final double? width;

  @override
  Widget build(BuildContext context) => Container(
        width: width,
        height: 20,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(
            color: color.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(DurbunRadius.sm + 1)),
        // widthFactor 1: without a width the pill hugs its text (a Wrap
        // would stretch an aligned box to the full row).
        child: Center(
          widthFactor: width == null ? 1 : null,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(text,
                maxLines: 1,
                style: DurbunType.monoStyle(size: 11.5, color: color, weight: FontWeight.w700, height: 1.1)),
          ),
        ),
      );
}

/// Key / value rows in a rounded card (the "General" tab, headers).
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
      child: Column(
        children: <Widget>[
          for (var i = 0; i < rows.length; i++)
            Container(
              decoration: BoxDecoration(
                border: i == 0 ? null : Border(top: BorderSide(color: c.hairline)),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  SizedBox(
                    width: 112,
                    child: Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: Text(rows[i].$1,
                          style: TextStyle(fontSize: 12, color: c.textMeta, fontWeight: FontWeight.w500)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: SelectableText(rows[i].$2,
                        style: DurbunType.monoStyle(size: 12.5, color: rows[i].$3 ?? c.text, height: 1.4)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

enum CalloutTone { info, warning, danger }

/// Explanation box ("why is this missing").
class Callout extends StatelessWidget {
  const Callout(
      {super.key,
      required this.title,
      this.body,
      this.tone = CalloutTone.info});

  final String title;
  final String? body;
  final CalloutTone tone;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final (fg, bg, icon) = switch (tone) {
      CalloutTone.info => (c.info, c.infoSoft, Icons.info_outline),
      CalloutTone.warning => (
          c.warning,
          c.warningSoft,
          Icons.warning_amber_rounded
        ),
      CalloutTone.danger => (c.danger, c.dangerSoft, Icons.error_outline),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
      decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(DurbunRadius.lg),
          border: Border.all(color: fg.withValues(alpha: 0.22))),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, size: 17, color: fg),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title,
                    style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: c.text)),
                if (body != null) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(body!,
                      style: TextStyle(fontSize: 12, color: c.textMuted)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Centered empty state with an icon, a title and a hint.
class EmptyState extends StatelessWidget {
  const EmptyState(
      {super.key,
      required this.icon,
      required this.title,
      this.body,
      this.actionLabel,
      this.onAction});

  final IconData icon;
  final String title;
  final String? body;

  /// A button under the text (for example "Clear filters").
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    // Scrolls when the space is short (landscape, large text).
    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(
              minHeight: box.maxHeight.isFinite ? box.maxHeight : 0),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  // The icon on a soft accent disc, in a faint halo.
                  Container(
                    width: 76,
                    height: 76,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: RadialGradient(colors: <Color>[
                        c.accent.withValues(alpha: c.isDark ? 0.16 : 0.10),
                        c.accent.withValues(alpha: 0),
                      ]),
                    ),
                    alignment: Alignment.center,
                    child: Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                          color: c.accentSoft,
                          shape: BoxShape.circle,
                          border: Border.all(color: c.accent.withValues(alpha: 0.25))),
                      child: Icon(icon, size: 23, color: c.badgeAccent),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(title,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          letterSpacing: -0.2,
                          color: c.text)),
                  if (body != null) ...<Widget>[
                    const SizedBox(height: 6),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 300),
                      child: Text(body!,
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 13, height: 1.45, color: c.textMuted)),
                    ),
                  ],
                  if (actionLabel != null && onAction != null) ...<Widget>[
                    const SizedBox(height: 14),
                    DButton(
                        label: actionLabel!,
                        icon: Icons.filter_alt_off_outlined,
                        onTap: onAction),
                  ],
                ],
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
  const NewItemsPill({super.key, required this.text, required this.onTap});

  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Material(
      color: c.accent,
      borderRadius: BorderRadius.circular(DurbunRadius.pill),
      elevation: 6,
      shadowColor: c.accent.withValues(alpha: 0.6),
      child: InkWell(
        borderRadius: BorderRadius.circular(DurbunRadius.pill),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.arrow_downward, size: 14, color: Colors.white),
              const SizedBox(width: 4),
              Text(text,
                  style: const TextStyle(
                      fontSize: 12,
                      color: Colors.white,
                      fontWeight: FontWeight.w600)),
            ],
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
      padding: const EdgeInsets.only(top: 14, bottom: 6),
      child: Row(
        children: <Widget>[
          Expanded(
              child: Text(text,
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: c.textMuted,
                      letterSpacing: 0.2))),
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
