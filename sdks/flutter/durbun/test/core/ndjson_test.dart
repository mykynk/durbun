import 'dart:convert';

import 'package:durbun/src/core/transport/ndjson.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('NdjsonLineDecoder', () {
    test('splits lines across chunk boundaries', () {
      final d = NdjsonLineDecoder();
      final out = <String>[];
      out.addAll(d.add(utf8.encode('{"type":"ping","ts":1}\n{"type":"con')));
      expect(out, ['{"type":"ping","ts":1}']);
      out.addAll(d.add(utf8.encode('fig","config":{}}\n')));
      expect(out.last, '{"type":"config","config":{}}');
      expect(d.pendingBytes, 0);
    });

    test('handles CRLF, empty lines and multi-byte characters split in two', () {
      final d = NdjsonLineDecoder();
      final bytes = utf8.encode('{"m":"Dürbün"}\r\n\n');
      final split = bytes.indexOf(0xC3) + 1; // inside "ü"
      final out = <String>[
        ...d.add(bytes.sublist(0, split)),
        ...d.add(bytes.sublist(split)),
      ];
      expect(out, ['{"m":"Dürbün"}']);
    });

    test('several lines in one chunk', () {
      final d = NdjsonLineDecoder();
      expect(d.add(utf8.encode('a\nb\nc\n')), ['a', 'b', 'c']);
    });

    test('a line longer than the frame limit is rejected', () {
      final d = NdjsonLineDecoder(maxLineBytes: 16);
      expect(() => d.add(utf8.encode('x' * 40)), throwsA(isA<FrameTooLargeException>()));
      final d2 = NdjsonLineDecoder(maxLineBytes: 16);
      expect(() => d2.add(utf8.encode('${'y' * 20}\n')), throwsA(isA<FrameTooLargeException>()));
    });
  });

  group('parseMessageLine', () {
    test('accepts JSON objects with a string type only', () {
      expect(parseMessageLine('{"type":"ping","ts":5}'), {'type': 'ping', 'ts': 5});
      expect(parseMessageLine('not json'), isNull);
      expect(parseMessageLine('[1,2]'), isNull);
      expect(parseMessageLine('{"ts":5}'), isNull);
      expect(parseMessageLine('{"type":5}'), isNull);
    });
  });
}
