/// The app as it looked when the panel opened: a picture of the app's own
/// layer, taken by `DurbunInspector` right before it pushes the panel (the
/// panel then covers the app), for "Report a bug". Kept in memory only, one
/// at a time, and let go when the panel closes.
library;

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'store.dart';

/// One opening of the panel: when, and the app's picture (null when none
/// could be taken).
class PanelOpening {
  PanelOpening(this.atMs, [this._image]);

  /// Epoch ms of the opening: "now" for a report started from Tools.
  final double atMs;
  ui.Image? _image;

  /// A handle of its own on the picture (the caller disposes it), or null.
  ui.Image? cloneImage() {
    try {
      return _image?.clone();
    } catch (_) {
      return null;
    }
  }

  bool get hasImage => _image != null;

  void dispose() {
    try {
      _image?.dispose();
    } catch (_) {}
    _image = null;
  }
}

final Expando<PanelOpening> _openings = Expando<PanelOpening>('durbun.opening');

/// The panel's current opening with [store], if it is open.
PanelOpening? panelOpeningOf(DurbunInspectorStore store) => _openings[store];

/// Sets (or, with null, ends) the opening with [store]; the previous one's
/// picture is let go.
void setPanelOpening(DurbunInspectorStore store, PanelOpening? opening) {
  final old = _openings[store];
  if (identical(old, opening)) return;
  old?.dispose();
  _openings[store] = opening;
}

/// The longest side of a picture, in pixels: sharp enough to read text on a
/// phone, small enough to stay a few MB in memory and a few hundred KB as a
/// PNG.
const double kSnapshotMaxSide = 1600;

/// Takes the picture of [key]'s [RenderRepaintBoundary] as it was last
/// painted. Waits for a frame on the way (at most a few hundred ms) when
/// one is due, so the picture is not of a half-painted tree. Null when it
/// cannot be taken (nothing painted yet, a platform without pictures);
/// never throws. The picture is made on the raster thread: the app's frame
/// is not held up.
Future<ui.Image?> snapshotApp(GlobalKey key) async {
  try {
    final binding = SchedulerBinding.instance;
    if (binding.schedulerPhase != SchedulerPhase.idle || binding.hasScheduledFrame) {
      await binding.endOfFrame.timeout(const Duration(milliseconds: 300));
    }
    final object = key.currentContext?.findRenderObject();
    if (object is! RenderRepaintBoundary || !object.attached || !object.hasSize || object.size.isEmpty) return null;
    final view = key.currentContext == null ? null : View.maybeOf(key.currentContext!);
    final dpr = view?.devicePixelRatio ?? 2;
    final side = math.max(object.size.width, object.size.height);
    final ratio = math.min(dpr, kSnapshotMaxSide / side);
    var clean = true;
    assert(() {
      // toImageSync asserts a clean boundary; skip rather than throw.
      clean = !object.debugNeedsPaint;
      return true;
    }());
    if (!clean) return null;
    return object.toImageSync(pixelRatio: ratio);
  } catch (_) {
    return null;
  }
}
