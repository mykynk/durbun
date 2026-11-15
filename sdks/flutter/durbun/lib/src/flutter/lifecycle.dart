import 'package:flutter/widgets.dart';

import '../core/client.dart';
import '../core/types.dart';
import 'metrics.dart' show schedulerBindingOrNull;

/// Follows the app's lifecycle once a Flutter binding exists:
/// - tells the client when the app is in the background, so it makes no
///   connection attempts while nobody looks and tries again at once when
///   the app comes back;
/// - with [logChanges], sends a log line (tag `lifecycle`) per change, e.g.
///   `AppLifecycleState.paused`.
class AppLifecycleWatcher with WidgetsBindingObserver {
  AppLifecycleWatcher(this.client, {this.logChanges = true});

  final DurbunClient client;
  final bool logChanges;

  WidgetsBinding? _binding;
  AppLifecycleState? _last;

  /// Attaches once the binding exists (called periodically until then).
  void ensureAttached() {
    if (_binding != null) return;
    try {
      final scheduler = schedulerBindingOrNull();
      if (scheduler is! WidgetsBinding) return;
      final binding = scheduler;
      _binding = binding;
      binding.addObserver(this);
      final state = binding.lifecycleState;
      _last = state;
      if (state != null && isBackground(state)) client.setAppInBackground(true);
    } catch (_) {}
  }

  /// Whether [state] means nobody sees the app.
  static bool isBackground(AppLifecycleState state) =>
      state == AppLifecycleState.paused || state == AppLifecycleState.hidden;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    try {
      if (state == _last) return;
      _last = state;
      client.setAppInBackground(isBackground(state));
      if (logChanges) {
        client.log(DurbunLogLevel.info, 'AppLifecycleState.${state.name}', tag: 'lifecycle');
      }
    } catch (_) {}
  }

  void dispose() {
    try {
      _binding?.removeObserver(this);
    } catch (_) {}
    _binding = null;
  }
}
