/// Replays a captured request from the phone (dart:io only; the stub keeps
/// the web build compiling). The replay goes through dart:io, so the SDK
/// captures it as a new request.
library;

export 'replay_stub.dart' if (dart.library.io) 'replay_io.dart';
