/// Logs view of the in-app inspector: the desktop's live log stream with
/// level toggles, quick filters, the query language, merged repeats,
/// network rows and a detail page.
library;

import 'package:flutter/material.dart';

import 'format.dart';
import 'json_tree.dart';
import 'live_list.dart';
import 'network_model.dart';
import 'network_view.dart' show CallDetailPage;
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// A row of the stream: a log line (with its repeat count) or a request.
class StreamItem {
  StreamItem.log(InspectorLog this.log) : call = null, ts = log.ts, key = 'l${log.seq}';
  StreamItem.call(InspectorCall this.call) : log = null, ts = call.ts, key = 'c${call.key}';

  final InspectorLog? log;
  final InspectorCall? call;
  final double ts;
  final String key;
  int repeats = 1;
}

const List<String> kLevels = <String>['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];

class LogFilters {
  final Set<String> levels = <String>{...kLevels};
  bool errorsOnly = false;
  bool crashes = false;
  bool network = true;
  bool flutterOnly = false;
  bool events = false;
  bool nativeOnly = false;
  final Set<String> hiddenTags = <String>{};
}

int _rank(String level) => kLevels.indexOf(level).clamp(0, 5);

bool logMatches(InspectorLog l, LogFilters f, List<QueryClause> q) {
  if (!f.levels.contains(l.level) && !l.isCrash && !l.isEvent) return false;
  if (f.errorsOnly && !l.isError) return false;
  if (f.crashes && !l.isCrash && l.kind != 'flutter-error') return false;
  if (f.events && !l.isEvent) return false;
  if (f.flutterOnly && l.native) return false;
  if (f.nativeOnly && !l.native) return false;
  if (l.tag != null && f.hiddenTags.contains(l.tag)) return false;
  for (final c in q) {
    final bool hit;
    switch (c.key) {
      case 'tag':
        hit = (l.tag?.toLowerCase() ?? '') == c.value || (l.tag?.toLowerCase().contains(c.value) ?? false);
      case 'level':
        final want = kLevels.indexWhere((x) => x.startsWith(c.value));
        hit = want >= 0 && _rank(l.level) >= want;
      case 'message':
        hit = l.message.toLowerCase().contains(c.value);
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
        hit = l.message.toLowerCase().contains(c.value) ||
            (l.tag?.toLowerCase().contains(c.value) ?? false) ||
            (l.error?['message']?.toString().toLowerCase().contains(c.value) ?? false) ||
            (l.error?['type']?.toString().toLowerCase().contains(c.value) ?? false);
    }
    if (hit == c.negate) return false;
  }
  return true;
}

bool callMatchesLogQuery(InspectorCall c, LogFilters f, List<QueryClause> q) {
  if (!f.network || f.events || f.crashes) return false;
  if (f.errorsOnly && !c.isFailure) return false;
  if (f.nativeOnly && !c.native) return false;
  if (f.flutterOnly && c.native) return false;
  for (final x in q) {
    if (x.key == 'tag' || x.key == 'level' || x.key == 'message') {
      if (!x.negate) return false;
      continue;
    }
    if (x.key == 'is' && x.value != 'network' && x.value != 'ag' && x.value != 'ağ' && !x.negate) return false;
    if (x.key == null && !(c.url.toLowerCase().contains(x.value) || c.method.toLowerCase() == x.value) != x.negate) return false;
  }
  return true;
}

/// Logs (and requests) in time order, consecutive identical lines merged.
List<StreamItem> buildStream(DurbunInspectorStore store, LogFilters f, List<QueryClause> q) {
  final items = <StreamItem>[
    for (final l in store.logs)
      if (logMatches(l, f, q)) StreamItem.log(l),
    for (final c in store.calls)
      if (callMatchesLogQuery(c, f, q)) StreamItem.call(c),
  ]..sort((a, b) => a.ts.compareTo(b.ts));
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

class LogsView extends StatefulWidget {
  const LogsView({super.key, required this.store, this.initialErrorsOnly = false});

  final DurbunInspectorStore store;
  final bool initialErrorsOnly;

  @override
  State<LogsView> createState() => _LogsViewState();
}

class _LogsViewState extends State<LogsView> {
  final LogFilters _f = LogFilters();
  final TextEditingController _search = TextEditingController();
  List<QueryClause> _q = const <QueryClause>[];
  bool _paused = false;

  @override
  void initState() {
    super.initState();
    _f.errorsOnly = widget.initialErrorsOnly;
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _setQuery(String v) => setState(() => _q = parseQuery(v));

  void _applyTagAction(String action, String tag) {
    if (action == 'hide') {
      setState(() => _f.hiddenTags.add(tag));
    } else {
      _search.text = 'tag:$tag';
      _setQuery(_search.text);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final items = buildStream(widget.store, _f, _q);
        final free = _q.where((x) => x.key == null && !x.negate).map((x) => x.value).firstOrNull ?? '';
        return Column(
          children: <Widget>[
            Container(
              color: c.bgPanel,
              padding: const EdgeInsets.fromLTRB(10, 8, 6, 0),
              child: Row(
                children: <Widget>[
                  Expanded(child: DSearchField(hint: t.logSearchHint, controller: _search, onChanged: _setQuery)),
                  DIconButton(
                    icon: _paused ? Icons.play_arrow_rounded : Icons.pause_rounded,
                    tooltip: _paused ? t.resume : t.pause,
                    active: _paused,
                    onTap: () => setState(() => _paused = !_paused),
                  ),
                ],
              ),
            ),
            Container(
              color: c.bgPanel,
              height: 44,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                children: <Widget>[
                  _LevelToggles(levels: _f.levels, onChanged: () => setState(() {})),
                  const SizedBox(width: 8),
                  for (final (label, icon, get, set) in <(String, IconData, bool Function(), void Function(bool))>[
                    (t.errorsOnly, Icons.warning_amber_rounded, () => _f.errorsOnly, (v) => _f.errorsOnly = v),
                    (t.crashes, Icons.bolt, () => _f.crashes, (v) => _f.crashes = v),
                    (t.network, Icons.swap_horiz, () => _f.network, (v) => _f.network = v),
                    (t.events, Icons.auto_awesome, () => _f.events, (v) => _f.events = v),
                    ('Flutter', Icons.flutter_dash, () => _f.flutterOnly, (v) => _f.flutterOnly = v),
                    (t.native, Icons.memory, () => _f.nativeOnly, (v) => _f.nativeOnly = v),
                  ]) ...<Widget>[
                    DToggle(label: label, icon: icon, selected: get(), onTap: () => setState(() => set(!get()))),
                    const SizedBox(width: 4),
                  ],
                  if (_f.hiddenTags.isNotEmpty)
                    DToggle(
                      label: t.hiddenTags(_f.hiddenTags.length),
                      icon: Icons.visibility_off_outlined,
                      selected: true,
                      onTap: () => setState(_f.hiddenTags.clear),
                    ),
                ],
              ),
            ),
            Divider(height: 1, color: c.border),
            Expanded(
              child: items.isEmpty
                  ? EmptyState(
                      icon: _f.errorsOnly || _f.crashes ? Icons.verified_outlined : Icons.notes,
                      title: widget.store.logs.isEmpty && widget.store.calls.isEmpty ? t.noLogsTitle : t.noMatchTitle,
                      body: widget.store.logs.isEmpty && widget.store.calls.isEmpty ? t.noLogsBody : t.noMatchBody,
                    )
                  : LiveList<StreamItem>(
                      items: items,
                      keyOf: (x) => x.key,
                      paused: _paused,
                      newText: t.newItems,
                      itemBuilder: (context, it) => it.call != null
                          ? _NetLogRow(call: it.call!, store: widget.store)
                          : LogRow(item: it, query: free, onTagAction: _applyTagAction),
                    ),
            ),
            if (widget.store.droppedLogs > 0)
              Container(
                width: double.infinity,
                color: c.bgPanel,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                child: Text(t.dropped(widget.store.droppedLogs), style: TextStyle(fontSize: 11, color: c.textMeta)),
              ),
          ],
        );
      },
    );
  }
}

class _LevelToggles extends StatelessWidget {
  const _LevelToggles({required this.levels, required this.onChanged});

  final Set<String> levels;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(color: c.bgSunken, borderRadius: BorderRadius.circular(DurbunRadius.md), border: Border.all(color: c.border)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final l in kLevels.take(5))
            GestureDetector(
              onTap: () {
                final on = levels.contains(l);
                if (on) {
                  levels.remove(l);
                  if (l == 'error') levels.remove('fatal');
                } else {
                  levels.add(l);
                  if (l == 'error') levels.add('fatal');
                }
                onChanged();
              },
              child: Container(
                width: 24,
                height: 22,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: levels.contains(l) ? c.level(l).withValues(alpha: 0.16) : Colors.transparent,
                  borderRadius: BorderRadius.circular(DurbunRadius.sm),
                ),
                child: Text(
                  LevelBadge.letter(l),
                  style: DurbunType.monoStyle(size: 11, weight: FontWeight.w700, color: levels.contains(l) ? c.level(l) : c.textSubtle, height: 1),
                ),
              ),
            ),
        ],
      ),
    );
  }
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
  const LogRow({super.key, required this.item, this.query = '', this.onTagAction});

  final StreamItem item;
  final String query;
  final void Function(String action, String tag)? onTagAction;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final l = item.log!;
    final tint = l.isCrash ? c.lvFatalBg : c.levelBg(l.level);
    final mono = DurbunType.monoStyle(size: DurbunType.logFs, color: l.isError ? c.text : c.text, height: 1.4);
    final errorLine = l.error == null ? null : <String?>[l.error!['type'] as String?, l.error!['message'] as String?].whereType<String>().join(': ');
    return Material(
      color: tint ?? Colors.transparent,
      child: InkWell(
        onTap: () async {
          final action = await Navigator.of(context).push<(String, String)>(
            MaterialPageRoute<(String, String)>(builder: (_) => DurbunTheme.wrap(context, LogDetailPage(log: l, repeats: item.repeats))),
          );
          if (action != null) onTagAction?.call(action.$1, action.$2);
        },
        child: Container(
          padding: const EdgeInsets.fromLTRB(10, 5, 10, 5),
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(color: l.isCrash ? c.lvFatal : (tint != null ? c.level(l.level) : Colors.transparent), width: 2),
              bottom: BorderSide(color: c.border.withValues(alpha: 0.45)),
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
                    DBadge(t.event, tone: BadgeTone.accent, icon: Icons.auto_awesome)
                  else
                    LevelBadge(l.level),
                  if (l.tag != null) TagChip(l.tag!, maxWidth: 150),
                  if (l.isCrash) DBadge(t.crash, tone: BadgeTone.danger, icon: Icons.bolt),
                  if (l.kind == 'flutter-error') DBadge('Flutter', tone: BadgeTone.danger),
                  if (l.native) DBadge(t.native, icon: Icons.memory),
                  if (item.repeats > 1) DBadge('×${item.repeats}', tone: BadgeTone.info, mono: true),
                ],
              ),
              const SizedBox(height: 3),
              Text.rich(
                TextSpan(
                  children: <InlineSpan>[
                    highlightSpan(l.message, query, l.isEvent ? mono.copyWith(fontWeight: FontWeight.w700) : mono, c.hlMark),
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
  const _NetLogRow({required this.call, required this.store});

  final InspectorCall call;
  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final uri = call.uri;
    final failed = call.error != null && !call.cancelled;
    final status = call.error != null ? (call.cancelled ? t.cancelledShort : 'FAIL') : (call.status?.toString() ?? '···');
    final tint = switch (statusClass(call)) {
      '4xx' => c.lvWarnBg,
      '5xx' || 'fail' => c.lvErrorBg,
      _ => null,
    };
    return Material(
      color: tint ?? Colors.transparent,
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => DurbunTheme.wrap(context, CallDetailPage(call: call, store: store))),
        ),
        child: Container(
          padding: const EdgeInsets.fromLTRB(10, 5, 10, 5),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.border.withValues(alpha: 0.45)))),
          // Wraps instead of overflowing on narrow phones and large text.
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Wrap(
                spacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  Text(formatClock(call.ts), style: DurbunType.monoStyle(size: 11, color: c.textSubtle, height: 1.2)),
                  Icon(Icons.swap_horiz, size: 15, color: c.textSubtle),
                  Text(call.method, style: DurbunType.monoStyle(size: 12, color: c.method(call.method), weight: FontWeight.w600, height: 1.3)),
                  Text(status, style: DurbunType.monoStyle(size: 12, color: call.cancelled ? c.textSubtle : c.status(call.status, failed: failed), weight: FontWeight.w700, height: 1.3)),
                  if (call.state != InspectorCallState.pending)
                    Text(formatDuration(call.duration), style: DurbunType.monoStyle(size: 11, color: c.textMeta, height: 1.3)),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                '${uri?.host ?? ''}${uri?.path ?? call.url}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DurbunType.monoStyle(size: 12, color: c.textMuted, height: 1.3),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class LogDetailPage extends StatefulWidget {
  const LogDetailPage({super.key, required this.log, this.repeats = 1});

  final InspectorLog log;
  final int repeats;

  @override
  State<LogDetailPage> createState() => _LogDetailPageState();
}

class _LogDetailPageState extends State<LogDetailPage> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final l = widget.log;
    final e = l.error;
    final stack = e?['stack'] is String ? e!['stack'] as String : '';
    final head = e == null ? '' : <String?>[e['type'] as String?, e['message'] as String?].whereType<String>().join(': ');
    final hasData = l.data != null;
    final tabs = <String>[t.message, if (hasData) t.data, if (stack.isNotEmpty) t.stack];
    final tab = _tab.clamp(0, tabs.length - 1);
    final pad = EdgeInsets.fromLTRB(14, 12, 14, 20 + MediaQuery.paddingOf(context).bottom);
    return Scaffold(
      backgroundColor: c.bgPanel,
      appBar: AppBar(
        backgroundColor: c.bgPanel,
        surfaceTintColor: Colors.transparent,
        foregroundColor: c.text,
        titleSpacing: 0,
        title: Row(
          children: <Widget>[
            if (l.isEvent) DBadge(t.event, tone: BadgeTone.accent, icon: Icons.auto_awesome) else LevelBadge(l.level),
            const SizedBox(width: 8),
            if (l.tag != null) Flexible(child: TagChip(l.tag!, maxWidth: 180)),
            if (l.isCrash) ...<Widget>[const SizedBox(width: 6), DBadge(t.crash, tone: BadgeTone.danger, icon: Icons.bolt)],
          ],
        ),
        actions: <Widget>[
          if (l.tag != null)
            PopupMenuButton<String>(
              tooltip: t.tagActions,
              icon: Icon(Icons.filter_alt_outlined, size: 19, color: c.textMuted),
              onSelected: (a) => Navigator.of(context).pop((a, l.tag!)),
              itemBuilder: (_) => <PopupMenuEntry<String>>[
                PopupMenuItem<String>(value: 'only', child: Text(t.onlyThisTag(l.tag!))),
                PopupMenuItem<String>(value: 'hide', child: Text(t.hideThisTag(l.tag!))),
              ],
            ),
          DIconButton(icon: Icons.copy_rounded, tooltip: t.copy, onTap: () => copyText(context, logAsText(l))),
          const SizedBox(width: 6),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
            child: Text(
              <String>[
                formatClock(l.ts),
                if (l.isEvent) t.event else l.level,
                if (l.native) t.nativeLayer else 'Dart',
                if (l.kind != null && l.kind != 'text') l.kind!,
                if (widget.repeats > 1) t.repeated(widget.repeats),
              ].join(' · '),
              style: DurbunType.monoStyle(size: 11.5, color: c.textMeta),
            ),
          ),
          if (tabs.length > 1) DTabs(labels: tabs, index: tab, onChanged: (i) => setState(() => _tab = i)) else Divider(height: 1, color: c.border),
          Expanded(child: _body(tabs[tab], l, head, stack, hasData, pad, c, t)),
        ],
      ),
    );
  }
  Widget _body(String name, InspectorLog l, String head, String stack, bool hasData, EdgeInsets pad, DurbunColors c, InspectorStrings t) {
    if (name == t.data) {
      if (l.data is Map || l.data is List) return JsonTreeView(value: l.data, padding: pad.copyWith(top: 4, left: 8));
      return ListView(padding: pad, children: <Widget>[SelectableText(prettyValue(l.data), style: DurbunType.monoStyle(color: c.text))]);
    }
    if (name == t.stack) return ListView(padding: pad, children: <Widget>[StackTraceView(stack: stack)]);
    return ListView(
      padding: pad,
      children: <Widget>[
        SelectableText(l.message, style: DurbunType.monoStyle(size: 13, color: c.text, weight: l.isEvent ? FontWeight.w700 : null)),
        if (head.isNotEmpty && head != l.message) ...<Widget>[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: c.dangerSoft, borderRadius: BorderRadius.circular(DurbunRadius.md)),
            child: SelectableText(head, style: DurbunType.monoStyle(size: 12.5, color: c.lvError)),
          ),
        ],
        if (stack.isNotEmpty) ...<Widget>[
          SectionTitle(t.stack),
          StackTraceView(stack: stack, maxFrames: 6),
        ],
        if (hasData) ...<Widget>[
          SectionTitle(t.data),
          SelectableText(dataPreview(l.data, max: 600), style: DurbunType.monoStyle(size: 12, color: c.textMuted)),
        ],
      ],
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
            child: SelectableText(
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
