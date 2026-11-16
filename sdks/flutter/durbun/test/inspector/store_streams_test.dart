// The panel store's record of WebSocket messages and event-stream events:
// the per-connection ring with its kept head, the payload cap, the global
// limits (the oldest ended connection gives first), the dropped counts and
// where they were, and the messages' sources (the panel's own copy, the
// desktop's copy, native lines).
import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/store.dart';
import 'package:flutter_test/flutter_test.dart';

Uint8List _utf(String s) => Uint8List.fromList(utf8.encode(s));

DurbunInspectorStore _store({
  int maxStreamMessages = DurbunInspectorStore.kDefaultStreamMessages,
  int streamMessageCap = DurbunInspectorStore.kDefaultStreamMessageCap,
  int maxStreamBytes = DurbunInspectorStore.kDefaultStreamBytes,
  int maxStreamMessagesTotal = DurbunInspectorStore.kDefaultStreamMessagesTotal,
}) =>
    DurbunInspectorStore(
      notifyDelay: Duration.zero,
      maxStreamMessages: maxStreamMessages,
      streamMessageCap: streamMessageCap,
      maxStreamBytes: maxStreamBytes,
      maxStreamMessagesTotal: maxStreamMessagesTotal,
    )..attached = true;

/// A WebSocket handshake (http URL, as dart:io reports it) the panel follows.
InspectorCall _ws(DurbunInspectorStore s, String id, {double at = 1000, String url = 'https://api.example.com/chat'}) {
  s.ingest(buildNetRequest(id: id, ts: at, method: 'GET', url: url, headers: const <List<String>>[
    <String>['Upgrade', 'websocket'],
  ]));
  s.ingest(buildNetResponse(id: id, ts: at + 50, status: 101, headers: const <List<String>>[
    <String>['Upgrade', 'websocket'],
  ]));
  s.streamOpened(id, kind: 'ws', ts: at + 50);
  return s.callByKey('d:$id')!;
}

void _text(DurbunInspectorStore s, String id, String text, {String dir = 'in', double ts = 2000}) {
  final b = _utf(text);
  s.streamWs(id, ts, dir, 'text', b.length, b, null, null);
}

void main() {
  group('one connection', () {
    test('a followed WebSocket: ws:// URL, open, messages in order with their direction and size', () {
      final s = _store();
      final call = _ws(s, '1');
      expect(call.url, 'wss://api.example.com/chat');
      expect(call.connectionKind, StreamKind.webSocket);
      final stream = call.stream!;
      expect(stream.followed, isTrue);
      expect(stream.state, StreamState.open);
      expect(stream.openTs, 1050);
      _text(s, '1', 'merhaba', dir: 'out', ts: 1100);
      _text(s, '1', 'dünya', ts: 1200);
      s.streamWs('1', 1300, 'in', 'binary', 4, Uint8List.fromList(<int>[0, 1, 2, 255]), null, null);
      s.streamWs('1', 1400, 'in', 'ping', 0, null, null, null);
      final m = stream.messages;
      expect(m.map((x) => x.seq), <int>[1, 2, 3, 4]);
      expect(m.map((x) => x.type), <String>['text', 'text', 'binary', 'ping']);
      expect(m[0].out, isTrue);
      expect(m[0].text(), 'merhaba');
      expect(m[1].size, utf8.encode('dünya').length);
      expect(m[2].bytes(), <int>[0, 1, 2, 255]);
      expect(m[2].preview, '00 01 02 ff');
      expect(m[3].isControl, isTrue);
      expect(stream.count, 4);
      expect(stream.received, 3);
      expect(stream.sent, 1);
      expect(stream.control, 1);
      expect(call.isFailure, isFalse);
    });

    test('the first close frame ends it: who closed, the code and the reason', () {
      final s = _store();
      final call = _ws(s, '1');
      s.streamWs('1', 3000, 'in', 'close', 16, null, 1001, 'server restart');
      s.streamWs('1', 3001, 'out', 'close', 16, null, 1001, 'server restart');
      final st = call.stream!;
      expect(st.state, StreamState.closed);
      expect(st.closedBy, 'in');
      expect(st.closeCode, 1001);
      expect(st.closeReason, 'server restart');
      expect(st.endTs, 3000);
      expect(st.messages, hasLength(2));
    });

    test('a break after opening: the stream fails, the request is not a failed request', () {
      final s = _store();
      final call = _ws(s, '1');
      _text(s, '1', 'a');
      s.streamEnded('1', 5000, error: 'SocketException: Connection reset by peer');
      expect(call.stream!.state, StreamState.failed);
      expect(call.stream!.error, contains('reset'));
      expect(call.error, isNull);
      expect(call.status, 101);
      expect(s.failureCount, 0);
    });

    test('the ring keeps the first messages and the newest; the rest is counted as dropped', () {
      final s = _store(maxStreamMessages: 100);
      final call = _ws(s, '1');
      for (var i = 1; i <= 250; i++) {
        _text(s, '1', 'm$i', ts: 2000.0 + i);
      }
      final st = call.stream!;
      expect(st.headKept, DurbunInspectorStore.kStreamHeadKept);
      expect(st.held, 100);
      expect(st.count, 250);
      expect(st.dropped, 150);
      final seqs = st.messages.map((m) => m.seq).toList();
      expect(seqs.take(20), List<int>.generate(20, (i) => i + 1), reason: 'the head stays');
      expect(seqs.skip(20), List<int>.generate(80, (i) => 171 + i), reason: 'then the newest');
      expect(s.streamMessagesHeld, 100);
    });

    test('a short ring keeps a quarter of it as the head', () {
      final s = _store(maxStreamMessages: 8);
      final call = _ws(s, '1');
      for (var i = 1; i <= 20; i++) {
        _text(s, '1', 'm$i');
      }
      final seqs = call.stream!.messages.map((m) => m.seq).toList();
      expect(seqs, <int>[1, 2, 15, 16, 17, 18, 19, 20]);
    });

    test('payloads are cut at the cap, the true size stays; a view of a large buffer is copied', () {
      final s = _store(streamMessageCap: 16);
      final call = _ws(s, '1');
      final big = Uint8List(100000);
      for (var i = 0; i < big.length; i++) {
        big[i] = 0x61;
      }
      s.streamWs('1', 2000, 'in', 'text', 100000, big, null, null);
      final m = call.stream!.messages.single;
      expect(m.size, 100000);
      expect(m.keptBytes, 16);
      expect(m.truncated, isTrue);
      expect(m.text(), 'a' * 16);
      expect(s.streamBytesHeld, 16, reason: 'only the kept part counts, and only it is held');
    });

    test('a cut inside a multi-byte character drops that character', () {
      final s = _store(streamMessageCap: 3);
      final call = _ws(s, '1');
      final b = _utf('aağ');
      s.streamWs('1', 2000, 'in', 'text', b.length, b, null, null);
      expect(call.stream!.messages.single.text(), 'aa', reason: 'no replacement sign at the end');
    });

    test('bodies off: sizes only, the payload says so', () {
      final s = _store()..captureBodiesNow = () => false;
      final call = _ws(s, '1');
      s.streamWs('1', 2000, 'in', 'text', 42, null, null, null);
      final m = call.stream!.messages.single;
      expect(m.hasPayload, isFalse);
      expect(m.size, 42);
      expect(m.body(), isNull);
      expect(s.capturesBodies, isFalse);
    });

    test('search reads the text, the event, the id and the close reason', () {
      final s = _store();
      final call = _ws(s, '1');
      _text(s, '1', '{"type":"Appointment","id":"apt_91"}');
      s.streamWs('1', 3000, 'in', 'close', 10, null, 4001, 'Oturum bitti');
      final m = call.stream!.messages;
      expect(m[0].matches('apt_91'), isTrue);
      expect(m[0].matches('appointment'), isTrue, reason: 'folded');
      expect(m[1].matches('oturum'), isTrue);
      expect(m[1].matches('4001'), isTrue);
      expect(m[0].matches('nope'), isFalse);
    });
  });

  group('event streams', () {
    test('events with their name, id and retry; the end', () {
      final s = _store();
      s.ingest(buildNetRequest(id: '7', ts: 1000, method: 'GET', url: 'https://api.example.com/live', headers: const <List<String>>[]));
      s.ingest(buildNetResponse(id: '7', ts: 1040, status: 200, headers: const <List<String>>[
        <String>['Content-Type', 'text/event-stream'],
      ]));
      final call = s.callByKey('d:7')!;
      expect(call.connectionKind, StreamKind.sse, reason: 'by its content type before any event');
      s.streamOpened('7', kind: 'sse', ts: 1040);
      final d = _utf('{"px":1.5}');
      s.streamSse('7', 1100, 'price', '1', 2500, d.length, d);
      s.streamSse('7', 1200, 'message', null, null, 3, _utf('one'));
      s.streamEnded('7', 1300);
      final st = call.stream!;
      final m = st.messages;
      expect(m[0].event, 'price');
      expect(m[0].eventId, '1');
      expect(m[0].retry, 2500);
      expect(m[1].event, isNull, reason: '"message" is the default type');
      expect(st.state, StreamState.closed);
      expect(st.sseEnded, isTrue);
      expect(call.url, 'https://api.example.com/live', reason: 'not a WebSocket: the URL stays');
    });

    test('an event stream the desktop gets as one body: the panel shows it open at its headers', () {
      final s = _store();
      s.ingest(buildNetRequest(id: '8', ts: 1000, method: 'GET', url: 'https://api.example.com/live', headers: const <List<String>>[]));
      s.streamOpened('8', kind: 'sse', ts: 1050, status: 200, statusText: 'OK', headers: const <List<String>>[
        <String>['content-type', 'text/event-stream'],
      ]);
      final call = s.callByKey('d:8')!;
      expect(call.status, 200);
      expect(call.state, InspectorCallState.done);
      expect(call.stream!.isOpen, isTrue);
      s.streamEnded('8', 2000, cancelled: true);
      expect(call.stream!.cancelled, isTrue);
      expect(call.stream!.state, StreamState.closed);
      // The usual response (the whole body) arrives at the end; the
      // messages stay.
      s.ingest(buildNetResponse(id: '8', ts: 2000, status: 200, headers: const <List<String>>[
        <String>['content-type', 'text/event-stream'],
      ]));
      expect(call.stream, isNotNull);
    });
  });

  group('limits across connections', () {
    test('past the byte budget the oldest ended connection gives first, then the oldest open one', () {
      final s = _store(maxStreamBytes: 1000);
      final ended = _ws(s, '1', at: 1000);
      final open = _ws(s, '2', at: 2000);
      for (var i = 0; i < 4; i++) {
        _text(s, '1', 'x' * 100);
        _text(s, '2', 'y' * 100);
      }
      s.streamWs('1', 3000, 'in', 'close', 2, null, 1000, null);
      final newest = _ws(s, '3', at: 4000);
      _text(s, '3', 'z' * 300);
      expect(s.streamBytesHeld, lessThanOrEqualTo(1000));
      expect(ended.stream!.dropped, greaterThan(0), reason: 'the ended connection gave first');
      expect(open.stream!.dropped, 0);
      expect(newest.stream!.dropped, 0);
      // Still over: the oldest open one gives next.
      _text(s, '3', 'z' * 600);
      expect(s.streamBytesHeld, lessThanOrEqualTo(1000));
      expect(ended.stream!.held, 0);
      expect(open.stream!.dropped, greaterThan(0));
    });

    test('past the message budget the same order applies', () {
      final s = _store(maxStreamMessagesTotal: 10);
      final a = _ws(s, '1', at: 1000);
      final b = _ws(s, '2', at: 2000);
      for (var i = 0; i < 6; i++) {
        _text(s, '1', 'a$i');
      }
      s.streamEnded('1', 2500, error: 'gone');
      for (var i = 0; i < 6; i++) {
        _text(s, '2', 'b$i');
      }
      expect(s.streamMessagesHeld, 10);
      expect(a.stream!.dropped, 2);
      expect(b.stream!.dropped, 0);
    });

    test('a request that leaves the store takes its messages with it; clear empties everything', () {
      final s = DurbunInspectorStore(notifyDelay: Duration.zero, maxCalls: 2)..attached = true;
      _ws(s, '1');
      _text(s, '1', 'x' * 50);
      expect(s.streamBytesHeld, 50);
      s.ingest(buildNetRequest(id: '2', ts: 3000, method: 'GET', url: 'https://a.io/', headers: const <List<String>>[]));
      s.ingest(buildNetRequest(id: '3', ts: 3001, method: 'GET', url: 'https://a.io/', headers: const <List<String>>[]));
      expect(s.callByKey('d:1'), isNull);
      expect(s.streamBytesHeld, 0);
      expect(s.streamMessagesHeld, 0);
      _ws(s, '4');
      _text(s, '4', 'y' * 20);
      s.clear();
      expect(s.streamBytesHeld, 0);
      expect(s.streamMessagesHeld, 0);
    });
  });

  group('sources', () {
    test("the desktop's copy (net.ws with a pending body, net.sse end) lands on the same entry", () {
      final s = _store();
      final call = _ws(s, '1');
      final body = _utf('selam');
      s.ingest(buildNetWs(
          id: '1',
          ts: 2000,
          dir: 'out',
          opcode: 'text',
          size: body.length,
          body: PendingBody(bytes: body, size: body.length, truncated: false, limit: 65536, capture: true)));
      final m = call.stream!.messages.single;
      expect(m.text(), 'selam');
      expect(m.out, isTrue);
    });

    test('native lines: base64 and text bodies, a net.error ends the stream', () {
      final s = _store();
      String line(Map<String, Object?> m) => jsonEncode(m);
      s.ingest(<String, Object?>{
        kEncodedLineKey: line(<String, Object?>{
          'type': 'net.request',
          'id': 'okhttp-1',
          'ts': 1000,
          'method': 'GET',
          'url': 'wss://n.example.com/s',
          'headers': <Object?>[],
          'source': 'okhttp',
        }),
      });
      s.ingest(<String, Object?>{
        kEncodedLineKey: line(<String, Object?>{'type': 'net.response', 'id': 'okhttp-1', 'ts': 1040, 'status': 101, 'headers': <Object?>[]}),
      });
      final call = s.callByKey('n:okhttp-1')!;
      expect(call.stream, isNull);
      expect(call.connectionKind, StreamKind.webSocket);
      s.ingest(<String, Object?>{
        kEncodedLineKey: line(<String, Object?>{
          'type': 'net.ws',
          'id': 'okhttp-1',
          'ts': 1100,
          'dir': 'in',
          'opcode': 'binary',
          'size': 3,
          'body': <String, Object?>{'encoding': 'base64', 'data': base64Encode(<int>[9, 8, 7]), 'size': 3},
        }),
      });
      s.ingest(<String, Object?>{
        kEncodedLineKey: line(<String, Object?>{
          'type': 'net.ws',
          'id': 'okhttp-1',
          'ts': 1200,
          'dir': 'out',
          'opcode': 'text',
          'size': 2,
          'body': <String, Object?>{'encoding': 'utf8', 'data': 'hi', 'size': 2},
        }),
      });
      final st = call.stream!;
      expect(st.followed, isFalse, reason: 'only the copy that went to the desktop');
      expect(st.messages[0].bytes(), <int>[9, 8, 7]);
      expect(st.messages[1].text(), 'hi');
      s.ingest(<String, Object?>{
        kEncodedLineKey: line(<String, Object?>{'type': 'net.error', 'id': 'okhttp-1', 'ts': 1300, 'error': 'EOF'}),
      });
      expect(st.state, StreamState.failed);
      expect(call.error, isNull);
      expect(s.failureCount, 0);
    });

    test("the panel's own handshake, then the desktop's: one entry, the messages kept", () {
      final s = _store();
      final call = _ws(s, '1');
      _text(s, '1', 'kept');
      s.ingest(buildNetRequest(id: '1', ts: 1000, method: 'GET', url: 'wss://api.example.com/chat', headers: const <List<String>>[]));
      expect(s.calls, hasLength(1));
      expect(identical(s.callByKey('d:1'), call), isTrue);
      expect(call.stream!.messages.single.text(), 'kept');
    });

    test('a 101 the SDK has no hook on says so; nothing is recorded while not attached or read-only', () {
      final s = _store();
      s.ingest(buildNetRequest(id: '1', ts: 1000, method: 'GET', url: 'wss://a.io/', headers: const <List<String>>[]));
      s.ingest(buildNetResponse(id: '1', ts: 1100, status: 101, headers: const <List<String>>[], noStream: true));
      expect(s.callByKey('d:1')!.noStream, isTrue);
      s.attached = false;
      expect(s.recordsStreams, isFalse);
      s.streamOpened('1', kind: 'ws', ts: 1100);
      expect(s.callByKey('d:1')!.stream, isNull);
      s
        ..attached = true
        ..readOnly = true;
      expect(s.recordsStreams, isFalse);
    });
  });
}
