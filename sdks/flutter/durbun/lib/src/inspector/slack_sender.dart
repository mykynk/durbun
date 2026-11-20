/// Who sends from the panel to Slack, and what they add: the name at the
/// end of every message ("Sent with Dürbün · Ayşe"), typed once on the
/// phone (kept across launches) or given by the app
/// ([DurbunInspector.slackSender]); and the tester's own message above a
/// shared request, log line or stream message.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'panel_prefs.dart';
import 'slack.dart' show canSendToSlack;
import 'store.dart';
import 'strings.dart';
import 'theme.dart';

const String kSlackSenderPref = 'slack-sender';

final ValueNotifier<String?> _typed = ValueNotifier<String?>(null);
Future<void>? _loading;

String? _clean(String? name) {
  final v = name?.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (v == null || v.isEmpty) return null;
  return v.length > 60 ? v.substring(0, 60) : v;
}

/// Reads the name typed on an earlier launch (once per process).
Future<void> loadSlackSender() => _loading ??= () async {
      try {
        final saved = _clean(await readPanelPref(kSlackSenderPref));
        // A name typed while it was being read wins.
        _typed.value ??= saved;
      } catch (_) {
        // A name is a nicety: the panel never sees its errors.
      }
    }();

/// The app's Slack webhook for [store]'s panel (a restored previous run's
/// store has none of its own), or null when Send to Slack is not offered.
String? slackWebhookFor(DurbunInspectorStore store) =>
    canSendToSlack ? store.slackWebhook ?? DurbunInspectorStore.existing?.slackWebhook : null;

/// The name typed on this phone (null: none, the app's name applies).
ValueListenable<String?> get typedSlackSender => _typed;

/// Takes [name] as typed now; [persist] keeps it for the next launches.
void setSlackSender(String name, {bool persist = false}) {
  _typed.value = _clean(name);
  if (persist) writePanelPref(kSlackSenderPref, _typed.value).ignore();
}

/// The sender for a message from [store]'s panel: the name typed on the
/// phone, else the app's, else none.
String? slackSenderFor(DurbunInspectorStore store) =>
    _typed.value ?? store.slackSender ?? DurbunInspectorStore.existing?.slackSender;

/// The last line of a Slack message: "Sent with Dürbün · Ayşe (in-app
/// panel)", without a name when there is none.
String slackFooterFor(InspectorStrings t, String? sender) => sender == null ? t.slackFooter : t.slackFooterFrom(sender);

/// [report] with the tester's [note] above it as a quote (Slack's
/// notification then shows the note); [report] alone without one.
String withShareNote(String report, String note) {
  final text = note.trim();
  if (text.isEmpty) return report;
  final quoted = text.split('\n').map((l) => l.trim().isEmpty ? '>' : '> ${l.trimRight()}').join('\n');
  return '$quoted\n\n$report';
}

@visibleForTesting
void debugResetSlackSender() {
  _typed.value = null;
  _loading = null;
}

/// A text field of the panel's sheets (a note, a name): the bug report's
/// look, filled, rounded, accent focus ring.
class PanelTextField extends StatelessWidget {
  const PanelTextField({
    super.key,
    required this.controller,
    required this.label,
    this.hint,
    this.enabled = true,
    this.minLines = 1,
    this.maxLines = 1,
    this.icon,
    this.onChanged,
    this.textCapitalization = TextCapitalization.sentences,
  });

  final TextEditingController controller;

  /// Read by screen readers (the field shows [hint]).
  final String label;
  final String? hint;
  final bool enabled;
  final int minLines;
  final int maxLines;
  final IconData? icon;
  final ValueChanged<String>? onChanged;
  final TextCapitalization textCapitalization;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    OutlineInputBorder border(Color color, [double width = 1]) => OutlineInputBorder(
          borderRadius: BorderRadius.circular(DurbunRadius.md),
          borderSide: BorderSide(color: color, width: width),
        );
    final multi = maxLines > 1;
    return Semantics(
      label: label,
      child: TextField(
        controller: controller,
        enabled: enabled,
        minLines: minLines,
        maxLines: maxLines,
        onChanged: onChanged,
        textCapitalization: textCapitalization,
        keyboardType: multi ? TextInputType.multiline : TextInputType.text,
        textInputAction: multi ? TextInputAction.newline : TextInputAction.done,
        style: TextStyle(fontSize: DurbunType.bodyMd, color: c.text, height: 1.4),
        cursorColor: c.accent,
        decoration: InputDecoration(
          isDense: true,
          filled: true,
          fillColor: c.fieldBg,
          hintText: hint,
          hintMaxLines: 3,
          hintStyle: TextStyle(fontSize: DurbunType.bodyMd, color: c.textSubtle, height: 1.4),
          prefixIcon: icon == null ? null : Icon(icon, size: 18, color: c.textSubtle),
          prefixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 40),
          contentPadding: const EdgeInsets.all(12),
          border: border(c.border),
          enabledBorder: border(c.border),
          disabledBorder: border(c.border),
          focusedBorder: border(c.accent, 1.5),
        ),
      ),
    );
  }
}

/// "Your name": who the Slack message is from, filled with the name typed
/// last time (or the app's). Kept on the phone when the sheet closes.
class SlackSenderField extends StatefulWidget {
  const SlackSenderField({super.key, required this.store, this.enabled = true});

  final DurbunInspectorStore store;
  final bool enabled;

  @override
  State<SlackSenderField> createState() => _SlackSenderFieldState();
}

class _SlackSenderFieldState extends State<SlackSenderField> {
  late final TextEditingController _name = TextEditingController(text: slackSenderFor(widget.store) ?? '');
  bool _edited = false;

  @override
  void initState() {
    super.initState();
    // The name typed on an earlier launch, unless something is typed.
    loadSlackSender().then((_) {
      if (!mounted || _edited) return;
      final name = slackSenderFor(widget.store) ?? '';
      if (name != _name.text) _name.text = name;
    });
  }

  @override
  void dispose() {
    if (_edited) setSlackSender(_name.text, persist: true);
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return PanelTextField(
      key: const ValueKey<String>('durbun-slack-sender'),
      controller: _name,
      enabled: widget.enabled,
      label: t.slackSenderLabel,
      hint: t.slackSenderHint,
      icon: Icons.person_outline_rounded,
      textCapitalization: TextCapitalization.words,
      onChanged: (v) {
        _edited = true;
        setSlackSender(v);
      },
    );
  }
}
