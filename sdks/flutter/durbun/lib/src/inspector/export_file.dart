/// Files of the in-app panel: session exports a share sheet sends, and the
/// app's cache directory they (and the previous run's log) live in.
/// dart:io only; the stub keeps the web build compiling and writes nothing.
library;

export 'export_file_stub.dart' if (dart.library.io) 'export_file_io.dart';
