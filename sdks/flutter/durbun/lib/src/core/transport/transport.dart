/// Runs a [TransportCore] on a background isolate (default) or locally, behind
/// one small interface. Commands are batched per microtask so a burst of logs
/// costs one isolate message.
library;

import 'dart:async';
import 'dart:isolate';

import 'transport_core.dart';

export 'transport_core.dart' show TransportConfig, TransportEndpoint, TransportEvents;

typedef TransportEventHandler = void Function(List<Object?> event);

abstract class Transport {
  /// Starts a transport. With [useIsolate] the connection engine runs on a
  /// background isolate; if spawning fails it silently runs locally instead.
  /// [zone] is where events are delivered (the SDK's internal zone).
  static Transport start(
    TransportConfig config,
    TransportEventHandler onEvent, {
    bool useIsolate = true,
    Zone? zone,
  }) {
    final z = zone ?? Zone.current;
    final t = useIsolate
        ? _IsolateTransport(config, onEvent, z)
        : _LocalTransport(config, onEvent, z);
    t._start();
    return t;
  }

  void setHello(Map<String, Object?> hello);

  void send(Map<String, Object?> message, {bool volatile = false});

  /// Completes with true once everything sent so far reached the desktop's
  /// socket, false on timeout or when not connected long enough.
  Future<bool> flush(Duration timeout);

  Future<void> close();

  /// Whether the engine runs on a background isolate (false after fallback).
  bool get isBackground;

  void _start();
}

abstract class _BatchingTransport extends Transport {
  _BatchingTransport(this.config, this._onEvent, this._zone);

  final TransportConfig config;
  final TransportEventHandler _onEvent;
  final Zone _zone;
  List<Object?> _batch = <Object?>[];
  bool _flushScheduled = false;
  bool _closed = false;
  int _flushToken = 0;
  final Map<int, Completer<bool>> _flushes = <int, Completer<bool>>{};

  /// Delivers a batch of commands (`['hello', map]`, `['send', map, volatile]`,
  /// `['flush', token, timeoutMs]`) to the engine.
  void _deliver(List<Object?> batch);

  void _enqueue(List<Object?> command) {
    if (_closed) return;
    _batch.add(command);
    if (!_flushScheduled) {
      _flushScheduled = true;
      _zone.scheduleMicrotask(_drainBatch);
    }
  }

  void _drainBatch() {
    _flushScheduled = false;
    if (_batch.isEmpty) return;
    final batch = _batch;
    _batch = <Object?>[];
    _deliver(batch);
  }

  void _handleEvent(List<Object?> event) {
    if (event.isNotEmpty && event[0] == TransportEvents.flushed) {
      final completer = _flushes.remove(event[1]);
      if (completer != null && !completer.isCompleted) {
        completer.complete(event[2] == true);
      }
      return;
    }
    _zone.run(() {
      try {
        _onEvent(event);
      } catch (_) {
        // Never let the owner's handler break the transport.
      }
    });
  }

  @override
  void setHello(Map<String, Object?> hello) =>
      _enqueue(<Object?>['hello', hello]);

  @override
  void send(Map<String, Object?> message, {bool volatile = false}) =>
      _enqueue(<Object?>['send', message, volatile]);

  @override
  Future<bool> flush(Duration timeout) {
    if (_closed) return Future<bool>.value(false);
    final token = ++_flushToken;
    final completer = Completer<bool>();
    _flushes[token] = completer;
    _enqueue(<Object?>['flush', token, timeout.inMilliseconds]);
    return completer.future.timeout(
      timeout + const Duration(milliseconds: 500),
      onTimeout: () {
        _flushes.remove(token);
        return false;
      },
    );
  }

  void _completeAllFlushes() {
    for (final c in _flushes.values) {
      if (!c.isCompleted) c.complete(false);
    }
    _flushes.clear();
  }
}

/// Applies one engine command batch (shared by both transports).
void _applyBatch(TransportCore core, List<Object?> batch) {
  for (final raw in batch) {
    final command = raw as List<Object?>;
    switch (command[0]) {
      case 'hello':
        core.setHello((command[1] as Map<Object?, Object?>).cast<String, Object?>());
      case 'send':
        core.send(
          (command[1] as Map<Object?, Object?>).cast<String, Object?>(),
          volatile: command[2] == true,
        );
      case 'flush':
        core.requestFlush(command[1] as int, command[2] as int);
    }
  }
}

class _LocalTransport extends _BatchingTransport {
  _LocalTransport(super.config, super.onEvent, super.zone);

  late final TransportCore _core;

  @override
  bool get isBackground => false;

  @override
  void _start() {
    _zone.run(() {
      _core = TransportCore(config, _handleEvent);
      _core.start();
    });
  }

  @override
  void _deliver(List<Object?> batch) => _applyBatch(_core, batch);

  @override
  Future<void> close() async {
    if (_closed) return;
    _drainBatch();
    _closed = true;
    await _core.stop();
    _completeAllFlushes();
  }
}

class _IsolateTransport extends _BatchingTransport {
  _IsolateTransport(super.config, super.onEvent, super.zone);

  RawReceivePort? _events;
  SendPort? _commands;
  Isolate? _isolate;
  _LocalTransport? _fallback;
  final List<List<Object?>> _pendingBatches = <List<Object?>>[];

  @override
  bool get isBackground => _fallback == null;

  @override
  void _start() {
    _zone.run(() => unawaited(_spawn()));
  }

  Future<void> _spawn() async {
    final events = RawReceivePort(null, 'durbun-transport-events');
    // Do not keep a pure-Dart program alive just because Dürbün is running.
    events.keepIsolateAlive = false;
    _events = events;
    final ready = Completer<SendPort>();
    events.handler = (Object? message) {
      if (message is SendPort) {
        if (!ready.isCompleted) ready.complete(message);
        return;
      }
      if (message is List<Object?>) _handleEvent(message);
    };
    try {
      _isolate = await Isolate.spawn<List<Object?>>(
        _transportIsolateMain,
        <Object?>[events.sendPort, config.toMap(), Isolate.current.controlPort],
        debugName: 'durbun-transport',
        errorsAreFatal: false,
      );
      final port = await ready.future.timeout(const Duration(seconds: 5));
      if (_closed) {
        port.send(const <Object?>['stop']);
        events.close();
        return;
      }
      _commands = port;
      for (final batch in _pendingBatches) {
        _post(batch);
      }
      _pendingBatches.clear();
    } catch (_) {
      _isolate?.kill(priority: Isolate.immediate);
      _isolate = null;
      events.close();
      _events = null;
      if (_closed) return;
      // Fallback: run the engine on this isolate.
      final local = _fallback = _LocalTransport(config, _onEvent, _zone);
      local._start();
      for (final batch in _pendingBatches) {
        local._deliver(batch);
      }
      _pendingBatches.clear();
    }
  }

  void _post(List<Object?> batch) {
    try {
      _commands!.send(<Object?>['batch', batch]);
    } catch (_) {
      // A message that cannot cross isolates (should not happen: every
      // payload is JSON-safe) is dropped rather than breaking the batch.
      for (final command in batch) {
        try {
          _commands!.send(<Object?>['batch', <Object?>[command]]);
        } catch (_) {}
      }
    }
  }

  @override
  void _deliver(List<Object?> batch) {
    final fallback = _fallback;
    if (fallback != null) {
      fallback._deliver(batch);
    } else if (_commands != null) {
      _post(batch);
    } else {
      _pendingBatches.add(batch);
    }
  }

  @override
  Future<bool> flush(Duration timeout) {
    final fallback = _fallback;
    if (fallback != null) {
      _drainBatch();
      return fallback.flush(timeout);
    }
    return super.flush(timeout);
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _drainBatch();
    _closed = true;
    final fallback = _fallback;
    if (fallback != null) {
      await fallback.close();
    } else if (_commands != null) {
      _commands!.send(const <Object?>['stop']);
      // Give the engine a moment to close its sockets, then make sure it is gone.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      _isolate?.kill(priority: Isolate.beforeNextEvent);
    }
    _events?.close();
    _events = null;
    _completeAllFlushes();
  }
}

/// Entry point of the background transport isolate.
void _transportIsolateMain(List<Object?> args) {
  final toOwner = args[0] as SendPort;
  final config = TransportConfig.fromMap(args[1] as Map<Object?, Object?>);
  final ownerControlPort = args[2] as SendPort?;

  late final TransportCore core;
  final commands = RawReceivePort(null, 'durbun-transport-commands');
  RawReceivePort? ownerExit;

  Future<void> shutdown() async {
    await core.stop();
    commands.close();
    ownerExit?.close();
    Isolate.exit();
  }

  runZonedGuarded(() {
    core = TransportCore(config, (event) {
      try {
        toOwner.send(event);
      } catch (_) {}
    });
    // RawReceivePort handlers run in the root zone; bind them to this guarded
    // zone so every error stays contained.
    commands.handler = Zone.current.bindUnaryCallbackGuarded((Object? message) {
      if (message is! List<Object?> || message.isEmpty) return;
      switch (message[0]) {
        case 'batch':
          _applyBatch(core, message[1] as List<Object?>);
        case 'stop':
          unawaited(shutdown());
      }
    });
    if (ownerControlPort != null) {
      // When the app isolate dies (e.g. Flutter hot restart) stop as well,
      // so no zombie connection keeps answering pings.
      final exitPort = ownerExit = RawReceivePort(null, 'durbun-owner-exit');
      exitPort.handler = Zone.current.bindUnaryCallbackGuarded(
        (Object? _) => unawaited(shutdown()),
      );
      Isolate(ownerControlPort).addOnExitListener(exitPort.sendPort);
    }
    toOwner.send(commands.sendPort);
    core.start();
  }, (error, stack) {
    // Swallow: the transport must never take anything down.
  });
}
