import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/scheduler.dart';

import '../core/client.dart';
import '../core/process_sampler.dart';
import '../core/protocol.dart';
import '../core/types.dart';

/// Aggregated frame statistics for one metrics interval.
class FrameSample {
  const FrameSample({
    required this.frames,
    required this.fps,
    required this.jankyFrames,
    required this.avgBuildMs,
    required this.avgRasterMs,
  });

  final int frames;

  /// Frame rate while the app was rendering: frames divided by the time their
  /// bottleneck stage (build or raster, at least one vsync) occupied, capped
  /// at the display refresh rate. Idle intervals produce no sample, so an
  /// idle app does not look like it runs at 0 FPS.
  final double fps;

  /// Frames whose build or raster time exceeded the frame budget.
  final int jankyFrames;
  final double avgBuildMs;
  final double avgRasterMs;
}

/// Collects [ui.FrameTiming]s between samples.
class FrameStatsAggregator {
  final List<ui.FrameTiming> _pending = <ui.FrameTiming>[];

  int get pendingFrames => _pending.length;

  void add(List<ui.FrameTiming> timings) {
    _pending.addAll(timings);
    if (_pending.length > 4000) {
      _pending.removeRange(0, _pending.length - 4000);
    }
  }

  /// Computes the sample for the frames collected since the last call; null
  /// when no frame was rendered.
  FrameSample? takeSample({double refreshRate = 60}) {
    if (_pending.isEmpty) return null;
    final frames = List<ui.FrameTiming>.of(_pending);
    _pending.clear();
    final rate = refreshRate.isFinite && refreshRate >= 10 ? refreshRate : 60.0;
    final budgetMs = 1000.0 / rate;
    var sumBuild = 0.0;
    var sumRaster = 0.0;
    var sumSlots = 0.0;
    var janky = 0;
    for (final t in frames) {
      final build = t.buildDuration.inMicroseconds / 1000.0;
      final raster = t.rasterDuration.inMicroseconds / 1000.0;
      sumBuild += build;
      sumRaster += raster;
      if (build > budgetMs || raster > budgetMs) janky++;
      sumSlots += math.max(budgetMs, math.max(build, raster));
    }
    final fps = math.min(rate, frames.length * 1000.0 / sumSlots);
    return FrameSample(
      frames: frames.length,
      fps: round2(fps),
      jankyFrames: janky,
      avgBuildMs: round2(sumBuild / frames.length),
      avgRasterMs: round2(sumRaster / frames.length),
    );
  }
}

/// Returns the scheduler binding once a Flutter binding exists, without
/// throwing (and without tripping "break on exceptions" while polling).
SchedulerBinding? schedulerBindingOrNull() {
  final dispatcher = ui.PlatformDispatcher.instance;
  // GestureBinding sets onPointerDataPacket and SchedulerBinding sets
  // onReportTimings (debug/profile) while initializing.
  if (dispatcher.onPointerDataPacket == null &&
      dispatcher.onReportTimings == null) {
    return null;
  }
  try {
    return SchedulerBinding.instance;
  } catch (_) {
    return null;
  }
}

/// Sends `metric` messages every `config.metricsIntervalMs` while connected:
/// FPS / janky frames / build & raster times (frame timings), memory (RSS),
/// CPU and thread count.
class FlutterMetrics {
  FlutterMetrics(this.client, {this.local = false});

  final DurbunClient client;

  /// The in-app inspector shows the samples: sample without a desktop too.
  final bool local;

  bool get _wanted => client.isConnected || local;
  final FrameStatsAggregator _frames = FrameStatsAggregator();
  final ProcessSampler _process = ProcessSampler();
  Timer? _timer;
  int _intervalMs = 0;
  SchedulerBinding? _binding;
  bool _timingsAttached = false;
  StreamSubscription<DurbunConnection>? _connectionSub;
  bool _disposed = false;

  void start() {
    client.addConfigListener(_onConfig);
    _connectionSub = client.connectionChanges.listen((_) => _update());
    _update();
  }

  void _onConfig(SdkConfig config) => _update();

  /// Starts or stops sampling according to the connection state.
  void _update() {
    if (_disposed) return;
    if (_wanted) {
      ensureAttached();
      final interval = client.config.metricsIntervalMs;
      if (_timer == null || interval != _intervalMs) {
        _timer?.cancel();
        _intervalMs = interval;
        _process.sample(); // prime the CPU delta
        _timer = client.startPeriodicTimer(
          Duration(milliseconds: interval),
          _tick,
        );
      }
    } else {
      _timer?.cancel();
      _timer = null;
      _detachTimings();
    }
  }

  /// Registers the frame timings callback once the binding exists.
  void ensureAttached() {
    if (_disposed || _timingsAttached || !_wanted) return;
    final binding = _binding ?? schedulerBindingOrNull();
    if (binding == null) return;
    _binding = binding;
    try {
      binding.addTimingsCallback(_onTimings);
      _timingsAttached = true;
    } catch (_) {}
  }

  void _detachTimings() {
    if (!_timingsAttached) return;
    try {
      _binding?.removeTimingsCallback(_onTimings);
    } catch (_) {}
    _timingsAttached = false;
    _frames.takeSample();
  }

  void _onTimings(List<ui.FrameTiming> timings) {
    try {
      _frames.add(timings);
    } catch (_) {}
  }

  void _tick() {
    if (_disposed || !_wanted) return;
    if (!_timingsAttached) ensureAttached();
    final frames = _frames.takeSample(refreshRate: _refreshRate());
    final process = _process.sample();
    client.metric(
      buildMetric(
        cpu: process.cpu,
        memoryMB: process.memoryMB,
        threads: process.threads,
        fps: frames?.fps,
        jankyFrames: frames?.jankyFrames,
        frameBuildMs: frames?.avgBuildMs,
        frameRasterMs: frames?.avgRasterMs,
      ),
    );
  }

  double _refreshRate() {
    try {
      final views = ui.PlatformDispatcher.instance.views;
      if (views.isNotEmpty) {
        final rate = views.first.display.refreshRate;
        if (rate.isFinite && rate >= 10) return rate;
      }
    } catch (_) {}
    return 60;
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    _detachTimings();
    unawaited(_connectionSub?.cancel());
    _connectionSub = null;
    client.removeConfigListener(_onConfig);
  }
}
