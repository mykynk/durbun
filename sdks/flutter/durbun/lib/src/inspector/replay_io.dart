import 'dart:io';

import 'store.dart';

bool get canReplay => true;

/// Puts the captured [headers] on [out] as they were sent. HttpClient sets
/// its own User-Agent and Accept-Encoding: the first captured value replaces
/// its default (adding would send it twice), and one the original did not
/// send is removed.
void replayHeaders(HttpHeaders out, List<List<String>> headers) {
  final seen = <String>{};
  for (final h in headers) {
    if (h.length < 2) continue;
    final n = h[0].toLowerCase();
    if (n.startsWith(':') || n == 'content-length' || n == 'host' || n == 'connection' || n == 'transfer-encoding') continue;
    // A redacted value would only fail the request.
    if (h[1] == '••••') continue;
    if (seen.add(n)) {
      out.set(h[0], h[1], preserveHeaderCase: true);
    } else {
      out.add(h[0], h[1], preserveHeaderCase: true);
    }
  }
  for (final preset in const <String>['user-agent', 'accept-encoding']) {
    if (!seen.contains(preset)) out.removeAll(preset);
  }
}

/// Sends [call] again (method, URL, headers, captured text or binary body).
/// Returns null on success, else the error text.
Future<String?> replayCall(InspectorCall call) async {
  final client = HttpClient();
  try {
    final req = await client.openUrl(call.method, Uri.parse(call.url)).timeout(const Duration(seconds: 30));
    replayHeaders(req.headers, call.requestHeaders);
    final body = call.requestBody;
    if (body != null && body.data.isNotEmpty) req.add(body.bytes);
    final res = await req.close().timeout(const Duration(seconds: 60));
    await res.drain<void>();
    return null;
  } catch (e) {
    return '$e';
  } finally {
    client.close();
  }
}
