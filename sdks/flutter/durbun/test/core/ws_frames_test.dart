// RFC 6455 / RFC 7692 frame reader: lengths, masking, fragmentation,
// control frames, permessage-deflate with and without context takeover.
import 'dart:convert';
import 'dart:io' show RawZLibFilter;
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:durbun/src/core/streams/ws_frames.dart';
import 'package:flutter_test/flutter_test.dart';

/// One frame on the wire.
List<int> frame(int opcode, List<int> payload, {bool fin = true, bool rsv1 = false, List<int>? mask}) {
  final out = <int>[(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode];
  final m = mask == null ? 0 : 0x80;
  final n = payload.length;
  if (n < 126) {
    out.add(m | n);
  } else if (n < 65536) {
    out
      ..add(m | 126)
      ..add(n >> 8)
      ..add(n & 0xFF);
  } else {
    out.add(m | 127);
    for (var shift = 56; shift >= 0; shift -= 8) {
      out.add((n >> shift) & 0xFF);
    }
  }
  if (mask != null) {
    out.addAll(mask);
    for (var i = 0; i < n; i++) {
      out.add(payload[i] ^ mask[i & 3]);
    }
  } else {
    out.addAll(payload);
  }
  return out;
}

/// A permessage-deflate compressor like dart:io's.
class Deflater {
  Deflater({this.noContextTakeover = false});

  final bool noContextTakeover;
  RawZLibFilter? _encoder;

  List<int> compress(List<int> message) {
    final encoder = _encoder ??= RawZLibFilter.deflateFilter(windowBits: 15, raw: true);
    encoder.process(message, 0, message.length);
    final out = <int>[];
    while (true) {
      final chunk = encoder.processed();
      if (chunk == null) break;
      out.addAll(chunk);
    }
    if (noContextTakeover) _encoder = null;
    return out.length > 4 ? out.sublist(0, out.length - 4) : <int>[0x00];
  }
}

class Collector {
  Collector({this.deflate = false, this.noContextTakeover = false, this.cap = 1 << 20});

  final bool deflate;
  final bool noContextTakeover;
  final List<WsMessage> messages = <WsMessage>[];
  late final WsFrameReader reader = WsFrameReader(
    onMessage: messages.add,
    wanted: () => wanted,
    cap: () => cap,
    deflate: deflate,
    noContextTakeover: noContextTakeover,
  );
  bool wanted = true;
  int cap;

  void feed(List<int> bytes, {int? chunk}) {
    if (chunk == null) {
      reader.add(bytes);
      return;
    }
    for (var i = 0; i < bytes.length; i += chunk) {
      reader.add(Uint8List.fromList(bytes.sublist(i, math.min(bytes.length, i + chunk))));
    }
  }
}

String text(WsMessage m) => utf8.decode(m.data!);

void main() {
  const mask = <int>[0x37, 0xFA, 0x21, 0x3D];

  test('text, binary, 16- and 64-bit lengths, masked and not', () {
    final big = List<int>.generate(70000, (i) => i & 0xFF);
    final mid = utf8.encode('ü' * 150);
    final bytes = <int>[
      ...frame(0x1, utf8.encode('merhaba')),
      ...frame(0x2, <int>[1, 2, 3], mask: mask),
      ...frame(0x1, mid, mask: mask),
      ...frame(0x2, big),
    ];
    for (final chunk in <int?>[null, 1, 3, 1000]) {
      final c = Collector()..feed(bytes, chunk: chunk);
      expect(c.messages.map((m) => m.opcode), <String>['text', 'binary', 'text', 'binary']);
      expect(text(c.messages[0]), 'merhaba');
      expect(c.messages[1].data, <int>[1, 2, 3]);
      expect(text(c.messages[2]), 'ü' * 150);
      expect(c.messages[2].size, 300);
      expect(c.messages[3].size, 70000);
      expect(c.messages[3].data, big);
      expect(c.reader.lost, isFalse);
    }
  });

  test('fragments are joined; control frames between them come first', () {
    final bytes = <int>[
      ...frame(0x1, utf8.encode('par'), fin: false, mask: mask),
      ...frame(0x9, utf8.encode('hi'), mask: mask),
      ...frame(0x0, utf8.encode('ça'), fin: false, mask: mask),
      ...frame(0x0, utf8.encode('lı'), mask: mask),
      ...frame(0xA, const <int>[]),
    ];
    final c = Collector()..feed(bytes, chunk: 2);
    expect(c.messages.map((m) => m.opcode), <String>['ping', 'text', 'pong']);
    expect(c.messages[0].data, utf8.encode('hi'));
    expect(text(c.messages[1]), 'parçalı');
    expect(c.messages[1].size, utf8.encode('parçalı').length);
    expect(c.messages[2].size, 0);
    expect(c.messages[2].data, isNull);
  });

  test('close frames with and without code and reason', () {
    final bytes = <int>[
      ...frame(0x8, <int>[0x03, 0xE8, ...utf8.encode('güle güle')], mask: mask),
      ...frame(0x8, const <int>[]),
    ];
    final c = Collector()..feed(bytes);
    expect(c.messages[0].opcode, 'close');
    expect(c.messages[0].closeCode, 1000);
    expect(c.messages[0].closeReason, 'güle güle');
    expect(c.messages[0].data, isNull);
    expect(c.messages[1].closeCode, isNull);
    expect(c.messages[1].closeReason, isNull);
  });

  test('the cap keeps a prefix and the full size; cap 0 keeps nothing', () {
    final c = Collector(cap: 4)..feed(frame(0x1, utf8.encode('abcdefgh'), mask: mask), chunk: 3);
    expect(c.messages.single.data, utf8.encode('abcd'));
    expect(c.messages.single.size, 8);
    expect(c.messages.single.truncated, isTrue);
    final z = Collector(cap: 0)..feed(frame(0x2, <int>[9, 9, 9]));
    expect(z.messages.single.data, isNull);
    expect(z.messages.single.size, 3);
  });

  test('the bytes fed are never changed', () {
    final bytes = Uint8List.fromList(frame(0x1, utf8.encode('aynı kalmalı'), mask: mask));
    final copy = Uint8List.fromList(bytes);
    Collector().feed(bytes);
    expect(bytes, copy);
  });

  group('permessage-deflate', () {
    final messages = <String>[
      '{"type":"chat","text":"merhaba dünya","room":"genel"}',
      '{"type":"chat","text":"merhaba dünya","room":"genel"}',
      '{"type":"chat","text":"nasılsın","room":"genel"}',
    ];

    test('context takeover: every message decodes exactly (they refer to the earlier ones)', () {
      final d = Deflater();
      final wire = <int>[
        for (final m in messages) ...frame(0x1, d.compress(utf8.encode(m)), rsv1: true, mask: mask),
      ];
      for (final chunk in <int?>[null, 1, 5]) {
        final c = Collector(deflate: true)..feed(wire, chunk: chunk);
        expect(c.messages.map(text), messages);
        expect(c.messages.map((m) => m.size), messages.map((m) => utf8.encode(m).length));
        expect(c.messages.any((m) => m.undecoded), isFalse);
      }
    });

    test('a compressed message split over frames, next to an uncompressed one', () {
      final d = Deflater();
      final payload = d.compress(utf8.encode('x' * 5000));
      final half = payload.length ~/ 2;
      final wire = <int>[
        ...frame(0x1, payload.sublist(0, half), rsv1: true, fin: false),
        ...frame(0x0, payload.sublist(half)),
        ...frame(0x1, utf8.encode('plain')),
      ];
      final c = Collector(deflate: true, cap: 10)..feed(wire, chunk: 7);
      expect(c.messages[0].size, 5000);
      expect(text(c.messages[0]), 'x' * 10);
      expect(text(c.messages[1]), 'plain');
    });

    test('a skipped message gives up the history: the next one is sizes only, never wrong', () {
      final d = Deflater();
      final wire = [for (final m in messages) frame(0x1, d.compress(utf8.encode(m)), rsv1: true)];
      final c = Collector(deflate: true);
      c
        ..wanted = false
        ..feed(wire[0])
        ..wanted = true
        ..feed(wire[1]);
      final second = c.messages.single;
      expect(second.undecoded, isTrue, reason: 'it repeats the first message, which was not followed');
      expect(second.data, isNull);
      expect(second.size, wire[1].length - 2, reason: 'the compressed payload size');
      // The history starts over; a message that does not refer back decodes.
      c.feed(frame(0x1, Deflater().compress(utf8.encode('yeni')), rsv1: true));
      expect(text(c.messages.last), 'yeni');
      expect(c.messages.last.undecoded, isFalse);
    });

    test('no context takeover: a skipped message does not matter', () {
      final d = Deflater(noContextTakeover: true);
      final wire = [for (final m in messages) frame(0x1, d.compress(utf8.encode(m)), rsv1: true)];
      final c = Collector(deflate: true, noContextTakeover: true);
      c
        ..wanted = false
        ..feed(wire[0])
        ..wanted = true
        ..feed(<int>[...wire[1], ...wire[2]]);
      expect(c.messages.map(text), messages.sublist(1));
    });

    test('RSV1 without negotiated deflate is read as plain bytes', () {
      final c = Collector()..feed(frame(0x2, <int>[1, 2], rsv1: true));
      expect(c.messages.single.data, <int>[1, 2]);
    });
  });

  test('a reserved opcode stops the reader for good', () {
    final c = Collector()
      ..feed(<int>[...frame(0x3, <int>[1]), ...frame(0x1, utf8.encode('after'))]);
    expect(c.reader.lost, isTrue);
    expect(c.messages, isEmpty);
  });

  test('negotiated parameters from Sec-WebSocket-Extensions', () {
    expect(parsePerMessageDeflate(null), isNull);
    expect(parsePerMessageDeflate('x-webkit-deflate-frame'), isNull);
    final p = parsePerMessageDeflate('permessage-deflate; server_no_context_takeover; client_max_window_bits=10')!;
    expect(p.serverNoContextTakeover, isTrue);
    expect(p.clientNoContextTakeover, isFalse);
    expect(parsePerMessageDeflate('foo, permessage-deflate; client_no_context_takeover')!.clientNoContextTakeover, isTrue);
  });
}
