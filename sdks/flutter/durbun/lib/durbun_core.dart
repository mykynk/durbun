/// Pure-Dart core of the Dürbün SDK (no Flutter imports): transport, wire
/// protocol, logger, mock engine and the dart:io HTTP capture. Usable from
/// command-line Dart programs (`dart run`) and from other HTTP adapters.
///
/// Flutter apps should use `package:durbun/durbun.dart` instead.
library;

export 'src/core/client.dart' show DurbunClient, DurbunCommandHandler;
export 'src/core/http/http_client.dart'
    show DurbunHttpClient, DurbunHttpOverrides, HttpCaptureHost;
export 'src/core/http/recorder.dart' show NetworkRecorder;
export 'src/core/http/response.dart' show DurbunHttpTuning;
export 'src/core/mocks.dart'
    show MockAction, MockRule, findMockRule, mockRuleMatches;
export 'src/core/options.dart' show DurbunOptions;
export 'src/core/protocol.dart'
    show
        PendingBody,
        SdkConfig,
        ServerWelcome,
        kDefaultSdkPort,
        kProtocolVersion,
        kSdkName,
        kSdkVersion;
export 'src/core/types.dart'
    show
        DurbunAction,
        DurbunActionKind,
        DurbunActionOption,
        DurbunConnection,
        DurbunLogLevel,
        DurbunPrintCapture;
