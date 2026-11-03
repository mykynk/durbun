/// Pages of the in-app inspector panel.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../flutter/durbun.dart' show Durbun, durbunInspectorState;
import 'format.dart';
import 'store.dart';
import 'strings.dart';

const Color _accent = Color(0xFF6E5CF0);
const Color _ok = Color(0xFF2E9E5B);
const Color _redirect = Color(0xFF3B82F6);
const Color _warn = Color(0xFFD98A1A);
const Color _bad = Color(0xFFE5484D);
const Color _muted = Color(0xFF8A8F98);
const TextStyle _mono =
    TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.35);

/// Page padding that keeps the last line above the home indicator (an
/// explicit ListView padding drops the safe area).
EdgeInsets _pagePadding(BuildContext context) =>
    EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.paddingOf(context).bottom);

/// Longest text shown in one body view; the rest goes through "Copy".
const int _maxShownChars = 200 * 1024;

ThemeData _panelTheme(BuildContext context) {
  final brightness =
      MediaQuery.maybePlatformBrightnessOf(context) ?? Brightness.light;
  return ThemeData(
    useMaterial3: true,
    colorScheme:
        ColorScheme.fromSeed(seedColor: _accent, brightness: brightness),
    visualDensity: VisualDensity.compact,
  );
}

Color statusColor(InspectorCall c) {
  if (c.state == InspectorCallState.failed) return c.cancelled ? _muted : _bad;
  final s = c.status;
  if (s == null) return _muted;
  if (s >= 500) return _bad;
  if (s >= 400) return _warn;
  if (s >= 300) return _redirect;
  return _ok;
}

Color levelColor(String level) => switch (level) {
      'fatal' || 'error' => _bad,
      'warn' => _warn,
      'info' => _redirect,
      'debug' => _ok,
      _ => _muted,
    };

void _copy(BuildContext context, String text) {
  Clipboard.setData(ClipboardData(text: text));
  final messenger = ScaffoldMessenger.maybeOf(context);
  messenger?.hideCurrentSnackBar();
  messenger?.showSnackBar(
    SnackBar(
        content: Text(InspectorStrings.of(context).copied),
        duration: const Duration(seconds: 1)),
  );
}

/// The panel: tabs for network, logs, errors, performance and info.
class InspectorHome extends StatelessWidget {
  const InspectorHome({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return Theme(
      data: _panelTheme(context),
      child: Builder(
        builder: (context) => DefaultTabController(
          length: 5,
          child: Scaffold(
            appBar: AppBar(
              title: Text(t.title),
              actions: <Widget>[
                IconButton(
                  tooltip: t.clear,
                  icon: const Icon(Icons.delete_sweep_outlined),
                  onPressed: store.clear,
                ),
                IconButton(
                  tooltip: t.close,
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
              ],
              bottom: TabBar(
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                tabs: <Widget>[
                  ListenableBuilder(
                    listenable: store,
                    builder: (_, __) =>
                        Tab(text: '${t.network} · ${store.calls.length}'),
                  ),
                  Tab(text: t.logs),
                  ListenableBuilder(
                    listenable: store,
                    builder: (_, __) => Tab(
                      text: store.errorCount == 0
                          ? t.errors
                          : '${t.errors} · ${store.errorCount}',
                    ),
                  ),
                  Tab(text: t.performance),
                  Tab(text: t.info),
                ],
              ),
            ),
            body: TabBarView(
              children: <Widget>[
                NetworkTab(store: store),
                LogsTab(store: store),
                LogsTab(store: store, errorsOnly: true),
                PerformanceTab(store: store),
                InfoTab(store: store),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SearchBar extends StatelessWidget {
  const _SearchBar({required this.onChanged, required this.filters});

  final ValueChanged<String> onChanged;
  final List<Widget> filters;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Column(
        children: <Widget>[
          TextField(
            onChanged: onChanged,
            decoration: InputDecoration(
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 20),
              hintText: t.search,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 6),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: <Widget>[
              for (final f in filters)
                Padding(padding: const EdgeInsets.only(right: 6), child: f)
            ]),
          ),
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(text,
              textAlign: TextAlign.center,
              style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ),
      );
}

class _DroppedNote extends StatelessWidget {
  const _DroppedNote(this.count);

  final int count;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Text(
          InspectorStrings.of(context).dropped(count),
          style: TextStyle(
              fontSize: 12,
              color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      );
}

/* ───────────────────────────── network ───────────────────────────── */

class NetworkTab extends StatefulWidget {
  const NetworkTab({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  State<NetworkTab> createState() => _NetworkTabState();
}

class _NetworkTabState extends State<NetworkTab> {
  String _query = '';
  bool _onlyFailures = false;

  bool _matches(InspectorCall c) {
    if (_onlyFailures && !c.isFailure) return false;
    if (_query.isEmpty) return true;
    final q = _query.toLowerCase();
    return c.url.toLowerCase().contains(q) ||
        c.method.toLowerCase() == q ||
        '${c.status ?? ''}'.startsWith(q) ||
        c.source.toLowerCase().contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return Column(
      children: <Widget>[
        _SearchBar(
          onChanged: (v) => setState(() => _query = v.trim()),
          filters: <Widget>[
            FilterChip(
              label: Text(t.onlyFailures),
              selected: _onlyFailures,
              onSelected: (v) => setState(() => _onlyFailures = v),
            ),
          ],
        ),
        Expanded(
          child: ListenableBuilder(
            listenable: widget.store,
            builder: (context, _) {
              final calls =
                  widget.store.calls.reversed.where(_matches).toList();
              final filtered = _query.isNotEmpty || _onlyFailures;
              if (calls.isEmpty) return _Empty(t.noRequests(filtered));
              final dropped = widget.store.droppedCalls;
              return ListView.separated(
                itemCount: calls.length + (dropped > 0 ? 1 : 0),
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (context, i) => i == calls.length
                    ? _DroppedNote(dropped)
                    : CallTile(call: calls[i], store: widget.store),
              );
            },
          ),
        ),
      ],
    );
  }
}

class CallTile extends StatelessWidget {
  const CallTile({super.key, required this.call, required this.store});

  final InspectorCall call;
  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final uri = call.uri;
    final path = uri == null
        ? call.url
        : (uri.path.isEmpty ? '/' : uri.path) +
            (uri.hasQuery ? '?${uri.query}' : '');
    final color = statusColor(call);
    final badge = call.error != null
        ? (call.cancelled ? '—' : 'ERR')
        : call.status?.toString() ?? '…';
    final size = call.responseBody?.size;
    final meta = <String>[
      if (uri != null && uri.host.isNotEmpty) uri.host,
      call.source,
      formatDuration(call.duration),
      if (size != null) formatBytes(size),
      formatClock(call.ts),
    ].join(' · ');
    return InkWell(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => Theme(
              data: Theme.of(context),
              child: CallDetailPage(call: call, store: store)),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Container(
              width: 44,
              padding: const EdgeInsets.symmetric(vertical: 3),
              decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4)),
              alignment: Alignment.center,
              child: Text(badge,
                  style: TextStyle(
                      color: color, fontWeight: FontWeight.w700, fontSize: 12)),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text.rich(
                    TextSpan(
                      children: <InlineSpan>[
                        TextSpan(
                            text: '${call.method} ',
                            style:
                                const TextStyle(fontWeight: FontWeight.w700)),
                        TextSpan(text: path),
                      ],
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13.5),
                  ),
                  const SizedBox(height: 2),
                  Text(meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 11.5,
                          color:
                              Theme.of(context).colorScheme.onSurfaceVariant)),
                ],
              ),
            ),
            if (call.mocked) ...<Widget>[
              const SizedBox(width: 6),
              _Chip(t.mocked, _accent),
            ],
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.text, this.color);

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(
            border: Border.all(color: color),
            borderRadius: BorderRadius.circular(4)),
        child: Text(text,
            style: TextStyle(
                fontSize: 10.5, color: color, fontWeight: FontWeight.w600)),
      );
}

class CallDetailPage extends StatelessWidget {
  const CallDetailPage({super.key, required this.call, required this.store});

  final InspectorCall call;
  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final uri = call.uri;
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text('${call.method} ${uri?.path ?? call.url}',
              maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: <Widget>[
            IconButton(
                tooltip: t.copyCurl,
                icon: const Icon(Icons.terminal),
                onPressed: () => _copy(context, curlFor(call))),
            IconButton(
                tooltip: t.copyAll,
                icon: const Icon(Icons.copy_all),
                onPressed: () => _copy(context, callAsText(call))),
          ],
          bottom: TabBar(tabs: <Widget>[
            Tab(text: t.summary),
            Tab(text: t.request),
            Tab(text: t.response)
          ]),
        ),
        body: ListenableBuilder(
          listenable: store,
          builder: (context, _) => TabBarView(
            children: <Widget>[
              _CallSummary(call: call),
              _HttpPart(
                  headers: call.requestHeaders,
                  body: call.requestBody,
                  hasBody: call.hasRequestBody,
                  contentType: call.requestContentType,
                  call: call),
              call.state == InspectorCallState.pending
                  ? _Empty(t.waiting)
                  : call.error != null
                      ? _ErrorView(call: call)
                      : _HttpPart(
                          headers: call.responseHeaders,
                          body: call.responseBody,
                          hasBody: call.hasResponseBody,
                          contentType: call.responseContentType,
                          call: call),
            ],
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value, {this.color});

  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            SizedBox(
              width: 130,
              child: Text(label,
                  style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                      fontSize: 13)),
            ),
            Expanded(
                child: SelectableText(value,
                    style: TextStyle(fontSize: 13, color: color))),
          ],
        ),
      );
}

class _CallSummary extends StatelessWidget {
  const _CallSummary({required this.call});

  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final status = call.error != null
        ? call.error!
        : call.status == null
            ? '…'
            : '${call.status} ${call.statusText ?? ''}'.trim();
    final timings = call.timings;
    return ListView(
      padding: _pagePadding(context),
      children: <Widget>[
        SelectableText(call.url, style: _mono),
        const SizedBox(height: 12),
        _Row(t.status, status, color: statusColor(call)),
        _Row(t.duration, formatDuration(call.duration)),
        _Row(t.time, formatClock(call.ts)),
        _Row(t.source,
            call.native ? '${call.source} (${t.native})' : call.source),
        if (call.mocked) _Row(t.mocked, call.mockRuleId ?? '✓', color: _accent),
        if (call.protocol != null) _Row(t.protocol, call.protocol!),
        if (call.remoteAddress != null)
          _Row(t.remoteAddress, call.remoteAddress!),
        if (call.requestBody != null)
          _Row('${t.request} · ${t.size}', formatBytes(call.requestBody!.size)),
        if (call.responseBody != null)
          _Row('${t.response} · ${t.size}',
              formatBytes(call.responseBody!.size)),
        if (timings != null)
          for (final e in timings.entries)
            if (e.value is num) _Row(e.key, '${(e.value as num).round()} ms'),
        if (call.bodiesDropped) ...<Widget>[
          const SizedBox(height: 8),
          Text(t.bodiesDropped)
        ],
      ],
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.call});

  final InspectorCall call;

  @override
  Widget build(BuildContext context) => ListView(
        padding: _pagePadding(context),
        children: <Widget>[
          SelectableText(call.error ?? '', style: _mono.copyWith(color: _bad))
        ],
      );
}

class _HttpPart extends StatelessWidget {
  const _HttpPart(
      {required this.headers,
      required this.body,
      required this.hasBody,
      required this.contentType,
      required this.call});

  final List<List<String>> headers;
  final InspectorBody? body;
  final bool hasBody;
  final String? contentType;
  final InspectorCall call;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return ListView(
      padding: _pagePadding(context),
      children: <Widget>[
        Text(t.headers, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 6),
        if (headers.isEmpty)
          Text(t.noHeaders, style: TextStyle(color: scheme.onSurfaceVariant)),
        for (final h in headers)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: SelectableText.rich(
              TextSpan(
                style: _mono,
                children: <InlineSpan>[
                  TextSpan(
                      text: '${h[0]}: ',
                      style: TextStyle(
                          color: scheme.primary, fontWeight: FontWeight.w600)),
                  TextSpan(text: h[1]),
                ],
              ),
            ),
          ),
        const SizedBox(height: 16),
        Row(
          children: <Widget>[
            Expanded(
                child: Text(t.body,
                    style: Theme.of(context).textTheme.titleSmall)),
            if (body != null && body!.isText && body!.data.isNotEmpty)
              TextButton.icon(
                onPressed: () =>
                    _copy(context, prettyJsonText(body!.data) ?? body!.data),
                icon: const Icon(Icons.copy, size: 16),
                label: Text(t.copy),
              ),
          ],
        ),
        const SizedBox(height: 6),
        BodyView(
            body: body,
            hasBody: hasBody,
            contentType: contentType,
            dropped: call.bodiesDropped),
      ],
    );
  }
}

/// A body as pretty JSON, text, an image preview or a binary note.
class BodyView extends StatelessWidget {
  const BodyView(
      {super.key,
      required this.body,
      required this.hasBody,
      this.contentType,
      this.dropped = false});

  final InspectorBody? body;
  final bool hasBody;
  final String? contentType;
  final bool dropped;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final muted =
        TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant);
    final b = body;
    if (b == null) {
      return Text(dropped ? t.bodiesDropped : t.noBody, style: muted);
    }
    final notes = <Widget>[
      if (b.truncated && b.data.isNotEmpty)
        Text(t.truncated(formatBytes(b.size)), style: muted),
    ];
    if (b.data.isEmpty) {
      return Text(b.size > 0 ? t.bodyNotCaptured : t.noBody, style: muted);
    }
    if (!b.isText) {
      final isImage = (contentType ?? '').toLowerCase().startsWith('image/');
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(t.binary(formatBytes(b.size)), style: muted),
          if (isImage && !b.truncated) ...<Widget>[
            const SizedBox(height: 8),
            Text(t.imagePreview, style: muted),
            const SizedBox(height: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 320),
              child: Image.memory(b.bytes,
                  errorBuilder: (_, __, ___) => const SizedBox.shrink()),
            ),
          ],
          ...notes,
        ],
      );
    }
    var text = b.displayText ?? b.data;
    final cut = text.length > _maxShownChars;
    if (cut) text = text.substring(0, _maxShownChars);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        ...notes,
        SelectableText(text, style: _mono),
        if (cut) Text(t.truncated(formatBytes(b.size)), style: muted),
      ],
    );
  }
}

/* ───────────────────────────── logs ───────────────────────────── */

enum _LevelFilter { all, warn, error }

const Map<String, int> _levelRank = <String, int>{
  'verbose': 0,
  'debug': 1,
  'info': 2,
  'warn': 3,
  'error': 4,
  'fatal': 5,
};

class LogsTab extends StatefulWidget {
  const LogsTab({super.key, required this.store, this.errorsOnly = false});

  final DurbunInspectorStore store;
  final bool errorsOnly;

  @override
  State<LogsTab> createState() => _LogsTabState();
}

class _LogsTabState extends State<LogsTab> {
  String _query = '';
  _LevelFilter _level = _LevelFilter.all;

  @override
  void initState() {
    super.initState();
    if (widget.errorsOnly) widget.store.markSeen();
  }

  bool _matches(InspectorLog l) {
    if (widget.errorsOnly && !l.isError) return false;
    final rank = _levelRank[l.level] ?? 2;
    if (_level == _LevelFilter.warn && rank < 3 && !l.isCrash) return false;
    if (_level == _LevelFilter.error && !l.isError) return false;
    if (_query.isEmpty) return true;
    final q = _query.toLowerCase();
    return l.message.toLowerCase().contains(q) ||
        (l.tag?.toLowerCase().contains(q) ?? false) ||
        (l.error?['message']?.toString().toLowerCase().contains(q) ?? false);
  }

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return Column(
      children: <Widget>[
        _SearchBar(
          onChanged: (v) => setState(() => _query = v.trim()),
          filters: widget.errorsOnly
              ? const <Widget>[]
              : <Widget>[
                  for (final (f, label) in <(_LevelFilter, String)>[
                    (_LevelFilter.all, t.all),
                    (_LevelFilter.warn, t.warnAndUp),
                    (_LevelFilter.error, t.errorAndUp),
                  ])
                    ChoiceChip(
                        label: Text(label),
                        selected: _level == f,
                        onSelected: (_) => setState(() => _level = f)),
                ],
        ),
        Expanded(
          child: ListenableBuilder(
            listenable: widget.store,
            builder: (context, _) {
              final logs = widget.store.logs.reversed.where(_matches).toList();
              if (logs.isEmpty) {
                return _Empty(widget.errorsOnly
                    ? t.noErrors
                    : t.noLogs(
                        _query.isNotEmpty || _level != _LevelFilter.all));
              }
              final dropped = widget.store.droppedLogs;
              return ListView.separated(
                itemCount: logs.length + (dropped > 0 ? 1 : 0),
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (context, i) => i == logs.length
                    ? _DroppedNote(dropped)
                    : LogTile(log: logs[i]),
              );
            },
          ),
        ),
      ],
    );
  }
}

class LogTile extends StatelessWidget {
  const LogTile({super.key, required this.log});

  final InspectorLog log;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final color = log.isCrash ? _bad : levelColor(log.level);
    final scheme = Theme.of(context).colorScheme;
    final errorLine = log.error == null
        ? null
        : [log.error!['type'], log.error!['message']]
            .whereType<String>()
            .join(': ');
    return InkWell(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
            builder: (_) =>
                Theme(data: Theme.of(context), child: LogDetailPage(log: log))),
      ),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Container(width: 3, color: color),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 6, 12, 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Text(formatClock(log.ts),
                            style: TextStyle(
                                fontSize: 11, color: scheme.onSurfaceVariant)),
                        const SizedBox(width: 6),
                        Text(log.isEvent ? t.event : log.level.toUpperCase(),
                            style: TextStyle(
                                fontSize: 11,
                                color: color,
                                fontWeight: FontWeight.w700)),
                        if (log.tag != null) ...<Widget>[
                          const SizedBox(width: 6),
                          Flexible(
                              child: Text(log.tag!,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      fontSize: 11, color: scheme.primary))),
                        ],
                        if (log.isCrash) ...<Widget>[
                          const SizedBox(width: 6),
                          _Chip(t.crash, _bad)
                        ],
                        if (log.native) ...<Widget>[
                          const SizedBox(width: 6),
                          _Chip(t.native, _muted)
                        ],
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(log.message,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13)),
                    if (errorLine != null &&
                        errorLine.isNotEmpty &&
                        errorLine != log.message)
                      Text(errorLine,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: _bad)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class LogDetailPage extends StatelessWidget {
  const LogDetailPage({super.key, required this.log});

  final InspectorLog log;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    final e = log.error;
    final stack = e?['stack'];
    final errorHead = e == null
        ? ''
        : [e['type'], e['message']].whereType<String>().join(': ');
    return Scaffold(
      appBar: AppBar(
        title:
            Text(log.isEvent ? t.event : (log.tag ?? log.level.toUpperCase())),
        actions: <Widget>[
          IconButton(
              tooltip: t.copy,
              icon: const Icon(Icons.copy_all),
              onPressed: () => _copy(context, logAsText(log))),
        ],
      ),
      body: ListView(
        padding: _pagePadding(context),
        children: <Widget>[
          _Row(t.time, formatClock(log.ts)),
          _Row(t.status, log.isEvent ? t.event : log.level.toUpperCase(),
              color: levelColor(log.level)),
          if (log.native) _Row(t.source, t.native),
          const SizedBox(height: 8),
          SelectableText(log.message, style: _mono),
          if (log.data != null) ...<Widget>[
            const SizedBox(height: 16),
            Text(t.data, style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 6),
            SelectableText(prettyValue(log.data), style: _mono),
          ],
          if (errorHead.isNotEmpty) ...<Widget>[
            const SizedBox(height: 16),
            SelectableText(errorHead, style: _mono.copyWith(color: _bad)),
          ],
          if (stack is String && stack.isNotEmpty) ...<Widget>[
            const SizedBox(height: 16),
            Text(t.stack, style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 6),
            SelectableText(stack, style: _mono.copyWith(fontSize: 11.5)),
          ],
        ],
      ),
    );
  }
}

/* ───────────────────────────── performance ───────────────────────────── */

class PerformanceTab extends StatelessWidget {
  const PerformanceTab({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final m = store.lastMetric;
        if (m == null) return _Empty(t.noMetrics);
        String ms(double? v) => v == null ? '—' : '${v.toStringAsFixed(1)} ms';
        String mb(double? v) => v == null ? '—' : '${v.toStringAsFixed(0)} MB';
        final fpsSeries = <double>[
          for (final s in store.metrics)
            if (s.fps != null) s.fps!
        ];
        return ListView(
          padding: _pagePadding(context),
          children: <Widget>[
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: <Widget>[
                _Tile(t.fps, m.fps?.toStringAsFixed(0) ?? '—',
                    color: m.fps == null
                        ? null
                        : (m.fps! >= 55
                            ? _ok
                            : m.fps! >= 40
                                ? _warn
                                : _bad)),
                _Tile(t.jank, '${m.jankyFrames ?? '—'}',
                    color: (m.jankyFrames ?? 0) > 0 ? _warn : null),
                _Tile(t.build, ms(m.frameBuildMs)),
                _Tile(t.raster, ms(m.frameRasterMs)),
                _Tile(t.memory, mb(m.memoryMB)),
                _Tile(t.heap, mb(m.heapMB)),
                if (m.cpu != null)
                  _Tile(t.cpu, '${m.cpu!.toStringAsFixed(0)}%'),
                if (m.threads != null) _Tile(t.threads, '${m.threads}'),
              ],
            ),
            if (fpsSeries.length >= 2) ...<Widget>[
              const SizedBox(height: 20),
              Text('${t.fps} · ${fpsSeries.length} s',
                  style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 8),
              SizedBox(
                height: 90,
                child: CustomPaint(
                  painter: _Sparkline(
                      fpsSeries, Theme.of(context).colorScheme.primary),
                  size: Size.infinite,
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile(this.label, this.value, {this.color});

  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 150,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label,
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
          const SizedBox(height: 4),
          Text(value,
              style: TextStyle(
                  fontSize: 20, fontWeight: FontWeight.w600, color: color)),
        ],
      ),
    );
  }
}

class _Sparkline extends CustomPainter {
  _Sparkline(this.values, this.color);

  final List<double> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final top = math.max(60.0, values.reduce(math.max));
    final path = Path();
    for (var i = 0; i < values.length; i++) {
      final x = size.width * i / (values.length - 1);
      final y = size.height * (1 - values[i] / top);
      i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    canvas.drawPath(
        path,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2);
  }

  @override
  bool shouldRepaint(_Sparkline old) =>
      old.values != values || old.color != color;
}

/* ───────────────────────────── info ───────────────────────────── */

class InfoTab extends StatelessWidget {
  const InfoTab({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final t = InspectorStrings.of(context);
    return StreamBuilder<Object?>(
      stream: Durbun.connection,
      builder: (context, _) => ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final state = durbunInspectorState();
          final hello = (state?['hello'] as Map?) ?? store.hello;
          final app = hello?['app'] as Map?;
          final device = hello?['device'] as Map?;
          final sdk = hello?['sdk'] as Map?;
          final layers = (sdk?['layers'] as List?)?.join(', ');
          final connected = state?['connected'] == true;
          final mocks = state?['mocks'];
          final mockCount = mocks is List ? mocks.length : 0;
          String join(List<Object?> parts) => parts
              .whereType<Object>()
              .map((p) => '$p')
              .where((p) => p.isNotEmpty)
              .join(' · ');
          return ListView(
            padding: _pagePadding(context),
            children: <Widget>[
              if (app != null)
                _Row(
                    t.app,
                    join(<Object?>[
                      app['name'],
                      app['id'],
                      app['version'],
                      app['build']
                    ])),
              if (device != null)
                _Row(
                    t.device,
                    join(<Object?>[
                      device['model'] ?? device['name'],
                      device['os'],
                      device['osVersion'],
                      if (device['emulator'] == true) 'emulator'
                    ])),
              if (layers != null) _Row(t.layers, layers),
              _Row(
                  t.desktop,
                  connected
                      ? t.connected(state?['via'] as String?)
                      : t.notConnected,
                  color: connected ? _ok : null),
              if (connected) _Row(t.activeMocks, '$mockCount'),
              _Row(t.kept,
                  '${t.network}: ${store.calls.length} · ${t.logs}: ${store.logs.length} · ${formatBytes(store.bodyBytes)}'),
            ],
          );
        },
      ),
    );
  }
}
