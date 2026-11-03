// No-op backend for platforms without dart:io (Flutter web): the API stays
// callable, the app body still runs, nothing is captured.
import 'dart:async';

import '../core/options.dart';
import '../core/types.dart';
import 'backend.dart';

DurbunBackend createDurbunBackend() => _StubBackend();

class _StubBackend implements DurbunBackend {
  @override
  bool get isActive => false;

  @override
  Future<void> init(DurbunOptions options) async {}

  @override
  Future<void> run(FutureOr<void> Function() body, DurbunOptions options) =>
      Future<void>.sync(body);

  @override
  void log(
    DurbunLogLevel level,
    Object? message, {
    String? tag,
    Object? data,
    Object? error,
    StackTrace? stackTrace,
  }) {}

  @override
  void event(String name, Map<String, Object?>? props) {}

  @override
  DurbunConnection get connection => DurbunConnection.disconnected;

  @override
  Stream<DurbunConnection> get connectionChanges =>
      const Stream<DurbunConnection>.empty();

  @override
  void addAction(DurbunAction action) {}

  @override
  void removeAction(String id) {}

  @override
  Future<bool> flush(Duration timeout) async => false;

  @override
  Future<void> dispose() async {}

  @override
  bool get capturesDartIo => false;

  @override
  bool get capturesUrlSession => false;

  @override
  DurbunMockDecision? findMock(String method, Uri url) => null;

  @override
  DurbunHttpCall? beginHttpCall({
    required String method,
    required Uri url,
    required List<List<String>> headers,
    List<int>? body,
    String? contentType,
    required String source,
    String? mockRuleId,
  }) => null;

  @override
  Map<String, Object?>? inspectorState() => null;
}
