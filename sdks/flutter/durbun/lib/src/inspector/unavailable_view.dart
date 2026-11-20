/// What `DurbunInspector.show()` opens when the SDK does not feed the panel:
/// why (not started, off in this build, panel turned off) and what to do,
/// instead of nothing happening.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../flutter/backend.dart' show DurbunOffReason, DurbunStartState;
import '../flutter/durbun.dart' show durbunBackend;
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// The code a developer adds to `main()` (shown when the SDK has not started).
const String kDurbunStartSnippet = 'void main() {\n'
    '  Durbun.run(() => runApp(const MyApp()));\n'
    '}';

/// Title and body for why the panel cannot open, by the SDK's start state.
(String, String) inspectorUnavailableText(InspectorStrings t, DurbunStartState state, DurbunOffReason? reason) =>
    switch (state) {
      DurbunStartState.off => (t.offTitle, t.offBody((reason ?? DurbunOffReason.option).name)),
      DurbunStartState.inspectorOff => (t.panelOffTitle, t.panelOffBody),
      DurbunStartState.unsupported => (t.unsupportedTitle, t.unsupportedBody),
      DurbunStartState.notStarted || DurbunStartState.running => (t.notStartedTitle, t.notStartedBody),
    };

/// One English line for the developer console, or null when there is
/// nothing to explain.
String? inspectorUnavailableConsoleText(DurbunStartState state, DurbunOffReason? reason) => switch (state) {
      DurbunStartState.notStarted => 'Dürbün: DurbunInspector is in the app, but the SDK has not started, so the '
          'panel stays closed. Start it in main(): Durbun.run(() => runApp(const MyApp())); '
          '(or await Durbun.init() before runApp).',
      DurbunStartState.off => 'Dürbün: off in this build (${switch (reason) {
          DurbunOffReason.release => 'a release build without --dart-define=DURBUN=true',
          DurbunOffReason.define => '--dart-define=DURBUN=false',
          DurbunOffReason.flutterTest => 'flutter test; DurbunOptions(enabled: true) turns it on',
          DurbunOffReason.option || null => 'DurbunOptions(enabled: false)',
        }}), so the in-app panel does not open.',
      DurbunStartState.inspectorOff =>
        'Dürbün: the in-app panel is off (DurbunOptions(inspector: false)); data still goes to the desktop.',
      DurbunStartState.running || DurbunStartState.unsupported => null,
    };

class InspectorUnavailablePage extends StatelessWidget {
  const InspectorUnavailablePage({super.key, required this.onClose});

  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final backend = durbunBackend();
    final state = backend.startState;
    final (title, body) = inspectorUnavailableText(t, state, backend.offReason);
    return Scaffold(
      backgroundColor: c.bgApp,
      appBar: AppBar(
        title: Text(t.title),
        automaticallyImplyLeading: false,
        actions: <Widget>[
          DIconButton(icon: Icons.close_rounded, tooltip: t.close, onTap: onClose),
          const SizedBox(width: 8),
        ],
      ),
      // Centred in the page while it fits; scrolls at large text.
      body: LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(16, 24, 16, 24 + MediaQuery.paddingOf(context).bottom),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: math.max(0, box.maxHeight - 48 - MediaQuery.paddingOf(context).bottom)),
            child: Center(
              child: MaxWidth(
                width: 480,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const Center(child: DurbunLogo(size: 56)),
                    const SizedBox(height: 20),
                    Semantics(
                      header: true,
                      child: Text(title, textAlign: TextAlign.center, style: DurbunType.heading(size: DurbunType.title, color: c.text)),
                    ),
                    const SizedBox(height: 8),
                    Text.rich(
                      inlineCode(body, base: DurbunType.ui(size: DurbunType.bodyMd, color: c.textMuted, height: 1.5), colors: c),
                      textAlign: TextAlign.center,
                    ),
                    if (state == DurbunStartState.notStarted || state == DurbunStartState.running) ...<Widget>[
                      const SizedBox(height: 20),
                      // The copy button sits in the snippet's corner.
                      const PlainCodeBlock(text: kDurbunStartSnippet, dart: true),
                    ],
                    const SizedBox(height: 24),
                    Align(child: DButton(label: t.close, kind: DButtonKind.outline, onTap: onClose)),
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
