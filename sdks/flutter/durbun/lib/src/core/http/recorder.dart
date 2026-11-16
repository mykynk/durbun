import '../mocks.dart';

/// What the dart:io HTTP wrapper needs from the SDK client.
abstract interface class NetworkRecorder {
  /// False → the wrapper is a pure pass-through (SDK disabled or disposed).
  bool get networkEnabled;

  /// Whether body contents are captured (sizes always are).
  bool get captureBodies;

  /// Bodies are cut after this many bytes.
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

/// A [NetworkRecorder] that also evaluates mock rules with conditions on the
/// request body (a GraphQL operation). Optional, so other implementations of
/// [NetworkRecorder] keep compiling; without it such rules never match.
abstract interface class MockRequestMatcher {
  /// Whether the rule for [method] [url] may depend on the request body.
  bool mockNeedsBody(String method, String url);

  /// First matching rule for this request. [body] returns the body text when
  /// it is held (null otherwise); called at most once, only when needed.
  MockRule? matchMockRequest(
    String method,
    String url, {
    String? contentType,
    String? Function()? body,
  });
}
