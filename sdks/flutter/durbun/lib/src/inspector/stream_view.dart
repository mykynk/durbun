/// The messages of a WebSocket or an event stream in the request detail:
/// the Messages (Events) tab, the list row's badge and one message's page.
/// Worded like the desktop's Messages tab (`network.streams.*`).
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'format.dart';
import 'live_list.dart';
import 'network_view.dart' show BodyPane;
import 'share_report.dart' show looksJson;
import 'share_sheet.dart' show showStreamMessageShareSheet;
import 'store.dart';
import 'strings.dart';
import 'text_match.dart';
import 'theme.dart';
import 'widgets.dart';

/// Time since the connection opened: `+S.mmm`, `+M:SS.mmm`, `+H:MM:SS.mmm`.
String formatStreamOffset(double ms) {
  final v = ms < 0 ? 0 : ms.round();
  final h = v ~/ 3600000, m = (v ~/ 60000) % 60, s = (v ~/ 1000) % 60;
  final milli = (v % 1000).toString().padLeft(3, '0');
  String two(int x) => x.toString().padLeft(2, '0');
  if (h > 0) return '+$h:${two(m)}:${two(s)}.$milli';
  if (m > 0) return '+$m:${two(s)}.$milli';
  return '+$s.$milli';
}

/// `WebSocket` or `SSE` (the title and the badge's screen-reader text).
String streamKindName(StreamKind kind) => kind == StreamKind.webSocket ? 'WebSocket' : 'SSE';

String _stateKey(StreamState s) => switch (s) {
      StreamState.open => 'open',
      StreamState.closed => 'closed',
      StreamState.failed => 'failed',
    };

/// The state word of [call]'s connection ("açık"), or null while the panel
/// does not follow it.
String? streamStateWord(InspectorStrings t, InspectorCall call) {
  final s = call.stream;
  return s == null ? null : t.streamState(_stateKey(s.state));
}

/// "Sunucu kapattı" / "Bağlantı koptu": how [s] ended.
String streamEndTitle(InspectorStrings t, InspectorStream s) {
  if (s.state == StreamState.failed) return t.streamStateTitle('failed');
  if (s.kind == StreamKind.sse) {
    if (s.sseEnded) return t.sseEndedByServer;
    if (s.cancelled) return t.sseClosedByApp;
    return t.connectionClosed;
  }
  return switch (s.closedBy) {
    'in' => t.closedByServer,
    'out' => t.closedByApp,
    _ => t.connectionClosed,
  };
}

/// "1000 · normal kapanış"; null without a code.
String? closeCodeText(InspectorStrings t, int? code) {
  if (code == null) return null;
  final name = t.closeCodeName(code);
  return name == null ? '$code' : '$code · $name';
}

/* ───────────────────────────── list badge ───────────────────────────── */

/// The Network row's badge of a connection: WS or SSE, its state (a dot
/// while open, a broken link when it broke) and its message count.
class StreamChip extends StatelessWidget {
  const StreamChip({super.key, required this.call});

  final InspectorCall call;

  /// What the badge shows: its text and whether it has an icon.
  static (String, bool) contentOf(InspectorCall call) {
    final kind = call.connectionKind ?? StreamKind.webSocket;
    final s = call.stream;
    final short = kind == StreamKind.webSocket ? 'WS' : 'SSE';
    final text = s == null ? short : '$short ${s.count}';
    return (text, s != null && s.state != StreamState.closed);
  }

  /// Drawn width for [style] (the row fits its tags by width).
  static double widthOf(InspectorCall call, double Function(String text) measure) {
    final (text, icon) = contentOf(call);
    return measure(text) + 12 + (icon ? 14 : 0);
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final kind = call.connectionKind ?? StreamKind.webSocket;
    final s = call.stream;
    final (text, _) = contentOf(call);
    final state = s?.state;
    final (ink, tint) = switch (state) {
      StreamState.open => (c.success, c.successSoft),
      StreamState.failed => (c.danger, c.dangerSoft),
      _ => (c.textMuted, c.bgActive),
    };
    final label = s == null
        ? streamKindName(kind)
        : t.streamChipTitle(streamKindName(kind), t.streamState(_stateKey(s.state)), s.count);
    return Semantics(
      label: label,
      excludeSemantics: true,
      child: Container(
        constraints: const BoxConstraints(minHeight: 20),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(color: tint, borderRadius: BorderRadius.circular(DurbunRadius.sm)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (state == StreamState.open) ...<Widget>[
              Container(width: 6, height: 6, decoration: BoxDecoration(color: ink, shape: BoxShape.circle)),
              const SizedBox(width: 6),
            ] else if (state == StreamState.failed) ...<Widget>[
              Icon(Icons.link_off_rounded, size: 12, color: ink),
              const SizedBox(width: 2),
            ],
            Flexible(
              child: Text(text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DurbunType.monoStyle(size: DurbunType.monoSm, color: ink, weight: FontWeight.w600, height: 1.2)),
            ),
          ],
        ),
      ),
    );
  }
}

/* ───────────────────────────── messages tab ───────────────────────────── */

/// What the messages tab remembers per store: ping/pong shown or hidden
/// (hidden by default, as on the desktop: they are keep-alives).
class _StreamMemory {
  bool showControl = false;
}

final Expando<_StreamMemory> _memories = Expando<_StreamMemory>('durbun.streams');

enum _ItemKind { message, gap, end }

class _Item {
  _Item.message(InspectorStreamMessage this.message)
      : kind = _ItemKind.message,
        seq = message.seq,
        gap = 0,
        head = null;
  _Item.gap(this.seq, this.gap, this.head)
      : kind = _ItemKind.gap,
        message = null;
  _Item.end(this.seq)
      : kind = _ItemKind.end,
        message = null,
        gap = 0,
        head = null;

  final _ItemKind kind;
  final int seq;
  final InspectorStreamMessage? message;
  final int gap;
  final int? head;
  bool first = false;

  Object get key => switch (kind) {
        _ItemKind.message => 'm$seq',
        _ItemKind.gap => 'g$seq',
        _ItemKind.end => 'end',
      };
}

/// The Messages tab (Events for an event stream): search, the ping/pong
/// switch, the counts and the live list, oldest first, the connection's end
/// as its last line. Opens the message page on a tap.
class StreamMessagesTab extends StatefulWidget {
  const StreamMessagesTab({super.key, required this.call, required this.store});

  final InspectorCall call;
  final DurbunInspectorStore store;

  @override
  State<StreamMessagesTab> createState() => _StreamMessagesTabState();
}

class _StreamMessagesTabState extends State<StreamMessagesTab> {
  late final _StreamMemory _memory = _memories[widget.store] ??= _StreamMemory();
  final TextEditingController _search = TextEditingController();
  String _query = '';

  /// Search results per message for the current query: a message is
  /// decoded once per query, not on every new message.
  String _cacheFor = '';
  Expando<bool> _cache = Expando<bool>();

  /// The messages listed now (the message page's up / down).
  List<InspectorStreamMessage> _shown = const <InspectorStreamMessage>[];

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  bool _matches(InspectorStreamMessage m, String folded) {
    if (folded != _cacheFor) {
      _cacheFor = folded;
      _cache = Expando<bool>();
    }
    return _cache[m] ??= m.matches(folded);
  }

  void _open(InspectorStreamMessage m) {
    FocusManager.instance.primaryFocus?.unfocus();
    final shown = _shown;
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (routeContext) => DurbunTheme.wrap(
            routeContext, StreamMessagePage(call: widget.call, store: widget.store, message: m, siblings: () => shown)))));
  }

  void _clearSearch() {
    _search.clear();
    setState(() => _query = '');
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final call = widget.call;
    final s = call.stream;
    final kind = call.connectionKind ?? StreamKind.webSocket;
    final sse = kind == StreamKind.sse;

    // The panel cannot have this connection's messages: one line why.
    if (s == null || (!s.followed && s.count == 0)) {
      if (widget.store.readOnly) return EmptyState(title: t.macOnlyTitle, body: t.previousRunNoMessages);
      if (call.noStream) return EmptyState(title: t.noHookTitle, body: t.noHookBody);
      return EmptyState(title: t.macOnlyTitle, body: t.macOnlyBody);
    }

    final all = s.messages;
    final folded = foldText(_query.trim());
    final terms = folded.isEmpty ? const <String>[] : <String>[folded];
    final hideControl = !_memory.showControl;
    final items = <_Item>[];
    final shown = <InspectorStreamMessage>[];
    var heldControl = 0;
    var pendingGap = 0;
    int? pendingHead;
    var contiguous = true;
    InspectorStreamMessage? prev;
    for (var i = 0; i < all.length; i++) {
      final m = all[i];
      final expected = prev == null ? 1 : prev.seq + 1;
      if (m.seq > expected) {
        pendingGap += m.seq - expected;
        // Right after the kept head: "after the first N".
        if (prev != null && contiguous && pendingHead == null) pendingHead = prev.seq;
        contiguous = false;
      }
      prev = m;
      if (m.isControl) heldControl++;
      if (m.isControl && hideControl) continue;
      if (folded.isNotEmpty && !_matches(m, folded)) continue;
      if (pendingGap > 0 && folded.isEmpty) items.add(_Item.gap(m.seq, pendingGap, pendingHead));
      pendingGap = 0;
      pendingHead = null;
      items.add(_Item.message(m));
      shown.add(m);
    }
    if (pendingGap > 0 && folded.isEmpty && items.isNotEmpty) items.add(_Item.gap((prev?.seq ?? 0) + 1, pendingGap, pendingHead));
    if (!s.isOpen && items.isNotEmpty) items.add(_Item.end(prev?.seq ?? 0));
    if (items.isNotEmpty) items.first.first = true;
    _shown = shown;

    final Widget body;
    if (all.isEmpty) {
      final end = s.isOpen ? null : _endBody(t, s);
      body = s.dropped > 0
          ? EmptyState(title: t.allDroppedTitle, body: t.streamGap(s.dropped))
          : switch (s.state) {
              StreamState.open => EmptyState(
                  title: sse ? t.openNoneEventsTitle : t.openNoneTitle, body: sse ? t.openNoneEventsBody : t.openNoneBody),
              StreamState.closed => EmptyState(title: t.closedNoneTitle, body: end),
              StreamState.failed => EmptyState(title: t.failedNoneTitle, body: end),
            };
    } else if (shown.isEmpty && folded.isNotEmpty) {
      body = EmptyState(title: t.streamNoMatchTitle, actionLabel: t.clearSearch, actionIcon: Icons.close_rounded, onAction: _clearSearch);
    } else if (shown.isEmpty && heldControl > 0 && hideControl) {
      body = EmptyState(
          title: t.onlyControlTitle,
          actionLabel: t.showControl,
          actionIcon: Icons.visibility_outlined,
          onAction: () => setState(() => _memory.showControl = true));
    } else {
      final bottom = MediaQuery.paddingOf(context).bottom;
      body = Padding(
        padding: EdgeInsets.fromLTRB(DurbunSpace.gutter, 2, DurbunSpace.gutter, 12 + bottom),
        child: Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: c.cardBg,
            borderRadius: BorderRadius.circular(DurbunRadius.lg),
            border: Border.all(color: c.border),
          ),
          child: MediaQuery.removePadding(
            context: context,
            removeBottom: true,
            child: LiveList<_Item>(
              items: items,
              keyOf: (x) => x.key,
              seqOf: (x) => x.seq,
              filterKey: '$folded|$hideControl',
              epoch: widget.store.clears,
              topPadding: 0,
              bottomPadding: 0,
              // A short list hugs its rows; a long one fills the page.
              shrinkWrap: items.length <= 24,
              newText: sse ? t.newEvents : t.newMessages,
              itemBuilder: (context, x) => switch (x.kind) {
                _ItemKind.message => _MessageRow(
                    message: x.message!, stream: s, sse: sse, terms: terms, first: x.first, onTap: () => _open(x.message!)),
                _ItemKind.gap => _GapRow(count: x.gap, head: x.head, first: x.first, keptHead: s.headKept, max: s.maxMessages),
                _ItemKind.end => _EndRow(stream: s, first: x.first),
              },
            ),
          ),
        ),
      );
    }

    final hasMessages = all.isNotEmpty;
    final counts = <String>[
      if (sse) t.streamEvents(s.count) else ...<String>[t.streamReceived(s.received), t.streamSent(s.sent)],
      if (s.dropped > 0) t.streamDroppedShort(s.dropped),
    ].join(' · ');
    final countStyle = DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.3);
    final bodiesOff = s.isOpen && !widget.store.capturesBodies;
    final search = SizedBox(
      height: kMinTapTarget,
      child: Center(
        child: DSearchField(
          controller: _search,
          hint: sse ? t.searchEvents : t.searchMessages,
          onChanged: (v) => setState(() => _query = v),
        ),
      ),
    );
    final countText = Semantics(
      container: true,
      child: Text(counts, maxLines: 2, overflow: TextOverflow.ellipsis, style: countStyle),
    );
    final toggle = heldControl == 0
        ? null
        : Semantics(
            hint: hideControl ? t.controlShow : t.controlHide,
            child: DToggle(
              label: hideControl ? t.controlHidden(heldControl) : t.controlLabel,
              icon: hideControl ? Icons.visibility_off_outlined : Icons.visibility_outlined,
              selected: !hideControl,
              tonal: true,
              onTap: () => setState(() => _memory.showControl = !_memory.showControl),
            ),
          );
    final large = MediaQuery.textScalerOf(context).scale(10) > 15;
    // From about 1.25× the counts and the switch no longer share a phone's
    // width (the switch would be cut).
    final stack = MediaQuery.textScalerOf(context).scale(10) > 12.4;
    final Widget toolbar = LayoutBuilder(builder: (context, box) {
      // Wide (landscape, a tablet): search, counts and the switch in one
      // row, so the list keeps the height.
      if (box.maxWidth >= 560 && !large) {
        return Row(
          children: <Widget>[
            Expanded(flex: 3, child: search),
            const SizedBox(width: 14),
            Flexible(flex: 2, child: countText),
            if (toggle != null) ...<Widget>[const SizedBox(width: 8), toggle],
          ],
        );
      }
      if (box.maxWidth >= 560) {
        // Wide with large text (landscape): the search and the switch share
        // a row, the counts go under them; the list keeps the height.
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(child: search),
                if (toggle != null) ...<Widget>[const SizedBox(width: 10), Flexible(child: toggle)],
              ],
            ),
            Padding(padding: const EdgeInsets.fromLTRB(4, 2, 0, 4), child: countText),
          ],
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          search,
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: stack
                // Larger text: the switch under the counts, at full width.
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: countText),
                      if (toggle != null) toggle,
                    ],
                  )
                : ConstrainedBox(
                    constraints: BoxConstraints(minHeight: toggle != null ? kMinTapTarget : 30),
                    child: Row(
                      children: <Widget>[
                        Expanded(child: countText),
                        if (toggle != null) ...<Widget>[const SizedBox(width: 8), Flexible(child: toggle)],
                      ],
                    ),
                  ),
          ),
        ],
      );
    });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (hasMessages)
          Padding(
            padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, 0, DurbunSpace.gutter, 0),
            child: toolbar,
          ),
        if (bodiesOff)
          Padding(
            padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter + 4, 0, DurbunSpace.gutter, 6),
            child: Row(
              children: <Widget>[
                Icon(Icons.info_outline_rounded, size: 14, color: c.textSubtle),
                const SizedBox(width: 6),
                Expanded(child: Text(t.streamBodiesOffNote, style: countStyle)),
              ],
            ),
          ),
        Flexible(child: body),
      ],
    );
  }

  String _endBody(InspectorStrings t, InspectorStream s) {
    final parts = <String>[
      streamEndTitle(t, s),
      if (s.closeCode != null) closeCodeText(t, s.closeCode)!,
      if (s.state == StreamState.failed && s.error != null) s.error!,
    ];
    return parts.join(' · ');
  }
}

/// A hairline over every row but the first.
Widget _rowFrame(BuildContext context, {required bool first, required Widget child}) {
  final c = DurbunColors.of(context);
  return DecoratedBox(
    decoration: BoxDecoration(border: first ? null : Border(top: BorderSide(color: c.hairline))),
    child: child,
  );
}

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.message,
    required this.stream,
    required this.sse,
    required this.terms,
    required this.first,
    required this.onTap,
  });

  final InspectorStreamMessage message;
  final InspectorStream stream;
  final bool sse;
  final List<String> terms;
  final bool first;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final m = message;
    final large = MediaQuery.textScalerOf(context).scale(10) > 15;
    // The arrow grows with the text (up to 24 pt).
    final iconSize = MediaQuery.textScalerOf(context).scale(15).clamp(15.0, 24.0);
    final quiet = m.isControl;
    final text = DurbunType.monoStyle(size: DurbunType.monoRow, color: quiet ? c.textMuted : c.text, height: 1.35);
    final meta = DurbunType.monoStyle(size: DurbunType.monoSm, color: c.textMuted, height: 1.3);
    final offset = formatStreamOffset(m.ts - stream.openTs);
    final size = formatBytes(m.size);

    final InlineSpan line1;
    if (m.isClose) {
      final parts = <String>[
        if (closeCodeText(t, m.closeCode) != null) closeCodeText(t, m.closeCode)!,
        if (m.closeReason?.isNotEmpty == true) '“${m.closeReason}”',
      ];
      line1 = parts.isEmpty
          ? TextSpan(text: t.streamTypeTitle('close'), style: text.copyWith(color: c.textMuted))
          : highlightTerms(parts.join(' · '), terms, text, c.hlMark);
    } else if (!m.hasPayload) {
      // Sizes only (bodies off, a ping without data): say what it was.
      line1 = TextSpan(
          text: m.size == 0 ? t.streamTypeTitle(m.type) : '${t.streamTypeTitle(m.type)} · ${formatBytes(m.size)}',
          style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.4));
    } else if (!m.isText) {
      line1 = TextSpan(text: m.preview, style: text.copyWith(color: quiet ? c.textSubtle : c.textMuted));
    } else {
      line1 = highlightTerms(_snippet(m, terms), terms, text, c.hlMark);
    }
    final event = sse && m.event != null && m.event!.isNotEmpty ? m.event! : null;
    final dirColor = m.out ? c.accentInk : c.info;
    final typeLabel = sse ? (m.eventId != null ? 'id ${m.eventId}' : null) : m.type;
    final semantics = <String>[
      if (!sse) t.streamDirName(m.out),
      sse ? (event ?? 'message') : t.streamTypeTitle(m.type),
      offset,
      formatBytes(m.size),
    ].join(', ');

    return _rowFrame(
      context,
      first: first,
      child: Semantics(
        button: true,
        label: semantics,
        child: Pressable(
          onTap: onTap,
          builder: (pressed) => AnimatedContainer(
            duration: DurbunMotion.of(context, DurbunMotion.fast),
            color: pressed ? c.text.withValues(alpha: c.isDark ? 0.05 : 0.04) : Colors.transparent,
            padding: EdgeInsets.fromLTRB(sse ? 12 : 8, 7, 12, 7),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (!sse)
                  SizedBox(
                    width: iconSize + 7,
                    child: Padding(
                      padding: const EdgeInsets.only(top: 1),
                      // Not by colour alone: the arrow points out of the app
                      // (up, sent) or into it (down, received).
                      child: Icon(m.out ? Icons.north_east_rounded : Icons.south_west_rounded,
                          size: iconSize, color: quiet ? c.textSubtle : dirColor),
                    ),
                  ),
                if (!sse) const SizedBox(width: 4),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Text.rich(
                        TextSpan(children: <InlineSpan>[
                          if (event != null)
                            TextSpan(text: '$event  ', style: text.copyWith(color: c.accentInk, fontWeight: FontWeight.w600)),
                          line1,
                        ]),
                        maxLines: large ? 2 : 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 3),
                      _MetaLine(
                        offset: offset,
                        type: typeLabel,
                        size: size,
                        style: meta,
                        typeStyle: meta.copyWith(
                            color: m.isClose ? c.warning : (quiet ? c.textSubtle : c.textMuted), fontWeight: FontWeight.w600),
                        separator: large ? ' · ' : '  ·  ',
                        separatorStyle: meta.copyWith(color: c.textSubtle),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A message row's second line: the time since the connection opened, the
/// type (or the event's id) and the size on the right. When the time and
/// the size leave the type too little room (large text, a narrow phone),
/// the parts wrap instead of being cut.
class _MetaLine extends StatelessWidget {
  const _MetaLine({
    required this.offset,
    required this.type,
    required this.size,
    required this.style,
    required this.typeStyle,
    required this.separator,
    required this.separatorStyle,
  });

  final String offset;
  final String? type;
  final String size;
  final TextStyle style;
  final TextStyle typeStyle;
  final String separator;
  final TextStyle separatorStyle;

  @override
  Widget build(BuildContext context) {
    final scaler = MediaQuery.textScalerOf(context);
    final dir = Directionality.of(context);
    double width(String text, TextStyle s) {
      final p = TextPainter(text: TextSpan(text: text, style: s), textDirection: dir, textScaler: scaler, maxLines: 1)..layout();
      final w = p.width;
      p.dispose();
      return w;
    }

    return LayoutBuilder(builder: (context, box) {
      final type = this.type;
      final fixed = width(offset, style) + width(size, style) + 8 + (type == null ? 0 : width(separator, separatorStyle));
      // The type keeps at least its start (or all of it when short).
      final typeMin = type == null ? 0.0 : math.min(width(type, typeStyle), scaler.scale(40));
      if (fixed + typeMin <= box.maxWidth) {
        return Row(
          children: <Widget>[
            Text(offset, style: style),
            if (type != null) Text(separator, style: separatorStyle),
            Expanded(child: Text(type ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: typeStyle)),
            const SizedBox(width: 8),
            Text(size, style: style),
          ],
        );
      }
      return Wrap(
        spacing: scaler.scale(10),
        runSpacing: 2,
        children: <Widget>[
          Text(offset, maxLines: 1, overflow: TextOverflow.ellipsis, style: style),
          if (type != null) Text(type, maxLines: 1, overflow: TextOverflow.ellipsis, style: typeStyle),
          Text(size, maxLines: 1, overflow: TextOverflow.ellipsis, style: style),
        ],
      );
    });
  }
}

/// The row's line of [m]: its start, or while searching the part around the
/// first match (a match past the row's width would not show).
String _snippet(InspectorStreamMessage m, List<String> terms) {
  final p = m.preview;
  if (terms.isEmpty) return p;
  final ranges = matchRanges(p, terms);
  if (ranges.isNotEmpty) {
    final at = ranges.first.$1;
    return at > 24 ? '…${p.substring(at - 12)}' : p;
  }
  final full = m.text();
  if (full == null) return p;
  final flat = full.replaceAll(_spaces, ' ');
  final deep = matchRanges(flat, terms);
  if (deep.isEmpty) return p;
  final start = deep.first.$1 > 12 ? deep.first.$1 - 12 : 0;
  final end = start + 200 < flat.length ? start + 200 : flat.length;
  return '${start > 0 ? '…' : ''}${flat.substring(start, end)}';
}

final RegExp _spaces = RegExp(r'\s+');

/// Where messages were removed by the memory limits.
class _GapRow extends StatelessWidget {
  const _GapRow({required this.count, required this.head, required this.first, required this.keptHead, required this.max});

  final int count;
  final int? head;
  final bool first;

  /// The ring's sizes, for the hint on a tap.
  final int keptHead;
  final int max;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final text = head == null ? t.streamGap(count) : t.streamGapHead(head!, count);
    return _rowFrame(
      context,
      first: first,
      child: Semantics(
        button: true,
        label: text,
        excludeSemantics: true,
        child: Pressable(
          onTap: () => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
              content: Text(t.streamDroppedHint(keptHead, max)),
              duration: const Duration(seconds: 5))),
          builder: (pressed) => Container(
            color: pressed ? c.bgActive : c.bgSunken,
            padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
            child: Row(
              children: <Widget>[
                Icon(Icons.more_vert_rounded, size: 16, color: c.textSubtle),
                const SizedBox(width: 8),
                Expanded(child: Text(text, style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.35))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The connection's end, the list's last line.
class _EndRow extends StatelessWidget {
  const _EndRow({required this.stream, required this.first});

  final InspectorStream stream;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final s = stream;
    final failed = s.state == StreamState.failed;
    final color = failed ? c.danger : c.textMuted;
    final end = s.endTs;
    final code = closeCodeText(t, s.closeCode);
    final meta = DurbunType.monoStyle(size: DurbunType.monoSm, color: c.textMuted, height: 1.3);
    final large = MediaQuery.textScalerOf(context).scale(10) > 15;
    return _rowFrame(
      context,
      first: first,
      child: Semantics(
        container: true,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 12, 9),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Icon(failed ? Icons.link_off_rounded : Icons.stop_circle_outlined, size: 16, color: color),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(streamEndTitle(t, s),
                        style: DurbunType.ui(size: DurbunType.body, weight: FontWeight.w600, color: failed ? c.danger : c.text, height: 1.35)),
                    if (code != null || s.closeReason?.isNotEmpty == true) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(
                          <String>[
                            if (code != null) code,
                            if (s.closeReason?.isNotEmpty == true) '“${s.closeReason}”',
                          ].join(' · '),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: meta.copyWith(color: c.text)),
                    ],
                    if (failed && s.error != null) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(s.error!, maxLines: 3, overflow: TextOverflow.ellipsis, style: meta.copyWith(color: c.text)),
                    ],
                    if (end != null) ...<Widget>[
                      const SizedBox(height: 3),
                      Text('${formatStreamOffset(end - s.openTs)}${large ? ' · ' : '  ·  '}${t.openFor(t.span(end - s.openTs))}', style: meta),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/* ───────────────────────────── message page ───────────────────────────── */

/// One message: its facts over its body (JSON tree, text, hex), with up /
/// down through the list it was opened from and Share.
class StreamMessagePage extends StatefulWidget {
  const StreamMessagePage({super.key, required this.call, required this.store, required this.message, this.siblings});

  final InspectorCall call;
  final DurbunInspectorStore store;
  final InspectorStreamMessage message;

  /// The messages listed when the page opened, in order.
  final List<InspectorStreamMessage> Function()? siblings;

  @override
  State<StreamMessagePage> createState() => _StreamMessagePageState();
}

class _StreamMessagePageState extends State<StreamMessagePage> {
  late InspectorStreamMessage _m = widget.message;

  /// Decoded once per message, when it is shown.
  late InspectorBody? _body = _m.body();

  void _show(InspectorStreamMessage next) {
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _m = next;
      _body = next.body();
    });
  }

  (InspectorStreamMessage?, InspectorStreamMessage?) _neighbours() {
    final list = widget.siblings?.call();
    if (list == null) return (null, null);
    final i = list.indexWhere((x) => identical(x, _m));
    if (i < 0) return (null, null);
    return (i > 0 ? list[i - 1] : null, i + 1 < list.length ? list[i + 1] : null);
  }

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final m = _m;
    final s = widget.call.stream;
    final sse = (widget.call.connectionKind ?? StreamKind.webSocket) == StreamKind.sse;
    final openTs = s?.openTs ?? widget.call.ts;
    final (prev, next) = _neighbours();
    final offset = formatStreamOffset(m.ts - openTs);
    final kept = m.keptBytes;
    final facts = <(String, String, IconData?, Color?)>[
      if (!sse) (t.fieldDirection, t.streamDirName(m.out), m.out ? Icons.north_east_rounded : Icons.south_west_rounded, m.out ? c.accentInk : c.info),
      if (sse) (t.fieldEvent, m.event ?? 'message', null, null) else (t.fieldType, m.type, null, null),
      (t.fieldSize, m.truncated && kept > 0 ? '${formatBytes(kept)} / ${formatBytes(m.size)}' : formatBytes(m.size), null, null),
      (t.fieldSinceOpen, offset, null, null),
      (t.fieldTime, formatClock(m.ts), null, null),
      if (m.eventId != null) (t.fieldEventId, m.eventId!, null, null),
      if (m.retry != null) (t.fieldRetry, '${m.retry} ms', null, null),
      if (m.closeCode != null) (t.fieldCloseCode, closeCodeText(t, m.closeCode)!, null, null),
      if (m.closeReason?.isNotEmpty == true) (t.fieldCloseReason, m.closeReason!, null, null),
    ];
    final b = _body;
    final Widget payload;
    if (b != null && b.data.isNotEmpty) {
      final text = m.text();
      payload = BodyPane(
        key: ObjectKey(m),
        body: b,
        hasBody: true,
        contentType: m.isText ? (text != null && looksJson('', text) ? 'application/json' : 'text/plain') : null,
        leading: Text(t.body, style: DurbunType.ui(size: DurbunType.body, weight: FontWeight.w600, color: c.textMuted)),
      );
    } else {
      final String title;
      if (m.isClose || m.size == 0) {
        title = t.payloadNone;
      } else if (!widget.store.capturesBodies) {
        title = t.payloadBodiesOff;
      } else {
        title = t.payloadNotCaptured;
      }
      // The facts say it all; a short line, not a page-sized empty state.
      payload = Align(
        alignment: Alignment.topLeft,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter + 4, 10, DurbunSpace.gutter, 0),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Padding(padding: const EdgeInsets.only(top: 1), child: Icon(Icons.info_outline_rounded, size: 16, color: c.textSubtle)),
              const SizedBox(width: 8),
              Expanded(child: Text(title, style: DurbunType.ui(size: DurbunType.body, color: c.textMuted, height: 1.4))),
            ],
          ),
        ),
      );
    }
    return Scaffold(
      backgroundColor: c.bgApp,
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(sse ? t.eventTitle(m.seq) : t.messageTitle(m.seq),
                maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.text)),
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(sse ? 'SSE · ${m.event ?? 'message'}' : 'WebSocket · ${t.streamTypeTitle(m.type)}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: DurbunType.ui(size: DurbunType.sm, color: c.textSubtle, height: 1.2)),
            ),
          ],
        ),
        actions: <Widget>[
          if (widget.siblings != null) ...<Widget>[
            DIconButton(icon: Icons.keyboard_arrow_up_rounded, tooltip: t.prevMessage, onTap: prev == null ? null : () => _show(prev)),
            DIconButton(icon: Icons.keyboard_arrow_down_rounded, tooltip: t.nextMessage, onTap: next == null ? null : () => _show(next)),
          ],
          DIconButton(
              icon: Theme.of(context).platform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded,
              tooltip: t.share,
              onTap: () => unawaited(showStreamMessageShareSheet(context, widget.call, m, widget.store))),
          const SizedBox(width: 4),
        ],
      ),
      body: LayoutBuilder(builder: (context, box) {
        final factsCard = Padding(
          padding: const EdgeInsets.fromLTRB(DurbunSpace.gutter, 4, DurbunSpace.gutter, 4),
          child: _Facts(facts: facts),
        );
        // A short page (landscape, large text): the facts scroll away and
        // the payload below them gets the whole height.
        if (box.maxHeight < 480) {
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[factsCard, SizedBox(height: box.maxHeight, child: payload)],
            ),
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[factsCard, Expanded(child: payload)],
        );
      }),
    );
  }
}

/// The message's facts in one card: label over value, as many per line as
/// fit.
class _Facts extends StatelessWidget {
  const _Facts({required this.facts});

  final List<(String, String, IconData?, Color?)> facts;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final label = DurbunType.ui(size: DurbunType.caption, color: c.textMuted, height: 1.3);
    final value = DurbunType.monoStyle(size: DurbunType.monoRow, color: c.text, height: 1.35, weight: FontWeight.w500);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
      decoration: BoxDecoration(color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: LayoutBuilder(
        builder: (context, box) {
          // Three columns on a phone, more when there is room, fewer with
          // large text.
          final scaler = MediaQuery.textScalerOf(context);
          final columns = (box.maxWidth / scaler.scale(104)).floor().clamp(1, 6);
          final w = (box.maxWidth - (columns - 1) * 12) / columns;
          double widthOf(String text, TextStyle style) =>
              (TextPainter(text: TextSpan(text: text, style: style), textDirection: TextDirection.ltr, textScaler: scaler, maxLines: 1)
                    ..layout())
                  .width;
          return Wrap(
            spacing: 12,
            runSpacing: 10,
            children: <Widget>[
              for (final (name, text, icon, color) in facts)
                SizedBox(
                  // A long value (a reason, a close code's name) takes the line.
                  width: widthOf(text, value) + (icon == null ? 0 : 18) > w ? box.maxWidth : w,
                  child: Semantics(
                    container: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: label),
                        const SizedBox(height: 2),
                        Row(
                          children: <Widget>[
                            if (icon != null) ...<Widget>[Icon(icon, size: 14, color: color), const SizedBox(width: 4)],
                            Flexible(child: Text(text, maxLines: 3, overflow: TextOverflow.ellipsis, style: value)),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
