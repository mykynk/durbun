import 'dart:async';
import 'dart:typed_data';

import 'package:durbun/durbun.dart';
import 'package:http/http.dart' as http;

/// Reports the requests of any package:http client (CronetClient,
/// OkHttpClient, …) to Dürbün. The response still streams to your code
/// chunk by chunk; only its first DurbunNetwork.maxBodyBytes bytes are copied
/// for the report, which is sent when the body ends, fails or is cancelled.
/// Server-Sent Events are reported one event at a time while the Mac app
/// asks for them.
class DurbunReportingClient extends http.BaseClient {
  DurbunReportingClient(this._inner, {this.source = 'cronet'});

  final http.Client _inner;
  final String source;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final call = DurbunNetwork.begin(
      method: request.method,
      url: request.url,
      headers: [for (final h in request.headers.entries) [h.key, h.value]],
      body: request is http.Request ? request.bodyBytes : null,
      contentType: request.headers['content-type'],
      source: source,
    );
    if (call == null) return _inner.send(request); // Dürbün is off
    final http.StreamedResponse response;
    try {
      response = await _inner.send(request);
    } catch (e) {
      call.error(e);
      rethrow;
    }
    final headers = [for (final h in response.headers.entries) [h.key, h.value]];
    final events = (response.headers['content-type'] ?? '').startsWith('text/event-stream')
        ? call.eventStream(status: response.statusCode, statusText: response.reasonPhrase, headers: headers)
        : null;
    if (events != null) return _withBody(response, events.tap(response.stream));

    final limit = DurbunNetwork.captureBodies ? DurbunNetwork.maxBodyBytes : 0;
    final copy = BytesBuilder(copy: false);
    var size = 0;
    var ended = false;
    void end([Object? error, bool cancelled = false]) {
      if (ended) return;
      ended = true;
      if (error != null) {
        call.error(error, cancelled: cancelled);
        return;
      }
      call.response(
        status: response.statusCode,
        statusText: response.reasonPhrase,
        headers: headers,
        body: copy.takeBytes(),
        bodySize: size,
        contentType: response.headers['content-type'],
      );
    }

    final body = StreamController<List<int>>(sync: true);
    body.onListen = () {
      final sub = response.stream.listen(
        (chunk) {
          if (size < limit) {
            copy.add(chunk.length <= limit - size ? chunk : chunk.sublist(0, limit - size));
          }
          size += chunk.length;
          body.add(chunk);
        },
        onError: (Object e, StackTrace st) {
          end(e);
          body.addError(e, st);
        },
        onDone: () {
          end();
          body.close();
        },
      );
      body
        ..onPause = sub.pause
        ..onResume = sub.resume
        ..onCancel = () {
          end('cancelled', true);
          return sub.cancel();
        };
    };
    return _withBody(response, body.stream);
  }

  http.StreamedResponse _withBody(http.StreamedResponse response, Stream<List<int>> body) {
    return http.StreamedResponse(
      body,
      response.statusCode,
      contentLength: response.contentLength,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  @override
  void close() => _inner.close();
}
