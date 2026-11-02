// A fake Dürbün desktop speaking the SDK wire protocol (NDJSON over TCP),
// used by the integration tests and by `tool/smoke.dart --dry-run`.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Accepts SDK connections, answers `hello` with `welcome` and records every
/// message.
class FakeDesktop {
  FakeDesktop._(this._server, {required this.autoWelcome}) {
    _server.listen(_onSocket);
  }

  static Future<FakeDesktop> start({
    int port = 0,
    bool autoWelcome = true,
    Map<String, Object?>? config,
    List<Map<String, Object?>> mocks = const <Map<String, Object?>>[],
    String appId = 'app:1',
  }) async {
    final server = await ServerSocket.bind(
      InternetAddress.loopbackIPv4,
      port,
      shared: false,
    );
    final desktop = FakeDesktop._(server, autoWelcome: autoWelcome);
    desktop.config = config ?? defaultConfig();
    desktop.mocks = mocks;
    desktop.appId = appId;
    return desktop;
  }

  static Map<String, Object?> defaultConfig({
    bool captureBodies = true,
    int maxBodyBytes = 1048576,
    int metricsIntervalMs = 1000,
    bool deviceLogsAvailable = false,
  }) => <String, Object?>{
    'captureBodies': captureBodies,
    'maxBodyBytes': maxBodyBytes,
    'metricsIntervalMs': metricsIntervalMs,
    'deviceLogsAvailable': deviceLogsAvailable,
  };

  final ServerSocket _server;
  final bool autoWelcome;
  late Map<String, Object?> config;
  late List<Map<String, Object?>> mocks;
  late String appId;
  final List<FakeSdkConnection> connections = <FakeSdkConnection>[];
  final StreamController<FakeSdkConnection> _connections =
      StreamController<FakeSdkConnection>.broadcast();

  int get port => _server.port;

  Stream<FakeSdkConnection> get onConnection => _connections.stream;

  /// The next connection that completed `hello` (or the current one).
  Future<FakeSdkConnection> nextConnection({
    Duration timeout = const Duration(seconds: 10),
    bool includeExisting = true,
  }) {
    if (includeExisting) {
      for (final c in connections.reversed) {
        if (!c.closed && c.hello != null) return Future.value(c);
      }
    }
    return _connections.stream.firstWhere((c) => c.hello != null).timeout(timeout);
  }

  void _onSocket(Socket socket) {
    final conn = FakeSdkConnection._(socket, this);
    connections.add(conn);
  }

  void _helloReceived(FakeSdkConnection conn) {
    if (autoWelcome) conn.sendWelcome();
    _connections.add(conn);
  }

  /// Connects to an SDK that listens (iOS usbmux path) like the desktop does.
  Future<FakeSdkConnection> connectTo(int port) async {
    // ignore: close_sinks
    final socket = await Socket.connect(InternetAddress.loopbackIPv4, port);
    final conn = FakeSdkConnection._(socket, this);
    connections.add(conn);
    return conn;
  }

  Future<void> close() async {
    for (final c in connections) {
      await c.close();
    }
    await _server.close();
    await _connections.close();
  }
}

class FakeSdkConnection {
  FakeSdkConnection._(this.socket, this.desktop) {
    // Write-side errors (e.g. the SDK reset the link) surface on `done`.
    unawaited(socket.done.then<void>((_) {}, onError: (Object _) {}));
    socket
        .cast<List<int>>()
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          _onLine,
          onDone: () => _markClosed(),
          onError: (Object _) => _markClosed(),
          cancelOnError: true,
        );
  }

  final Socket socket;
  final FakeDesktop desktop;
  final List<Map<String, Object?>> received = <Map<String, Object?>>[];
  final StreamController<Map<String, Object?>> _messages =
      StreamController<Map<String, Object?>>.broadcast();
  final Completer<void> _closed = Completer<void>();
  Map<String, Object?>? hello;
  bool closed = false;

  /// Lines that were not valid JSON objects (should stay empty).
  final List<String> invalidLines = <String>[];

  Stream<Map<String, Object?>> get messages => _messages.stream;

  Future<void> get done => _closed.future;

  void _onLine(String line) {
    if (line.trim().isEmpty) return;
    Object? decoded;
    try {
      decoded = jsonDecode(line);
    } catch (_) {
      invalidLines.add(line);
      return;
    }
    if (decoded is! Map<String, Object?>) {
      invalidLines.add(line);
      return;
    }
    received.add(decoded);
    if (decoded['type'] == 'hello' && hello == null) {
      hello = decoded;
      desktop._helloReceived(this);
    }
    if (!_messages.isClosed) _messages.add(decoded);
  }

  void _markClosed() {
    closed = true;
    if (!_closed.isCompleted) _closed.complete();
  }

  void send(Map<String, Object?> message) {
    if (closed) return;
    socket.write('${jsonEncode(message)}\n');
  }

  void sendRaw(String text) {
    if (closed) return;
    socket.write(text);
  }

  void sendWelcome({
    String? appId,
    Map<String, Object?>? config,
    List<Map<String, Object?>>? mocks,
  }) {
    send(<String, Object?>{
      'type': 'welcome',
      'protocol': 1,
      'server': 'durbun/0.1.0-test',
      'appId': appId ?? desktop.appId,
      'config': config ?? desktop.config,
      'mocks': mocks ?? desktop.mocks,
    });
  }

  /// Messages of [type] received so far.
  List<Map<String, Object?>> ofType(String type) =>
      received.where((m) => m['type'] == type).toList();

  /// Waits for the first message (already received or future) matching
  /// [test].
  Future<Map<String, Object?>> waitFor(
    bool Function(Map<String, Object?> message) test, {
    Duration timeout = const Duration(seconds: 10),
    String? description,
  }) {
    for (final m in received) {
      if (test(m)) return Future.value(m);
    }
    return messages.firstWhere(test).timeout(
      timeout,
      onTimeout: () => throw TimeoutException(
        'FakeDesktop: no message matching ${description ?? 'predicate'}; '
        'received ${received.map((m) => m['type']).toList()}',
      ),
    );
  }

  /// Waits until at least [count] messages match [test].
  Future<List<Map<String, Object?>>> waitForCount(
    bool Function(Map<String, Object?> message) test,
    int count, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (true) {
      final matches = received.where(test).toList();
      if (matches.length >= count) return matches;
      if (DateTime.now().isAfter(deadline)) {
        throw TimeoutException(
          'FakeDesktop: expected $count matching messages, got '
          '${matches.length}: ${received.map((m) => m['type']).toList()}',
        );
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  Future<Map<String, Object?>> waitForLog(String message, {Duration? timeout}) =>
      waitFor(
        (m) => m['type'] == 'log' && m['message'] == message,
        timeout: timeout ?? const Duration(seconds: 10),
        description: 'log "$message"',
      );

  /// net.response / net.error for request [id].
  Future<Map<String, Object?>> waitForNetEnd(String id) => waitFor(
    (m) => (m['type'] == 'net.response' || m['type'] == 'net.error') && m['id'] == id,
    description: 'net end for $id',
  );

  /// Sends a command and waits for its `command.result`.
  Future<Map<String, Object?>> command(
    String name, {
    Map<String, Object?>? params,
    String? id,
  }) {
    final commandId = id ?? 'c${DateTime.now().microsecondsSinceEpoch}';
    final result = waitFor(
      (m) => m['type'] == 'command.result' && m['id'] == commandId,
      description: 'command.result $commandId',
    );
    send(<String, Object?>{
      'type': 'command',
      'id': commandId,
      'name': name,
      if (params != null) 'params': params,
    });
    return result;
  }

  Future<void> close() async {
    if (!closed) {
      try {
        await socket.close();
      } catch (_) {}
      socket.destroy();
    }
    _markClosed();
    if (!_messages.isClosed) await _messages.close();
  }

  /// Abruptly drops the connection (simulates the desktop going away).
  void destroy() {
    socket.destroy();
    _markClosed();
  }
}

/// A free TCP port on 127.0.0.1 (bound and released immediately).
Future<int> freePort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = s.port;
  await s.close();
  return port;
}
