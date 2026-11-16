/// The socket of a dart:io WebSocket after its 101 upgrade, teed: the frames
/// in both directions are read from copies while the bytes reach the app and
/// the network unchanged (same chunk objects, same order, same pause /
/// resume / cancel). Only sockets of a WebSocket handshake made through
/// Dürbün's `HttpClient` wrapper get here; the SDK's own connection to the
/// desktop is a plain `Socket.connect` and never does.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'stream_reporter.dart';
import 'ws_frames.dart';

/// Follows one WebSocket connection: two frame readers and its end.
class WsCapture {
  WsCapture(this.reporter, {String? extensions}) {
    final deflate = parsePerMessageDeflate(extensions);
    incoming = WsFrameReader(
      onMessage: (m) => _onMessage('in', m),
      wanted: () => reporter.wanted,
      cap: () => reporter.cap,
      deflate: deflate != null,
      noContextTakeover: deflate?.serverNoContextTakeover ?? false,
    );
    outgoing = WsFrameReader(
      onMessage: (m) => _onMessage('out', m),
      wanted: () => reporter.wanted,
      cap: () => reporter.cap,
      deflate: deflate != null,
      noContextTakeover: deflate?.clientNoContextTakeover ?? false,
    );
  }

  final StreamReporter reporter;
  late final WsFrameReader incoming;
  late final WsFrameReader outgoing;
  bool _closeIn = false;
  bool _closeOut = false;
  bool _ended = false;

  void _onMessage(String dir, WsMessage message) {
    if (message.opcode == 'close') {
      if (dir == 'in') {
        _closeIn = true;
      } else {
        _closeOut = true;
      }
    }
    reporter.wsFrame(dir, message);
  }

  // Both directions are read to the end: the app answers a close frame
  // after the read side ended.
  void read(List<int> chunk) => incoming.add(chunk);

  void wrote(List<int> chunk) => outgoing.add(chunk);

  /// The socket failed: a broken connection unless both sides had closed.
  void failed(Object error) {
    if (_ended) return;
    _ended = true;
    if (_closeIn && _closeOut) return;
    reporter.fail(error);
  }

  /// The socket ended: broken when no close frame went either way.
  void ended() {
    if (_ended) return;
    _ended = true;
    if (_closeIn || _closeOut) return;
    reporter.fail(const WebSocketException('The connection closed without a close frame'));
  }
}

/// A [Socket] that forwards everything to [_inner] and shows [_capture] the
/// bytes read and written.
class WsSocketTee extends Stream<Uint8List> implements Socket {
  WsSocketTee(this._inner, this._capture) {
    // The socket's end, also when the app stopped reading it first.
    _inner.done.then<void>(
      (_) => _guard(_capture.ended),
      onError: (Object error) => _guard(() => _capture.failed(error)),
    );
  }

  final Socket _inner;
  final WsCapture _capture;
  bool _listened = false;

  /// The wrapped socket (for diagnostics and tests).
  Socket get inner => _inner;

  void _guard(void Function() body) {
    try {
      body();
    } catch (_) {}
  }

  /* ───────────── Stream ───────────── */

  @override
  StreamSubscription<Uint8List> listen(
    void Function(Uint8List event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    if (_listened) {
      // Single subscription: let the inner socket report the misuse.
      return _inner.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
    }
    _listened = true;
    // Cancelled in the controller's onCancel.
    // ignore: cancel_subscriptions
    StreamSubscription<Uint8List>? source;
    late final StreamController<Uint8List> out;
    out = StreamController<Uint8List>(
      sync: true,
      onListen: () {
        source = _inner.listen(
          (chunk) {
            _guard(() => _capture.read(chunk));
            out.add(chunk);
          },
          onError: (Object error, StackTrace stack) {
            _guard(() => _capture.failed(error));
            out.addError(error, stack);
          },
          onDone: () {
            _guard(_capture.ended);
            out.close();
          },
        );
      },
      onPause: () => source?.pause(),
      onResume: () => source?.resume(),
      onCancel: () {
        // The app stopped reading; the connection may still be closed
        // properly (seen through the socket's `done`).
        final s = source;
        source = null;
        return s?.cancel();
      },
    );
    return out.stream.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  }

  /* ───────────── IOSink ───────────── */

  @override
  Encoding get encoding => _inner.encoding;

  @override
  set encoding(Encoding value) => _inner.encoding = value;

  @override
  void add(List<int> data) {
    _inner.add(data);
    _guard(() => _capture.wrote(data));
  }

  @override
  void write(Object? object) {
    final string = '$object';
    if (string.isEmpty) return;
    add(_inner.encoding.encode(string));
  }

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) {
    final iterator = objects.iterator;
    if (!iterator.moveNext()) return;
    if (separator.isEmpty) {
      do {
        write(iterator.current);
      } while (iterator.moveNext());
    } else {
      write(iterator.current);
      while (iterator.moveNext()) {
        write(separator);
        write(iterator.current);
      }
    }
  }

  @override
  void writeln([Object? object = '']) => write('$object\n');

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  void addError(Object error, [StackTrace? stackTrace]) => _inner.addError(error, stackTrace);

  @override
  Future<dynamic> addStream(Stream<List<int>> stream) => _inner.addStream(
    stream.map((chunk) {
      _guard(() => _capture.wrote(chunk));
      return chunk;
    }),
  );

  @override
  Future<dynamic> flush() => _inner.flush();

  @override
  Future<dynamic> close() => _inner.close();

  @override
  Future<dynamic> get done => _inner.done;

  /* ───────────── Socket ───────────── */

  @override
  void destroy() => _inner.destroy();

  @override
  bool setOption(SocketOption option, bool enabled) => _inner.setOption(option, enabled);

  @override
  Uint8List getRawOption(RawSocketOption option) => _inner.getRawOption(option);

  @override
  void setRawOption(RawSocketOption option) => _inner.setRawOption(option);

  @override
  int get port => _inner.port;

  @override
  int get remotePort => _inner.remotePort;

  @override
  InternetAddress get address => _inner.address;

  @override
  InternetAddress get remoteAddress => _inner.remoteAddress;

  /// Every member of the dart:io interface (Dart 3.10) is implemented above.
  /// A member added by a newer Dart SDK then fails at runtime (only if used)
  /// instead of breaking the compilation of every app using Dürbün.
  @override
  dynamic noSuchMethod(Invocation invocation) => throw NoSuchMethodError.withInvocation(this, invocation);

  @override
  String toString() => _inner.toString();
}
