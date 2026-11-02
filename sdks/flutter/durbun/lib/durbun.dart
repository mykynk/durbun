/// Dürbün SDK for Flutter: streams app logs, errors, crashes, events, dart:io
/// HTTP traffic and frame/memory metrics to the Dürbün desktop inspector.
///
/// ```dart
/// import 'package:durbun/durbun.dart';
///
/// Future<void> main() async {
///   await Durbun.run(() async {
///     WidgetsFlutterBinding.ensureInitialized();
///     runApp(const MyApp());
///   });
/// }
/// ```
library;

export 'src/core/options.dart' show DurbunOptions;
export 'src/core/types.dart'
    show
        DurbunAction,
        DurbunActionKind,
        DurbunActionOption,
        DurbunConnection,
        DurbunHttpCall,
        DurbunLogLevel,
        DurbunMockDecision,
        DurbunPrintCapture;
export 'src/flutter/durbun.dart' show Durbun, DurbunNetwork;
