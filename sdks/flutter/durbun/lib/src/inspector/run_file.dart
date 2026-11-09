/// Writes and reads the previous-run log (dart:io only; on the web there is
/// none and nothing is kept).
library;

export 'run_file_stub.dart' if (dart.library.io) 'run_file_io.dart';
