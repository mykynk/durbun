import 'dart:io';

import 'env/native.dart';
import 'protocol.dart';

/// Process-level metrics: resident memory, CPU (% of one core) and threads.
class ProcessSampler {
  final Stopwatch _wall = Stopwatch()..start();
  int? _lastCpuUs;
  int? _lastWallUs;

  ({double? cpu, double? memoryMB, int? threads}) sample() {
    double? memoryMB;
    try {
      memoryMB = round2(ProcessInfo.currentRss / (1024 * 1024));
    } catch (_) {}

    double? cpu;
    final cpuUs = processCpuTimeMicros();
    final wallUs = _wall.elapsedMicroseconds;
    final lastCpu = _lastCpuUs;
    final lastWall = _lastWallUs;
    if (cpuUs != null && lastCpu != null && lastWall != null && wallUs > lastWall) {
      final value = (cpuUs - lastCpu) / (wallUs - lastWall) * 100;
      if (value >= 0) cpu = round2(value);
    }
    _lastCpuUs = cpuUs;
    _lastWallUs = wallUs;

    return (cpu: cpu, memoryMB: memoryMB, threads: processThreadCount());
  }
}
