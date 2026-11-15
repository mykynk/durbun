/// What `DurbunInspector.show()` opens when the SDK does not feed the panel:
/// why (not started, off in this build, panel turned off) and what to do,
/// instead of nothing happening.
library;

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
        shape: Border(bottom: BorderSide(color: c.border)),
        actions: <Widget>[
          DIconButton(icon: Icons.close_rounded, tooltip: t.close, onTap: onClose),
          const SizedBox(width: 4),
        ],
      ),
      body: ListView(
        padding: EdgeInsets.fromLTRB(20, 32, 20, 24 + MediaQuery.paddingOf(context).bottom),
        children: <Widget>[
          MaxWidth(
            width: 480,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const Center(child: DurbunLogo(size: 48)),
                const SizedBox(height: 16),
                Text(title,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: DurbunType.title, fontWeight: FontWeight.w600, color: c.text, height: 1.3)),
                const SizedBox(height: 6),
                Text(body,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: DurbunType.body + 1, height: 1.45, color: c.textMuted)),
                if (state == DurbunStartState.notStarted || state == DurbunStartState.running) ...<Widget>[
                  const SizedBox(height: 20),
                  // The copy button sits in the snippet's corner.
                  CodeBlock(text: kDurbunStartSnippet),
                ],
                const SizedBox(height: 24),
                Align(child: DButton(label: t.close, kind: DButtonKind.ghost, onTap: onClose)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
