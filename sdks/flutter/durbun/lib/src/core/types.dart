// Public, platform-agnostic SDK types. This file must not import dart:io,
// dart:ffi, dart:isolate or package:flutter (it is shared with the web stub).
import 'dart:async';

/// Log levels, identical to the desktop's `LogLevel`.
enum DurbunLogLevel {
  /// Very detailed tracing, usually filtered out (`Durbun.v`).
  verbose('verbose'),

  /// Diagnostic detail for developers (`Durbun.d`).
  debug('debug'),

  /// Normal events worth seeing (`Durbun.i`, the default of `Durbun.log`).
  info('info'),

  /// Something unexpected that the app recovered from (`Durbun.w`).
  warn('warn'),

  /// A failure the user may notice (`Durbun.e`).
  error('error'),

  /// A crash or an error the app cannot continue after (`Durbun.f`);
  /// uncaught errors are reported at this level.
  fatal('fatal');

  /// A level with its [wireName].
  const DurbunLogLevel(this.wireName);

  /// Name used on the wire protocol.
  final String wireName;
}

/// How `print` / `debugPrint` output is captured.
enum DurbunPrintCapture {
  /// Capture only when the desktop does not already see the device logs
  /// (`SdkConfig.deviceLogsAvailable == false`), so lines are never duplicated.
  auto,

  /// Always send printed lines as app logs.
  always,

  /// Never capture printed lines.
  never,
}

/// State of the connection to the Dürbün desktop.
class DurbunConnection {
  /// A connection state; the SDK creates these, apps read them from
  /// `Durbun.connectionState` and `Durbun.connection`.
  const DurbunConnection({
    required this.connected,
    this.via,
    this.appId,
    this.server,
  });

  /// Not connected (initial state).
  static const DurbunConnection disconnected = DurbunConnection(
    connected: false,
  );

  /// Whether the hello/welcome handshake completed and the link is up.
  final bool connected;

  /// Transport description, e.g. `tcp 127.0.0.1:9751` or `usbmux 127.0.0.1:9752`.
  final String? via;

  /// App session id assigned by the desktop (e.g. `app:3`).
  final String? appId;

  /// Desktop identifier from the welcome message (e.g. `durbun/0.1.0`).
  final String? server;

  @override
  String toString() => connected
      ? 'DurbunConnection(connected via $via, appId: $appId, server: $server)'
      : 'DurbunConnection(disconnected)';
}

/// Kind of an app action shown on the desktop and in the panel's App tools.
enum DurbunActionKind {
  /// An on/off switch ([DurbunAction.toggle]).
  toggle,

  /// A choice among [DurbunAction.options] ([DurbunAction.select]).
  select,

  /// A button that runs code once per tap ([DurbunAction.button]).
  button,
}

/// One choice of a [DurbunAction.select] action.
class DurbunActionOption {
  /// A choice whose [value] is passed to the action and whose [label] is
  /// shown, e.g. `DurbunActionOption('staging', 'Staging')`.
  const DurbunActionOption(this.value, this.label);

  /// What the action receives when this choice is picked.
  final String value;

  /// What the desktop and the panel show for this choice.
  final String label;
}

/// A custom control shown for this app on the desktop (Device tab → app
/// tools). The desktop invokes it through the `commands` capability.
///
/// ```dart
/// Durbun.addAction(DurbunAction.button(
///   id: 'app.clearCache',
///   label: 'Clear cache',
///   onPressed: (_) async => cache.clear(),
/// ));
/// ```
class DurbunAction {
  /// A one-shot button. The returned value (JSON-like) is sent back as the
  /// command result data.
  DurbunAction.button({
    required this.id,
    required this.label,
    this.group,
    this.labelKey,
    required FutureOr<Object?> Function(Map<String, Object?> params) onPressed,
  }) : kind = DurbunActionKind.button,
       options = const [],
       _onPressed = onPressed,
       _boolValue = null,
       _onToggle = null,
       _stringValue = null,
       _onSelect = null;

  /// An on/off switch. [value] reports the current state.
  DurbunAction.toggle({
    required this.id,
    required this.label,
    this.group,
    this.labelKey,
    required bool Function() value,
    required FutureOr<void> Function(bool value) onChanged,
  }) : kind = DurbunActionKind.toggle,
       options = const [],
       _onPressed = null,
       _boolValue = value,
       _onToggle = onChanged,
       _stringValue = null,
       _onSelect = null;

  /// A choice between [options]. [value] reports the current option value.
  DurbunAction.select({
    required this.id,
    required this.label,
    this.group,
    this.labelKey,
    required this.options,
    required String Function() value,
    required FutureOr<void> Function(String value) onChanged,
  }) : kind = DurbunActionKind.select,
       _onPressed = null,
       _boolValue = null,
       _onToggle = null,
       _stringValue = value,
       _onSelect = onChanged;

  /// Stable id, e.g. `flutter.debugPaint` or `app.clearCache`.
  final String id;

  /// Whether this is a toggle, a select or a button (set by the
  /// constructor used).
  final DurbunActionKind kind;

  /// English label (fallback when the desktop has no translation).
  final String label;

  /// Grouping on the desktop, e.g. `flutter`.
  final String? group;

  /// Optional i18n key for the desktop UI.
  final String? labelKey;

  /// The choices of a select action, in display order; empty for toggles
  /// and buttons.
  final List<DurbunActionOption> options;

  final FutureOr<Object?> Function(Map<String, Object?> params)? _onPressed;
  final bool Function()? _boolValue;
  final FutureOr<void> Function(bool value)? _onToggle;
  final String Function()? _stringValue;
  final FutureOr<void> Function(String value)? _onSelect;

  /// Current value (`bool` for toggles, `String` for selects, null for buttons).
  Object? get currentValue {
    try {
      return switch (kind) {
        DurbunActionKind.toggle => _boolValue!(),
        DurbunActionKind.select => _stringValue!(),
        DurbunActionKind.button => null,
      };
    } catch (_) {
      return null;
    }
  }

  /// Descriptor in the wire format (`AppActionDescriptor`).
  Map<String, Object?> describe() {
    final value = currentValue;
    return <String, Object?>{
      'id': id,
      'kind': kind.name,
      'label': label,
      if (labelKey != null) 'labelKey': labelKey,
      if (group != null) 'group': group,
      if (kind == DurbunActionKind.select)
        'options': [
          for (final o in options) {'value': o.value, 'label': o.label},
        ],
      if (value != null) 'value': value,
    };
  }

  /// Runs the action for a desktop command. Toggles accept
  /// `{value|enabled|on: bool}` (missing → flip), selects accept
  /// `{value|option|mode: String}`. Returns the command result data.
  Future<Object?> invoke(Map<String, Object?> params) async {
    switch (kind) {
      case DurbunActionKind.button:
        return await _onPressed!(params);
      case DurbunActionKind.toggle:
        final requested = parseBoolParam(
          params['value'] ?? params['enabled'] ?? params['on'],
        );
        final current = _boolValue!();
        await _onToggle!(requested ?? !current);
        return <String, Object?>{'value': _boolValue()};
      case DurbunActionKind.select:
        final raw = params['value'] ?? params['option'] ?? params['mode'];
        if (raw == null) {
          throw ArgumentError('Missing "value" parameter for $id');
        }
        final wanted = raw.toString();
        final match = options.where(
          (o) => o.value.toLowerCase() == wanted.toLowerCase(),
        );
        if (match.isEmpty) {
          throw ArgumentError(
            'Unknown option "$wanted" for $id '
            '(expected one of ${options.map((o) => o.value).join(', ')})',
          );
        }
        await _onSelect!(match.first.value);
        return <String, Object?>{'value': _stringValue!()};
    }
  }
}

/// A mock rule decision for HTTP stacks that do not use dart:io (e.g. Dio
/// with a native adapter). See `DurbunNetwork.findMock`.
class DurbunMockDecision {
  /// A decision; `DurbunNetwork.findMock` builds these from the desktop's
  /// rules.
  const DurbunMockDecision({
    required this.ruleId,
    required this.ruleLabel,
    required this.type,
    this.status = 200,
    this.headers = const <List<String>>[],
    this.body = const <int>[],
    this.delay = Duration.zero,
    this.failure = 'connection',
    this.message,
  });

  /// Id of the desktop rule that matched; pass it to `DurbunNetwork.begin`
  /// as `mockRuleId` so the request is shown as mocked.
  final String ruleId;

  /// The rule's name (or its URL pattern) for logs and error messages.
  final String ruleLabel;

  /// `respond` | `delay` | `fail`.
  final String type;

  /// respond: status, `[name, value]` headers and decoded body bytes.
  final int status;

  /// respond: response headers as `[name, value]` pairs.
  final List<List<String>> headers;

  /// respond: the response body, already decoded (not compressed).
  final List<int> body;

  /// Wait before responding / sending / failing.
  final Duration delay;

  /// fail: `timeout` | `connection` | `dns` | `tls` | `custom`.
  final String failure;

  /// fail: the error text to throw (`custom`), or null for the platform's
  /// usual message of that [failure].
  final String? message;
}

/// Reporting handle for one request made outside dart:io.
abstract class DurbunHttpCall {
  /// Request id within this app session.
  String get id;

  /// Reports the response (once). [body] is the decoded body (or its first
  /// `DurbunNetwork.maxBodyBytes` bytes or more); the SDK truncates it to the
  /// desktop's limit. [bodySize]: the whole body's size when [body] is only a
  /// prefix of it (or null was passed to save the work).
  void response({
    required int status,
    String? statusText,
    List<List<String>> headers = const <List<String>>[],
    List<int>? body,
    String? contentType,
    int? bodySize,
  });

  /// Reports a failure (once).
  void error(Object error, {bool cancelled = false});
}

/// Parses a loosely typed boolean command parameter.
bool? parseBoolParam(Object? value) {
  if (value is bool) return value;
  if (value is num) return value != 0;
  if (value is String) {
    switch (value.trim().toLowerCase()) {
      case 'true':
      case '1':
      case 'on':
      case 'yes':
      case 'enabled':
        return true;
      case 'false':
      case '0':
      case 'off':
      case 'no':
      case 'disabled':
        return false;
    }
  }
  return null;
}
