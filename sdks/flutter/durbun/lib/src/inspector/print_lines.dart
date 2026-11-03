/// Turns captured `print` lines into panel log entries. The `logger`
/// package's PrettyPrinter prints one box per log, a line at a time:
///
///     ┌───────────────
///     │ #0  AppLogger.d (package:app/logger.dart:12:5)
///     ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
///     │ 🐛 [Auth] token refreshed
///     └───────────────
///
/// Those lines are joined back into one entry, with the level read from the
/// emoji (or the ANSI colour) and the tag from a leading `[Tag]`.
library;

import 'dart:async';

/// One finished print entry.
class PrintEntry {
  const PrintEntry(
      {required this.ts,
      required this.level,
      required this.message,
      this.tag,
      this.stack,
      this.error});

  final double ts;

  /// Wire level: verbose, debug, info, warn, error, fatal.
  final String level;
  final String message;
  final String? tag;
  final String? stack;

  /// The box's error section (logger's `error:` argument).
  final String? error;
}

final RegExp _ansi = RegExp(r'\x1B\[[0-9;]*m');
final RegExp _ansiColor = RegExp(r'\x1B\[38;5;(\d+)m');
final RegExp _leadingTag = RegExp(r'^\[([^\[\]\s][^\[\]]{0,40})\]\s*');
final RegExp _levelWord =
    RegExp(r'^\[(VERBOSE|TRACE|DEBUG|INFO|WARN|WARNING|ERROR|SEVERE|FATAL)\]\s*', caseSensitive: false);
const Map<String, String> _levelWords = <String, String>{
  'verbose': 'verbose',
  'trace': 'verbose',
  'debug': 'debug',
  'info': 'info',
  'warn': 'warn',
  'warning': 'warn',
  'error': 'error',
  'severe': 'error',
  'fatal': 'fatal',
};
final RegExp _frame = RegExp(r'^#\d+\s');
final RegExp _time = RegExp(r'^\d{1,2}:\d{2}:\d{2}(\.\d+)?(\s|$)|^\d{4}-\d{2}-\d{2}[ T]\d');

const List<(String, String)> _emojis = <(String, String)>[
  ('🐛', 'debug'),
  ('💡', 'info'),
  ('⚠️', 'warn'),
  ('⚠', 'warn'),
  ('⛔', 'error'),
  ('👾', 'fatal'),
];

// PrettyPrinter's default level colours (ANSI 256).
const Map<String, String> _colorLevels = <String, String>{
  '244': 'verbose',
  '12': 'info',
  '208': 'warn',
  '196': 'error',
  '199': 'fatal',
};

/// Collects print lines and emits [PrintEntry]s. A plain line is emitted at
/// once; a box is emitted at its closing line (or, when it never closes,
/// when the next plain line arrives or [flushDelay] passes).
class PrintLineAssembler {
  PrintLineAssembler(this.emit,
      {this.flushDelay = const Duration(milliseconds: 250)});

  final void Function(PrintEntry entry) emit;
  final Duration flushDelay;

  List<String>? _box;
  String? _boxColor;
  double _boxTs = 0;
  Timer? _timer;

  void add(String text, double ts) {
    for (final raw in text.split('\n')) {
      _line(raw, ts);
    }
  }

  void _line(String raw, double ts) {
    final color = _ansiColor.firstMatch(raw)?.group(1);
    final line = raw.replaceAll(_ansi, '').trimRight();
    final head = line.trimLeft();
    if (head.startsWith('┌')) {
      flush();
      _box = <String>[];
      _boxColor = color;
      _boxTs = ts;
      _arm();
      return;
    }
    final box = _box;
    if (box != null) {
      if (head.startsWith('└')) {
        flush();
        return;
      }
      if (head.startsWith('│') || head.startsWith('├')) {
        box.add(head);
        _boxColor ??= color;
        _arm();
        return;
      }
      flush();
    }
    if (line.trim().isEmpty) return;
    emit(_plain(line, color, ts));
  }

  void _arm() {
    _timer?.cancel();
    _timer = Timer(flushDelay, flush);
  }

  /// Emits a box that is still open.
  void flush() {
    _timer?.cancel();
    _timer = null;
    final box = _box;
    _box = null;
    if (box == null) return;
    final entry = _fromBox(box, _boxColor, _boxTs);
    if (entry != null) emit(entry);
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
    _box = null;
  }

  static PrintEntry _plain(String line, String? color, double ts) {
    var (level, text) = _emojiLevel(line);
    level ??= _colorLevels[color];
    var m = _leadingTag.firstMatch(text);
    // `[Tag] [DEBUG] message` (easy_logger and similar): the bracketed word
    // is the level, not a tag.
    if (m != null && _levelWords.containsKey(m.group(1)!.toLowerCase())) m = null;
    var body = m == null ? text : text.substring(m.end);
    final word = _levelWord.firstMatch(body);
    if (word != null) {
      level ??= _levelWords[word.group(1)!.toLowerCase()];
      body = body.substring(word.end);
    }
    return PrintEntry(
      ts: ts,
      level: level ?? 'info',
      message: body,
      tag: m?.group(1) ?? 'flutter',
    );
  }

  static (String?, String) _emojiLevel(String text) {
    final t = text.trimLeft();
    for (final (e, level) in _emojis) {
      if (t.startsWith(e)) {
        // `🐛 ` + the line: drop the emoji (and its variation selector)
        // and one space, keep the line's own indent (pretty-printed JSON).
        var rest = t.substring(e.length);
        if (rest.startsWith('️')) rest = rest.substring(1);
        if (rest.startsWith(' ')) rest = rest.substring(1);
        return (level, rest);
      }
    }
    return (null, text);
  }

  static PrintEntry? _fromBox(List<String> lines, String? color, double ts) {
    final sections = <List<String>>[<String>[]];
    for (final l in lines) {
      if (l.startsWith('├')) {
        if (sections.last.isNotEmpty) sections.add(<String>[]);
      } else {
        // `│ text` → `text` (one space after the bar).
        var body = l.substring(1);
        if (body.startsWith(' ')) body = body.substring(1);
        sections.last.add(body);
      }
    }
    sections.removeWhere((s) => s.isEmpty);
    if (sections.isEmpty) return null;
    // The message is the last section; before it come the error, the stack
    // and the time (each optional).
    final message = sections.removeLast();
    String? level;
    final text = <String>[];
    for (final l in message) {
      final (lv, rest) = _emojiLevel(l);
      level ??= lv;
      text.add(rest);
    }
    level ??= _colorLevels[color];
    var body = text.join('\n').trim();
    final tag = _leadingTag.firstMatch(body);
    if (tag != null) body = body.substring(tag.end);
    String? stack;
    String? error;
    for (final s in sections) {
      if (s.every((l) => _frame.hasMatch(l.trimLeft()))) {
        stack = s.join('\n');
      } else if (s.length == 1 && _time.hasMatch(s.first.trim())) {
        continue;
      } else {
        error = s.join('\n').trim();
      }
    }
    return PrintEntry(
      ts: ts,
      level: level ?? 'info',
      message: body,
      tag: tag?.group(1) ?? 'flutter',
      stack: stack,
      error: error,
    );
  }
}
