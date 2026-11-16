/// Performance view: the frame rate as the lead with a ring, figure tiles
/// for what the app reports (frame times, memory, CPU), and time charts
/// (FPS, frame times, memory) for the app on the phone.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../flutter/metrics.dart' show displayRefreshRate;
import 'store.dart';
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

class PerformanceView extends StatelessWidget {
  const PerformanceView({super.key, required this.store, this.refreshRate});

  final DurbunInspectorStore store;

  /// The screen's refresh rate (Hz); default: the display's, as used for
  /// counting janky frames.
  final double? refreshRate;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final rate = refreshRate ?? displayRefreshRate(View.maybeOf(context)?.display);
    final budgetMs = 1000 / rate;
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final samples = store.metrics;
        final m = store.lastMetric;
        if (m == null) {
          return EmptyState(
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
        final fpsColor = m.fps == null || m.fps! >= rate * 0.92
            ? null
            : (m.fps! >= rate * 0.67
                    ? c.warning
                    : c.danger);
        String ms(double? v) => v == null ? '—' : v.toStringAsFixed(1);
        String mb(double? v) => v == null ? '—' : v.toStringAsFixed(0);
        final peak = samples.map((s) => s.memoryMB).whereType<double>().fold<double?>(null, (a, b) => a == null ? b : math.max(a, b));
        final buildAvg = avg((s) => s.frameBuildMs);
        final rasterAvg = avg((s) => s.frameRasterMs);
        final tiles = <StatTile>[
          StatTile(
              width: 0,
              label: t.buildTime,
              value: ms(m.frameBuildMs),
              unit: 'ms',
              sub: t.avg(ms(buildAvg)),
              subColor: c.info,
              color: (m.frameBuildMs ?? 0) > budgetMs ? c.warning : null),
          StatTile(
              width: 0,
              label: t.rasterTime,
              value: ms(m.frameRasterMs),
              unit: 'ms',
              sub: t.avg(ms(rasterAvg)),
              subColor: c.pickViolet,
              color: (m.frameRasterMs ?? 0) > budgetMs ? c.warning : null),
          StatTile(width: 0, label: t.memory, value: mb(m.memoryMB), unit: 'MB', sub: t.peakShort(mb(peak))),
          if (m.cpu != null)
            StatTile(
                width: 0,
                label: 'CPU',
                value: m.cpu!.toStringAsFixed(0),
                unit: '%',
                sub: m.threads == null ? null : t.threadCount(m.threads!))
          else if (m.threads != null)
            StatTile(width: 0, label: t.threads, value: '${m.threads}'),
        ];
        return ListView(
          padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.paddingOf(context).bottom),
          children: <Widget>[
            FpsHero(
              fps: m.fps,
              average: avg((s) => s.fps),
              rate: rate,
              janky: m.jankyFrames,
              jankyInWindow: jankTotal,
              color: fpsColor ?? c.success,
            ),
            const SizedBox(height: 12),
            // Two per row; an odd last tile takes the whole row instead of
            // leaving a hole. One per row when a tile would be too narrow.
            LayoutBuilder(
              builder: (context, box) {
                final scale = MediaQuery.textScalerOf(context).scale(10) / 10;
                final two = (box.maxWidth - 12) / 2 >= 130 * math.max(1.0, scale * 0.8);
                final w = two ? (box.maxWidth - 12) / 2 : box.maxWidth;
                return Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: <Widget>[
                    for (var i = 0; i < tiles.length; i++)
                      tiles[i].withWidth(two && i == tiles.length - 1 && tiles.length.isOdd ? box.maxWidth : w),
                  ],
                );
              },
            ),
            const SizedBox(height: 12),
            ChartCard(
              title: t.fpsTimeline,
              note: t.fpsTarget(rate.round()),
              noteColor: c.success,
              fill: true,
              series: <ChartSeries>[
                ChartSeries('FPS', c.success, <double?>[for (final s in samples) s.fps])
              ],
              marks: <bool>[for (final s in samples) (s.jankyFrames ?? 0) > 0],
              markColor: c.warning,
              guide: rate,
              minTop: rate,
            ),
            const SizedBox(height: 12),
            ChartCard(
              title: t.frameTimesBudget(budgetMs),
              unit: 'ms',
              series: <ChartSeries>[
                ChartSeries(t.buildTime, c.info, <double?>[for (final s in samples) s.frameBuildMs]),
                ChartSeries(t.rasterTime, c.pickViolet, <double?>[for (final s in samples) s.frameRasterMs]),
              ],
              guide: budgetMs,
              guideColor: c.danger,
              minTop: math.max(20, budgetMs * 1.2),
            ),
            const SizedBox(height: 12),
            ChartCard(
              title: t.memory,
              unit: 'MB',
              note: peak == null ? null : t.peak(mb(peak)),
              noteColor: c.pickOrange,
              fill: true,
              series: <ChartSeries>[
                ChartSeries(t.memory, c.pickOrange, <double?>[for (final s in samples) s.memoryMB]),
              ],
            ),
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(t.perfWindow(samples.length, refreshRate: rate),
                  style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.45)),
            ),
          ],
        );
      },
    );
  }
}

/// The frame rate as the page's lead: the figure in its state colour, the
/// average, the janky frames, and a ring that fills against the screen's
/// refresh rate.
class FpsHero extends StatelessWidget {
  const FpsHero(
      {super.key,
      required this.fps,
      required this.average,
      required this.rate,
      required this.janky,
      required this.jankyInWindow,
      required this.color});

  final double? fps;
  final double? average;
  final double rate;
  final int? janky;
  final int jankyInWindow;

  /// Green while the rate holds; amber or red when it drops.
  final Color color;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final value = fps?.toStringAsFixed(0) ?? '—';
    return Semantics(
      container: true,
      label: '${t.frameRate}: $value FPS, ${t.avg(average?.toStringAsFixed(0))}',
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
              color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(t.frameRate, style: DurbunType.ui(size: DurbunType.body, color: c.textMuted, weight: FontWeight.w500)),
                    const SizedBox(height: 4),
                    Wrap(
                      crossAxisAlignment: WrapCrossAlignment.end,
                      spacing: 8,
                      children: <Widget>[
                        Text(value, style: DurbunType.figureStyle(size: 40, color: color).copyWith(height: 1.05)),
                        Padding(
                          padding: const EdgeInsets.only(bottom: 5),
                          child: Text('FPS · ${t.avg(average?.toStringAsFixed(0))}',
                              style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.textMuted, height: 1.2)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(t.jankLine(janky ?? 0, jankyInWindow),
                        style: DurbunType.ui(
                            size: DurbunType.body, color: (janky ?? 0) > 0 ? c.warning : c.textMuted, height: 1.4)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: 64,
                height: 64,
                child: CustomPaint(
                  painter: _RingPainter(
                      fraction: fps == null ? 0 : (fps! / rate).clamp(0.0, 1.0), color: color, track: c.bgActive),
                  child: Center(
                    child: Text('${rate.round()} Hz',
                        style: DurbunType.monoStyle(size: 10, color: c.textMuted, height: 1),
                        textScaler: MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.2)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.fraction, required this.color, required this.track});

  final double fraction;
  final Color color;
  final Color track;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 6.0;
    final rect = Offset.zero & size;
    final r = rect.deflate(stroke / 2);
    canvas.drawArc(r, 0, math.pi * 2, false, Paint()..color = track..style = PaintingStyle.stroke..strokeWidth = stroke);
    if (fraction <= 0) return;
    canvas.drawArc(
        r,
        -math.pi / 2,
        math.pi * 2 * fraction,
        false,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = stroke
          ..strokeCap = StrokeCap.round);
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.fraction != fraction || old.color != color || old.track != track;
}

/// A figure in a card: the label with a small note on the right (an
/// average, a peak), and the value with its unit.
class StatTile extends StatelessWidget {
  const StatTile(
      {super.key,
      required this.width,
      required this.label,
      required this.value,
      this.unit,
      this.sub,
      this.subColor,
      this.color,
      this.lead = false});

  /// The page's main figure: larger, on its own row.
  final bool lead;
  final double width;
  final String label;
  final String value;
  final String? unit;
  final String? sub;

  /// The note's colour, e.g. the series colour it matches in a chart.
  final Color? subColor;
  final Color? color;

  StatTile withWidth(double w) =>
      StatTile(key: key, width: w, label: label, value: value, unit: unit, sub: sub, subColor: subColor, color: color, lead: lead);

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      width: width,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
          color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: double.infinity,
            child: Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 2,
            children: <Widget>[
              Text(label, style: DurbunType.ui(size: DurbunType.body, color: c.textMuted, weight: FontWeight.w500)),
              if (sub != null)
                Text(sub!, style: DurbunType.monoStyle(size: DurbunType.monoRow, color: subColor ?? c.textMuted, height: 1.35)),
            ],
          ),
          ),
          SizedBox(height: lead ? 4 : 6),
          Text.rich(
            TextSpan(
              children: <InlineSpan>[
                TextSpan(text: value, style: DurbunType.figureStyle(size: lead ? 36 : 26, color: color ?? c.text).copyWith(height: 1.1)),
                if (unit != null)
                  TextSpan(text: ' $unit', style: DurbunType.monoStyle(size: DurbunType.monoRow, color: c.textMuted, height: 1.1)),
              ],
            ),
          ),
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

/// A time chart in a card: the title, a legend or a note on the right,
/// and the lines (with a soft fill under a single series).
class ChartCard extends StatelessWidget {
  const ChartCard(
      {super.key,
      required this.title,
      required this.series,
      this.unit,
      this.guide,
      this.guideColor,
      this.minTop = 1,
      this.marks,
      this.markColor,
      this.note,
      this.noteColor,
      this.fill = false});

  final String title;
  final String? unit;
  final List<ChartSeries> series;
  final double? guide;

  /// The dashed guide's colour; default a muted line.
  final Color? guideColor;
  final double minTop;
  final List<bool>? marks;
  final Color? markColor;

  /// A short note on the right of the title (the target, a peak).
  final String? note;
  final Color? noteColor;

  /// A gradient under the line (single series).
  final bool fill;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
          color: c.cardBg, borderRadius: BorderRadius.circular(DurbunRadius.lg), border: Border.all(color: c.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Wraps the legend under the title when space is short.
          SizedBox(
            width: double.infinity,
            child: Wrap(
            spacing: 10,
            runSpacing: 4,
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              Text(title, style: DurbunType.heading(size: DurbunType.label, color: c.text)),
              if (note != null)
                Text(note!, style: DurbunType.monoStyle(size: DurbunType.monoRow, color: noteColor ?? c.textMuted, height: 1.35))
              // One series: the title already names it.
              else if (series.length > 1)
                Wrap(
                  spacing: 12,
                  children: <Widget>[
                    for (final s in series)
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Container(width: 8, height: 8, decoration: BoxDecoration(color: s.color, shape: BoxShape.circle)),
                          const SizedBox(width: 6),
                          Text(s.label, style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted)),
                        ],
                      ),
                  ],
                ),
            ],
          ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 112,
            width: double.infinity,
            child: CustomPaint(
              painter: _ChartPainter(
                  label: DefaultTextStyle.of(context).style.copyWith(fontSize: 9.5, color: c.textSubtle, height: 1),
                  series: series,
                  guide: guide,
                  guideColor: guideColor,
                  minTop: minTop,
                  unit: unit,
                  marks: marks,
                  markColor: markColor,
                  fill: fill,
                  grid: c.hairline,
                  text: c.textSubtle,
                  background: c.cardBg,
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
      this.guideColor,
      this.fill = false,
      required this.grid,
      required this.text,
      required this.background,
      this.scaler = TextScaler.noScaling});

  final TextStyle label;
  final List<ChartSeries> series;
  final double? guide;
  final double minTop;
  final String? unit;
  final List<bool>? marks;
  final Color? markColor;
  final Color? guideColor;
  final bool fill;
  final Color grid;
  final Color text;

  /// The card under the chart: rings the marks so they stand off the line.
  final Color background;

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
        ..color = guideColor?.withValues(alpha: 0.8) ?? text.withValues(alpha: 0.7)
        ..strokeWidth = 1;
      for (var x = left; x < size.width; x += 6) {
        canvas.drawLine(
            Offset(x, y), Offset(math.min(x + 3, size.width), y), dash);
      }
    }
    final n = series.isEmpty ? 0 : series.first.values.length;
    if (n < 1) return;
    double xAt(int i) => n == 1 ? left + w : left + w * i / (n - 1);
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
      if (fill && series.length == 1 && started) {
        final area = Path.from(path);
        final xs = <double>[for (var i = 0; i < s.values.length; i++) if (s.values[i] != null) xAt(i)];
        if (xs.length > 1 && !s.values.contains(null)) {
          area
            ..lineTo(xs.last, h)
            ..lineTo(xs.first, h)
            ..close();
          canvas.drawPath(
              area,
              Paint()
                ..shader = LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: <Color>[s.color.withValues(alpha: 0.28), s.color.withValues(alpha: 0)],
                ).createShader(Rect.fromLTWH(left, 0, w, h)));
        }
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = s.color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..strokeJoin = StrokeJoin.round,
      );
    }
    _paintMarks(canvas, xAt, h, top, background);
  }

  @override
  bool shouldRepaint(_ChartPainter old) => true;

  /// A dot on the first line where a sample is marked (janky frames).
  void _paintMarks(Canvas canvas, double Function(int) xAt, double h, double top, Color background) {
    final mk = marks;
    if (mk == null || markColor == null || series.isEmpty) return;
    final values = series.first.values;
    final dot = Paint()..color = markColor!;
    final ring = Paint()
      ..color = background
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    for (var i = 0; i < mk.length && i < values.length; i++) {
      final v = values[i];
      if (!mk[i] || v == null) continue;
      final p = Offset(xAt(i), h * (1 - v / top));
      canvas.drawCircle(p, 3, dot);
      canvas.drawCircle(p, 3.75, ring);
    }
  }
}
