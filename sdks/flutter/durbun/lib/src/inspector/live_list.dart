/// Live list as on the desktop: oldest at the top, follows the newest line
/// at the bottom; scrolling up freezes it and a "↓ N new" pill brings it
/// back.
library;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;

import 'widgets.dart';

class LiveList<T> extends StatefulWidget {
  const LiveList({super.key, required this.items, required this.keyOf, required this.itemBuilder, required this.newText, this.paused = false});

  /// Oldest first.
  final List<T> items;
  final Object Function(T item) keyOf;
  final Widget Function(BuildContext context, T item) itemBuilder;
  final String Function(int count) newText;

  /// Frozen by the toolbar's pause button.
  final bool paused;

  @override
  State<LiveList<T>> createState() => _LiveListState<T>();
}

class _LiveListState<T> extends State<LiveList<T>> {
  final ScrollController _scroll = ScrollController();
  List<T>? _frozen;
  bool _jumpScheduled = false;

  bool get _following => _frozen == null && !widget.paused;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _scheduleJump();
  }

  @override
  void didUpdateWidget(LiveList<T> old) {
    super.didUpdateWidget(old);
    if (widget.paused && _frozen == null) _frozen = List<T>.of(old.items);
    if (!widget.paused && old.paused && _atEnd()) _frozen = null;
    if (_following) _scheduleJump();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  bool _atEnd() => !_scroll.hasClients || _scroll.position.maxScrollExtent - _scroll.offset < 40;

  void _onScroll() {
    if (!_scroll.hasClients) return;
    if (_frozen == null && !_atEnd() && _scroll.position.userScrollDirection != ScrollDirection.idle) {
      setState(() => _frozen = List<T>.of(widget.items));
    } else if (_frozen != null && !widget.paused && _scroll.position.maxScrollExtent - _scroll.offset < 4) {
      setState(() => _frozen = null);
    }
  }

  void _scheduleJump() {
    if (_jumpScheduled) return;
    _jumpScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _jumpScheduled = false;
      if (!mounted || !_following || !_scroll.hasClients) return;
      final max = _scroll.position.maxScrollExtent;
      if (_scroll.offset != max) _scroll.jumpTo(max);
    });
  }

  void _resume() {
    setState(() => _frozen = null);
    _scheduleJump();
  }

  @override
  Widget build(BuildContext context) {
    final shown = _frozen ?? widget.items;
    var fresh = 0;
    if (_frozen != null) {
      final seen = <Object>{for (final x in _frozen!) widget.keyOf(x)};
      for (final x in widget.items) {
        if (!seen.contains(widget.keyOf(x))) fresh++;
      }
    }
    return Stack(
      children: <Widget>[
        ListView.builder(
          controller: _scroll,
          padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + 8),
          itemCount: shown.length,
          itemBuilder: (context, i) => widget.itemBuilder(context, shown[i]),
        ),
        if (fresh > 0 && !widget.paused)
          Positioned(
            bottom: MediaQuery.paddingOf(context).bottom + 14,
            left: 0,
            right: 0,
            child: Center(child: NewItemsPill(text: widget.newText(fresh), onTap: _resume)),
          ),
      ],
    );
  }
}
