/// Performance view: the desktop's stat tiles and time charts (FPS, frame
/// times, memory) for the app on the phone.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

class PerformanceView extends StatelessWidget {
  const PerformanceView({super.key, required this.store});

  final DurbunInspectorStore store;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final samples = store.metrics;
        final m = store.lastMetric;
        if (m == null) {
          return EmptyState(
              icon: Icons.speed_rounded,
              title: t.noMetricsTitle,
              body: t.noMetricsBody);
        }
        double? avg(double? Function(InspectorMetric s) f) {
          final xs = samples.map(f).whereType<double>().toList();
          return xs.isEmpty ? null : xs.reduce((a, b) => a + b) / xs.length;
        }

        final jankTotal =
            samples.fold<int>(0, (s, x) => s + (x.jankyFrames ?? 0));
        // Color only when the frame rate drops.
        final fpsColor = m.fps == null || m.fps! >= 55
            ? null
            : (m.fps! >= 40
                    ? c.warning
                    : c.danger);
        String ms(double? v) => v == null ? '—' : v.toStringAsFixed(1);
        String mb(double? v) => v == null ? '—' : v.toStringAsFixed(0);
        return ListView(
          padding: EdgeInsets.fromLTRB(
              12, 12, 12, 20 + MediaQuery.paddingOf(context).bottom),
          children: <Widget>[
            LayoutBuilder(
              builder: (context, box) {
                final w = (box.maxWidth - 8) / 2;
                return Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    StatTile(
                        width: w,
                        label: 'FPS',
                        value: m.fps?.toStringAsFixed(0) ?? '—',
                        sub: t.avg(avg((s) => s.fps)?.toStringAsFixed(0)),
                        color: fpsColor),
                    StatTile(
                        width: w,
                        label: t.jank,
                        value: '${m.jankyFrames ?? '—'}',
                        sub: t.inWindow(jankTotal),
                        color: (m.jankyFrames ?? 0) > 0 ? c.warning : null),
                    StatTile(
                        width: w,
                        label: t.buildTime,
                        value: ms(m.frameBuildMs),
                        unit: 'ms',
                        sub: t.avg(ms(avg((s) => s.frameBuildMs)))),
                    StatTile(
                        width: w,
                        label: t.rasterTime,
                        value: ms(m.frameRasterMs),
                        unit: 'ms',
                        sub: t.avg(ms(avg((s) => s.frameRasterMs)))),
                    StatTile(
                        width: w,
                        label: t.memory,
                        value: mb(m.memoryMB),
                        unit: 'MB',
                        sub: t.peak(mb(samples
                            .map((s) => s.memoryMB)
                            .whereType<double>()
                            .fold<double?>(null,
                                (a, b) => a == null ? b : math.max(a, b))))),
                    StatTile(
                        width: w,
                        label: t.heap,
                        value: mb(m.heapMB),
                        unit: 'MB'),
                    if (m.cpu != null)
                      StatTile(
                          width: w,
                          label: 'CPU',
                          value: m.cpu!.toStringAsFixed(0),
                          unit: '%'),
                    if (m.threads != null)
                      StatTile(
                          width: w, label: t.threads, value: '${m.threads}'),
                  ],
                );
              },
            ),
            const SizedBox(height: 16),
            ChartCard(
              title: 'FPS',
              series: <ChartSeries>[
                ChartSeries(
                    'FPS', c.success, <double?>[for (final s in samples) s.fps])
              ],
              marks: <bool>[for (final s in samples) (s.jankyFrames ?? 0) > 0],
              markColor: c.warning,
              guide: 60,
              minTop: 60,
            ),
            const SizedBox(height: 12),
            ChartCard(
              title: t.frameTimes,
              unit: 'ms',
              series: <ChartSeries>[
                ChartSeries(t.buildTime, c.info,
                    <double?>[for (final s in samples) s.frameBuildMs]),
                // One series leads in color; the other is a neutral step.
                ChartSeries(t.rasterTime, c.textSubtle,
                    <double?>[for (final s in samples) s.frameRasterMs]),
              ],
              guide: 16.7,
              minTop: 20,
            ),
            const SizedBox(height: 12),
            ChartCard(
              title: t.memory,
              unit: 'MB',
              series: <ChartSeries>[
                ChartSeries(t.memory, c.pickOrange,
                    <double?>[for (final s in samples) s.memoryMB]),
                ChartSeries(t.heap, c.textSubtle,
                    <double?>[for (final s in samples) s.heapMB]),
              ],
            ),
            const SizedBox(height: 12),
            Text(t.perfWindow(samples.length),
                style: TextStyle(fontSize: 12, color: c.textMeta)),
          ],
        );
      },
    );
  }
}

class StatTile extends StatelessWidget {
  const StatTile(
      {super.key,
      required this.width,
      required this.label,
      required this.value,
      this.unit,
      this.sub,
      this.color});

  final double width;
  final String label;
  final String value;
  final String? unit;
  final String? sub;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      width: width,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: c.bgPanel,
          borderRadius: BorderRadius.circular(DurbunRadius.lg),
          border: Border.all(color: c.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label,
              style: TextStyle(
                  fontSize: 11.5,
                  color: c.textMuted,
                  fontWeight: FontWeight.w500)),
          const SizedBox(height: 4),
          Text.rich(
            TextSpan(
              children: <InlineSpan>[
                TextSpan(
                    text: value,
                    style: DurbunType.monoStyle(
                        size: 24,
                        weight: FontWeight.w500,
                        color: color ?? c.text,
                        height: 1.1)),
                if (unit != null)
                  TextSpan(
                      text: ' $unit',
                      style: TextStyle(fontSize: 12, color: c.textSubtle)),
              ],
            ),
          ),
          if (sub != null) ...<Widget>[
            const SizedBox(height: 4),
            Text(sub!, style: TextStyle(fontSize: 11, color: c.textMeta)),
          ],
        ],
      ),
    );
  }
}

class ChartSeries {
  const ChartSeries(this.label, this.color, this.values);

  final String label;
  final Color color;
  final List<double?> values;
}

class ChartCard extends StatelessWidget {
  const ChartCard(
      {super.key,
      required this.title,
      required this.series,
      this.unit,
      this.guide,
      this.minTop = 1,
      this.marks,
      this.markColor});

  final String title;
  final String? unit;
  final List<ChartSeries> series;
  final double? guide;
  final double minTop;
  final List<bool>? marks;
  final Color? markColor;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: c.bgPanel,
          borderRadius: BorderRadius.circular(DurbunRadius.lg),
          border: Border.all(color: c.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Wraps the legend under the title when space is short.
          Wrap(
            spacing: 10,
            runSpacing: 4,
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              Text(title,
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: c.text)),
              Wrap(
                spacing: 8,
                children: <Widget>[
                  for (final s in series)
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                                color: s.color,
                                borderRadius: BorderRadius.circular(2))),
                        const SizedBox(width: 4),
                        Text(s.label,
                            style: TextStyle(fontSize: 11, color: c.textMuted)),
                      ],
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 96,
            width: double.infinity,
            child: CustomPaint(
              painter: _ChartPainter(
                  label: DefaultTextStyle.of(context)
                      .style
                      .copyWith(fontSize: 9.5, color: c.textSubtle, height: 1),
                  series: series,
                  guide: guide,
                  minTop: minTop,
                  unit: unit,
                  marks: marks,
                  markColor: markColor,
                  grid: c.border,
                  text: c.textSubtle,
                  scaler: MediaQuery.textScalerOf(context)),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChartPainter extends CustomPainter {
  _ChartPainter(
      {required this.label,
      required this.series,
      required this.guide,
      required this.minTop,
      required this.unit,
      required this.marks,
      required this.markColor,
      required this.grid,
      required this.text,
      this.scaler = TextScaler.noScaling});

  final TextStyle label;
  final List<ChartSeries> series;
  final double? guide;
  final double minTop;
  final String? unit;
  final List<bool>? marks;
  final Color? markColor;
  final Color grid;
  final Color text;

  /// The phone's text size: the axis labels follow it like other text.
  final TextScaler scaler;

  @override
  void paint(Canvas canvas, Size size) {
    var top = minTop;
    for (final s in series) {
      for (final v in s.values) {
        if (v != null && v > top) top = v;
      }
    }
    top = top * 1.1;
    final labels = <TextPainter>[
      for (var i = 0; i <= 2; i++)
        TextPainter(
          text: TextSpan(text: (top * (1 - i / 2)).toStringAsFixed(0), style: label),
          textDirection: TextDirection.ltr,
          textScaler: scaler,
        )..layout(),
    ];
    // The gutter grows with the labels (large text, four-digit values).
    final left = math.max(30.0, labels.map((tp) => tp.width).reduce(math.max) + 6);
    final w = size.width - left;
    final h = size.height - 2;
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (var i = 0; i <= 2; i++) {
      final y = h * i / 2;
      canvas.drawLine(Offset(left, y), Offset(size.width, y), gridPaint);
      final tp = labels[i];
      tp.paint(canvas,
          Offset(0, (y - tp.height / 2).clamp(0, math.max(0.0, size.height - tp.height))));
      tp.dispose();
    }
    final g = guide;
    if (g != null && g <= top) {
      final y = h * (1 - g / top);
      final dash = Paint()
        ..color = text.withValues(alpha: 0.7)
        ..strokeWidth = 1;
      for (var x = left; x < size.width; x += 6) {
        canvas.drawLine(
            Offset(x, y), Offset(math.min(x + 3, size.width), y), dash);
      }
    }
    final n = series.isEmpty ? 0 : series.first.values.length;
    if (n < 1) return;
    double xAt(int i) => n == 1 ? left + w : left + w * i / (n - 1);
    final mk = marks;
    if (mk != null && markColor != null) {
      final p = Paint()..color = markColor!.withValues(alpha: 0.22);
      for (var i = 0; i < mk.length && i < n; i++) {
        if (mk[i]) canvas.drawRect(Rect.fromLTWH(xAt(i) - 2, 0, 4, h), p);
      }
    }
    for (final s in series) {
      final path = Path();
      var started = false;
      for (var i = 0; i < s.values.length; i++) {
        final v = s.values[i];
        if (v == null) {
          started = false;
          continue;
        }
        final pt = Offset(xAt(i), h * (1 - v / top));
        if (!started) {
          path.moveTo(pt.dx, pt.dy);
          started = true;
        } else {
          path.lineTo(pt.dx, pt.dy);
        }
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = s.color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.8
          ..strokeJoin = StrokeJoin.round,
      );
    }
  }

  @override
  bool shouldRepaint(_ChartPainter old) => true;
}
