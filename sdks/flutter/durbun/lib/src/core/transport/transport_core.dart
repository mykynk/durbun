/// The connection engine: runs either on a background isolate (default) or on
/// the calling isolate. It only exchanges plain lists/maps with its owner, so
/// the same code works on both sides of an isolate boundary.
///
/// Strategy (SPEC §6.1): client attempts to every endpoint (127.0.0.1:9751,
/// then the optional Wi-Fi host) plus, on iOS physical devices, a listener on
/// 127.0.0.1:9752–9755 for the desktop's usbmux tunnel. Whichever completes
/// hello → welcome first becomes active; the others are closed. Reconnects
/// with 0.5 s → 3 s backoff; after two minutes without a desktop the rounds
/// slow down to about every 30 s (with jitter), and they stop while the app
/// is in the background. Coming back to the foreground or a new desktop
/// address tries again at once (the iOS USB listener never sleeps). While
/// disconnected the last N outgoing messages are kept in a ring buffer and
/// flushed on (re)connect.
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

  /// `['handshake-failed', via]`: that handshake ended without a welcome
  /// (timeout, closed, or another link won).
  static const String handshakeFailed = 'handshake-failed';

  /// `['round-failed', attempts, generation]`: a full round of client
  /// attempts failed. `attempts` lists `[endpoint, kind, detail]` per tried
  /// endpoint (kinds: see [AttemptKind]); `generation` counts
  /// [TransportCore.setEndpoints] calls, so an owner can ignore a round that
  /// started before the endpoints changed.
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

/// Why one client attempt failed (`round-failed` events).
abstract final class AttemptKind {
  /// Nothing listens on that port (the host answered with a reset).
  static const String refused = 'refused';

  /// No answer within the connect timeout (wrong address, other network,
  /// firewall).
  static const String timeout = 'timeout';

  /// No route to the host or network (also iOS's denied Local Network
  /// permission).
  static const String unreachable = 'unreachable';

  /// The operating system refused the socket (Android without the INTERNET
  /// permission, sandboxed macOS without the network client entitlement).
  static const String denied = 'denied';

  /// The host name could not be resolved.
  static const String lookup = 'lookup';

  /// The peer accepted the connection and closed it before the welcome.
  static const String closed = 'closed';

  /// The peer accepted the connection but sent no welcome in time.
  static const String noWelcome = 'no-welcome';

  /// Anything else.
  static const String error = 'error';

  /// Sorts a connect error into one of the kinds above.
  static String classify(Object error) {
    final text = error.toString().toLowerCase();
    int? code;
    if (error is SocketException) code = error.osError?.errorCode;
    if (text.contains('failed host lookup')) return lookup;
    // errno: Darwin / Linux (Android) / Windows.
    if (code == 61 || code == 111 || code == 10061 || text.contains('connection refused')) {
      return refused;
    }
    if (error is TimeoutException || code == 60 || code == 110 || code == 10060 || text.contains('timed out')) {
      return timeout;
    }
    if (code == 65 || code == 51 || code == 113 || code == 101 || code == 10065 || code == 10051 ||
        text.contains('no route to host') || text.contains('network is unreachable')) {
      return unreachable;
    }
    if (code == 1 || code == 13 || text.contains('operation not permitted') || text.contains('permission denied')) {
      return denied;
    }
    return AttemptKind.error;
  }
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
    this.maxOfflineBufferedBytes = 8 * 1024 * 1024,
    this.offlineGraceMs = 30000,
    this.minBackoffMs = 500,
    this.maxBackoffMs = 3000,
    this.idleAfterMs = 120000,
    this.idleMaxBackoffMs = 30000,
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

  /// Smaller budget while no desktop is in reach: before the first
  /// connection, and once a connection has been gone for [offlineGraceMs].
  /// Past it the bodies of the oldest messages are stripped (the requests
  /// stay, marked truncated; the in-app panel has its own copy), so an app
  /// used without a desktop does not hold every image it loaded. Whole
  /// messages are still dropped only past [maxBufferedBytes].
  final int maxOfflineBufferedBytes;
  final int offlineGraceMs;
  final int minBackoffMs;
  final int maxBackoffMs;

  /// After failing this long without a break, rounds slow down towards
  /// [idleMaxBackoffMs] (±20 % jitter) so an app used without a desktop
  /// does not wake up every few seconds.
  final int idleAfterMs;
  final int idleMaxBackoffMs;
  final int handshakeTimeoutMs;

  /// Close a connection that was pinged before but has been silent this long.
  final int silenceTimeoutMs;

  Map<String, Object?> toMap() => <String, Object?>{
    'endpoints': [for (final e in endpoints) e.toMap()],
    'listenPorts': listenPorts,
    'maxBufferedMessages': maxBufferedMessages,
    'maxBufferedBytes': maxBufferedBytes,
    'maxOfflineBufferedBytes': maxOfflineBufferedBytes,
    'offlineGraceMs': offlineGraceMs,
    'minBackoffMs': minBackoffMs,
    'maxBackoffMs': maxBackoffMs,
    'idleAfterMs': idleAfterMs,
    'idleMaxBackoffMs': idleMaxBackoffMs,
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
    maxOfflineBufferedBytes: (m['maxOfflineBufferedBytes'] as num).toInt(),
    offlineGraceMs: (m['offlineGraceMs'] as num).toInt(),
    minBackoffMs: (m['minBackoffMs'] as num).toInt(),
    maxBackoffMs: (m['maxBackoffMs'] as num).toInt(),
    idleAfterMs: (m['idleAfterMs'] as num?)?.toInt() ?? 120000,
    idleMaxBackoffMs: (m['idleMaxBackoffMs'] as num?)?.toInt() ?? 30000,
    handshakeTimeoutMs: (m['handshakeTimeoutMs'] as num).toInt(),
    silenceTimeoutMs: (m['silenceTimeoutMs'] as num).toInt(),
  );
}

class _Queued {
  _Queued(this.message, this.cost, {this.stream = false});

  /// Replaced (never mutated) when its body is shed: on a local engine the
  /// map is shared with the sender, e.g. the in-app panel's copy.
  Map<String, Object?> message;
  int cost;

  /// A `net.ws` / `net.sse` message: dropped first under pressure.
  final bool stream;

  /// Dropped while queued (removing from the middle of the queue would cost
  /// O(n)); the pump skips it.
  bool dead = false;
}

class TransportCore {
  TransportCore(this.config, this._emit);

  final TransportConfig config;
  final void Function(List<Object?> event) _emit;

  /// Client endpoints tried each round; [setEndpoints] replaces them.
  late List<TransportEndpoint> _endpoints = List<TransportEndpoint>.of(config.endpoints);
  int _generation = 0;

  final ListQueue<_Queued> _queue = ListQueue<_Queued>();

  /// The queued stream messages, oldest first (a subset of [_queue]).
  final ListQueue<_Queued> _streamQueue = ListQueue<_Queued>();

  /// Queued messages that are not [_Queued.dead].
  int _live = 0;

  /// The latest config from a desktop asked for stream messages; until then
  /// (and after a config without `captureStreams: true`) they are dropped
  /// here, whatever the sender still believed.
  bool _streamsAllowed = false;

  /// The desktop of this connection knows stream messages (a config of it
  /// had the `captureStreams` field): the messages that finish a started
  /// stream still go to it when the setting is off or left out.
  bool _streamsKnown = false;
  int _queuedCost = 0;
  int _dropped = 0;
  bool _droppedWhileOffline = false;
  bool _everConnected = false;

  /// When the last active connection was lost (stopwatch ms), or null.
  int? _offlineSinceMs;
  final Stopwatch _clock = Stopwatch()..start();
  Timer? _offlineTimer;

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

  /// Current wait between failed rounds (see [_nextBackoff]).
  int _backoff = 0;

  /// When the current run of failed rounds started (stopwatch ms), or null.
  int? _failingSinceMs;

  /// The app is in the background: no client rounds until it comes back.
  bool _background = false;
  Completer<void>? _foregroundWaiter;
  final math.Random _random = math.Random();
  final List<_FlushWaiter> _flushWaiters = <_FlushWaiter>[];

  bool get isConnected => _active != null;
  int get queueLength => _live;

  /// Approximate memory held by the queue (see [estimateMessageCost]).
  int get queuedBytes => _queuedCost;

  /// The byte budget that applies right now (see
  /// [TransportConfig.maxOfflineBufferedBytes]).
  int get byteBudget {
    final full = config.maxBufferedBytes;
    if (_active != null) return full;
    final since = _offlineSinceMs;
    final offline = !_everConnected ||
        (since != null && _clock.elapsedMilliseconds - since >= config.offlineGraceMs);
    if (!offline) return full;
    return math.min(full, config.maxOfflineBufferedBytes);
  }

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
    final stream = isStreamMessage(message);
    final finalStream = stream && isFinalStreamMessage(message);
    if (finalStream ? !_streamsKnown : (stream && !_streamsAllowed)) return;
    final cost = estimateMessageCost(message);
    // The messages that finish a stream are not dropped before others.
    final queued = _Queued(message, cost, stream: stream && !finalStream);
    _queue.add(queued);
    if (queued.stream) _streamQueue.add(queued);
    _live++;
    _queuedCost += cost;
    while (_live > config.maxBufferedMessages) {
      _dropOldest();
    }
    final budget = byteBudget;
    if (_queuedCost > budget) _shedBytes(budget);
    if (_active != null) _schedulePump();
  }

  /// Replaces the client endpoints (e.g. a Mac address entered on the phone)
  /// and starts a new round at once. An active link through an endpoint
  /// that is no longer listed is closed, so the next round reaches the new
  /// one; a link through a kept endpoint or the USB listener stays.
  void setEndpoints(List<TransportEndpoint> endpoints) {
    if (_stopped) return;
    _endpoints = List<TransportEndpoint>.of(endpoints);
    _generation++;
    _failingSinceMs = null;
    _backoff = config.minBackoffMs;
    final active = _active;
    if (active != null && active.via.startsWith('tcp ') &&
        !_endpoints.any((e) => active.via == 'tcp $e')) {
      active.close('the desktop address changed');
    }
    _wake();
  }

  /// The app went to the background (no client rounds: no wake-ups while
  /// nobody looks) or came back (tries again at once, fast backoff). An
  /// active connection is not touched; the USB listener keeps listening.
  void setBackground(bool background) {
    if (_stopped || background == _background) return;
    _background = background;
    if (!background) {
      final waiter = _foregroundWaiter;
      _foregroundWaiter = null;
      if (waiter != null && !waiter.isCompleted) waiter.complete();
      retryNow();
    }
  }

  /// Starts a new round now with the fast backoff (e.g. the panel's
  /// Connect with the same address).
  void retryNow() {
    if (_stopped) return;
    _failingSinceMs = null;
    _backoff = config.minBackoffMs;
    _wake();
  }

  /// The wait after a failed round: doubles up to [TransportConfig.maxBackoffMs];
  /// after [TransportConfig.idleAfterMs] of failures up to
  /// [TransportConfig.idleMaxBackoffMs], with ±20 % jitter so many phones do
  /// not knock in step.
  int _nextBackoff(int current) {
    final since = _failingSinceMs;
    final idle = since != null && _clock.elapsedMilliseconds - since >= config.idleAfterMs;
    if (!idle) return math.min(current * 2, config.maxBackoffMs);
    final base = math.min(math.max(current, config.maxBackoffMs) * 2, config.idleMaxBackoffMs);
    final jitter = 0.8 + _random.nextDouble() * 0.4;
    return math.max(config.minBackoffMs, (base * jitter).round());
  }

  /// Ends every pending backoff sleep (the client loop tries again now).
  void _wake() {
    for (final s in _sleepers.toList()) {
      if (!s.isCompleted) s.complete();
    }
    _sleepers.clear();
  }

  /// Emits `['flushed', token, ok]` once everything queued so far was written
  /// to an active connection (ok=true) or after [timeoutMs] (ok=false).
  void requestFlush(int token, int timeoutMs) {
    if (_live == 0 && !_pumping) {
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
    _offlineTimer?.cancel();
    for (final s in _sleepers.toList()) {
      if (!s.isCompleted) s.complete();
    }
    _sleepers.clear();
    final hw = _helloWaiter;
    if (hw != null && !hw.isCompleted) hw.complete();
    final fw = _foregroundWaiter;
    if (fw != null && !fw.isCompleted) fw.complete();
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
    _streamQueue.clear();
    _live = 0;
    _queuedCost = 0;
  }

  /* ───────────────────────── connection management ───────────────────────── */

  Future<void> _clientLoop() async {
    _backoff = config.minBackoffMs;
    while (!_stopped) {
      if (_active != null) {
        await (_activeLost ??= Completer<void>()).future;
        if (_stopped) break;
        _backoff = config.minBackoffMs;
        _failingSinceMs = null;
        await _sleep(_backoff);
        continue;
      }
      if (_hello == null) {
        await (_helloWaiter ??= Completer<void>()).future;
        continue;
      }
      if (_background) {
        await (_foregroundWaiter ??= Completer<void>()).future;
        continue;
      }
      final endpoints = _endpoints;
      final generation = _generation;
      if (endpoints.isEmpty) {
        // Listener-only mode: no rounds; the listener does the work and
        // retryNow/setEndpoints wake this loop.
        await _sleep(config.idleMaxBackoffMs);
        continue;
      }
      var connected = false;
      final attempts = <Object?>[];
      for (final endpoint in endpoints) {
        if (_stopped || _active != null || generation != _generation) break;
        final failure = await _attempt(endpoint);
        connected = failure == null;
        if (connected) break;
        attempts.add(<Object?>['$endpoint', failure.$1, failure.$2]);
      }
      if (_stopped) break;
      if (connected || _active != null) {
        _backoff = config.minBackoffMs;
        _failingSinceMs = null;
        continue;
      }
      if (generation != _generation) {
        // The endpoints changed mid-round: start over with the new ones.
        _backoff = config.minBackoffMs;
        continue;
      }
      _failingSinceMs ??= _clock.elapsedMilliseconds;
      _emit(<Object?>[TransportEvents.roundFailed, attempts, generation]);
      final wait = _backoff;
      await _sleep(wait);
      if (generation != _generation) {
        _backoff = config.minBackoffMs;
        continue;
      }
      // retryNow() during the sleep reset the backoff: keep that.
      if (_backoff == wait) _backoff = _nextBackoff(wait);
    }
  }

  /// Test hook: the wait the client loop uses after its next failed round.
  int get debugBackoffMs => _backoff;

  /// Test hook: whether client rounds are paused (app in the background).
  bool get debugInBackground => _background;

  /// Null when connected, else why not: `(kind, detail)` (see [AttemptKind]).
  Future<(String, String)?> _attempt(TransportEndpoint endpoint) async {
    Socket socket;
    try {
      socket = await Socket.connect(
        endpoint.host,
        endpoint.port,
        timeout: Duration(milliseconds: endpoint.connectTimeoutMs),
      );
    } catch (e) {
      return (AttemptKind.classify(e), _shortError(e));
    }
    if (_stopped || _active != null) {
      socket.destroy();
      return (AttemptKind.error, 'another connection was made');
    }
    final conn = _Conn(this, socket, 'tcp $endpoint');
    if (await _handshake(conn)) return null;
    final reason = conn.closeReason ?? '';
    if (reason == 'closed by the desktop' || reason.startsWith('socket error')) {
      return (AttemptKind.closed, reason);
    }
    return (AttemptKind.noWelcome, 'no welcome within ${config.handshakeTimeoutMs ~/ 1000} s');
  }

  static String _shortError(Object e) {
    final text = e is SocketException
        ? <String>[e.message, if (e.osError != null) e.osError!.message].where((s) => s.isNotEmpty).join(': ')
        : e.toString();
    return text.length > 160 ? '${text.substring(0, 160)}…' : text;
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
      _emit(<Object?>[TransportEvents.handshakeFailed, conn.via]);
      return false;
    }
    return true;
  }

  void _activate(_Conn conn) {
    _active = conn;
    conn.active = true;
    _everConnected = true;
    _offlineSinceMs = null;
    _offlineTimer?.cancel();
    _offlineTimer = null;
    _activeLost = Completer<void>();
    final welcome = conn.welcome;
    _applyStreamConfig(welcome == null ? null : welcome['config'], newConnection: true);
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
      _offlineSinceMs = _clock.elapsedMilliseconds;
      _offlineTimer?.cancel();
      if (!_stopped) {
        // Still gone after the grace period: shrink the queue to the offline
        // budget even if the app sends nothing more.
        _offlineTimer = Timer(Duration(milliseconds: config.offlineGraceMs), () {
          _offlineTimer = null;
          final budget = byteBudget;
          if (!_stopped && _queuedCost > budget) _shedBytes(budget);
        });
      }
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
          _applyStreamConfig(message['config']);
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
      case 'config':
        if (conn.active) {
          _applyStreamConfig(message['config']);
          _emit(<Object?>[TransportEvents.message, message]);
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

  /// Drops the oldest stream message, or the oldest message when none is
  /// queued: WebSocket messages and SSE events give way to logs and requests.
  void _dropOldest() {
    _Queued? dropped;
    if (_streamQueue.isNotEmpty) {
      dropped = _streamQueue.removeFirst()..dead = true;
    } else {
      while (_queue.isNotEmpty) {
        final q = _queue.removeFirst();
        if (q.dead) continue;
        dropped = q;
        break;
      }
    }
    if (dropped == null) return;
    _live--;
    _queuedCost -= dropped.cost;
    _dropped++;
    if (_active == null) _droppedWhileOffline = true;
  }

  /// Forgets the queued stream messages: the desktop does not want them
  /// (its config says so), so they are not sent late either.
  void _discardStreamMessages() {
    while (_streamQueue.isNotEmpty) {
      final q = _streamQueue.removeFirst()..dead = true;
      _live--;
      _queuedCost -= q.cost;
    }
  }

  /// A welcome / config arrived: stream messages are allowed from now on
  /// only when it asks for them (absent = an older desktop = no).
  void _applyStreamConfig(Object? config, {bool newConnection = false}) {
    _streamsAllowed = config is Map && config['captureStreams'] == true;
    final knows = config is Map && config.containsKey('captureStreams');
    _streamsKnown = newConnection ? knows : (_streamsKnown || knows);
    if (!_streamsAllowed) _discardStreamMessages();
    if (!_streamsKnown) {
      // An older desktop: not even the end of a stream.
      for (final q in _queue) {
        if (!q.dead && isStreamMessage(q.message)) {
          q.dead = true;
          _live--;
          _queuedCost -= q.cost;
        }
      }
    }
  }

  /// Over [bodyBudget]: strip body data from the oldest messages first (the
  /// requests stay visible, marked truncated); over [maxBufferedBytes] drop
  /// whole messages too.
  void _shedBytes(int bodyBudget) {
    for (final q in _queue) {
      if (_queuedCost <= bodyBudget) break;
      if (q.dead) continue;
      final body = q.message['body'];
      if (body is Map && body[kPendingBodyMarker] == true) {
        final bytes = body['bytes'];
        if (bytes is Uint8List && bytes.isNotEmpty) {
          q.message = <String, Object?>{
            ...q.message,
            'body': <Object?, Object?>{
              ...body,
              'bytes': Uint8List(0),
              'truncated': true,
            },
          };
          q.cost -= bytes.length;
          _queuedCost -= bytes.length;
        }
      }
    }
    while (_queuedCost > config.maxBufferedBytes && _live > 1) {
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
    _live++;
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
        if (_live == 0) {
          _queue.clear();
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
          if (q.dead) continue;
          if (q.stream && _streamQueue.isNotEmpty && identical(_streamQueue.first, q)) {
            _streamQueue.removeFirst();
          }
          _live--;
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
    if (!_stopped && _active != null && _live > 0) _schedulePump();
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

  /// The first reason it was closed for.
  String? closeReason;
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
    closeReason = reason;
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
