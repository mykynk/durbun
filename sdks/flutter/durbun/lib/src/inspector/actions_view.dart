/// Tools → App tools: the app's own `DurbunAction` controls (buttons,
/// switches, choices) and the native layer's, usable on the phone without
/// the Mac. The desktop sees the new values.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../flutter/durbun.dart' show durbunBackend;
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// Groups in the order the page lists them: the app's own first.
const List<String> _groupOrder = <String>['app', 'flutter', 'android', 'ios'];

String _groupKey(Object? group) {
  final g = group is String ? group : '';
  return g.isEmpty ? 'app' : g;
}

class AppToolsView extends StatefulWidget {
  const AppToolsView({super.key});

  @override
  State<AppToolsView> createState() => _AppToolsViewState();
}

class _AppToolsViewState extends State<AppToolsView> {
  final Set<String> _running = <String>{};

  String _label(InspectorStrings t, Map<String, Object?> a) =>
      t.actionLabel(a['labelKey'] as String?) ?? '${a['label'] ?? a['id']}';

  static String _errorText(Object e) {
    final text = switch (e) {
      StateError(:final message) => message,
      ArgumentError(:final message) => '$message',
      TimeoutException() => 'no answer',
      _ => '$e',
    };
    return text.length > 200 ? '${text.substring(0, 200)}…' : text;
  }

  Future<void> _run(InspectorStrings t, Map<String, Object?> a, Map<String, Object?> params) async {
    final id = '${a['id']}';
    if (_running.contains(id)) return;
    final label = _label(t, a);
    final messenger = ScaffoldMessenger.maybeOf(context);
    setState(() => _running.add(id));
    try {
      final result = await durbunBackend().runAction(id, params);
      if (a['kind'] == 'button') {
        final value = _resultText(result);
        final dump = id.toLowerCase().contains('dump');
        messenger?.showSnackBar(SnackBar(
          content: Text(<String>[
            value == null ? t.actionDone(label) : t.actionValue(label, value),
            if (dump) t.dumpInLogs,
          ].join(' · ')),
          duration: const Duration(seconds: 2),
        ));
      }
    } catch (e) {
      messenger?.showSnackBar(SnackBar(content: Text(t.actionFailed(label, _errorText(e))), duration: const Duration(seconds: 4)));
    } finally {
      if (mounted) setState(() => _running.remove(id));
    }
  }

  /// A short text for a button's result: plain values as they are, a small
  /// map as `key: value` pairs; nothing for null or a large result.
  static String? _resultText(Object? result) {
    if (result == null) return null;
    if (result is String || result is num || result is bool) {
      final s = '$result';
      return s.isEmpty || s.length > 80 ? null : s;
    }
    if (result is Map && result.isNotEmpty && result.length <= 3) {
      final s = result.entries.map((e) => '${e.key}: ${e.value}').join(', ');
      return s.length > 80 ? null : s;
    }
    return null;
  }

  Future<void> _press(InspectorStrings t, Map<String, Object?> a) async {
    final group = _groupKey(a['group']);
    // Built-in tools are harmless; the app's own buttons may clear data or log out.
    if (group == 'app' || !_groupOrder.contains(group)) {
      final label = _label(t, a);
      final yes = await showDialog<bool>(
        context: context,
        useRootNavigator: false,
        builder: (dialogContext) => DurbunTheme.wrap(
          dialogContext,
          Builder(builder: (dialog) {
            final c = DurbunColors.of(dialog);
            return AlertDialog(
              backgroundColor: c.bgElevated,
              surfaceTintColor: Colors.transparent,
              title: Text(t.runConfirm(label), style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: c.text)),
              actions: <Widget>[
                TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: Text(t.cancel)),
                TextButton(onPressed: () => Navigator.of(dialog).pop(true), child: Text(t.run)),
              ],
            );
          }),
        ),
      );
      if (yes != true || !mounted) return;
    }
    await _run(t, a, const <String, Object?>{});
  }

  Future<void> _choose(InspectorStrings t, Map<String, Object?> a) async {
    final options = <(String, String)>[
      for (final o in (a['options'] as List?) ?? const <Object?>[])
        if (o is Map) ('${o['value']}', t.actionOption('${o['value']}') ?? '${o['label'] ?? o['value']}'),
    ];
    final current = '${a['value'] ?? ''}';
    final picked = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      backgroundColor: DurbunColors.of(context).bgApp,
      builder: (sheetContext) => DurbunTheme.wrap(
        sheetContext,
        Builder(builder: (sheet) {
          final c = DurbunColors.of(sheet);
          return ListView(
            shrinkWrap: true,
            padding: EdgeInsets.fromLTRB(8, 0, 8, 12 + MediaQuery.paddingOf(sheet).bottom),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                child: Text(_label(t, a), style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: c.text)),
              ),
              for (final o in options)
                ListTile(
                  title: Text(o.$2, style: TextStyle(color: c.text)),
                  trailing: o.$1 == current ? Icon(Icons.check_rounded, color: c.accent) : null,
                  onTap: () => Navigator.of(sheet).pop(o.$1),
                ),
            ],
          );
        }),
      ),
    );
    if (picked == null || picked == current || !mounted) return;
    await _run(t, a, <String, Object?>{'value': picked});
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final backend = durbunBackend();
    return ListenableBuilder(
      listenable: backend.changes,
      builder: (context, _) {
        final actions = backend.actions;
        if (actions.isEmpty) {
          return ListView(
            padding: const EdgeInsets.all(12),
            children: <Widget>[
              const SizedBox(height: 24),
              EmptyState(title: t.noToolsTitle, body: t.noToolsBody),
            ],
          );
        }
        final groups = <String, List<Map<String, Object?>>>{};
        for (final a in actions) {
          (groups[_groupKey(a['group'])] ??= <Map<String, Object?>>[]).add(a);
        }
        final keys = groups.keys.toList()
          ..sort((x, y) {
            int rank(String g) {
              final i = _groupOrder.indexOf(g);
              return i < 0 ? 0 : i; // other app groups next to the app's own
            }

            return rank(x).compareTo(rank(y));
          });
        return ListView(
          padding: EdgeInsets.fromLTRB(12, 0, 12, 20 + MediaQuery.paddingOf(context).bottom),
          children: <Widget>[
            for (final g in keys) ...<Widget>[
              SectionTitle(t.actionGroup(g)),
              Container(
                decoration: BoxDecoration(color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: <Widget>[
                    for (var i = 0; i < groups[g]!.length; i++) ...<Widget>[
                      if (i > 0) Divider(height: 1, color: c.hairline),
                      _row(c, t, groups[g]![i]),
                    ],
                  ],
                ),
              ),
            ],
          ],
        );
      },
    );
  }

  Widget _row(DurbunColors c, InspectorStrings t, Map<String, Object?> a) {
    final id = '${a['id']}';
    final label = _label(t, a);
    final busy = _running.contains(id);
    final kind = a['kind'];
    final Widget trailing;
    VoidCallback? onTap;
    switch (kind) {
      case 'toggle':
        final on = a['value'] == true;
        trailing = Switch(value: on, onChanged: busy ? null : (v) => _run(t, a, <String, Object?>{'value': v}));
        onTap = busy ? null : () => _run(t, a, <String, Object?>{'value': !on});
      case 'select':
        final value = '${a['value'] ?? ''}';
        String shown = value;
        for (final o in (a['options'] as List?) ?? const <Object?>[]) {
          if (o is Map && '${o['value']}' == value) shown = t.actionOption(value) ?? '${o['label'] ?? value}';
        }
        trailing = Row(mainAxisSize: MainAxisSize.min, children: <Widget>[
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 140),
            child: Text(shown, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: c.textSubtle)),
          ),
          Icon(Icons.chevron_right_rounded, size: 20, color: c.textSubtle),
        ]);
        onTap = busy ? null : () => _choose(t, a);
      default:
        trailing = Icon(Icons.play_arrow_rounded, size: 20, color: c.accent);
        onTap = busy ? null : () => _press(t, a);
    }
    return Semantics(
      button: kind != 'toggle',
      toggled: kind == 'toggle' ? a['value'] == true : null,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 52),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 6, 10, 6),
            child: Row(
              children: <Widget>[
                Expanded(child: Text(label, style: TextStyle(fontSize: 15, color: c.text))),
                const SizedBox(width: 8),
                if (busy && kind != 'toggle')
                  SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: c.accent))
                else
                  trailing,
              ],
            ),
          ),
        ),
      ),
    );
  }
}
