import 'store.dart';

bool get canReplay => false;

/// Not available without dart:io.
Future<String?> replayCall(InspectorCall call) async => 'unsupported';
