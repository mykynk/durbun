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
    return Material(
      color: on ? c.accentSoft : c.cardBg,
      shape: StadiumBorder(
        side: BorderSide(color: on ? c.accent.withValues(alpha: 0.7) : c.border),
      ),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Container(
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.tune_rounded, size: 15, color: on ? c.badgeAccent : c.text),
              const SizedBox(width: 5),
              Text(t.filters,
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: on ? c.badgeAccent : c.text,
                      height: 1.2)),
              if (on) ...<Widget>[
                const SizedBox(width: 6),
                Container(
                  height: 17,
                  constraints: const BoxConstraints(minWidth: 17),
                  padding: const EdgeInsets.symmetric(horizontal: 5),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                      color: c.accent, borderRadius: BorderRadius.circular(999)),
                  child: Text('$count',
                      style: DurbunType.monoStyle(
                          size: 10.5,
                          color: Colors.white,
                          weight: FontWeight.w700,
                          height: 1.1)),
                ),
              ],
            ],
          ),
        ),
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
  final Color? color;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final fg = color ?? c.badgeAccent;
    return Semantics(
      button: true,
      label: '${t.remove}: $label',
      child: Material(
        color: (color ?? c.accent).withValues(alpha: 0.14),
        shape: StadiumBorder(
          side: BorderSide(color: (color ?? c.accent).withValues(alpha: 0.5)),
        ),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onRemove,
          // A long tag shrinks with an ellipsis instead of overflowing
          // (the filter sheet's Wrap, large text).
          child: Container(
            height: 30,
            constraints: const BoxConstraints(maxWidth: 260),
            padding: const EdgeInsets.only(left: 10, right: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Flexible(
                  child: Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: mono
                        ? DurbunType.monoStyle(
                            size: 11.5,
                            color: fg,
                            weight: FontWeight.w600,
                            height: 1.2)
                        : TextStyle(
                            fontSize: 12,
                            color: fg,
                            fontWeight: FontWeight.w600,
                            height: 1.2)),
                ),
                const SizedBox(width: 3),
                Icon(Icons.close_rounded, size: 14, color: fg.withValues(alpha: 0.8)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The scrolling row under the search field.
class FilterRow extends StatelessWidget {
  const FilterRow({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      color: c.bgPanel,
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
        itemCount: children.length,
        separatorBuilder: (_, __) => const SizedBox(width: 6),
        itemBuilder: (_, i) => children[i],
      ),
    );
  }
}

/// A titled group in the filter sheet.
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
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title,
              style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: c.text,
                  letterSpacing: -0.1)),
          if (hint != null) ...<Widget>[
            const SizedBox(height: 2),
            Text(hint!, style: TextStyle(fontSize: 11.5, color: c.textMeta)),
          ],
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 6, children: children),
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
      this.icon});

  final String label;
  final String? hint;
  final IconData? icon;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return InkWell(
      onTap: () => onChanged(!value),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 10, 8),
        child: Row(
          children: <Widget>[
            if (icon != null) ...<Widget>[
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                    color: c.trackBg,
                    borderRadius: BorderRadius.circular(DurbunRadius.md)),
                child: Icon(icon, size: 17, color: c.textMuted),
              ),
              const SizedBox(width: 12),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(label, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w500, color: c.text)),
                  if (hint != null)
                    Text(hint!,
                        style: TextStyle(fontSize: 11.5, color: c.textMeta)),
                ],
              ),
            ),
            Switch(value: value, onChanged: onChanged),
          ],
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
                maxHeight: MediaQuery.sizeOf(sheet).height * 0.8),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 8, 4),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(title,
                            style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                                letterSpacing: -0.3,
                                color: c.text)),
                      ),
                      if (onReset != null)
                        TextButton(
                          onPressed: () {
                            onReset();
                            changed();
                          },
                          child: Text(t.resetFilters),
                        ),
                    ],
                  ),
                ),
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    padding: EdgeInsets.only(
                        bottom: 16 + MediaQuery.paddingOf(sheet).bottom),
                    children: build(sheet, changed),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.fromLTRB(
                      16, 4, 16, 12 + MediaQuery.paddingOf(sheet).bottom),
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
                child: Text(t.queryHelp,
                    style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.3,
                        color: c.text)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(t.queryHelpBody,
                    style: TextStyle(fontSize: 12.5, color: c.textMuted)),
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
                        const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        ConstrainedBox(
                          constraints: const BoxConstraints(minWidth: 132),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            widthFactor: 1,
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                              decoration: BoxDecoration(
                                  color: c.accentSoft,
                                  borderRadius: BorderRadius.circular(DurbunRadius.sm)),
                              child: Text(h.token,
                                  style: DurbunType.monoStyle(
                                      size: 12.5,
                                      color: c.badgeAccent,
                                      weight: FontWeight.w600)),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(h.meaning,
                              style: TextStyle(fontSize: 13, color: c.text)),
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
