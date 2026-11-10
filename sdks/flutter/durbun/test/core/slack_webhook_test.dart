import 'package:durbun/src/core/env/environment.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Slack webhook: the option wins, https only, nothing without one', () {
    expect(resolveSlackWebhook(' https://hooks.slack.com/services/T/B/x '), 'https://hooks.slack.com/services/T/B/x');
    for (final bad in <String?>[null, '', '  ', 'http://hooks.slack.com/services/T/B/x', 'hooks.slack.com/x', 'https://u:p@hooks.slack.com/x']) {
      // No --dart-define=DURBUN_SLACK_WEBHOOK under `flutter test`.
      expect(resolveSlackWebhook(bad), isNull, reason: '$bad');
    }
  });
}
