// Platform-agnostic backend contract behind the `Durbun` facade. The IO
// implementation lives in backend_io.dart, the no-op one (web) in
// backend_stub.dart. Must not import dart:io.
import 'dart:async';

import 'package:flutter/foundation.dart' show Listenable;

import '../core/connection_report.dart';
import '../core/options.dart';
import '../core/types.dart';

/// How the SDK's start went, for the in-app panel when it cannot open.
enum DurbunStartState {
  /// `Durbun.run` / `Durbun.init` was not called (yet).
  notStarted,

  /// Off in this build (see [DurbunOffReason]).
  off,

  /// Running, with the panel turned off (`DurbunOptions.inspector: false`).
  inspectorOff,

  /// Running with the panel.
  running,

  /// No dart:io (Flutter web): nothing is captured.
  unsupported,
}

/// Why the SDK is off in this build.
enum DurbunOffReason {
  /// `DurbunOptions(enabled: false)`.
  option,

  /// `--dart-define=DURBUN=false`.
  define,

  /// A release build without `--dart-define=DURBUN=true`.
  release,

  /// Under `flutter test` without `enabled: true`.
  flutterTest,
}

abstract class DurbunBackend {
  /// True once the SDK runs (enabled and started).
  bool get isActive;

  /// [actions]: added through the facade before the SDK started; they are
  /// in the first hello.
  Future<void> init(
    DurbunOptions options, {
    List<DurbunAction> actions = const <DurbunAction>[],
  });

  Future<void> run(
    FutureOr<void> Function() body,
    DurbunOptions options, {
    List<DurbunAction> actions = const <DurbunAction>[],
  });

  void log(
    DurbunLogLevel level,
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  });

  void event(String name, Map<String, Object?>? props);

  DurbunConnection get connection;

  Stream<DurbunConnection> get connectionChanges;

  void addAction(DurbunAction action);

  void removeAction(String id);

  Future<bool> flush(Duration timeout);

  /// Captures dart:io HTTP of the calling (background) isolate through the
  /// SDK running in the main isolate; true when captured.
  Future<bool> attachIsolate();

  Future<void> dispose();

  /// Whether dart:io `HttpClient` traffic is captured right now.
  bool get capturesDartIo;

  /// Whether the plugin's native layer captures URLSession traffic (iOS).
  bool get capturesUrlSession;

  /// The desktop's body limit (`config.maxBodyBytes`); 0 when off.
  int get maxBodyBytes;

  /// Whether bodies are captured at all (`config.captureBodies`).
  bool get captureBodies;

  /// Mock rule applying to a request made outside dart:io, if any. [body]
  /// gives the request body as text when the caller holds it (rules limited
  /// to a GraphQL operation read it); called at most once, only when needed.
  DurbunMockDecision? findMock(
    String method,
    Uri url, {
    String? contentType,
    String? Function()? body,
  });

  /// Starts reporting a request made outside dart:io (null when off).
  DurbunHttpCall? beginHttpCall({
    required String method,
    required Uri url,
    required List<List<String>> headers,
    List<int>? body,
    String? contentType,
    required String source,
    String? mockRuleId,
    int? bodySize,
  });

  /// Whether the desktop takes WebSocket messages and SSE events right now.
  bool get capturesStreams;

  /// Starts reporting a WebSocket connection made outside dart:io (null when
  /// off).
  DurbunWebSocketCall? beginWebSocket({
    required Uri url,
    required List<List<String>> headers,
    required String source,
  });

  /// Desktop state for the in-app inspector: `{connected, via, appId, config,
  /// mocks, hello}`; null when the SDK is off.
  Map<String, Object?>? inspectorState();

  /// How the last start went.
  DurbunStartState get startState;

  /// Why it is off, when [startState] is [DurbunStartState.off].
  DurbunOffReason? get offReason;

  /// Whether this runs under `flutter test`.
  bool get inFlutterTest;

  /// Why the app is (not) connected to the desktop; null when off.
  ConnectionReport? get connectionReport;

  /// Fires when [connectionReport], the actions or their values change.
  Listenable get changes;

  /// Uses [address] as the Mac's Wi-Fi address from now on and keeps it for
  /// the next launches; null goes back to the build's address.
  Future<void> setDesktopHost(String? address);

  /// Descriptors of the app's and the native layer's actions (wire format).
  List<Map<String, Object?>> get actions;

  /// Runs one of [actions] from the panel (see `DurbunClient.runAction`).
  Future<Object?> runAction(String id, Map<String, Object?> params);
}
