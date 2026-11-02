import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:durbun/src/core/body.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/core/transport/ndjson.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> wire(
  List<int> bytes, {
  int? size,
  bool truncated = false,
  int limit = 1 << 20,
  bool capture = true,
  String? contentType,
  String? contentEncoding,
}) => wireBodyFromPending(
  PendingBody(
    bytes: Uint8List.fromList(bytes),
    size: size ?? bytes.length,
    truncated: truncated,
    limit: limit,
    capture: capture,
    contentType: contentType,
    contentEncoding: contentEncoding,
  ).toMessageValue(),
);

void main() {
  group('isTextContentType (same list as the protocol)', () {
    test('text-like types', () {
      for (final ct in [
        'application/json; charset=utf-8',
        'APPLICATION/JSON',
        'application/vnd.api+json',
        'application/problem+json',
        'text/html; charset=UTF-8',
        'text/plain',
        'application/xml',
        'application/rss+xml',
        'application/javascript',
        'application/x-www-form-urlencoded',
        'application/graphql',
        'application/x-yaml',
        'text/csv',
      ]) {
        expect(isTextContentType(ct), isTrue, reason: ct);
      }
    });

    test('binary types', () {
      for (final ct in [
        null,
        'image/png',
        'image/webp',
        'application/octet-stream',
        'application/pdf',
        'multipart/form-data; boundary=x',
        'video/mp4',
      ]) {
        expect(isTextContentType(ct), isFalse, reason: '$ct');
      }
    });
  });

  group('BodyCapture', () {
    test('keeps at most limit bytes but counts the real size', () {
      final c = BodyCapture(limit: 10, enabled: true)
        ..add([1, 2, 3, 4])
        ..add(Uint8List.fromList([5, 6, 7, 8]))
        ..add([9, 10, 11, 12]);
      expect(c.size, 12);
      expect(c.captured, 10);
      expect(c.truncated, isTrue);
      final pending = c.toPending(contentType: 'application/octet-stream')!;
      expect(pending.bytes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(pending.size, 12);
      expect(pending.truncated, isTrue);
    });

    test('copies the caller buffer', () {
      final chunk = Uint8List.fromList([1, 2, 3]);
      final c = BodyCapture(limit: 100, enabled: true)..add(chunk);
      chunk[0] = 99;
      expect(c.toPending()!.bytes, [1, 2, 3]);
    });

    test('disabled capture still counts the size', () {
      final c = BodyCapture(limit: 100, enabled: false)..add(List.filled(50, 1));
      final pending = c.toPending()!;
      expect(pending.size, 50);
      expect(pending.bytes, isEmpty);
      expect(pending.capture, isFalse);
    });

    test('nothing written → no body', () {
      expect(BodyCapture(limit: 10, enabled: true).toPending(), isNull);
    });

    test('incomplete marks the body truncated', () {
      final c = BodyCapture(limit: 100, enabled: true)..add([1, 2]);
      expect(c.toPending(incomplete: true)!.truncated, isTrue);
    });
  });

  group('wireBodyFromPending', () {
    test('JSON → utf8 text', () {
      final json = '{"user":{"id":42,"name":"Yusuf Kaynak","city":"İstanbul"}}';
      final w = wire(utf8.encode(json), contentType: 'application/json; charset=utf-8');
      expect(w, {'encoding': 'utf8', 'data': json, 'size': utf8.encode(json).length});
    });

    test('binary → base64', () {
      final png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
      final w = wire(png, contentType: 'image/png');
      expect(w['encoding'], 'base64');
      expect(base64Decode(w['data']! as String), png);
      expect(w['size'], png.length);
      expect(w.containsKey('truncated'), isFalse);
    });

    test('truncated text keeps the real size and never splits a UTF-8 sequence', () {
      final text = 'ğğğ'; // 6 bytes
      final bytes = utf8.encode(text);
      final w = wire(
        bytes.sublist(0, 5),
        size: 6,
        truncated: true,
        limit: 5,
        contentType: 'text/plain; charset=utf-8',
      );
      expect(w['data'], 'ğğ');
      expect(w['size'], 6);
      expect(w['truncated'], isTrue);
    });

    test('gzip bytes are decoded (size = decoded size)', () {
      final json = jsonEncode({'items': List.generate(50, (i) => {'id': i, 'title': 'Ürün $i'})});
      final compressed = gzip.encode(utf8.encode(json));
      final w = wire(
        compressed,
        contentType: 'application/json',
        contentEncoding: 'gzip',
      );
      expect(w['encoding'], 'utf8');
      expect(w['data'], json);
      expect(w['size'], utf8.encode(json).length);
    });

    test('decoded bodies larger than the limit are cut', () {
      final json = '{"data":"${'x' * 5000}"}';
      final w = wire(
        gzip.encode(utf8.encode(json)),
        contentType: 'application/json',
        contentEncoding: 'gzip',
        limit: 100,
      );
      expect((w['data']! as String).length, 100);
      expect(w['size'], json.length);
      expect(w['truncated'], isTrue);
    });

    test('undecodable encodings (br) stay base64', () {
      final w = wire(
        [0x1b, 0x2c, 0x00, 0xff],
        contentType: 'application/json',
        contentEncoding: 'br',
      );
      expect(w['encoding'], 'base64');
    });

    test('captureBodies=false → only the size', () {
      final w = wire(
        const [],
        size: 2048,
        capture: false,
        contentType: 'application/json',
      );
      expect(w, {'encoding': 'utf8', 'data': '', 'size': 2048, 'truncated': true});
    });

    test('no content type: sniff text vs binary', () {
      expect(wire(utf8.encode('{"a":1}'))['encoding'], 'utf8');
      expect(wire([0, 1, 2, 3, 255])['encoding'], 'base64');
    });
  });

  group('trimIncompleteUtf8', () {
    test('drops only an incomplete trailing sequence', () {
      final euro = utf8.encode('a€'); // 61 E2 82 AC
      expect(trimIncompleteUtf8(Uint8List.fromList(euro)), euro);
      expect(trimIncompleteUtf8(Uint8List.fromList(euro.sublist(0, 3))), [0x61]);
      expect(trimIncompleteUtf8(Uint8List.fromList(euro.sublist(0, 2))), [0x61]);
      final emoji = utf8.encode('🔭'); // 4 bytes
      expect(trimIncompleteUtf8(Uint8List.fromList(emoji.sublist(0, 3))), isEmpty);
      expect(trimIncompleteUtf8(Uint8List.fromList(emoji)), emoji);
    });
  });

  group('encodeMessageLine', () {
    test('resolves pending bodies and terminates with a newline', () {
      final msg = buildNetResponse(
        id: '7',
        ts: 1767225600123.5,
        status: 200,
        headers: [
          ['content-type', 'application/json'],
        ],
        body: PendingBody(
          bytes: Uint8List.fromList(utf8.encode('{"ok":true}')),
          size: 11,
          truncated: false,
          limit: 100,
          capture: true,
          contentType: 'application/json',
        ),
      );
      final line = encodeMessageLine(msg)!;
      expect(line.last, 0x0A);
      final decoded = jsonDecode(utf8.decode(line)) as Map<String, Object?>;
      expect(decoded['body'], {'encoding': 'utf8', 'data': '{"ok":true}', 'size': 11});
      expect(decoded['type'], 'net.response');
      expect(decoded['status'], 200);
    });

    test('oversized messages are shrunk to fit the frame limit', () {
      final msg = buildLog(level: 'info', message: 'x' * 5000, data: {'big': 'y' * 5000});
      final line = encodeMessageLine(msg, maxFrameBytes: 2000)!;
      expect(line.length, lessThanOrEqualTo(2000));
      final decoded = jsonDecode(utf8.decode(line)) as Map<String, Object?>;
      expect(decoded['message'], startsWith('xxx'));
      expect(decoded['message'], contains('more characters'));
      expect(decoded['data'], contains('omitted'));
    });

    test('body data is dropped first when a body does not fit', () {
      final msg = buildNetRequest(
        id: '1',
        ts: 1,
        method: 'POST',
        url: 'https://x.dev/upload',
        headers: const [],
        body: PendingBody(
          bytes: Uint8List.fromList(List.filled(4000, 0x41)),
          size: 4000,
          truncated: false,
          limit: 1 << 20,
          capture: true,
          contentType: 'text/plain',
        ),
      );
      final decoded =
          jsonDecode(utf8.decode(encodeMessageLine(msg, maxFrameBytes: 1000)!))
              as Map<String, Object?>;
      expect(decoded['body'], {'encoding': 'utf8', 'data': '', 'size': 4000, 'truncated': true});
    });
  });
}
