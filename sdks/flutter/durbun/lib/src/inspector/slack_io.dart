import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/http/http_client.dart' show DurbunHttpOverrides;

bool get canSendToSlack => true;

const Duration _timeout = Duration(seconds: 15);

/// Slack's answer, as much as a snack bar shows.
const int _maxAnswerChars = 200;

/// Posts [text] to [webhook] with a client Dürbün does not capture (the
/// webhook URL must not land in the request list). Link previews stay off:
/// URLs in a report may be internal. Redirects are not followed: they would
/// carry the message somewhere the developer did not set.
Future<String?> postToSlack(String webhook, String text) async {
  final client = DurbunHttpOverrides.uncapturedClient()..connectionTimeout = _timeout;
  try {
    final req = await client.postUrl(Uri.parse(webhook)).timeout(_timeout);
    req.followRedirects = false;
    req.headers.contentType = ContentType.json;
    req.add(utf8.encode(jsonEncode(<String, Object?>{'text': text, 'unfurl_links': false, 'unfurl_media': false})));
    final res = await req.close().timeout(_timeout);
    final answer = (await res.transform(utf8.decoder).join().timeout(_timeout)).trim();
    if (res.statusCode >= 200 && res.statusCode < 300) return null;
    if (answer.isEmpty) return 'HTTP ${res.statusCode}';
    return answer.length > _maxAnswerChars ? answer.substring(0, _maxAnswerChars) : answer;
  } on TimeoutException {
    return 'timeout';
  } catch (e) {
    return '$e';
  } finally {
    client.close(force: true);
  }
}
