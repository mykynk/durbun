/// What stream capture (WebSocket messages, Server-Sent Events) needs from
/// the SDK, next to `NetworkRecorder`. A recorder that does not implement it
/// gets no stream messages (and SSE responses are reported like any other).
abstract interface class StreamCaptureHost {
  /// Send `net.ws` / `net.sse` now: the latest desktop config has
  /// `captureStreams: true`.
  bool get captureStreams;

  /// Payload bytes kept of one stream message (0: sizes only).
  int get streamMessageCap;

  /// Stream messages are wanted, or may still be (no desktop config yet).
  /// While false, captures skip all decoding work.
  bool get streamsWanted;
}
