// Platform-agnostic backend contract behind the `Durbun` facade. The IO
// implementation lives in backend_io.dart, the no-op one (web) in
// backend_stub.dart. Must not import dart:io.
import 'dart:async';

import '../core/options.dart';
import '../core/types.dart';

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

  Future<void> dispose();

  /// Whether dart:io `HttpClient` traffic is captured right now.
  bool get capturesDartIo;

  /// Whether the plugin's native layer captures URLSession traffic (iOS).
  bool get capturesUrlSession;

  /// The desktop's body limit (`config.maxBodyBytes`); 0 when off.
  int get maxBodyBytes;

  /// Whether bodies are captured at all (`config.captureBodies`).
  bool get captureBodies;

  /// Mock rule applying to a request made outside dart:io, if any.
  DurbunMockDecision? findMock(String method, Uri url);

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

  /// Desktop state for the in-app inspector: `{connected, via, appId, config,
  /// mocks, hello}`; null when the SDK is off.
  Map<String, Object?>? inspectorState();
}
