// Platform-agnostic: must not import dart:io / package:flutter.

/// A Dart stack trace from a build made with `--split-debug-info` (and
/// usually `--obfuscate`): frames carry only addresses, and the symbols live
/// in the folder the build wrote them to.
///
/// ```text
/// *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
/// pid: 4711, tid: 4730, name 1.ui
/// os: android arch: arm64 comp: yes sim: no
/// build_id: '6c3e1a…'
/// isolate_dso_base: 7a5e1c8000, vm_dso_base: 7a5e1c8000
///     #00 abs 0000007a5e3d33f3 virt 00000000002793f3 _kDartIsolateSnapshotInstructions+0x1c13f3
/// ```
class AddressOnlyStack {
  const AddressOnlyStack({this.os, this.arch, this.buildId});

  /// `android`, `ios`, `macos`, … (null when the header is missing).
  final String? os;

  /// `arm64`, `arm`, `x64`, … (null when the header is missing).
  final String? arch;

  /// The build's id; the symbols file of the same build carries it.
  final String? buildId;

  /// `app.android-arm64.symbols`: the file `--split-debug-info` wrote for
  /// this platform and architecture.
  String get symbolsFile => os != null && arch != null ? 'app.$os-$arch.symbols' : 'app.<platform>-<arch>.symbols';

  /// The command that turns [stackFile] back into file names and lines.
  String symbolizeCommand({String stackFile = 'stack.txt', String symbolsDir = '<split-debug-info folder>'}) =>
      'flutter symbolize -i $stackFile -d $symbolsDir/$symbolsFile';

  static final RegExp _frame = RegExp(r'#\d+\s+abs\s+[0-9a-f]+\s+virt\s+[0-9a-f]+', caseSensitive: false);
  static final RegExp _osArch = RegExp(r'os:\s*(\w+)\s+arch:\s*(\w+)');
  static final RegExp _buildId = RegExp(r"build_id:\s*'?([0-9a-fA-F]+)");

  /// The stack's format when [stack] is an address-only Dart stack, else
  /// null. A native crash dump (also `*** *** ***`) has no
  /// `isolate_dso_base` and no `virt` frames, so it does not match.
  static AddressOnlyStack? parse(String? stack) {
    if (stack == null || stack.isEmpty) return null;
    final head = stack.length > 4096 ? stack.substring(0, 4096) : stack;
    final dart = head.contains('isolate_dso_base') ||
        head.contains('_kDartIsolateSnapshotInstructions') ||
        _frame.hasMatch(head);
    if (!dart) return null;
    final osArch = _osArch.firstMatch(head);
    return AddressOnlyStack(
      os: osArch?.group(1),
      arch: osArch?.group(2),
      buildId: _buildId.firstMatch(head)?.group(1),
    );
  }
}
