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

/// Slack Web API answers are small; an upload URL is a few hundred characters.
const int _maxApiAnswerChars = 64 * 1024;

/// A screenshot can take a while on a slow network.
const Duration _uploadTimeout = Duration(seconds: 60);

/// Posts [form] to the Slack Web API method at [url] with the bot [token]
/// (`Authorization: Bearer`), with a client Dürbün does not capture (the
/// token must not land in the request list). No redirects. Returns the HTTP
/// status and the JSON answer, or status 0 and why no answer came; never
/// throws.
Future<({int status, String answer})> postSlackForm(String url, String token, Map<String, String> form) async {
  final client = DurbunHttpOverrides.uncapturedClient()..connectionTimeout = _timeout;
  try {
    final req = await client.postUrl(Uri.parse(url)).timeout(_timeout);
    req.followRedirects = false;
    req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    req.headers.contentType = ContentType('application', 'x-www-form-urlencoded', charset: 'utf-8');
    req.add(utf8.encode(Uri(queryParameters: form).query));
    final res = await req.close().timeout(_timeout);
    final answer = (await res.transform(const Utf8Decoder(allowMalformed: true)).join().timeout(_timeout)).trim();
    return (status: res.statusCode, answer: answer.length > _maxApiAnswerChars ? answer.substring(0, _maxApiAnswerChars) : answer);
  } on TimeoutException {
    return (status: 0, answer: 'timeout');
  } catch (e) {
    return (status: 0, answer: '$e');
  } finally {
    client.close(force: true);
  }
}

/// Posts [bytes] (the screenshot) to the one-time upload [url] Slack gave,
/// without the token and without following redirects. Returns the HTTP
/// status and Slack's answer, or status 0 and why; never throws.
Future<({int status, String answer})> postSlackBytes(String url, List<int> bytes) async {
  final client = DurbunHttpOverrides.uncapturedClient()..connectionTimeout = _timeout;
  try {
    final req = await client.postUrl(Uri.parse(url)).timeout(_timeout);
    req.followRedirects = false;
    req.headers.contentType = ContentType('application', 'octet-stream');
    req.contentLength = bytes.length;
    req.add(bytes);
    final res = await req.close().timeout(_uploadTimeout);
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
