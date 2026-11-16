/// Filter pieces shared by the Logs and Network toolbars: the "Filters"
/// button with its count, removable chips for the active filters, the
/// filter sheet and the tappable query help.
library;

import 'package:flutter/material.dart';

import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// "Filters · 2": opens the filter sheet.
class FilterButton extends StatelessWidget {
  const FilterButton({super.key, required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final on = count > 0;
    final fg = on ? c.accentInk : c.text;
    return ChipFrame(
      look: on ? ChipLook.tonal : ChipLook.outline,
      onTap: onTap,
      child: ChipLabel(
        label: t.filters,
        color: fg,
        icon: Icons.tune_rounded,
        trailing: on
            ? Padding(
                padding: const EdgeInsets.only(left: 6),
                child: Container(
                  height: 18,
                  constraints: const BoxConstraints(minWidth: 18),
                  padding: const EdgeInsets.symmetric(horizontal: 5),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: c.accentFill, borderRadius: BorderRadius.circular(DurbunRadius.pill)),
                  child: Text('$count',
                      style: DurbunType.ui(size: DurbunType.caption, color: c.onAccent, weight: FontWeight.w600, height: 1.1)),
                ),
              )
            : null,
      ),
    );
  }
}

/// An active filter, with an × that removes it.
class ActiveChip extends StatelessWidget {
  const ActiveChip(
      {super.key,
      required this.label,
      required this.onRemove,
      this.color,
      this.mono = false});

  final String label;
  final VoidCallback onRemove;

  /// A colour dot before the label (a method, a status class).
  final Color? color;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return ChipFrame(
      look: ChipLook.tonal,
      onTap: onRemove,
      semanticLabel: '${t.remove}: $label',
      child: ExcludeSemantics(
        child: ChipLabel(
          label: label,
          color: c.accentInk,
          mono: mono,
          dot: color,
          trailing: Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Icon(Icons.close_rounded, size: 16, color: c.accentInk),
          ),
        ),
      ),
    );
  }
}

/// The scrolling row of chips under the search field.
class FilterRow extends StatelessWidget {
  const FilterRow({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      color: c.bgApp,
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, 2, DurbunSpace.gutter, 2),
        itemCount: children.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (_, i) => children[i],
      ),
    );
  }
}

/// A titled group in the filter sheet: a small muted title, an optional
/// hint, then its chips.
class SheetSection extends StatelessWidget {
  const SheetSection(
      {super.key, required this.title, required this.children, this.hint});

  final String title;
  final String? hint;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, 14, DurbunSpace.gutter, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title,
              style: TextStyle(
                  fontSize: DurbunType.body,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.1,
                  height: 1.4,
                  color: c.textMuted)),
          if (hint != null) ...<Widget>[
            const SizedBox(height: 1),
            Text(hint!, style: TextStyle(fontSize: DurbunType.sm, height: 1.35, color: c.textSubtle)),
          ],
          const SizedBox(height: 2),
          // Chips are 44 pt tall to tap and 32 pt drawn: no run spacing.
          Wrap(spacing: 8, children: children),
        ],
      ),
    );
  }
}

/// A switch row in the filter sheet.
class SheetSwitch extends StatelessWidget {
  const SheetSwitch(
      {super.key,
      required this.label,
      required this.value,
      required this.onChanged,
      this.hint,
      this.icon,
      this.iconColor});

  final String label;
  final String? hint;
  final IconData? icon;

  /// The icon's colour (a warning sign in amber); muted by default.
  final Color? iconColor;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return MergeSemantics(
      child: Semantics(
      toggled: value,
      child: Pressable(
        onTap: () => onChanged(!value),
        builder: (pressed) => Container(
          color: pressed ? c.bgHover : Colors.transparent,
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, 6, 10, 6),
          child: Row(
            children: <Widget>[
              if (icon != null) ...<Widget>[
                Icon(icon, size: 20, color: iconColor ?? c.textMuted),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(label, style: DurbunType.heading(size: DurbunType.label, color: c.text).copyWith(height: 1.3)),
                    if (hint != null)
                      Text(hint!, style: TextStyle(fontSize: DurbunType.sm, height: 1.35, color: c.textMuted)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              ExcludeSemantics(child: Switch(value: value, onChanged: onChanged)),
            ],
          ),
        ),
      ),
      ),
    );
  }
}

/// Opens a bottom sheet whose content [build]s again after every change;
/// [onReset] adds a "Reset filters" button.
Future<void> showFilterSheet(
  BuildContext context, {
  required String title,
  required List<Widget> Function(BuildContext context, VoidCallback changed)
      build,
  required VoidCallback onChanged,
  VoidCallback? onReset,
  String? subtitle,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: DurbunColors.of(context).bgPanel,
    builder: (routeContext) => DurbunTheme.wrap(
      routeContext,
      StatefulBuilder(
        builder: (sheet, setSheet) {
          void changed() {
            onChanged();
            setSheet(() {});
          }

          final c = DurbunColors.of(sheet);
          final t = InspectorStrings.of(sheet);
          return ConstrainedBox(
            constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(sheet).height * 0.85),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, 0, 6, 2),
                  child: TitleWithLink(
                    title: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(title, style: DurbunType.heading(color: c.text)),
                        if (subtitle != null)
                          Text(subtitle, style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.35)),
                      ],
                    ),
                    link: onReset == null
                        ? null
                        : TextButton(
                            onPressed: () {
                              onReset();
                              changed();
                            },
                            child: Text(t.resetFilters, textAlign: TextAlign.end),
                          ),
                  ),
                ),
                // A few dozen rows: built at once (a lazy list would leave
                // the last ones unbuilt until scrolled to).
                Flexible(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: build(sheet, changed),
                    ),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.fromLTRB(
                      DurbunSpace.gutter, 8, DurbunSpace.gutter, 12 + MediaQuery.paddingOf(sheet).bottom),
                  child: SizedBox(
                    width: double.infinity,
                    child: DButton(
                        label: t.done,
                        primary: true,
                        large: true,
                        onTap: () => Navigator.of(sheet).pop()),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    ),
  );
}

/// One query word in the help list: what to type and what it does.
class QueryHint {
  const QueryHint(this.token, this.meaning);

  final String token;
  final String meaning;
}

/// Lists the query words; a tap adds the word to [controller].
Future<void> showQueryHelp(BuildContext context,
    {required List<QueryHint> hints,
    required TextEditingController controller,
    required ValueChanged<String> onChanged}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: DurbunColors.of(context).bgPanel,
    builder: (routeContext) => DurbunTheme.wrap(
      routeContext,
      Builder(builder: (sheet) {
        final c = DurbunColors.of(sheet);
        final t = InspectorStrings.of(sheet);
        return ConstrainedBox(
          constraints:
              BoxConstraints(maxHeight: MediaQuery.sizeOf(sheet).height * 0.75),
          child: ListView(
            shrinkWrap: true,
            padding: EdgeInsets.only(
                bottom: 16 + MediaQuery.paddingOf(sheet).bottom),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                child: Text(t.queryHelp, style: DurbunType.heading(color: c.text)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(t.queryHelpBody,
                    style: TextStyle(fontSize: DurbunType.body, height: 1.45, color: c.textMuted)),
              ),
              for (final h in hints)
                InkWell(
                  onTap: () {
                    final cur = controller.text.trimRight();
                    final next = cur.isEmpty ? h.token : '$cur ${h.token}';
                    controller.value = TextEditingValue(
                        text: next,
                        selection:
                            TextSelection.collapsed(offset: next.length));
                    onChanged(next);
                    Navigator.of(sheet).pop();
                  },
                  child: Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        ConstrainedBox(
                          constraints: const BoxConstraints(minWidth: 132),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            widthFactor: 1,
                            // A keycap: what to type.
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                  color: c.chipBg,
                                  border: Border.all(color: c.border),
                                  borderRadius: BorderRadius.circular(DurbunRadius.sm)),
                              child: Text(h.token,
                                  style: DurbunType.monoStyle(
                                      size: 12.5,
                                      color: c.text,
                                      weight: FontWeight.w500)),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(h.meaning,
                              style: TextStyle(fontSize: DurbunType.bodyMd, height: 1.4, color: c.text)),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        );
      }),
    ),
  );
}

/// A title (and its hint) with a link at the end of the row. The link takes
/// its own width up to half the row, wrapping at large text; the title the
/// rest.
class TitleWithLink extends StatelessWidget {
  const TitleWithLink({super.key, required this.title, this.link});

  final Widget title;
  final Widget? link;

  @override
  Widget build(BuildContext context) {
    final end = link;
    if (end == null) return SizedBox(width: double.infinity, child: title);
    return LayoutBuilder(
      builder: (context, box) => Row(
        children: <Widget>[
          Expanded(child: title),
          ConstrainedBox(constraints: BoxConstraints(maxWidth: box.maxWidth / 2), child: end),
        ],
      ),
    );
  }
}
