import '../mocks.dart';

/// What the dart:io HTTP wrapper needs from the SDK client.
abstract interface class NetworkRecorder {
  /// False → the wrapper is a pure pass-through (SDK disabled or disposed).
  bool get networkEnabled;

  bool get captureBodies;

  int get maxBodyBytes;

  /// Whether the value of [lowerCaseName] must be redacted.
  bool isRedactedHeader(String lowerCaseName);

  /// First matching mock rule for this request, or null.
  MockRule? matchMock(String method, String url);

  /// Non-null while the very first desktop handshake may still be in flight;
  /// requests wait for it (bounded) so startup requests can be mocked.
  Future<void>? get mocksReady;

  /// Unique request id within this app session.
  String nextRequestId();

  /// Queues a `net.*` message.
  void sendNetMessage(Map<String, Object?> message);
}
