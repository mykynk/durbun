import 'dart:io';

import 'store.dart';

bool get canReplay => true;

/// Sends [call] again (method, URL, headers, captured text or binary body).
/// Returns null on success, else the error text.
Future<String?> replayCall(InspectorCall call) async {
  final client = HttpClient();
  try {
    final req = await client.openUrl(call.method, Uri.parse(call.url)).timeout(const Duration(seconds: 30));
    for (final h in call.requestHeaders) {
      final n = h[0].toLowerCase();
      if (n.startsWith(':') || n == 'content-length' || n == 'host' || n == 'connection' || n == 'transfer-encoding') continue;
      // A redacted value would only fail the request.
      if (h[1] == '••••') continue;
      req.headers.add(h[0], h[1], preserveHeaderCase: true);
    }
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
