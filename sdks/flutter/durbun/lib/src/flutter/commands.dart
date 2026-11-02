import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import '../core/client.dart';
import '../core/types.dart';

/// Flutter developer toggles and dumps the desktop can trigger (same ids as
/// the desktop's VM-service bridge, SPEC §5.6). Debug-only flags are offered
/// only in debug builds, where the framework honours them.
class FlutterCommands {
  FlutterCommands(this.client);

  final DurbunClient client;

  static const String group = 'flutter';

  static const List<DurbunActionOption> brightnessOptions = <DurbunActionOption>[
    DurbunActionOption('system', 'System'),
    DurbunActionOption('light', 'Light'),
    DurbunActionOption('dark', 'Dark'),
  ];

  static const List<DurbunActionOption> platformOptions = <DurbunActionOption>[
    DurbunActionOption('default', 'Default'),
    DurbunActionOption('android', 'Android'),
    DurbunActionOption('iOS', 'iOS'),
    DurbunActionOption('macOS', 'macOS'),
  ];

  List<DurbunAction> buildActions() => <DurbunAction>[
    if (kDebugMode)
      DurbunAction.toggle(
        id: 'flutter.debugPaint',
        label: 'Debug paint',
        labelKey: 'flutter.debugPaint',
        group: group,
        value: () => debugPaintSizeEnabled,
        onChanged: (v) async {
          debugPaintSizeEnabled = v;
          await _forceRepaint();
        },
      ),
    if (kDebugMode)
      DurbunAction.toggle(
        id: 'flutter.repaintRainbow',
        label: 'Repaint rainbow',
        labelKey: 'flutter.repaintRainbow',
        group: group,
        value: () => debugRepaintRainbowEnabled,
        onChanged: (v) async {
          debugRepaintRainbowEnabled = v;
          await _forceRepaint();
        },
      ),
    DurbunAction.toggle(
      id: 'flutter.slowAnimations',
      label: 'Slow animations',
      labelKey: 'flutter.slowAnimations',
      group: group,
      value: () => timeDilation != 1.0,
      onChanged: (v) => timeDilation = v ? 5.0 : 1.0,
    ),
    DurbunAction.toggle(
      id: 'flutter.performanceOverlay',
      label: 'Performance overlay',
      labelKey: 'flutter.performanceOverlay',
      group: group,
      value: () => WidgetsApp.showPerformanceOverlayOverride,
      onChanged: (v) async {
        WidgetsApp.showPerformanceOverlayOverride = v;
        await _forceRebuild();
      },
    ),
    if (kDebugMode)
      DurbunAction.toggle(
        id: 'flutter.invertOversizedImages',
        label: 'Invert oversized images',
        labelKey: 'flutter.invertOversizedImages',
        group: group,
        value: () => debugInvertOversizedImages,
        onChanged: (v) async {
          debugInvertOversizedImages = v;
          await _forceRepaint();
        },
      ),
    if (!kReleaseMode)
      DurbunAction.select(
        id: 'flutter.brightness',
        label: 'Brightness',
        labelKey: 'flutter.brightness',
        group: group,
        options: brightnessOptions,
        value: () => switch (debugBrightnessOverride) {
          ui.Brightness.light => 'light',
          ui.Brightness.dark => 'dark',
          null => 'system',
        },
        onChanged: (v) async {
          debugBrightnessOverride = switch (v) {
            'light' => ui.Brightness.light,
            'dark' => ui.Brightness.dark,
            _ => null,
          };
          await _reassemble();
        },
      ),
    if (kDebugMode)
      DurbunAction.select(
        id: 'flutter.platform',
        label: 'Target platform',
        labelKey: 'flutter.platform',
        group: group,
        options: platformOptions,
        value: () => switch (debugDefaultTargetPlatformOverride) {
          TargetPlatform.android => 'android',
          TargetPlatform.iOS => 'iOS',
          TargetPlatform.macOS => 'macOS',
          _ => 'default',
        },
        onChanged: (v) async {
          debugDefaultTargetPlatformOverride = switch (v) {
            'android' => TargetPlatform.android,
            'iOS' => TargetPlatform.iOS,
            'macOS' => TargetPlatform.macOS,
            _ => null,
          };
          await _reassemble();
        },
      ),
    DurbunAction.button(
      id: 'flutter.dumpWidgetTree',
      label: 'Dump widget tree',
      labelKey: 'flutter.dumpWidgetTree',
      group: group,
      onPressed: (_) => _dump('Widget tree', dumpWidgetTree()),
    ),
    DurbunAction.button(
      id: 'flutter.dumpRenderTree',
      label: 'Dump render tree',
      labelKey: 'flutter.dumpRenderTree',
      group: group,
      onPressed: (_) => _dump('Render tree', dumpRenderTree()),
    ),
  ];

  void register() => client.addActions(buildActions());

  /// Sends the dump as one log entry (first line = title, so it stays
  /// readable when collapsed) and returns a small summary.
  Map<String, Object?> _dump(String title, String text) {
    final lines = '\n'.allMatches(text).length + 1;
    client.log(
      DurbunLogLevel.info,
      '$title ($lines lines)\n$text',
      tag: 'flutter',
    );
    return <String, Object?>{'lines': lines, 'chars': text.length};
  }

  static String dumpWidgetTree() {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    final mode = kDebugMode
        ? 'DEBUG MODE'
        : kReleaseMode
        ? 'RELEASE MODE'
        : 'PROFILE MODE';
    return '${binding.runtimeType} - $mode\n'
        '${root == null ? '<no tree currently mounted>' : root.toStringDeep()}'
        .trimRight();
  }

  static String dumpRenderTree() {
    final views = RendererBinding.instance.renderViews;
    if (views.isEmpty) return 'No render tree root was added to the binding.';
    return <String>[for (final v in views) v.toStringDeep()].join('\n\n').trimRight();
  }

  static Future<void> _forceRepaint() async {
    final binding = RendererBinding.instance;
    late RenderObjectVisitor visitor;
    visitor = (RenderObject child) {
      child.markNeedsPaint();
      child.visitChildren(visitor);
    };
    for (final view in binding.renderViews) {
      view.visitChildren(visitor);
    }
    binding.scheduleFrame();
    await _endOfFrame();
  }

  static Future<void> _forceRebuild() async {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    final owner = binding.buildOwner;
    if (root != null && owner != null) {
      owner.reassemble(root);
      await _endOfFrame();
    }
  }

  static Future<void> _reassemble() async {
    await WidgetsBinding.instance.reassembleApplication().timeout(
      const Duration(seconds: 8),
      onTimeout: () {},
    );
  }

  /// Waits for the next frame, but never hangs (e.g. app in background).
  static Future<void> _endOfFrame() async {
    try {
      await SchedulerBinding.instance.endOfFrame.timeout(
        const Duration(seconds: 2),
        onTimeout: () {},
      );
    } catch (_) {}
  }
}
