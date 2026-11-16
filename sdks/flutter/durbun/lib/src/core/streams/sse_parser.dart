/// Incremental Server-Sent Events parser (the `text/event-stream` rules of
/// the HTML standard, "Interpreting an event stream"). Pure Dart, no I/O.
library;

import 'dart:convert';
import 'dart:typed_data';

/// One dispatched event.
class SseEvent {
  SseEvent({
    required this.data,
    required this.size,
    this.event,
    this.eventId,
    this.retry,
  });

  /// The first [SseParser.keepBytes] bytes of the data (the `data:` lines
  /// joined with "\n", UTF-8).
  final Uint8List data;

  /// Full size of the data in bytes.
  final int size;

  /// `event:` field (null when absent or empty).
  final String? event;

  /// `id:` field of this event's block (or of a block without data before
  /// it), when there was one; may be empty (the server reset the last
  /// event id).
  final String? eventId;

  /// `retry:` field in ms, when this block (or a block without data before
  /// it) had a valid one.
  final int? retry;

  /// Whether [data] is only a prefix of the data.
  bool get truncated => size > data.length;
}

/// Turns the bytes of an event stream into [SseEvent]s, chunk by chunk.
///
/// Works on bytes, so chunk boundaries inside a UTF-8 character or inside a
/// CRLF pair never matter (the line breaks CR, LF and CRLF are ASCII and
/// never part of a multi-byte character). Memory stays bounded however long
/// a line or an event is: data beyond [keepBytes] is only counted, field
/// names and the `event:` / `id:` / `retry:` values are cut at
/// [maxFieldBytes]. Comments are skipped; an event is dispatched at a blank
/// line when its data is not empty (as `EventSource` does); an unfinished
/// event at the end of the stream is discarded. The `id:` and `retry:` of a
/// block that is not dispatched (e.g. a lone `retry: 3000`) are reported
/// with the next event, so they are not lost.
class SseParser {
  SseParser(this.onEvent, {this.keepBytes = 0, this.maxFieldBytes = 1024});

  final void Function(SseEvent event) onEvent;

  /// Data bytes kept per event (0: only sizes). May change between events.
  int keepBytes;

  /// Longest `event:` / `id:` / `retry:` value kept, in bytes.
  final int maxFieldBytes;

  static const int _lf = 0x0A, _cr = 0x0D, _colon = 0x3A, _space = 0x20;

  // Stream position.
  bool _started = false;
  int _bomMatched = 0;
  bool _afterCr = false;

  // The line being read.
  bool _inValue = false;
  bool _skipLeadingSpace = false;
  final BytesBuilder _name = BytesBuilder(copy: true);
  bool _nameTooLong = false;
  _Field _field = _Field.ignore;
  final BytesBuilder _value = BytesBuilder(copy: true);
  bool _lineEmpty = true;

  // The event being built.
  final BytesBuilder _data = BytesBuilder(copy: true);
  int _dataSize = 0;
  bool _hasData = false;
  int _keep = 0;
  String? _eventType;
  String? _eventId;
  int? _retry;

  /// Feeds the next chunk of the stream.
  void add(List<int> chunk) {
    var i = 0;
    final n = chunk.length;
    if (!_started) {
      // An optional UTF-8 BOM at the very start of the stream.
      while (i < n && _bomMatched < 3) {
        const bom = <int>[0xEF, 0xBB, 0xBF];
        if (chunk[i] != bom[_bomMatched]) {
          _started = true;
          if (_bomMatched > 0) {
            // Not a BOM after all: those bytes are content.
            final partial = bom.sublist(0, _bomMatched);
            _bomMatched = 3;
            add(partial);
          }
          break;
        }
        _bomMatched++;
        i++;
      }
      if (_bomMatched == 3) _started = true;
      if (!_started) return;
    }
    while (i < n) {
      final b = chunk[i];
      if (_afterCr) {
        _afterCr = false;
        if (b == _lf) {
          i++;
          continue;
        }
      }
      if (b == _lf || b == _cr) {
        _endLine();
        _afterCr = b == _cr;
        i++;
        continue;
      }
      // A run of ordinary bytes up to the next line break.
      var end = i;
      while (end < n) {
        final c = chunk[end];
        if (c == _lf || c == _cr) break;
        if (!_inValue && c == _colon) break;
        end++;
      }
      if (!_inValue) {
        if (end > i) _addName(chunk, i, end);
        if (end < n && chunk[end] == _colon) {
          _startValue();
          end++;
        }
        i = end;
        continue;
      }
      if (end > i) _addValue(chunk, i, end);
      i = end;
    }
  }

  /// The stream ended: an unfinished event is discarded.
  void close() {
    _resetLine();
    _resetEvent();
  }

  void _addName(List<int> chunk, int start, int end) {
    _lineEmpty = false;
    if (_nameTooLong) return;
    if (_name.length + (end - start) > 16) {
      // No field name the parser knows is that long: the line is ignored.
      _nameTooLong = true;
      return;
    }
    _name.add(chunk is Uint8List ? Uint8List.sublistView(chunk, start, end) : chunk.sublist(start, end));
  }

  void _startValue() {
    _lineEmpty = false;
    _inValue = true;
    _skipLeadingSpace = true;
    _field = _nameTooLong ? _Field.ignore : _fieldFor(_name.takeBytes());
    if (_field == _Field.data) _beginDataLine();
  }

  static _Field _fieldFor(Uint8List name) {
    switch (ascii.decode(name, allowInvalid: true)) {
      case 'data':
        return _Field.data;
      case 'event':
        return _Field.event;
      case 'id':
        return _Field.id;
      case 'retry':
        return _Field.retry;
      case '':
        return _Field.comment;
      default:
        return _Field.ignore;
    }
  }

  void _addValue(List<int> chunk, int start, int end) {
    if (_skipLeadingSpace) {
      _skipLeadingSpace = false;
      if (chunk[start] == _space) start++;
      if (start >= end) return;
    }
    switch (_field) {
      case _Field.data:
        _addData(chunk, start, end);
      case _Field.event:
      case _Field.id:
      case _Field.retry:
        final room = maxFieldBytes - _value.length;
        if (room <= 0) return;
        final stop = end - start > room ? start + room : end;
        _value.add(chunk is Uint8List ? Uint8List.sublistView(chunk, start, stop) : chunk.sublist(start, stop));
      case _Field.comment:
      case _Field.ignore:
        break;
    }
  }

  void _beginDataLine() {
    if (!_hasData) {
      _hasData = true;
      _keep = keepBytes < 0 ? 0 : keepBytes;
      return;
    }
    // Lines of one event are joined with "\n".
    _dataSize += 1;
    if (_data.length < _keep) _data.addByte(_lf);
  }

  void _addData(List<int> chunk, int start, int end) {
    final len = end - start;
    _dataSize += len;
    final room = _keep - _data.length;
    if (room <= 0) return;
    final stop = len > room ? start + room : end;
    _data.add(chunk is Uint8List ? Uint8List.sublistView(chunk, start, stop) : chunk.sublist(start, stop));
  }

  void _endLine() {
    if (_lineEmpty) {
      _dispatch();
      _resetLine();
      return;
    }
    if (!_inValue) {
      // A field name without a colon: the whole line is the name, the value
      // is empty.
      _field = _nameTooLong ? _Field.ignore : _fieldFor(_name.takeBytes());
      if (_field == _Field.data) _beginDataLine();
    }
    switch (_field) {
      case _Field.event:
        _eventType = utf8.decode(_value.takeBytes(), allowMalformed: true);
      case _Field.id:
        final bytes = _value.takeBytes();
        // An id containing NULL is ignored.
        if (!bytes.contains(0)) _eventId = utf8.decode(bytes, allowMalformed: true);
      case _Field.retry:
        final bytes = _value.takeBytes();
        if (bytes.isNotEmpty && bytes.every((b) => b >= 0x30 && b <= 0x39) && bytes.length <= 15) {
          _retry = int.parse(ascii.decode(bytes));
        }
      case _Field.data:
      case _Field.comment:
      case _Field.ignore:
        break;
    }
    _resetLine();
  }

  void _dispatch() {
    if (!_hasData) {
      // Not an event; its id / retry go with the next one.
      _eventType = null;
      return;
    }
    try {
      onEvent(SseEvent(
        data: _data.takeBytes(),
        size: _dataSize,
        event: _eventType == null || _eventType!.isEmpty ? null : _eventType,
        eventId: _eventId,
        retry: _retry,
      ));
    } catch (_) {}
    _resetEvent();
  }

  void _resetLine() {
    _inValue = false;
    _skipLeadingSpace = false;
    _name.clear();
    _nameTooLong = false;
    _field = _Field.ignore;
    _value.clear();
    _lineEmpty = true;
  }

  void _resetEvent() {
    _data.clear();
    _dataSize = 0;
    _hasData = false;
    _eventType = null;
    _eventId = null;
    _retry = null;
  }
}

enum _Field { data, event, id, retry, comment, ignore }

/// Whether a `content-type` header value is `text/event-stream`.
bool isEventStreamContentType(String? contentType) {
  if (contentType == null) return false;
  final semi = contentType.indexOf(';');
  final mime = (semi < 0 ? contentType : contentType.substring(0, semi)).trim().toLowerCase();
  return mime == 'text/event-stream';
}
