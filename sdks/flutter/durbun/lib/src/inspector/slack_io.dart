import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/http/http_client.dart' show DurbunHttpOverrides;

bool get canSendToSlack => true;

const Duration _timeout = Duration(seconds: 15);

/// Slack's answer, as much as a snack bar shows.
const int _maxAnswerChars = 200;

/// Posts [payload] as JSON to [webhook] with a client Dürbün does not
/// capture (the webhook URL must not land in the request list). Redirects
/// are not followed: they would carry the message somewhere the developer did
/// not set. Returns the HTTP status and Slack's answer, or status 0 and why
/// no answer came; never throws.
Future<({int status, String answer})> postToSlack(String webhook, Map<String, Object?> payload) async {
  final client = DurbunHttpOverrides.uncapturedClient()..connectionTimeout = _timeout;
  try {
    final req = await client.postUrl(Uri.parse(webhook)).timeout(_timeout);
    req.followRedirects = false;
    req.headers.contentType = ContentType.json;
    req.add(utf8.encode(jsonEncode(payload)));
    final res = await req.close().timeout(_timeout);
    final answer = (await res.transform(const Utf8Decoder(allowMalformed: true)).join().timeout(_timeout)).trim();
    return (status: res.statusCode, answer: answer.length > _maxAnswerChars ? answer.substring(0, _maxAnswerChars) : answer);
  } on TimeoutException {
    return (status: 0, answer: 'timeout');
  } catch (e) {
    return (status: 0, answer: '$e');
  } finally {
    client.close(force: true);
  }
}
