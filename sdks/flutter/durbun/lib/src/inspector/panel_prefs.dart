/// Small values the panel keeps across launches (the Mac address entered on
/// the phone, whether the "shake to open" hint was shown): one file each in
/// `<app cache>/durbun-prefs`. Nothing on the web or without the plugin.
library;

export 'panel_prefs_stub.dart' if (dart.library.io) 'panel_prefs_io.dart';
