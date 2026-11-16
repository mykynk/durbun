import 'dart:typed_data';

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

/// The in-app panel's own record of stream messages, apart from what goes to
/// the desktop. The desktop's copy follows its config exactly; the panel
/// records whenever it records requests, with or without a desktop. A
/// message the desktop takes reaches the panel through the client's
/// outgoing tap (with the desktop's payload cap); one it does not take comes
/// here, and only here. Internal to the SDK (not exported).
abstract interface class LocalStreamSink {
  /// The panel records stream messages right now.
  bool get recordsStreams;

  /// Payload bytes the panel keeps of one message while bodies are
  /// captured.
  int get localStreamCap;

  /// The SDK follows the messages of the connection whose handshake was
  /// request [id] ([kind] `ws` or `sse`), from [ts] on. [url]: a
  /// WebSocket's `ws(s)://` address. [status], [statusText] and [headers]:
  /// an event stream the desktop gets the usual way (its response, with the
  /// body, only at its end); the panel shows it open at once.
  void streamOpened(
    String id, {
    required String kind,
    required double ts,
    String? url,
    int? status,
    String? statusText,
    List<List<String>>? headers,
  });

  /// One WebSocket message or control frame ([dir] `in` / `out`); [data]
  /// is the kept start of the payload (null: none kept).
  void streamWs(
    String id,
    double ts,
    String dir,
    String opcode,
    int size,
    Uint8List? data,
    int? closeCode,
    String? closeReason,
  );

  /// One dispatched Server-Sent Events event.
  void streamSse(String id, double ts, String? event, String? eventId, int? retry, int size, Uint8List? data);

  /// The connection ended: the server ended the event stream (no [error]),
  /// the app stopped reading it ([cancelled]) or it broke ([error]).
  void streamEnded(String id, double ts, {String? error, bool cancelled = false});

  /// A handshake `net.request` / `net.response` / `net.error` the desktop
  /// does not get (a WebSocket reported through `DurbunNetwork.webSocket`
  /// while the desktop takes no stream messages).
  void localNet(Map<String, Object?> message);
}

/// A recorder that can hand stream messages to the in-app panel.
abstract interface class LocalStreamHost {
  LocalStreamSink? get localStreams;
}
