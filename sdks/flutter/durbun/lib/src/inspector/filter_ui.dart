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

/// The scrolling row under the search field.
class FilterRow extends StatelessWidget {
  const FilterRow({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      color: c.bgPanel,
      height: 52,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        itemCount: children.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
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
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title,
              style: TextStyle(
                  fontSize: DurbunType.body,
                  fontWeight: FontWeight.w600,
                  color: c.textMuted)),
          if (hint != null) ...<Widget>[
            const SizedBox(height: 2),
            Text(hint!, style: TextStyle(fontSize: DurbunType.body, color: c.textSubtle)),
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
        padding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
        child: Row(
          children: <Widget>[
            if (icon != null) ...<Widget>[
              Icon(icon, size: 22, color: c.textMuted),
              const SizedBox(width: 14),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(label, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: c.text)),
                  if (hint != null)
                    Text(hint!,
                        style: TextStyle(fontSize: DurbunType.body, color: c.textSubtle)),
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
                                fontSize: DurbunType.title,
                                fontWeight: FontWeight.w600,
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
                // A few dozen rows: built at once (a lazy list would leave
                // the last ones unbuilt until scrolled to).
                Flexible(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: build(sheet, changed),
                    ),
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
                        fontSize: DurbunType.title,
                        fontWeight: FontWeight.w600,
                        color: c.text)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(t.queryHelpBody,
                    style: TextStyle(fontSize: 13, color: c.textMuted)),
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
                                  color: c.trackBg,
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
