/// Live list as on the desktop: oldest at the top, follows the newest line
/// at the bottom; scrolling up freezes it and a "↓ N new" pill brings it
/// back.
///
/// Freezing keeps a cut point (the newest arrival seq at that moment), not a
/// copy of the list, so a filter or search changed while frozen still
/// applies to what is shown. Rows the store's ring drops from the top while
/// the list is frozen stay until it follows again, so the row being read
/// does not slide away.
///
/// A sorted list ([LiveList.fromTop]: newest on top, slowest, largest, by
/// status) follows its top instead. New requests and requests that finish
/// would move rows anywhere in it, so a frozen sorted list keeps a copy of
/// the order it showed: rows stay where they were (an evicted or changed
/// request too) and new ones wait behind a "↑ N new" pill that sorts again
/// and goes to the top. Scrolling back to the top follows again.
library;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;

import 'widgets.dart';

class LiveList<T> extends StatefulWidget {
  const LiveList(
      {super.key,
      required this.items,
      required this.keyOf,
      required this.seqOf,
      required this.itemBuilder,
      required this.newText,
      this.paused = false,
      this.filterKey,
      this.epoch,
      this.fromTop = false});

  /// Oldest first.
  final List<T> items;
  final Object Function(T item) keyOf;

  /// Arrival order (grows with every new item).
  final int Function(T item) seqOf;
  final Widget Function(BuildContext context, T item) itemBuilder;
  final String Function(int count) newText;

  /// Frozen by the toolbar's pause button.
  final bool paused;

  /// Changes with the filters and search; a change goes back to following
  /// the newest line (unless paused), so the results are in view.
  final Object? filterKey;

  /// Changes when the source is cleared: rows kept from before are let go.
  final Object? epoch;

  /// [items] are sorted, first on top (not arrival order): the list follows
  /// the top and a frozen list keeps its order (see the library comment).
  final bool fromTop;

  @override
  State<LiveList<T>> createState() => _LiveListState<T>();
}

class _LiveListState<T> extends State<LiveList<T>> {
  final ScrollController _scroll = ScrollController();

  /// Items with a larger seq arrived after the freeze and are held back.
  int? _cutoff;
  bool _jumpScheduled = false;

  /// Rows that left the top of [LiveList.items] while frozen (the ring was
  /// full), still shown above the others so nothing moves.
  List<T> _retained = <T>[];
  List<T> _lastShown = <T>[];
  static const int _maxRetained = 5000;

  /// [LiveList.fromTop]: the order shown when the list froze.
  List<T>? _frozenOrder;

  bool get _following => _cutoff == null && !widget.paused;

  int _newest(List<T> items) {
    var max = -1;
    for (final x in items) {
      final s = widget.seqOf(x);
      if (s > max) max = s;
    }
    return max;
  }

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _scheduleJump();
  }

  @override
  void didUpdateWidget(LiveList<T> old) {
    super.didUpdateWidget(old);
    if (widget.paused && _cutoff == null) _cutoff = _newest(old.items);
    if (!widget.paused && old.paused && _atEnd()) _cutoff = null;
    if (widget.filterKey != old.filterKey && !widget.paused) _cutoff = null;
    if (widget.fromTop != old.fromTop) {
      _retained = <T>[];
      _frozenOrder = null;
    }
    if (widget.fromTop) {
      _keepOrder(old);
    } else {
      _retainEvicted(old);
    }
    if (_following) _scheduleJump();
  }

  /// [LiveList.fromTop]: takes the order shown when the list freezes; a
  /// filter, search or order changed while paused (or a clear) takes it
  /// again from the new items, up to the cut point.
  void _keepOrder(LiveList<T> old) {
    final cut = _cutoff;
    if (cut == null) {
      _frozenOrder = null;
    } else if (_frozenOrder == null && widget.fromTop == old.fromTop) {
      _frozenOrder = List<T>.of(_lastShown);
    } else if (_frozenOrder == null || widget.filterKey != old.filterKey || widget.epoch != old.epoch) {
      _frozenOrder = <T>[
        for (final x in widget.items)
          if (widget.seqOf(x) <= cut) x
      ];
    }
  }

  /// Keeps the rows shown last that are gone from the top of the new items.
  void _retainEvicted(LiveList<T> old) {
    if (_following || widget.filterKey != old.filterKey || widget.epoch != old.epoch) {
      _retained = <T>[];
      return;
    }
    if (identical(widget.items, old.items) || _lastShown.isEmpty) return;
    final present = <Object>{for (final x in widget.items) widget.keyOf(x)};
    final kept = <T>[];
    for (final x in _lastShown) {
      if (present.contains(widget.keyOf(x))) break;
      kept.add(x);
    }
    _retained = kept.length > _maxRetained ? kept.sublist(kept.length - _maxRetained) : kept;
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// How far the view is from the end the list follows (the bottom, or the
  /// top of a sorted list).
  double _fromAnchor() => widget.fromTop
      ? _scroll.offset - _scroll.position.minScrollExtent
      : _scroll.position.maxScrollExtent - _scroll.offset;

  bool _atEnd() => !_scroll.hasClients || _fromAnchor() < 40;

  void _onScroll() {
    if (!_scroll.hasClients) return;
    if (_cutoff == null &&
        !_atEnd() &&
        _scroll.position.userScrollDirection != ScrollDirection.idle) {
      setState(() {
        _cutoff = _newest(widget.items);
        if (widget.fromTop) _frozenOrder = List<T>.of(_lastShown);
      });
    } else if (_cutoff != null && !widget.paused && _fromAnchor() < 4) {
      setState(() {
        _cutoff = null;
        _frozenOrder = null;
      });
    }
  }

  void _scheduleJump() {
    if (_jumpScheduled) return;
    _jumpScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _jumpScheduled = false;
      if (!mounted || !_following || !_scroll.hasClients) return;
      final end = widget.fromTop
          ? _scroll.position.minScrollExtent
          : _scroll.position.maxScrollExtent;
      if (_scroll.offset != end) _scroll.jumpTo(end);
    });
  }

  void _resume() {
    setState(() {
      _cutoff = null;
      _frozenOrder = null;
    });
    _scheduleJump();
  }

  @override
  Widget build(BuildContext context) {
    final cut = _cutoff;
    if (_following) _retained = <T>[];
    final List<T> shown;
    final int fresh;
    final frozen = cut == null ? null : _frozenOrder;
    if (widget.fromTop && frozen != null) {
      // The order shown when it froze; what is not in it waits.
      shown = frozen;
      final kept = <Object>{for (final x in frozen) widget.keyOf(x)};
      fresh = widget.items.where((x) => !kept.contains(widget.keyOf(x))).length;
    } else {
      final live = cut == null
          ? widget.items
          : <T>[
              for (final x in widget.items)
                if (widget.seqOf(x) <= cut) x
            ];
      shown = _retained.isEmpty ? live : <T>[..._retained, ...live];
      fresh = widget.items.length - live.length;
    }
    _lastShown = shown;
    final pillAt = MediaQuery.paddingOf(context).bottom + 14;
    return Stack(
      children: <Widget>[
        ListView.builder(
          controller: _scroll,
          padding:
              EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + 8),
          itemCount: shown.length,
          itemBuilder: (context, i) => KeyedSubtree(
              key: ValueKey<Object>(widget.keyOf(shown[i])),
              child: widget.itemBuilder(context, shown[i])),
        ),
        if (fresh > 0 && !widget.paused)
          Positioned(
            top: widget.fromTop ? 10 : null,
            bottom: widget.fromTop ? null : pillAt,
            left: 0,
            right: 0,
            child: Center(
                child: NewItemsPill(
                    text: widget.newText(fresh),
                    up: widget.fromTop,
                    onTap: _resume)),
          ),
      ],
    );
  }
}
