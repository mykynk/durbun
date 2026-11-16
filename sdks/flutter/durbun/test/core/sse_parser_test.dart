// The incremental text/event-stream parser: chunk boundaries anywhere,
// line breaks, comments, fields, caps.
import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/src/core/streams/sse_parser.dart';
import 'package:flutter_test/flutter_test.dart';

List<SseEvent> parse(List<List<int>> chunks, {int keep = 1 << 20}) {
  final events = <SseEvent>[];
  final parser = SseParser(events.add, keepBytes: keep);
  for (final c in chunks) {
    parser.add(c);
  }
  parser.close();
  return events;
}

String dataOf(SseEvent e) => utf8.decode(e.data);

/// [text] split into chunks of [size] bytes.
List<List<int>> split(String text, int size) {
  final bytes = utf8.encode(text);
  return <List<int>>[
    for (var i = 0; i < bytes.length; i += size) bytes.sublist(i, i + size > bytes.length ? bytes.length : i + size),
  ];
}

void main() {
  const stream = ': welcome comment\n'
      'retry: 3000\n'
      'event: price\n'
      'id: 7\n'
      'data: {"sym":"DÜR",\n'
      'data:"px":1.5}\n'
      '\n'
      'data: plain message ünïcödé 🎉\n'
      '\n'
      'event: message\n'
      'data\n'
      '\n';

  void expectStream(List<SseEvent> events) {
    expect(events, hasLength(3));
    expect(events[0].event, 'price');
    expect(events[0].eventId, '7');
    expect(events[0].retry, 3000);
    expect(dataOf(events[0]), '{"sym":"DÜR",\n"px":1.5}');
    expect(events[0].size, utf8.encode('{"sym":"DÜR",\n"px":1.5}').length);
    expect(events[1].event, isNull);
    expect(events[1].eventId, isNull);
    expect(events[1].retry, isNull);
    expect(dataOf(events[1]), 'plain message ünïcödé 🎉');
    expect(events[2].event, 'message');
    expect(dataOf(events[2]), '', reason: 'a "data" line without a colon is an empty data line');
  }

  test('fields, comments and the data lines joined with \\n', () {
    expectStream(parse(<List<int>>[utf8.encode(stream)]));
  });

  test('every chunk size, also inside UTF-8 characters and CRLF pairs', () {
    final crlf = stream.replaceAll('\n', '\r\n');
    final cr = stream.replaceAll('\n', '\r');
    for (final text in [stream, crlf, cr]) {
      for (var size = 1; size <= 9; size++) {
        expectStream(parse(split(text, size)));
      }
    }
  });

  test('a UTF-8 BOM at the start is skipped, also split over chunks', () {
    final bytes = <int>[0xEF, 0xBB, 0xBF, ...utf8.encode('data: a\n\n')];
    expect(dataOf(parse(<List<int>>[bytes]).single), 'a');
    expect(dataOf(parse(<List<int>>[bytes.sublist(0, 1), bytes.sublist(1, 2), bytes.sublist(2)]).single), 'a');
  });

  test('one leading space of a value is removed, a second one stays', () {
    final e = parse(<List<int>>[utf8.encode('data:  two\nevent:x\n\n')]).single;
    expect(dataOf(e), ' two');
    expect(e.event, 'x');
  });

  test('blocks without data are not dispatched (their id and retry go with the next event); '
      'an unfinished event at the end is dropped', () {
    final events = parse(<List<int>>[utf8.encode('retry: 900\nid: 1\nevent: ping\n\ndata: kept\n\ndata: next\n\ndata: lost')]);
    expect(events.map(dataOf), <String>['kept', 'next']);
    expect(events[0].eventId, '1');
    expect(events[0].retry, 900);
    expect(events[0].event, isNull, reason: 'the event type is not carried over');
    expect(events[1].eventId, isNull);
    expect(events[1].retry, isNull);
  });

  test('id with NULL is ignored, an empty id is kept, retry must be digits', () {
    final events = parse(<List<int>>[
      utf8.encode('id: a\u0000b\nretry: 12x\ndata: 1\n\nid\nretry: 50\ndata: 2\n\n'),
    ]);
    expect(events[0].eventId, isNull);
    expect(events[0].retry, isNull);
    expect(events[1].eventId, '');
    expect(events[1].retry, 50);
  });

  test('unknown fields and long field names are ignored', () {
    final events = parse(<List<int>>[utf8.encode('foo: bar\n${'x' * 40}: y\ndata: ok\n\n')]);
    expect(dataOf(events.single), 'ok');
  });

  test('data beyond keepBytes is counted, not kept; a huge line never grows memory', () {
    final big = 'z' * 100000;
    final events = parse(split('data: $big\ndata: tail\n\n', 777), keep: 16);
    final e = events.single;
    expect(e.data.length, 16);
    expect(e.size, 100000 + 1 + 4);
    expect(e.truncated, isTrue);
  });

  test('keepBytes 0 keeps sizes only', () {
    final e = parse(<List<int>>[utf8.encode('data: hello\n\n')], keep: 0).single;
    expect(e.data, isEmpty);
    expect(e.size, 5);
  });

  test('event and id values are cut at maxFieldBytes', () {
    final events = <SseEvent>[];
    SseParser(events.add, keepBytes: 10, maxFieldBytes: 4)
      ..add(utf8.encode('event: abcdefgh\nid: 123456\ndata: x\n\n'))
      ..close();
    expect(events.single.event, 'abcd');
    expect(events.single.eventId, '1234');
  });

  test('chunks that are Uint8List views are not kept by reference', () {
    final buffer = Uint8List.fromList(utf8.encode('data: abc\n\n'));
    final events = <SseEvent>[];
    final parser = SseParser(events.add, keepBytes: 100)..add(Uint8List.sublistView(buffer, 0, 9));
    buffer.fillRange(0, 9, 0x41);
    parser.add(Uint8List.sublistView(buffer, 9));
    expect(dataOf(events.single), 'abc');
  });

  test('the content type check', () {
    expect(isEventStreamContentType('text/event-stream'), isTrue);
    expect(isEventStreamContentType('Text/Event-Stream; charset=utf-8'), isTrue);
    expect(isEventStreamContentType('text/plain'), isFalse);
    expect(isEventStreamContentType(null), isFalse);
  });
}
