/// Web: nothing is kept.
Future<String?> readPanelPref(String name) async => null;

Future<bool> writePanelPref(String name, String? value) async => false;

/// Whether values can be kept at all.
bool get panelPrefsAvailable => false;
