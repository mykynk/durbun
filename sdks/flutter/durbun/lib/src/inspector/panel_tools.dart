/// `DurbunPanelTools`: which items the in-app panel's Tools tab shows, set
/// by the host app on [DurbunInspector.tools].
library;

import 'package:flutter/foundation.dart';

/// The items of the in-app panel's Tools tab, each turned on or off by the
/// app. Everything is on by default; the app card at the top (name,
/// version, device, connection) is always there.
///
/// ```dart
/// DurbunInspector(
///   tools: const DurbunPanelTools(previousRun: false, clearData: false),
///   child: child!,
/// )
/// ```
///
/// Pass a new value to change it while the app runs (for example from a
/// debug menu): the panel follows on its next frame.
@immutable
class DurbunPanelTools {
  /// Every item on, Mac connection shown when a Mac is in reach.
  const DurbunPanelTools({
    this.bugReport = true,
    this.statistics = true,
    this.macConnection,
    this.appTools = true,
    this.deviceInfo = true,
    this.mocks = true,
    this.exportSession = true,
    this.previousRun = true,
    this.theme = true,
    this.clearData = true,
  });

  /// Every item off: Tools shows only the app card.
  const DurbunPanelTools.none()
      : bugReport = false,
        statistics = false,
        macConnection = false,
        appTools = false,
        deviceInfo = false,
        mocks = false,
        exportSession = false,
        previousRun = false,
        theme = false,
        clearData = false;

  /// "Report a bug": the moment with its screenshot, logs and requests.
  final bool bugReport;

  /// The Statistics tile (requests, success rate, slowest hosts).
  final bool statistics;

  /// The Mac connection tile. `null` (default): shown once a Mac is in
  /// reach in this run (connected now or before, or a Wi-Fi address set in
  /// the app or entered on the phone), so testers without a Mac never see
  /// it; `true`: always; `false`: never. Device & SDK still offers the page
  /// while no Mac is connected.
  final bool? macConnection;

  /// The App tools tile (the app's own `Durbun.addAction` controls).
  final bool appTools;

  /// The Device & SDK tile.
  final bool deviceInfo;

  /// The Mocks row (only while a Mac is connected: rules come from it).
  final bool mocks;

  /// The Export session row (Markdown or HAR through the share sheet).
  final bool exportSession;

  /// The Previous run row (with `DurbunInspector.keepPreviousRun`; off it
  /// says how to turn it on).
  final bool previousRun;

  /// The Dark theme switch.
  final bool theme;

  /// The red "Clear captured data" card (Network and Logs keep their own
  /// Clear button).
  final bool clearData;

  /// A copy with the given items changed.
  DurbunPanelTools copyWith({
    bool? bugReport,
    bool? statistics,
    bool? Function()? macConnection,
    bool? appTools,
    bool? deviceInfo,
    bool? mocks,
    bool? exportSession,
    bool? previousRun,
    bool? theme,
    bool? clearData,
  }) =>
      DurbunPanelTools(
        bugReport: bugReport ?? this.bugReport,
        statistics: statistics ?? this.statistics,
        macConnection: macConnection == null ? this.macConnection : macConnection(),
        appTools: appTools ?? this.appTools,
        deviceInfo: deviceInfo ?? this.deviceInfo,
        mocks: mocks ?? this.mocks,
        exportSession: exportSession ?? this.exportSession,
        previousRun: previousRun ?? this.previousRun,
        theme: theme ?? this.theme,
        clearData: clearData ?? this.clearData,
      );

  @override
  bool operator ==(Object other) =>
      other is DurbunPanelTools &&
      other.bugReport == bugReport &&
      other.statistics == statistics &&
      other.macConnection == macConnection &&
      other.appTools == appTools &&
      other.deviceInfo == deviceInfo &&
      other.mocks == mocks &&
      other.exportSession == exportSession &&
      other.previousRun == previousRun &&
      other.theme == theme &&
      other.clearData == clearData;

  @override
  int get hashCode => Object.hash(
      bugReport, statistics, macConnection, appTools, deviceInfo, mocks, exportSession, previousRun, theme, clearData);
}
