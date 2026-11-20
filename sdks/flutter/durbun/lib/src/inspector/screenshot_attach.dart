/// The app's screenshot from when the panel opened, as an attachment: the
/// row that shows it (with Leave out / Put it back), the enlarged view, the
/// PNG and the file the share sheet sends, and why Slack did not take it.
/// "Report a bug" and the request and log line share sheets use them.
library;

import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'export_file.dart' show writeExportBytes;
import 'format.dart' show formatClock;
import 'slack.dart' show SlackShotError, SlackShotProblem;
import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

/// Writes the screenshot file and returns its path (tests replace it).
@visibleForTesting
Future<String?> Function(String name, List<int> bytes)? debugBugBytesWriter;

/// Encodes the screenshot as PNG (tests replace it: encoding needs the
/// engine's real event loop).
@visibleForTesting
Future<Uint8List?> Function(ui.Image image)? debugSnapshotPng;

/// [image] as PNG bytes, or null.
Future<Uint8List?> snapshotPng(ui.Image image) async {
  final encode = debugSnapshotPng;
  if (encode != null) return encode(image);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data?.buffer.asUint8List();
}

/// Writes [bytes] as the export file [name]; its path, or null.
Future<String?> writeSnapshotFile(String name, List<int> bytes) =>
    (debugBugBytesWriter ?? ((String n, List<int> b) => writeExportBytes(n, b)))(name, bytes);

/// Why Slack did not take the screenshot, in the tester's words.
String slackShotReason(SlackShotError e, InspectorStrings t) => switch (e.problem) {
      SlackShotProblem.noKey => t.slackShotNoKey,
      SlackShotProblem.reconnect => t.slackShotReconnect,
      SlackShotProblem.notInChannel => t.slackShotNotInChannel,
      SlackShotProblem.notInDm => t.slackShotNotInDm,
      SlackShotProblem.rateLimited => t.slackShotRateLimited,
      SlackShotProblem.unreachable => t.slackShotUnreachable,
      SlackShotProblem.rejected => t.slackShotRejected(e.detail),
    };

/// The screenshot large, zoomable, in a dialog on the panel's navigator.
Future<void> showScreenshotDialog(BuildContext context, ui.Image image) {
  final t = InspectorStrings.of(context);
  return showDialog<void>(
    context: context,
    useRootNavigator: false,
    builder: (dialogContext) => DurbunTheme.wrap(
      dialogContext,
      Builder(builder: (dialog) {
        final c = DurbunColors.of(dialog);
        return Dialog(
          backgroundColor: c.bgPanel,
          insetPadding: const EdgeInsets.all(DurbunSpace.lg),
          clipBehavior: Clip.antiAlias,
          child: Stack(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 52, 12, 12),
                child: Semantics(
                  image: true,
                  label: t.bugScreenshot,
                  child: InteractiveViewer(
                    maxScale: 4,
                    child: RawImage(image: image, fit: BoxFit.contain),
                  ),
                ),
              ),
              PositionedDirectional(
                top: 4,
                start: 16,
                end: 52,
                child: SizedBox(
                  height: kMinTapTarget,
                  child: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: Text(t.bugScreenshot, style: DurbunType.heading(size: DurbunType.label, color: c.text)),
                  ),
                ),
              ),
              PositionedDirectional(
                top: 4,
                end: 4,
                child: DIconButton(icon: Icons.close_rounded, tooltip: t.close, onTap: () => Navigator.of(dialog).pop()),
              ),
            ],
          ),
        );
      }),
    ),
  );
}

/// The screenshot row: a thumbnail (tap to enlarge), when it was taken, that
/// it is not masked, and Leave out / Put it back. [outText] says where it
/// stays out of ("Not in the report").
class ScreenshotRow extends StatelessWidget {
  const ScreenshotRow({
    super.key,
    required this.shot,
    required this.shotAt,
    required this.included,
    required this.onToggle,
    required this.onEnlarge,
    this.outText,
    this.note,
  });

  final ui.Image? shot;
  final double? shotAt;
  final bool included;
  final VoidCallback? onToggle;
  final VoidCallback onEnlarge;
  final String? outText;

  /// A line under the rest while it is in ("Slack takes text only…").
  final String? note;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final image = shot;
    final String status;
    if (image == null) {
      status = t.bugScreenshotNoneHint;
    } else if (!included) {
      status = outText ?? t.bugScreenshotOut;
    } else {
      status = t.bugScreenshotWhen(shotAt == null ? '' : formatClock(shotAt!).substring(0, 8));
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(DurbunSpace.lg, 14, DurbunSpace.lg, 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          ScreenshotThumbnail(image: image, included: included, onTap: image == null ? null : onEnlarge),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(image == null ? t.bugScreenshotNone : t.bugScreenshot,
                    style: TextStyle(fontSize: DurbunType.label, color: c.text, fontWeight: FontWeight.w500, height: 1.3)),
                const SizedBox(height: 2),
                Text(status, style: DurbunType.ui(size: DurbunType.body, color: c.textMuted, height: 1.35)),
                if (image != null && included) ...<Widget>[
                  const SizedBox(height: 4),
                  Text(t.bugScreenshotNotMasked, style: DurbunType.ui(size: DurbunType.sm, color: c.textSubtle, height: 1.35)),
                  if (note != null) ...<Widget>[
                    const SizedBox(height: 4),
                    Text(note!, style: DurbunType.ui(size: DurbunType.sm, color: c.textMuted, height: 1.35)),
                  ],
                ],
                if (image != null) ...<Widget>[
                  const SizedBox(height: 10),
                  DButton(
                    kind: included ? DButtonKind.outline : DButtonKind.tonal,
                    icon: included ? Icons.hide_image_outlined : Icons.add_photo_alternate_outlined,
                    label: included ? t.bugScreenshotRemove : t.bugScreenshotAdd,
                    onTap: onToggle,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The screenshot, small, in a phone-like frame; dimmed with a crossed eye
/// when it stays out, a placeholder when there is none.
class ScreenshotThumbnail extends StatelessWidget {
  const ScreenshotThumbnail({super.key, required this.image, required this.included, required this.onTap});

  final ui.Image? image;
  final bool included;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final img = image;
    final aspect = img == null || img.height == 0 ? 0.46 : img.width / img.height;
    final width = aspect < 1 ? 64.0 : 112.0;
    final height = (width / aspect).clamp(48.0, 140.0);
    final radius = BorderRadius.circular(DurbunRadius.md);
    final Widget picture = img == null
        ? ColoredBox(
            color: c.bgSunken,
            child: Center(child: Icon(Icons.image_not_supported_outlined, size: 22, color: c.textSubtle)),
          )
        : Stack(
            fit: StackFit.expand,
            children: <Widget>[
              Opacity(
                  opacity: included ? 1 : 0.3, child: RawImage(image: img, fit: BoxFit.cover, alignment: Alignment.topCenter)),
              if (!included)
                Center(
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(color: c.bgPanel, shape: BoxShape.circle, border: Border.all(color: c.border)),
                    child: Icon(Icons.visibility_off_outlined, size: 18, color: c.textMuted),
                  ),
                ),
            ],
          );
    final frame = Container(
      width: width,
      height: height,
      clipBehavior: Clip.antiAlias,
      foregroundDecoration: BoxDecoration(borderRadius: radius, border: Border.all(color: c.borderStrong)),
      decoration: BoxDecoration(borderRadius: radius),
      child: picture,
    );
    if (onTap == null) return ExcludeSemantics(child: frame);
    return Semantics(
      button: true,
      image: true,
      label: t.bugScreenshotEnlarge,
      child: Tooltip(
        message: t.bugScreenshotEnlarge,
        excludeFromSemantics: true,
        // 44 pt to tap even for a short (landscape) picture.
        child: Pressable(
          onTap: onTap,
          builder: (pressed) => ConstrainedBox(
            constraints: const BoxConstraints(minHeight: kMinTapTarget, minWidth: kMinTapTarget),
            child: Opacity(opacity: pressed ? 0.8 : 1, child: frame),
          ),
        ),
      ),
    );
  }
}
