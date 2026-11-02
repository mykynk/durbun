/// The connection engine: runs either on a background isolate (default) or on
/// the calling isolate. It only exchanges plain lists/maps with its owner, so
/// the same code works on both sides of an isolate boundary.
///
/// Strategy (SPEC §6.1): client attempts to every endpoint (127.0.0.1:9751,
/// then the optional Wi-Fi host) plus, on iOS physical devices, a listener on
/// 127.0.0.1:9752–9755 for the desktop's usbmux tunnel. Whichever completes
/// hello → welcome first becomes active; the others are closed. Reconnects
/// forever with 0.5 s → 3 s backoff; while disconnected the last N outgoing
/// messages are kept in a ring buffer and flushed on (re)connect.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../protocol.dart';
import 'ndjson.dart';

/// Event names emitted to the owner (first element of each event list).
abstract final class TransportEvents {
  /// `['handshake', via]`: a socket is open and hello was sent.
  static const String handshake = 'handshake';

  /// `['round-failed']`: a full round of client attempts failed.
  static const String roundFailed = 'round-failed';

  /// `['connected', welcomeMap, via]`.
  static const String connected = 'connected';

  /// `['disconnected', reason]`.
  static const String disconnected = 'disconnected';

  /// `['message', map]`: mocks / config / command / welcome-after-connect.
  static const String message = 'message';

  /// `['flushed', token, ok]`.
  static const String flushed = 'flushed';

  /// `['diag', text]`: diagnostics for the developer console.
  static const String diag = 'diag';
}

class TransportEndpoint {
  const TransportEndpoint(
    this.host,
    this.port, {
    this.connectTimeoutMs = 2000,
  });

  final String host;
  final int port;
  final int connectTimeoutMs;

  Map<String, Object?> toMap() => <String, Object?>{
    'host': host,
    'port': port,
    'connectTimeoutMs': connectTimeoutMs,
  };

  static TransportEndpoint fromMap(Map<Object?, Object?> m) =>
      TransportEndpoint(
        m['host'] as String,
        (m['port'] as num).toInt(),
        connectTimeoutMs: (m['connectTimeoutMs'] as num?)?.toInt() ?? 2000,
      );

  @override
  String toString() => '$host:$port';
}

class TransportConfig {
  const TransportConfig({
    required this.endpoints,
    this.listenPorts = const <int>[],
    this.maxBufferedMessages = 5000,
    this.maxBufferedBytes = 48 * 1024 * 1024,
    this.minBackoffMs = 500,
    this.maxBackoffMs = 3000,
    this.handshakeTimeoutMs = 5000,
    this.silenceTimeoutMs = 60000,
  });

  /// Client endpoints, tried in order each round.
  final List<TransportEndpoint> endpoints;

  /// Loopback ports to listen on (first free one wins); empty = no listener.
  final List<int> listenPorts;
  final int maxBufferedMessages;

  /// Approximate memory budget of the queue (bodies are dropped first).
  final int maxBufferedBytes;
  final int minBackoffMs;
  final int maxBackoffMs;
  final int handshakeTimeoutMs;

  /// Close a connection that was pinged before but has been silent this long.
  final int silenceTimeoutMs;

  Map<String, Object?> toMap() => <String, Object?>{
    'endpoints': [for (final e in endpoints) e.toMap()],
    'listenPorts': listenPorts,
    'maxBufferedMessages': maxBufferedMessages,
    'maxBufferedBytes': maxBufferedBytes,
    'minBackoffMs': minBackoffMs,
    'maxBackoffMs': maxBackoffMs,
    'handshakeTimeoutMs': handshakeTimeoutMs,
    'silenceTimeoutMs': silenceTimeoutMs,
  };

  static TransportConfig fromMap(Map<Object?, Object?> m) => TransportConfig(
    endpoints: [
      for (final e in m['endpoints'] as List<Object?>)
        TransportEndpoint.fromMap(e as Map<Object?, Object?>),
    ],
    listenPorts: [
      for (final p in m['listenPorts'] as List<Object?>) (p as num).toInt(),
    ],
    maxBufferedMessages: (m['maxBufferedMessages'] as num).toInt(),
    maxBufferedBytes: (m['maxBufferedBytes'] as num).toInt(),
    minBackoffMs: (m['minBackoffMs'] as num).toInt(),
    maxBackoffMs: (m['maxBackoffMs'] as num).toInt(),
    handshakeTimeoutMs: (m['handshakeTimeoutMs'] as num).toInt(),
    silenceTimeoutMs: (m['silenceTimeoutMs'] as num).toInt(),
  );
}

class _Queued {
  _Queued(this.message, this.cost);
  final Map<String, Object?> message;
  int cost;
}

class TransportCore {
  TransportCore(this.config, this._emit);

  final TransportConfig config;
  final void Function(List<Object?> event) _emit;

  final ListQueue<_Queued> _queue = ListQueue<_Queued>();
  int _queuedCost = 0;
  int _dropped = 0;
  bool _droppedWhileOffline = false;

  Map<String, Object?>? _hello;
  Completer<void>? _helloWaiter;

  _Conn? _active;
  Completer<void>? _activeLost;
  _Conn? _listenerCandidate;
  final Set<_Conn> _connections = <_Conn>{};
  ServerSocket? _server;

  bool _started = false;
  bool _stopped = false;
  bool _pumping = false;
  bool _pumpScheduled = false;
  final Set<Completer<void>> _sleepers = <Completer<void>>{};
  final List<_FlushWaiter> _flushWaiters = <_FlushWaiter>[];

  bool get isConnected => _active != null;
  int get queueLength => _queue.length;

  void start() {
    if (_started || _stopped) return;
    _started = true;
    unawaited(_clientLoop());
    if (config.listenPorts.isNotEmpty) unawaited(_listenLoop());
  }

  /// Sets the hello sent on every new connection (its `ts` is refreshed).
  void setHello(Map<String, Object?> hello) {
    _hello = hello;
    final waiter = _helloWaiter;
    _helloWaiter = null;
    if (waiter != null && !waiter.isCompleted) waiter.complete();
  }

  /// Queues a message. Volatile messages (metrics, pongs) are dropped instead
  /// of buffered while disconnected.
  void send(Map<String, Object?> message, {bool volatile = false}) {
    if (_stopped) return;
    if (volatile && _active == null) return;
    final cost = estimateMessageCost(message);
    _queue.add(_Queued(message, cost));
    _queuedCost += cost;
    while (_queue.length > config.maxBufferedMessages) {
      _dropOldest();
    }
    if (_queuedCost > config.maxBufferedBytes) _shedBytes();
    if (_active != null) _schedulePump();
  }

  /// Emits `['flushed', token, ok]` once everything queued so far was written
  /// to an active connection (ok=true) or after [timeoutMs] (ok=false).
  void requestFlush(int token, int timeoutMs) {
    if (_queue.isEmpty && !_pumping) {
      _emit(<Object?>[TransportEvents.flushed, token, true]);
      return;
    }
    final waiter = _FlushWaiter(token);
    waiter.timer = Timer(Duration(milliseconds: timeoutMs), () {
      if (_flushWaiters.remove(waiter)) {
        _emit(<Object?>[TransportEvents.flushed, token, false]);
      }
    });
    _flushWaiters.add(waiter);
  }

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    for (final s in _sleepers.toList()) {
      if (!s.isCompleted) s.complete();
    }
    _sleepers.clear();
    final hw = _helloWaiter;
    if (hw != null && !hw.isCompleted) hw.complete();
    final lost = _activeLost;
    if (lost != null && !lost.isCompleted) lost.complete();
    for (final c in _connections.toList()) {
      c.close('stopped');
    }
    final server = _server;
    _server = null;
    if (server != null) {
      try {
        await server.close();
      } catch (_) {}
    }
    for (final w in _flushWaiters) {
      w.timer?.cancel();
      _emit(<Object?>[TransportEvents.flushed, w.token, false]);
    }
    _flushWaiters.clear();
    _queue.clear();
    _queuedCost = 0;
  }

  /* ───────────────────────── connection management ───────────────────────── */

  Future<void> _clientLoop() async {
    var backoff = config.minBackoffMs;
    while (!_stopped) {
      if (_active != null) {
        await (_activeLost ??= Completer<void>()).future;
        if (_stopped) break;
        backoff = config.minBackoffMs;
        await _sleep(backoff);
        continue;
      }
      if (_hello == null) {
        await (_helloWaiter ??= Completer<void>()).future;
        continue;
      }
      if (config.endpoints.isEmpty) {
        // Listener-only mode: just wait while the listener does the work.
        await _sleep(config.maxBackoffMs);
        continue;
      }
      var connected = false;
      for (final endpoint in config.endpoints) {
        if (_stopped || _active != null) break;
        connected = await _attempt(endpoint);
        if (connected) break;
      }
      if (_stopped) break;
      if (connected || _active != null) {
        backoff = config.minBackoffMs;
        continue;
      }
      _emit(const <Object?>[TransportEvents.roundFailed]);
      await _sleep(backoff);
      backoff = math.min(backoff * 2, config.maxBackoffMs);
    }
  }

  Future<bool> _attempt(TransportEndpoint endpoint) async {
    Socket socket;
    try {
      socket = await Socket.connect(
        endpoint.host,
        endpoint.port,
        timeout: Duration(milliseconds: endpoint.connectTimeoutMs),
      );
    } catch (_) {
      return false;
    }
    if (_stopped || _active != null) {
      socket.destroy();
      return false;
    }
    return _handshake(_Conn(this, socket, 'tcp $endpoint'));
  }

  Future<void> _listenLoop() async {
    while (!_stopped) {
      if (_hello == null) {
        // Bind only once there is a hello to send. It reaches a background
        // engine a moment after the engine started (and the Flutter glue may
        // hold it back, see helloGate); a desktop that connected in between
        // would be accepted and dropped. Unbound, it is refused and retries.
        await (_helloWaiter ??= Completer<void>()).future;
        continue;
      }
      ServerSocket? server;
      for (final port in config.listenPorts) {
        try {
          server = await ServerSocket.bind(InternetAddress.loopbackIPv4, port);
          break;
        } catch (_) {
          // Port busy (e.g. a previous isolate after hot restart): next one.
        }
      }
      if (_stopped) {
        await server?.close();
        break;
      }
      if (server == null) {
        await _sleep(3000);
        continue;
      }
      _server = server;
      final boundPort = server.port;
      _emit(<Object?>[
        TransportEvents.diag,
        'listening for USB (usbmux) connections on 127.0.0.1:$boundPort',
      ]);
      final done = Completer<void>();
      server.listen(
        (socket) => _onAccept(socket, boundPort),
        onError: (Object _) {},
        onDone: () {
          if (!done.isCompleted) done.complete();
        },
        cancelOnError: false,
      );
      await done.future;
      if (identical(_server, server)) _server = null;
      if (!_stopped) await _sleep(1000);
    }
  }

  void _onAccept(Socket socket, int port) {
    if (_stopped ||
        _active != null ||
        _listenerCandidate != null ||
        _hello == null) {
      socket.destroy();
      return;
    }
    final conn = _Conn(this, socket, 'usbmux 127.0.0.1:$port');
    _listenerCandidate = conn;
    unawaited(
      _handshake(conn).whenComplete(() {
        if (identical(_listenerCandidate, conn)) _listenerCandidate = null;
      }),
    );
  }

  Future<bool> _handshake(_Conn conn) async {
    final hello = Map<String, Object?>.of(_hello!)..['ts'] = nowEpochMs();
    _emit(<Object?>[TransportEvents.handshake, conn.via]);
    // The connection is activated synchronously when its welcome arrives (see
    // _onInbound), so messages that follow in the same TCP chunk are handled.
    final ok = await conn.handshake(
      hello,
      Duration(milliseconds: config.handshakeTimeoutMs),
    );
    if (!ok) {
      conn.close('handshake failed');
      return false;
    }
    return true;
  }

  void _activate(_Conn conn) {
    _active = conn;
    conn.active = true;
    _activeLost = Completer<void>();
    _emit(<Object?>[
      TransportEvents.connected,
      conn.welcome ?? const <String, Object?>{},
      conn.via,
    ]);
    if (_dropped > 0) _enqueueDroppedWarning();
    _schedulePump();
  }

  void _onClosed(_Conn conn, String reason) {
    _connections.remove(conn);
    if (identical(_active, conn)) {
      _active = null;
      _emit(<Object?>[TransportEvents.disconnected, reason]);
      final lost = _activeLost;
      _activeLost = null;
      if (lost != null && !lost.isCompleted) lost.complete();
    }
  }

  void _onInbound(_Conn conn, Map<String, Object?> message) {
    switch (message['type']) {
      case 'welcome':
        if (conn.active) {
          _emit(<Object?>[TransportEvents.message, message]);
        } else if (conn.handshaking) {
          if (_stopped || _active != null || conn.closed) {
            conn.completeHandshake(false); // another link won the race
          } else {
            conn.welcome = message;
            _activate(conn);
            conn.completeHandshake(true);
          }
        }
      case 'ping':
        conn.sawPing = true;
        if (conn.active) {
          send(buildPong(), volatile: true);
        } else {
          conn.writeDirect(buildPong());
        }
      default:
        if (conn.active) _emit(<Object?>[TransportEvents.message, message]);
    }
  }

  Future<void> _sleep(int ms) {
    if (_stopped) return Future<void>.value();
    final c = Completer<void>();
    _sleepers.add(c);
    Timer(Duration(milliseconds: ms), () {
      _sleepers.remove(c);
      if (!c.isCompleted) c.complete();
    });
    return c.future;
  }

  /* ───────────────────────────────── queue ───────────────────────────────── */

  void _dropOldest() {
    final dropped = _queue.removeFirst();
    _queuedCost -= dropped.cost;
    _dropped++;
    if (_active == null) _droppedWhileOffline = true;
  }

  /// Over the byte budget: strip body data from the oldest messages first
  /// (the requests stay visible), then drop whole messages.
  void _shedBytes() {
    for (final q in _queue) {
      if (_queuedCost <= config.maxBufferedBytes) return;
      final body = q.message['body'];
      if (body is Map && body[kPendingBodyMarker] == true) {
        final bytes = body['bytes'];
        if (bytes is Uint8List && bytes.isNotEmpty) {
          body['bytes'] = Uint8List(0);
          body['truncated'] = true;
          q.cost -= bytes.length;
          _queuedCost -= bytes.length;
        }
      }
    }
    while (_queuedCost > config.maxBufferedBytes && _queue.length > 1) {
      _dropOldest();
    }
  }

  void _enqueueDroppedWarning() {
    final n = _dropped;
    final offline = _droppedWhileOffline;
    _dropped = 0;
    _droppedWhileOffline = false;
    final why = offline
        ? 'while the desktop was unreachable'
        : 'because the desktop could not keep up';
    final message = buildLog(
      level: 'warn',
      tag: 'durbun',
      message:
          'Dürbün SDK dropped $n message${n == 1 ? '' : 's'} $why '
          '(buffer limit: ${config.maxBufferedMessages} messages).',
      data: <String, Object?>{'dropped': n},
    );
    final cost = estimateMessageCost(message);
    _queue.add(_Queued(message, cost));
    _queuedCost += cost;
  }

  void _schedulePump() {
    if (_pumpScheduled || _pumping || _stopped) return;
    _pumpScheduled = true;
    scheduleMicrotask(() {
      _pumpScheduled = false;
      unawaited(_pump());
    });
  }

  Future<void> _pump() async {
    if (_pumping) return;
    _pumping = true;
    try {
      while (!_stopped) {
        final conn = _active;
        if (conn == null || conn.closed) break;
        if (_queue.isEmpty) {
          if (_dropped > 0) {
            _enqueueDroppedWarning();
            continue;
          }
          _resolveFlushWaiters();
          break;
        }
        final batch = BytesBuilder(copy: false);
        var count = 0;
        while (_queue.isNotEmpty && count < 256 && batch.length < 256 * 1024) {
          final q = _queue.removeFirst();
          _queuedCost -= q.cost;
          final line = encodeMessageLine(q.message);
          if (line != null) batch.add(line);
          count++;
        }
        if (batch.isEmpty) continue;
        try {
          conn.socket.add(batch.takeBytes());
          await conn.socket.flush();
        } catch (e) {
          conn.close('write failed: $e');
          break;
        }
      }
    } finally {
      _pumping = false;
    }
    if (!_stopped && _active != null && _queue.isNotEmpty) _schedulePump();
  }

  void _resolveFlushWaiters() {
    if (_flushWaiters.isEmpty) return;
    for (final w in _flushWaiters) {
      w.timer?.cancel();
      _emit(<Object?>[TransportEvents.flushed, w.token, true]);
    }
    _flushWaiters.clear();
  }
}

class _FlushWaiter {
  _FlushWaiter(this.token);
  final int token;
  Timer? timer;
}

/// One socket (client attempt, accepted usbmux tunnel or the active link).
class _Conn {
  _Conn(this.core, this.socket, this.via) {
    core._connections.add(this);
    // Write errors also complete `done` with an error; they are handled
    // through flush()/onError, so just mark them as handled here.
    unawaited(socket.done.then<void>((_) {}, onError: (Object _) {}));
    try {
      socket.setOption(SocketOption.tcpNoDelay, true);
    } catch (_) {}
    _subscription = socket.listen(
      _onData,
      onError: (Object e) => close('socket error: $e'),
      onDone: () => close('closed by the desktop'),
      cancelOnError: true,
    );
  }

  final TransportCore core;
  final Socket socket;
  final String via;
  final NdjsonLineDecoder _decoder = NdjsonLineDecoder();
  StreamSubscription<Uint8List>? _subscription;
  Completer<bool>? _handshake;
  Timer? _handshakeTimer;
  Timer? _watchdog;
  Map<String, Object?>? welcome;
  bool active = false;
  bool closed = false;
  bool sawPing = false;
  int _lastInbound = DateTime.now().millisecondsSinceEpoch;

  Future<bool> handshake(Map<String, Object?> hello, Duration timeout) {
    final completer = _handshake = Completer<bool>();
    if (!writeDirect(hello)) {
      close('could not send hello');
      return Future<bool>.value(false);
    }
    _handshakeTimer = Timer(timeout, () {
      if (!completer.isCompleted) completer.complete(false);
    });
    _watchdog = Timer.periodic(const Duration(seconds: 5), (_) => _checkSilence());
    return completer.future;
  }

  /// Whether hello was sent and the welcome is still awaited.
  bool get handshaking {
    final completer = _handshake;
    return completer != null && !completer.isCompleted;
  }

  void completeHandshake(bool ok) {
    final completer = _handshake;
    if (completer == null || completer.isCompleted) return;
    _handshakeTimer?.cancel();
    completer.complete(ok);
  }

  /// Writes outside the pump (only before the connection is active).
  bool writeDirect(Map<String, Object?> message) {
    final line = encodeMessageLine(message);
    if (line == null || closed) return false;
    try {
      socket.add(line);
      return true;
    } catch (_) {
      return false;
    }
  }

  void _onData(Uint8List chunk) {
    _lastInbound = DateTime.now().millisecondsSinceEpoch;
    List<String> lines;
    try {
      lines = _decoder.add(chunk);
    } on FrameTooLargeException {
      close('inbound frame too large');
      return;
    }
    for (final line in lines) {
      final message = parseMessageLine(line);
      if (message != null) core._onInbound(this, message);
      if (closed) return;
    }
  }

  void _checkSilence() {
    if (closed || !sawPing) return;
    final silent = DateTime.now().millisecondsSinceEpoch - _lastInbound;
    if (silent > core.config.silenceTimeoutMs) {
      close('no data from the desktop for ${silent ~/ 1000} s');
    }
  }

  void close(String reason) {
    if (closed) return;
    closed = true;
    _handshakeTimer?.cancel();
    _watchdog?.cancel();
    final completer = _handshake;
    if (completer != null && !completer.isCompleted) completer.complete(false);
    unawaited(_subscription?.cancel());
    try {
      socket.destroy();
    } catch (_) {}
    core._onClosed(this, reason);
  }
}
