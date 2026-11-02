import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

import '../core/client.dart';
import '../core/json_safe.dart';
import '../core/protocol.dart';
import '../core/types.dart';

/// Chains `FlutterError.onError` and `PlatformDispatcher.onError` (and
/// re-chains them when the app installs its own handlers later, e.g.
/// Crashlytics), reporting `flutter-error` and `crash` entries.
class FlutterErrorHooks {
  FlutterErrorHooks(this.client);

  final DurbunClient client;

  /// Every handler closure we installed (each keeps its own `previous`, so
  /// re-chaining can never loop).
  final Set<Object> _ourFlutterHandlers = <Object>{};
  final Set<Object> _ourPlatformHandlers = <Object>{};
  FlutterExceptionHandler? _latestFlutterHandler;
  FlutterExceptionHandler? _latestFlutterPrevious;
  ui.ErrorCallback? _latestPlatformHandler;
  ui.ErrorCallback? _latestPlatformPrevious;

  FlutterErrorDetails? _lastDetails;
  final List<(Object, DateTime)> _recentUncaught = <(Object, DateTime)>[];
  bool _disposed = false;

  void install() => ensureInstalled();

  /// (Re)installs our handlers if the app replaced them.
  void ensureInstalled() {
    if (_disposed) return;
    final currentFlutter = FlutterError.onError;
    if (currentFlutter == null || !_ourFlutterHandlers.contains(currentFlutter)) {
      final previous = currentFlutter;
      void handler(FlutterErrorDetails details) {
        _reportFlutterError(details);
        if (previous != null) previous(details);
      }

      _ourFlutterHandlers.add(handler);
      _latestFlutterHandler = handler;
      _latestFlutterPrevious = previous;
      FlutterError.onError = handler;
    }

    final dispatcher = ui.PlatformDispatcher.instance;
    final currentPlatform = dispatcher.onError;
    if (currentPlatform == null ||
        !_ourPlatformHandlers.contains(currentPlatform)) {
      final previous = currentPlatform;
      bool handler(Object error, StackTrace stack) {
        reportUncaught(error, stack, source: 'platform');
        return previous?.call(error, stack) ?? false;
      }

      _ourPlatformHandlers.add(handler);
      _latestPlatformHandler = handler;
      _latestPlatformPrevious = previous;
      dispatcher.onError = handler;
    }
  }

  /// Restores the handlers that were there before our latest installation.
  void dispose() {
    _disposed = true;
    if (identical(FlutterError.onError, _latestFlutterHandler)) {
      FlutterError.onError = _latestFlutterPrevious;
    }
    final dispatcher = ui.PlatformDispatcher.instance;
    if (identical(dispatcher.onError, _latestPlatformHandler)) {
      dispatcher.onError = _latestPlatformPrevious;
    }
  }

  void _reportFlutterError(FlutterErrorDetails details) {
    if (_disposed || identical(details, _lastDetails)) return;
    _lastDetails = details;
    try {
      String exceptionText;
      try {
        exceptionText = details.exceptionAsString();
      } catch (_) {
        exceptionText = details.exception.toString();
      }
      client.sendLog(
        level: details.silent ? DurbunLogLevel.warn : DurbunLogLevel.error,
        message: renderFlutterErrorDetails(details),
        tag: 'flutter',
        kind: details.silent ? SdkLogKind.text : SdkLogKind.flutterError,
        error: buildErrorInfo(
          type: details.exception.runtimeType.toString(),
          message: capString(exceptionText, 64 * 1024),
          stack: details.stack == null
              ? null
              : capString(details.stack.toString(), 256 * 1024),
        ),
        data: <String, Object?>{
          if (details.library != null) 'library': details.library,
          if (details.context != null) 'context': details.context.toString(),
          if (details.silent) 'silent': true,
        },
      );
    } catch (_) {}
  }

  /// Reports an uncaught (zone or platform) error once.
  void reportUncaught(Object error, StackTrace? stack, {required String source}) {
    if (_disposed) return;
    final now = DateTime.now();
    _recentUncaught.removeWhere(
      (e) => now.difference(e.$2) > const Duration(seconds: 10),
    );
    if (_recentUncaught.any((e) => identical(e.$1, error))) return;
    _recentUncaught.add((error, now));
    if (_recentUncaught.length > 32) _recentUncaught.removeAt(0);
    try {
      String text;
      try {
        text = error.toString();
      } catch (_) {
        text = error.runtimeType.toString();
      }
      client.sendLog(
        level: DurbunLogLevel.fatal,
        message: 'Unhandled exception: $text',
        tag: 'flutter',
        kind: SdkLogKind.crash,
        error: DurbunClient.errorInfo(error, stack),
        data: <String, Object?>{'source': source},
      );
    } catch (_) {}
  }
}

/// The error box exactly as `FlutterError.dumpErrorToConsole` prints it in
/// debug builds; a compact form in profile/release (no diagnostics there).
String renderFlutterErrorDetails(FlutterErrorDetails details) {
  if (kDebugMode) {
    try {
      return TextTreeRenderer(
        wrapWidthProperties: FlutterError.wrapWidth,
        maxDescendentsTruncatableNode: 5,
      ).render(details.toDiagnosticsNode(style: DiagnosticsTreeStyle.error)).trimRight();
    } catch (_) {
      // fall through to the compact form
    }
  }
  final sb = StringBuffer();
  try {
    sb.write(details.exceptionAsString());
  } catch (_) {
    sb.write(details.exception.runtimeType);
  }
  if (details.context != null) sb.write('\n${details.context}');
  if (details.library != null) sb.write('\n(${details.library})');
  return sb.toString();
}
