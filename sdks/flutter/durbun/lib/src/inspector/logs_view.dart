/// Logs view of the in-app inspector: the desktop's live log stream with
/// level toggles, quick filters, the query language, merged repeats,
/// network rows and a detail page.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'filter_ui.dart';
import 'format.dart';
import 'json_tree.dart';
import 'live_list.dart';
import 'network_model.dart';
import 'network_view.dart' show CallDetailPage;
import 'share_sheet.dart' show showLogShareSheet;
import 'store.dart';
import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

/// A row of the stream: a log line (with its repeat count) or a request.
class StreamItem {
  StreamItem.log(InspectorLog this.log) : call = null, ts = log.ts, key = 'l${log.seq}', seq = log.seq;
  StreamItem.call(InspectorCall this.call) : log = null, ts = call.ts, key = 'c${call.key}', seq = call.seq;

  final InspectorLog? log;
  final InspectorCall? call;
  final double ts;
  final String key;

  /// Arrival order in the store (logs and calls share the counter).
  final int seq;
  int repeats = 1;
}

/// "Type: message", without the type twice when the message already starts
/// with it (Dart's `toString()` of most exceptions does).
String errorHead(Map<String, Object?> error) {
  final type = error['type'] is String ? error['type'] as String : null;
  final message = error['message'] is String ? error['message'] as String : null;
  if (type == null || type.isEmpty) return message ?? '';
  if (message == null || message.isEmpty) return type;
  return message.startsWith(type) ? message : '$type: $message';
}

const List<String> kLevels = <String>['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];

class LogFilters {
  /// Lines below this level are hidden (crashes and events always pass).
  String minLevel = 'verbose';
  bool errorsOnly = false;
  bool crashes = false;

  /// Requests are mixed into the stream (an "include" switch, unlike the
  /// "only" filters around it).
  bool network = true;
  bool events = false;

  /// `all`, `flutter` (Dart) or `native` (Kotlin/Swift).
  String source = 'all';
  final Set<String> hiddenTags = <String>{};

  /// Filters away from their default (the badge on the Filters button).
  int get activeCount =>
      (minLevel != 'verbose' ? 1 : 0) +
      (errorsOnly ? 1 : 0) +
      (crashes ? 1 : 0) +
      (!network ? 1 : 0) +
      (events ? 1 : 0) +
      (source != 'all' ? 1 : 0) +
      (hiddenTags.isNotEmpty ? 1 : 0);

  void reset() {
    minLevel = 'verbose';
    errorsOnly = false;
    crashes = false;
    network = true;
    events = false;
    source = 'all';
    hiddenTags.clear();
  }

  /// Changes whenever a filter does (tells the live list to follow again).
  String get signature => '$minLevel|$errorsOnly|$crashes|$network|$events|$source|${hiddenTags.join(',')}';
}

int _rank(String level) => kLevels.indexOf(level).clamp(0, 5);

bool logMatches(InspectorLog l, LogFilters f, List<QueryClause> q) {
  if (_rank(l.level) < _rank(f.minLevel) && !l.isCrash && !l.isEvent) return false;
  if (f.errorsOnly && !l.isError) return false;
  if (f.crashes && !l.isCrash && l.kind != 'flutter-error') return false;
  if (f.events && !l.isEvent) return false;
  if (f.source == 'flutter' && l.native) return false;
  if (f.source == 'native' && !l.native) return false;
  if (l.tag != null && f.hiddenTags.contains(l.tag)) return false;
  for (final c in q) {
    final bool hit;
    switch (c.key) {
      case 'tag':
        hit = foldContains(l.tag ?? '', c.value);
      case 'level':
        final want = kLevels.indexWhere((x) => x.startsWith(c.value));
        hit = want >= 0 && _rank(l.level) >= want;
      case 'message':
        hit = l.folded.contains(c.value);
      case 'is':
        hit = switch (c.value) {
          'crash' || 'cokme' || 'çökme' => l.isCrash,
          'error' || 'hata' => l.isError,
          'event' || 'olay' => l.isEvent,
          'native' => l.native,
          'flutter' => l.kind == 'flutter-error' || l.tag == 'flutter',
          _ => false,
        };
      default:
        hit = l.folded.contains(c.value) ||
            foldContains(l.tag ?? '', c.value) ||
            foldContains('${l.error?['message'] ?? ''}', c.value) ||
            foldContains('${l.error?['type'] ?? ''}', c.value);
    }
    if (hit == c.negate) return false;
  }
  return true;
}

bool callMatchesLogQuery(InspectorCall c, LogFilters f, List<QueryClause> q, {bool Function(String host)? isDefaultHost}) {
  if (!f.network || f.events || f.crashes) return false;
  // Only the default hosts (DurbunInspector.defaultHosts), as on Network.
  if (isDefaultHost != null && !isDefaultHost(hostOf(c))) return false;
  if (f.errorsOnly && !c.isFailure) return false;
  if (f.source == 'native' && !c.native) return false;
  if (f.source == 'flutter' && c.native) return false;
  for (final x in q) {
    if (x.key == 'tag' || x.key == 'level' || x.key == 'message') {
      if (!x.negate) return false;
      continue;
    }
    if (x.key == 'is' && x.value != 'network' && x.value != 'ag' && !x.negate) return false;
    if (x.key == null && !(urlContains(c.url, x.value) || foldText(c.method) == x.value) != x.negate) return false;
  }
  return true;
}

/// Logs (and requests) in time order, consecutive identical lines merged.
/// Entries with the same time keep their arrival order (the lines of one
/// multi-line `print` share a time; [List.sort] is not stable).
List<StreamItem> buildStream(DurbunInspectorStore store, LogFilters f, List<QueryClause> q) {
  final items = <StreamItem>[
    for (final l in store.logs)
      if (logMatches(l, f, q)) StreamItem.log(l),
    for (final c in store.calls)
      if (callMatchesLogQuery(c, f, q, isDefaultHost: store.isDefaultHost)) StreamItem.call(c),
  ]..sort((a, b) {
      final byTime = a.ts.compareTo(b.ts);
      return byTime != 0 ? byTime : a.seq.compareTo(b.seq);
    });
  final out = <StreamItem>[];
  for (final it in items) {
    final prev = out.isEmpty ? null : out.last;
    final a = prev?.log, b = it.log;
    if (a != null && b != null && a.level == b.level && a.tag == b.tag && a.message == b.message && a.data == null && b.data == null && !b.isEvent && !b.isCrash) {
      prev!.repeats++;
      continue;
    }
    out.add(it);
  }
  return out;
}

/// What the Logs page keeps for one store (one app run): its filters and
/// search, so closing and opening the panel does not lose them. Pause is
/// not kept: the panel opens live.
class _LogsMemory {
  final LogFilters filters = LogFilters();
  String query = '';
}

final Expando<_LogsMemory> _logsMemories = Expando<_LogsMemory>('durbun.logs');

class LogsView extends StatefulWidget {
  const LogsView({super.key, required this.store, this.initialErrorsOnly = false});

  final DurbunInspectorStore store;

  /// Turns "Errors only" on when the page opens.
  final bool initialErrorsOnly;

  @override
  State<LogsView> createState() => _LogsViewState();
}

class _LogsViewState extends State<LogsView> {
  late final _LogsMemory _memory = _logsMemories[widget.store] ??= _LogsMemory();
  LogFilters get _f => _memory.filters;
  late final TextEditingController _search = TextEditingController(text: _memory.query);
  late List<QueryClause> _q = parseQuery(_memory.query);
  bool _paused = false;

  @override
  void initState() {
    super.initState();
    if (widget.initialErrorsOnly) _f.errorsOnly = true;
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _setQuery(String v) {
    _memory.query = v;
    setState(() => _q = parseQuery(v));
  }

  void _applyTagAction(String action, String tag) {
    if (action == 'hide') {
      setState(() => _f.hiddenTags.add(tag));
    } else {
      _search.text = 'tag:$tag';
      _setQuery(_search.text);
    }
  }

  void _clearAll() {
    _search.clear();
    _memory.query = '';
    setState(() {
      _f.reset();
      _q = const <QueryClause>[];
    });
  }

  void _openFilters() {
    final t = InspectorStrings.of(context);
    showFilterSheet(
      context,
      title: t.logFilters,
      onChanged: () => setState(() {}),
      onReset: _f.reset,
      build: (context, changed) {
        final c = DurbunColors.of(context);
        return <Widget>[
          SheetSection(
            title: t.level,
            hint: t.levelHint,
            children: <Widget>[
              for (final l in kLevels.take(5))
                DToggle(
                  label: l == 'verbose' ? t.allLevels : t.levelAtLeast(t.levelName(l)),
                  color: l == 'verbose' ? null : c.level(l),
                  selected: _f.minLevel == l,
                  onTap: () {
                    _f.minLevel = l;
                    changed();
                  },
                ),
            ],
          ),
          SheetSection(
            title: t.source,
            children: <Widget>[
              for (final (v, label) in <(String, String)>[('all', t.allSources), ('flutter', t.flutterSource), ('native', t.nativeSource)])
                DToggle(
                  label: label,
                  selected: _f.source == v,
                  onTap: () {
                    _f.source = v;
                    changed();
                  },
                ),
            ],
          ),
          const SizedBox(height: 8),
          SheetSwitch(label: t.errorsOnly, hint: t.onlyErrorsHint, icon: Icons.warning_amber_rounded, value: _f.errorsOnly, onChanged: (v) {
            _f.errorsOnly = v;
            changed();
          }),
          SheetSwitch(label: t.crashes, hint: t.crashesHint, icon: Icons.bolt_rounded, value: _f.crashes, onChanged: (v) {
            _f.crashes = v;
            changed();
          }),
          SheetSwitch(label: t.events, hint: t.eventsHint, icon: Icons.outlined_flag_rounded, value: _f.events, onChanged: (v) {
            _f.events = v;
            changed();
          }),
          SheetSwitch(label: t.showRequests, hint: t.showRequestsHint, icon: Icons.swap_horiz_rounded, value: _f.network, onChanged: (v) {
            _f.network = v;
            changed();
          }),
          if (_f.hiddenTags.isNotEmpty)
            SheetSection(
              title: t.hiddenTagsTitle,
              hint: t.hiddenTagsHint,
              children: <Widget>[
                for (final tag in _f.hiddenTags.toList()..sort())
                  ActiveChip(label: tag, mono: true, color: c.tag(tag).$1, onRemove: () {
                    _f.hiddenTags.remove(tag);
                    changed();
                  }),
              ],
            ),
        ];
      },
    );
  }

  Future<void> _pickLevel(BuildContext anchor) async {
    final t = InspectorStrings.of(context);
    final c = DurbunColors.of(context);
    final box = anchor.findRenderObject() as RenderBox?;
    final overlay = Navigator.of(context).overlay?.context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;
    final at = box.localToGlobal(Offset(0, box.size.height + 4), ancestor: overlay);
    final picked = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(at.dx, at.dy, overlay.size.width - at.dx, 0),
      color: c.bgElevated,
      items: <PopupMenuEntry<String>>[
        for (final l in kLevels.take(5))
          PopupMenuItem<String>(
            value: l,
            height: 44,
            child: Row(children: <Widget>[
              Container(width: 8, height: 8, decoration: BoxDecoration(color: l == 'verbose' ? c.textSubtle : c.level(l), shape: BoxShape.circle)),
              const SizedBox(width: 10),
              Text(l == 'verbose' ? t.allLevels : t.levelAtLeast(t.levelName(l)),
                  style: TextStyle(fontSize: 14, color: c.text, fontWeight: _f.minLevel == l ? FontWeight.w600 : FontWeight.w400)),
            ]),
          ),
      ],
    );
    if (picked != null) setState(() => _f.minLevel = picked);
  }

  /// Filters button, level menu, then the active filters (each with an ×)
  /// so they are always in view, then quick toggles for the rest.
  List<Widget> _chips(InspectorStrings t, DurbunColors c) {
    final active = <Widget>[];
    final quick = <Widget>[];
    void toggle(String label, IconData icon, bool on, void Function(bool) set) => on
        ? active.add(ActiveChip(label: label, onRemove: () => setState(() => set(false))))
        : quick.add(DToggle(label: label, icon: icon, selected: false, onTap: () => setState(() => set(true))));
    toggle(t.errorsOnly, Icons.warning_amber_rounded, _f.errorsOnly, (v) => _f.errorsOnly = v);
    toggle(t.crashes, Icons.bolt_rounded, _f.crashes, (v) => _f.crashes = v);
    toggle(t.events, Icons.outlined_flag_rounded, _f.events, (v) => _f.events = v);
    if (_f.source != 'all') active.add(ActiveChip(label: _f.source == 'native' ? t.nativeSource : t.flutterSource, onRemove: () => setState(() => _f.source = 'all')));
    if (!_f.network) active.add(ActiveChip(label: t.requestsHidden, onRemove: () => setState(() => _f.network = true)));
    if (_f.hiddenTags.isNotEmpty) active.add(ActiveChip(label: t.hiddenTags(_f.hiddenTags.length), onRemove: () => setState(_f.hiddenTags.clear)));
    return <Widget>[
      FilterButton(count: _f.activeCount, onTap: _openFilters),
      Builder(
        builder: (anchor) => DToggle(
          label: '${_f.minLevel == 'verbose' ? t.level : t.levelAtLeast(t.levelName(_f.minLevel))} ▾',
          color: _f.minLevel == 'verbose' ? null : c.level(_f.minLevel),
          selected: _f.minLevel != 'verbose',
          onTap: () => _pickLevel(anchor),
        ),
      ),
      ...active,
      ...quick,
    ];
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return ActiveListenableBuilder(
      listenable: widget.store,
      builder: (context) {
        final items = buildStream(widget.store, _f, _q);
        final terms = freeTerms(_q);
        final nothing = widget.store.logs.isEmpty && widget.store.calls.isEmpty;
        return Column(
          children: <Widget>[
            Container(
              color: c.bgPanel,
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 0),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: DSearchField(
                      hint: t.logSearchHint,
                      controller: _search,
                      onChanged: _setQuery,
                      onHelp: () => showQueryHelp(context,
                          hints: <QueryHint>[for (final (k, v) in t.logQueryHints) QueryHint(k, v)], controller: _search, onChanged: _setQuery),
                    ),
                  ),
                  const SizedBox(width: 4),
                  DIconButton(
                    icon: _paused ? Icons.play_arrow_rounded : Icons.pause_rounded,
                    tooltip: _paused ? t.resume : t.pause,
                    active: _paused,
                    size: 40,
                    onTap: () => setState(() => _paused = !_paused),
                  ),
                ],
              ),
            ),
            FilterRow(children: _chips(t, c)),
            Divider(height: 1, color: c.border),
            Expanded(
              child: items.isEmpty
                  ? EmptyState(
                      icon: _f.errorsOnly || _f.crashes ? Icons.verified_outlined : Icons.notes_rounded,
                      title: nothing ? t.noLogsTitle : t.noMatchTitle,
                      body: nothing ? t.noLogsBody : t.noMatchBody,
                      actionLabel: nothing ? null : t.clearFilters,
                      onAction: nothing ? null : _clearAll,
                    )
                  : LiveList<StreamItem>(
                      items: items,
                      keyOf: (x) => x.key,
                      seqOf: (x) => x.seq,
                      paused: _paused,
                      filterKey: '${_f.signature}#${_search.text}',
                      epoch: widget.store.clears,
                      newText: t.newItems,
                      itemBuilder: (context, it) => it.call != null
                          ? _NetLogRow(call: it.call!, store: widget.store, terms: terms)
                          : LogRow(item: it, terms: terms, onTagAction: _applyTagAction, store: widget.store),
                    ),
            ),
            if (widget.store.droppedLogs > 0)
              Container(
                width: double.infinity,
                color: c.bgPanel,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: Text(t.dropped(widget.store.droppedLogs), style: TextStyle(fontSize: 11, color: c.textMeta)),
              ),
          ],
        );
      },
    );
  }
}

/// The start of a message for a row: a few lines, a few hundred characters.
/// A row shows three lines; laying out a whole logged HTML page for that
/// takes seconds on a phone.
String rowPreview(String message, {int maxLines = 4, int maxChars = 600}) {
  var end = message.length < maxChars ? message.length : maxChars;
  var nl = -1;
  for (var i = 0; i < maxLines; i++) {
    nl = message.indexOf('\n', nl + 1);
    if (nl < 0 || nl >= end) break;
    if (i == maxLines - 1) end = nl;
  }
  return end < message.length ? '${message.substring(0, end)}…' : message;
}

/// [text] in pieces of about [size] characters, cut at line ends where it
/// can, so a long message is laid out a screen at a time.
List<String> textChunks(String text, {int size = 2000}) {
  final out = <String>[];
  var at = 0;
  while (at < text.length) {
    var end = at + size >= text.length ? text.length : at + size;
    if (end < text.length) {
      final nl = text.lastIndexOf('\n', end);
      if (nl > at) end = nl + 1;
    }
    out.add(text.substring(at, end));
    at = end;
  }
  return out;
}

/// `{ key: value, key2: … }` preview of a log's data, one line.
String dataPreview(Object? data, {int max = 120}) {
  String one(Object? v) => switch (v) {
    null => 'null',
    final String s => '"${s.length > 40 ? '${s.substring(0, 40)}…' : s}"',
    final Map<Object?, Object?> m => '{${m.length}}',
    final List<Object?> l => '[${l.length}]',
    _ => '$v',
  };
  final String s;
  if (data is Map) {
    s = '{ ${data.entries.map((e) => '${e.key}: ${one(e.value)}').join(', ')} }';
  } else if (data is List) {
    s = '[ ${data.map(one).join(', ')} ]';
  } else {
    s = one(data);
  }
  return s.length > max ? '${s.substring(0, max)}…' : s;
}

class LogRow extends StatelessWidget {
  const LogRow({super.key, required this.item, this.terms = const <String>[], this.onTagAction, this.store});

  final StreamItem item;

  /// For the detail page's Share (app and device of the report, Slack).
  final DurbunInspectorStore? store;

  /// Folded free words of the search, marked in the message.
  final List<String> terms;
  final void Function(String action, String tag)? onTagAction;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final l = item.log!;
    final tint = l.isCrash ? c.lvFatalBg : c.levelBg(l.level);
    final mono = DurbunType.monoStyle(size: DurbunType.logFs, color: l.isError ? c.text : c.text, height: 1.4);
    final errorLine = l.error == null ? null : errorHead(l.error!);
    return Material(
      color: tint ?? Colors.transparent,
      child: InkWell(
        onTap: () async {
          // The keyboard would come back with the search field's focus.
          FocusManager.instance.primaryFocus?.unfocus();
          final action = await Navigator.of(context).push<(String, String)>(
            MaterialPageRoute<(String, String)>(builder: (routeContext) => DurbunTheme.wrap(routeContext, LogDetailPage(log: l, repeats: item.repeats, store: store))),
          );
          if (action != null) onTagAction?.call(action.$1, action.$2);
        },
        child: Container(
          // The 3 pt edge plus 9 puts the text on the toolbar's 12 pt line.
          padding: const EdgeInsets.fromLTRB(9, 8, 12, 8),
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(color: l.isCrash ? c.lvFatal : (tint != null ? c.level(l.level) : Colors.transparent), width: 3),
              bottom: BorderSide(color: c.hairline),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Wrap(
                spacing: 6,
                runSpacing: 3,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  Text(formatClock(l.ts), style: DurbunType.monoStyle(size: 11, color: c.textSubtle, height: 1.2)),
                  if (l.isEvent)
                    DBadge(t.event, tone: BadgeTone.accent, icon: Icons.outlined_flag_rounded)
                  else
                    LevelBadge(l.level),
                  if (l.tag != null) TagChip(l.tag!, maxWidth: 150),
                  if (l.isCrash) DBadge(t.crash, tone: BadgeTone.danger, icon: Icons.bolt_rounded),
                  if (l.kind == 'flutter-error') DBadge('Flutter', tone: BadgeTone.danger),
                  if (l.native) DBadge(t.native, icon: Icons.memory_rounded),
                  if (item.repeats > 1) DBadge('×${item.repeats}', tone: BadgeTone.info, mono: true),
                ],
              ),
              const SizedBox(height: 4),
              Text.rich(
                TextSpan(
                  children: <InlineSpan>[
                    highlightTerms(rowPreview(l.message), terms, l.isEvent ? mono.copyWith(fontWeight: FontWeight.w600) : mono, c.hlMark),
                    if (l.data != null) TextSpan(text: '  ${dataPreview(l.data)}', style: mono.copyWith(color: c.textMuted, fontSize: 11.5)),
                  ],
                ),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
              if (errorLine != null && errorLine.isNotEmpty && errorLine != l.message)
                Text(errorLine, maxLines: 2, overflow: TextOverflow.ellipsis, style: mono.copyWith(color: c.lvError, fontSize: 12)),
            ],
          ),
        ),
      ),
    );
  }
}

/// A request inside the log stream.
class _NetLogRow extends StatelessWidget {
  const _NetLogRow({required this.call, required this.store, this.terms = const <String>[]});

  final InspectorCall call;
  final DurbunInspectorStore store;
  final List<String> terms;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final uri = call.uri;
    final failed = call.error != null && !call.cancelled;
    final status = call.error != null ? (call.cancelled ? t.cancelledShort : t.failShort) : (call.status?.toString() ?? '···');
    final tint = switch (statusClass(call)) {
      '4xx' => c.lvWarnBg,
      '5xx' || 'fail' => c.lvErrorBg,
      _ => null,
    };
    return Material(
      color: tint ?? Colors.transparent,
      child: InkWell(
        onTap: () {
          FocusManager.instance.primaryFocus?.unfocus();
          Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (routeContext) => DurbunTheme.wrap(
                  routeContext, CallDetailPage(call: call, store: store))));
        },
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.hairline))),
          // Wraps instead of overflowing on narrow phones and large text.
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Wrap(
                spacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  Text(formatClock(call.ts), style: DurbunType.monoStyle(size: 11, color: c.textSubtle, height: 1.2)),
                  Icon(Icons.swap_vert_rounded, size: 15, color: c.textSubtle),
                  Text(call.method, style: DurbunType.monoStyle(size: 12, color: c.method(call.method), weight: FontWeight.w600, height: 1.3)),
                  StatusPill(text: status, color: call.cancelled ? c.textSubtle : c.status(call.status, failed: failed), width: null),
                  if (call.state != InspectorCallState.pending)
                    Text(formatDuration(call.duration), style: DurbunType.monoStyle(size: 11, color: c.textMeta, height: 1.3)),
                ],
              ),
              const SizedBox(height: 2),
              Text.rich(
                highlightTerms(decodeUrl(uri == null ? call.url : '${uri.host}${uri.path}'), terms,
                    DurbunType.monoStyle(size: 12, color: c.textMuted, height: 1.3), c.hlMark),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class LogDetailPage extends StatefulWidget {
  const LogDetailPage({super.key, required this.log, this.repeats = 1, this.store});

  final InspectorLog log;
  final int repeats;

  /// The store whose app and device the share report names (default: the
  /// SDK's store).
  final DurbunInspectorStore? store;

  @override
  State<LogDetailPage> createState() => _LogDetailPageState();
}

class _LogDetailPageState extends State<LogDetailPage> {
  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final l = widget.log;
    final store = widget.store ?? DurbunInspectorStore.existing;
    final e = l.error;
    final stack = e?['stack'] is String ? e!['stack'] as String : '';
    final head = e == null ? '' : errorHead(e);
    final hasData = l.data != null;
    final tabs = <String>[t.message, if (hasData) t.data, if (stack.isNotEmpty) t.stack];
    final pad = EdgeInsets.fromLTRB(16, 12, 16, 20 + MediaQuery.paddingOf(context).bottom);
    return Scaffold(
      backgroundColor: c.bgPanel,
      appBar: AppBar(
        backgroundColor: c.bgPanel,
        surfaceTintColor: Colors.transparent,
        foregroundColor: c.text,
        titleSpacing: 0,
        title: Row(
          children: <Widget>[
            if (l.isEvent) DBadge(t.event, tone: BadgeTone.accent, icon: Icons.outlined_flag_rounded) else LevelBadge(l.level),
            const SizedBox(width: 8),
            if (l.tag != null) Flexible(child: TagChip(l.tag!, maxWidth: 180)),
            if (l.isCrash) ...<Widget>[const SizedBox(width: 6), DBadge(t.crash, tone: BadgeTone.danger, icon: Icons.bolt_rounded)],
          ],
        ),
        actions: <Widget>[
          if (l.tag != null)
            SizedBox.square(
              dimension: kMinTapTarget,
              child: PopupMenuButton<String>(
                tooltip: t.tagActions,
                icon: Icon(Icons.filter_alt_outlined, size: 19, color: c.textMuted),
                onSelected: (a) => Navigator.of(context).pop((a, l.tag!)),
                itemBuilder: (_) => <PopupMenuEntry<String>>[
                  PopupMenuItem<String>(value: 'only', child: Text(t.onlyThisTag(l.tag!))),
                  PopupMenuItem<String>(value: 'hide', child: Text(t.hideThisTag(l.tag!))),
                ],
              ),
            ),
          DIconButton(icon: Icons.copy_rounded, tooltip: t.copy, size: kMinTapTarget, onTap: () => copyText(context, logAsText(l))),
          if (store != null)
            DIconButton(
                icon: Theme.of(context).platform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded,
                tooltip: t.shareLogTitle,
                size: kMinTapTarget,
                onTap: () => unawaited(showLogShareSheet(context, l, store))),
          const SizedBox(width: 6),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              <String>[
                formatClock(l.ts),
                if (l.isEvent) t.event else t.levelName(l.level),
                if (l.native) t.nativeLayer else 'Dart',
                if (l.kind != null && l.kind != 'text') switch (l.kind) { 'crash' => t.crash, 'flutter-error' => 'Flutter', final k => k! },
                if (widget.repeats > 1) t.repeated(widget.repeats),
              ].join(' · '),
              style: DurbunType.monoStyle(size: 11.5, color: c.textMeta),
            ),
          ),
          if (tabs.length > 1)
            Expanded(
              child: SwipeTabs(
                tabs: <DTab>[for (final name in tabs) DTab(name)],
                pages: <Widget>[for (final name in tabs) _body(name, l, head, stack, hasData, pad, c, t)],
              ),
            )
          else ...<Widget>[
            Divider(height: 1, color: c.border),
            Expanded(child: _body(tabs.first, l, head, stack, hasData, pad, c, t)),
          ],
        ],
      ),
    );
  }
  Widget _body(String name, InspectorLog l, String head, String stack, bool hasData, EdgeInsets pad, DurbunColors c, InspectorStrings t) {
    if (name == t.data) {
      if (l.data is Map || l.data is List) return JsonTreeView(value: l.data, padding: pad.copyWith(top: 4, left: 8));
      return swipeSafeSelection(ListView(padding: pad, children: <Widget>[Text(prettyValue(l.data), style: DurbunType.monoStyle(color: c.text))]));
    }
    if (name == t.stack) return swipeSafeSelection(ListView(padding: pad, children: <Widget>[StackTraceView(stack: stack)]));
    final msgStyle = DurbunType.monoStyle(size: 13, color: c.text, weight: l.isEvent ? FontWeight.w600 : null);
    // Plain text: a SelectableText takes horizontal drags and the tabs would
    // not swipe.
    return swipeSafeSelection(
      ListView(
        padding: pad,
        children: <Widget>[
        // Said first: the end of a long message is far down the page.
          if (l.cutChars > 0)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Callout(title: t.messageCut(l.cutChars)),
            ),
          for (final part in textChunks(l.message)) Text(part.endsWith('\n') ? part.substring(0, part.length - 1) : part, style: msgStyle),
          if (head.isNotEmpty && head != l.message) ...<Widget>[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: c.dangerSoft, borderRadius: BorderRadius.circular(DurbunRadius.md)),
              child: Text(head, style: DurbunType.monoStyle(size: 12.5, color: c.lvError)),
            ),
          ],
          if (stack.isNotEmpty) ...<Widget>[
            SectionTitle(t.stack),
            StackTraceView(stack: stack, maxFrames: 6),
          ],
          if (hasData) ...<Widget>[
            SectionTitle(t.data),
            Text(dataPreview(l.data, max: 600), style: DurbunType.monoStyle(size: 12, color: c.textMuted)),
          ],
        ],
      ),
    );
  }
}

/// Stack frames, app frames bright and framework / SDK frames dimmed.
class StackTraceView extends StatelessWidget {
  const StackTraceView({super.key, required this.stack, this.maxFrames});

  final String stack;
  final int? maxFrames;

  static bool isFrameworkFrame(String line) =>
      line.contains('package:flutter/') ||
      line.contains('dart:') ||
      line.contains('package:durbun/') ||
      line.contains('android.') ||
      line.contains('java.') ||
      line.contains('kotlin.') ||
      line.contains('libsystem') ||
      line.contains('UIKitCore') ||
      line.contains('CoreFoundation') ||
      line.contains('GraphicsServices');

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    var lines = stack.split('\n').where((l) => l.trim().isNotEmpty).toList();
    final more = maxFrames != null && lines.length > maxFrames! ? lines.length - maxFrames! : 0;
    if (more > 0) lines = lines.take(maxFrames!).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (final line in lines)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 1.5),
            child: Text(
              line.trim(),
              style: DurbunType.monoStyle(size: 11.5, color: isFrameworkFrame(line) ? c.textSubtle : c.text, height: 1.35),
            ),
          ),
        if (more > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(InspectorStrings.of(context).moreFrames(more), style: TextStyle(fontSize: 11.5, color: c.textMeta)),
          ),
      ],
    );
  }
}
