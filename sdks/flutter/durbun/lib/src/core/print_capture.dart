import 'protocol.dart';
import 'types.dart';

/// Sink used by [PrintCapture] (implemented by the SDK client).
typedef PrintLineSink = void Function(String line, double ts);

/// Decides what happens to captured `print` lines.
///
/// `auto` follows `SdkConfig.deviceLogsAvailable`: lines printed before the
/// first welcome are held (bounded) until the desktop says whether it already
/// sees the device's stdout, then sent or discarded.
class PrintCapture {
  PrintCapture({
    required this.mode,
    required this.sink,
    this.dropFlutterErrorBoxes = false,
    this.maxPending = 500,
  });

  final DurbunPrintCapture mode;
  final PrintLineSink sink;

  /// When errors are captured as `flutter-error` entries, the console copy of
  /// the error box (and "Another exception was thrown") is a duplicate.
  final bool dropFlutterErrorBoxes;
  final int maxPending;

  final List<(String, double)> _pending = <(String, double)>[];
  SdkConfig? _config;
  bool _inErrorBox = false;

  static final RegExp _boxEnd = RegExp(r'^═{20,}\s*$');

  /// Lines waiting for the first config (for tests/diagnostics).
  int get pendingCount => _pending.length;

  void onLine(String line) {
    if (mode == DurbunPrintCapture.never) return;
    if (dropFlutterErrorBoxes && _isErrorBoxLine(line)) return;
    final ts = nowEpochMs();
    if (mode == DurbunPrintCapture.always) {
      sink(line, ts);
      return;
    }
    final config = _config;
    if (config == null) {
      _pending.add((line, ts));
      if (_pending.length > maxPending) _pending.removeAt(0);
      return;
    }
    if (!config.deviceLogsAvailable) sink(line, ts);
  }

  void onConfig(SdkConfig config) {
    _config = config;
    if (_pending.isEmpty) return;
    final pending = List<(String, double)>.of(_pending);
    _pending.clear();
    if (mode == DurbunPrintCapture.auto && !config.deviceLogsAvailable) {
      for (final (line, ts) in pending) {
        sink(line, ts);
      }
    }
  }

  bool _isErrorBoxLine(String line) {
    if (_inErrorBox) {
      if (_boxEnd.hasMatch(line)) _inErrorBox = false;
      return true;
    }
    if (line.startsWith('══╡ EXCEPTION CAUGHT BY')) {
      // A whole box printed at once ends with its closing rule.
      final lines = line.split('\n');
      _inErrorBox = lines.length == 1 || !_boxEnd.hasMatch(lines.last);
      return true;
    }
    return line.startsWith('Another exception was thrown:');
  }
}
