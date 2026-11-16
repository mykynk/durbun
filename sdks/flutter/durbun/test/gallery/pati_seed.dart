// Realistic data for the panel gallery: "Pati", a pet care app, a few
// minutes into a session.
import 'dart:convert';
import 'dart:typed_data';

import 'package:durbun/src/core/body.dart' show wireBodyFromPending;
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/inspector/store.dart';

PendingBody jsonBody(Object value, {String contentType = 'application/json; charset=utf-8'}) {
  final bytes = Uint8List.fromList(utf8.encode(value is String ? value : jsonEncode(value)));
  return PendingBody(bytes: bytes, size: bytes.length, truncated: false, limit: 1 << 22, capture: true, contentType: contentType);
}

const List<String> _names = <String>[
  'Luna', 'Pamuk', 'Zeytin', 'Boncuk', 'Karamel', 'Tarçın', 'Fıstık', 'Duman', 'Mia', 'Paşa',
  'Limon', 'Bal', 'Şans', 'Çakıl', 'Mırnav', 'Kont', 'Leo', 'Kuki', 'Maya', 'Badem',
];
const List<String> _breeds = <String>['Tekir', 'British Shorthair', 'Golden Retriever', 'Van Kedisi', 'Beagle', 'Sokak köpeği'];

Map<String, Object?> petsPage(int page, {int count = 36, int seed = 0}) => <String, Object?>{
      'page': page,
      'pageSize': count,
      'total': 46,
      'items': <Object?>[
        for (var i = 0; i < count; i++)
          <String, Object?>{
            'id': 400 + i,
            'name': _names[(i + seed) % _names.length],
            'species': i % 3 == 0 ? 'dog' : 'cat',
            'breed': _breeds[i % _breeds.length],
            'birthDate': '20${18 + i % 6}-0${1 + i % 9}-1${i % 9}',
            'weightKg': double.parse((3.4 + i * 0.65).toStringAsFixed(1)),
            'vaccinated': i % 4 != 0,
            'microchip': i % 5 == 0 ? null : '9001${(870000000 + i * 7919).toString()}',
            'owner': <String, Object?>{'id': 8812, 'name': 'Ayşe Demir', 'city': 'İstanbul'},
            'photos': <String>['https://cdn.pati.app/img/pets/${400 + i}-640.jpg'],
            'tags': <String>[if (i % 2 == 0) 'indoor', if (i % 3 == 0) 'senior', 'insured'],
          },
      ],
    };

const String _vetStack = '#0      VetRepository.appointments (package:pati/data/vet_repository.dart:84:7)\n'
    '<asynchronous suspension>\n'
    '#1      AppointmentsCubit.load (package:pati/features/vet/appointments_cubit.dart:41:22)\n'
    '<asynchronous suspension>\n'
    '#2      _AppointmentsPageState.initState.<anonymous closure> (package:pati/features/vet/appointments_page.dart:58:5)\n'
    '#3      _rootRun (dart:async/zone.dart:1525:47)\n'
    '#4      _CustomZone.run (dart:async/zone.dart:1422:19)\n'
    '#5      _CustomZone.runGuarded (dart:async/zone.dart:1321:7)\n'
    '#6      _CustomZone.bindCallbackGuarded.<anonymous closure> (dart:async/zone.dart:1362:23)\n'
    '#7      _microtaskLoop (dart:async/schedule_microtask.dart:40:21)\n'
    '#8      _startMicrotaskLoop (dart:async/schedule_microtask.dart:49:5)';

const String _crashStack = '#0      CartController.checkout (package:pati/features/cart/cart_controller.dart:132:9)\n'
    '#1      _CheckoutButton.build.<anonymous closure> (package:pati/features/cart/checkout_button.dart:27:31)\n'
    '#2      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1176:21)\n'
    '#3      GestureRecognizer.invokeCallback (package:flutter/src/gestures/recognizer.dart:351:24)\n'
    '#4      TapGestureRecognizer.handleTapUp (package:flutter/src/gestures/tap.dart:656:11)';

Map<String, Object?> patiHello() => buildHello(
      app: <String, Object?>{'name': 'Pati', 'id': 'app.pati.mobile', 'version': '3.4.0', 'build': '412'},
      device: <String, Object?>{
        'platform': 'android',
        'osVersion': '14',
        'model': 'Galaxy A73',
        'manufacturer': 'Samsung',
        'name': 'SM-A736B',
        'isPhysical': true,
      },
      session: 'gallery',
      capabilities: const <String>['logs', 'network', 'crash', 'metrics'],
      actions: const <Map<String, Object?>>[],
      layers: const <String>['flutter', 'android'],
    );

/// Requests, logs and samples of the session. [now] is "now" in ms.
DurbunInspectorStore patiStore({double? now, bool withMetrics = true}) {
  final end = now ?? DateTime.now().millisecondsSinceEpoch.toDouble();
  final t0 = end - 4 * 60 * 1000;
  final s = DurbunInspectorStore(notifyDelay: Duration.zero)..bodyResolver = wireBodyFromPending;
  s.ingest(patiHello());
  const api = 'https://api.pati.app';
  const json = <List<String>>[
    <String>['Content-Type', 'application/json; charset=utf-8'],
  ];
  const auth = <List<String>>[
    <String>['Accept', 'application/json'],
    <String>['Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI4ODEyIiwibmFtZSI6IkF5xZ9lIERlbWlyIiwiaWF0IjoxNzk0ODM4MDAwfQ.Qm9uY3VrUGFtdWtMdW5h'],
    <String>['User-Agent', 'Pati/3.4.0 (Android 14; SM-A736B) Dart/3.9'],
    <String>['X-Request-Id', 'b7c1f0e2-4a59-4d1e-9a3f-2c8e5d7a1b90'],
  ];
  const resHeaders = <List<String>>[
    <String>['Content-Type', 'application/json; charset=utf-8'],
    <String>['Cache-Control', 'private, max-age=0'],
    <String>['Server', 'nginx/1.27.2'],
    <String>['Set-Cookie', 'pati_sid=4f1c9e7a; Path=/; HttpOnly; Secure; SameSite=Lax'],
    <String>['X-Request-Id', 'b7c1f0e2-4a59-4d1e-9a3f-2c8e5d7a1b90'],
    <String>['Date', 'Mon, 16 Nov 2026 14:31:12 GMT'],
  ];
  var t = t0;
  double next(double ms) => t += ms;

  void call(String id, String method, String url,
      {int? status,
      double start = 0,
      double took = 120,
      Object? reqBody,
      Object? resBody,
      String? error,
      bool mocked = false,
      String source = 'dart:io',
      Map<String, Object?>? timings,
      List<List<String>> reqHeaders = auth,
      List<List<String>> res = resHeaders,
      String contentType = 'application/json; charset=utf-8'}) {
    final at = next(start);
    s.ingest(buildNetRequest(
        id: id, ts: at, method: method, url: url, headers: reqHeaders, body: reqBody == null ? null : jsonBody(reqBody), source: source));
    if (error != null) {
      s.ingest(buildNetError(id: id, ts: at + took, error: error));
    } else if (status != null) {
      s.ingest(buildNetResponse(
        id: id,
        ts: at + took,
        status: status,
        headers: res,
        body: resBody == null ? null : jsonBody(resBody, contentType: contentType),
        protocol: 'h2',
        remoteAddress: '104.21.48.17:443',
        timings: timings ?? <String, Object?>{'dns': 8, 'connect': 21, 'tls': 34, 'send': 2, 'wait': (took * 0.7).round(), 'receive': (took * 0.1).round()},
        mocked: mocked,
        mockRuleId: mocked ? 'rule-promos' : null,
      ));
    }
  }

  s.ingest(buildLog(level: 'info', message: 'Pati 3.4.0 (412) açıldı', tag: 'app', ts: next(200)));
  s.ingest(buildLog(level: 'debug', message: 'Önbellekten 24 hayvan okundu (12 KB)', tag: 'cache', ts: next(40)));
  call('1', 'POST', '$api/v2/auth/token',
      status: 200,
      start: 300,
      took: 212,
      reqHeaders: json,
      reqBody: <String, Object?>{'grant_type': 'refresh_token', 'refresh_token': 'rt_4f1c9e7a2b'},
      resBody: <String, Object?>{'access_token': 'eyJhbGciOiJIUzI1NiJ9.e30.x', 'expires_in': 3600, 'token_type': 'Bearer'});
  s.ingest(buildLog(level: 'info', message: 'Kullanıcı girişi tamam (id 8812)', tag: 'auth', ts: next(30)));
  call('2', 'GET', '$api/v2/pets?owner=8812&page=1', status: 200, start: 120, took: 340, resBody: petsPage(1));
  // Long-lived connections: a chat WebSocket (101) and a live feed of
  // Server-Sent Events, both still open, with their messages.
  final wsAt = next(80);
  s.ingest(buildNetRequest(id: '20', ts: wsAt, method: 'GET', url: 'wss://api.pati.app/v2/chat?room=8812', headers: <List<String>>[
    ...auth,
    <String>['Upgrade', 'websocket'],
    <String>['Connection', 'Upgrade'],
    <String>['Sec-WebSocket-Version', '13'],
    <String>['Sec-WebSocket-Extensions', 'permessage-deflate; client_max_window_bits'],
  ]));
  s.ingest(buildNetResponse(
    id: '20',
    ts: wsAt + 96,
    status: 101,
    statusText: 'Switching Protocols',
    headers: <List<String>>[
      <String>['Upgrade', 'websocket'],
      <String>['Connection', 'Upgrade'],
      <String>['Sec-WebSocket-Accept', 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='],
      <String>['Sec-WebSocket-Extensions', 'permessage-deflate'],
    ],
    protocol: 'HTTP/1.1',
    remoteAddress: '104.21.48.17:443',
    timings: <String, Object?>{'connect': 41, 'send': 1, 'wait': 52, 'receive': 0},
  ));
  final sseAt = next(40);
  s.ingest(buildNetRequest(id: '21', ts: sseAt, method: 'GET', url: '$api/v2/live/adoptions', headers: <List<String>>[
    ...auth,
    <String>['Accept', 'text/event-stream'],
  ]));
  s.ingest(buildNetResponse(
    id: '21',
    ts: sseAt + 74,
    status: 200,
    headers: <List<String>>[
      <String>['Content-Type', 'text/event-stream; charset=utf-8'],
      <String>['Cache-Control', 'no-cache'],
    ],
    protocol: 'HTTP/1.1',
    remoteAddress: '104.21.48.17:443',
    timings: <String, Object?>{'connect': 0, 'send': 1, 'wait': 70, 'receive': 0},
  ));
  addChatMessages(s, '20', wsAt + 96, end);
  addAdoptionEvents(s, '21', sseAt + 74, end);
  for (var i = 0; i < 3; i++) {
    s.ingest(buildLog(level: 'verbose', message: 'Konum izni zaten verilmiş', tag: 'location', ts: next(15)));
  }
  call('3', 'GET', 'https://cdn.pati.app/img/pets/412-640.jpg',
      status: 200,
      start: 90,
      took: 2410,
      reqHeaders: const <List<String>>[
        <String>['Accept', 'image/*']
      ],
      res: const <List<String>>[
        <String>['Content-Type', 'image/jpeg'],
        <String>['Content-Length', '84213'],
        <String>['Cache-Control', 'public, max-age=31536000, immutable'],
      ]);
  s.ingest(buildLog(level: 'warn', message: 'Görsel yavaş yüklendi (2,4 sn): 412-640.jpg', tag: 'image', ts: next(10)));
  call('4', 'POST', '$api/graphql',
      status: 200,
      start: 400,
      took: 186,
      reqBody: <String, Object?>{
        'operationName': 'VetAppointments',
        'query': r'query VetAppointments($petId: ID!) { appointments(petId: $petId) { id date vet { name clinic } } }',
        'variables': <String, Object?>{'petId': '412'},
      },
      resBody: <String, Object?>{
        'data': <String, Object?>{
          'appointments': <Object?>[
            <String, Object?>{'id': 'apt_91', 'date': '2026-11-21T10:30:00+03:00', 'vet': <String, Object?>{'name': 'Dr. Elif Kaya', 'clinic': 'Moda Veteriner'}},
            <String, Object?>{'id': 'apt_97', 'date': '2026-12-04T15:00:00+03:00', 'vet': <String, Object?>{'name': 'Dr. Can Aydın', 'clinic': 'Moda Veteriner'}},
          ],
        },
      });
  s.ingest(buildEvent(name: 'add_to_cart', props: <String, Object?>{'sku': 'MAMA-KEDI-12KG', 'price': 649.9, 'currency': 'TRY'}, ts: next(600)));
  call('5', 'PUT', '$api/v2/pets/412',
      status: 200,
      start: 300,
      took: 158,
      reqBody: <String, Object?>{'name': 'Luna', 'weightKg': 4.6, 'vaccinated': true},
      resBody: <String, Object?>{'id': 412, 'name': 'Luna', 'weightKg': 4.6, 'vaccinated': true, 'updatedAt': '2026-11-16T14:31:40Z'});
  call('6', 'PATCH', '$api/v2/users/me/settings', status: 204, start: 260, took: 97, reqBody: <String, Object?>{'notifications': <String, Object?>{'vaccineReminders': true}});
  call('7', 'DELETE', '$api/v2/cart/items/77',
      status: 404,
      start: 500,
      took: 74,
      resBody: <String, Object?>{'error': 'not_found', 'message': 'Sepette bu ürün yok', 'itemId': 77});
  call('8', 'GET', '$api/v2/vets/nearby?lat=41.0422&lng=29.0083&radius=3000',
      status: 500,
      start: 700,
      took: 3420,
      timings: <String, Object?>{'dns': 12, 'connect': 26, 'tls': 41, 'send': 1, 'wait': 3290, 'receive': 50},
      resBody: <String, Object?>{'error': 'internal', 'message': 'upstream timeout: geo-service', 'traceId': '7d2a9c1e'});
  s.ingest(buildLog(
      level: 'error',
      message: 'Randevular yüklenemedi',
      tag: 'vet',
      ts: next(20),
      error: buildErrorInfo(type: 'DioException', message: '[bad response] 500 Internal Server Error', stack: _vetStack)));
  call('9', 'GET', '$api/v2/feed?since=2026-11-16T14:00:00Z', start: 800, took: 15000, error: 'TimeoutException after 0:00:15.000000: Future not completed');
  call('10', 'GET', '$api/v2/promotions', status: 200, start: 300, took: 4, mocked: true, resBody: <String, Object?>{
    'items': <Object?>[
      <String, Object?>{'id': 'kis-25', 'title': 'Kış kampanyası', 'discount': 25},
    ],
  });
  call('11', 'POST', 'https://events.pati.app/v1/track',
      status: 202, start: 200, took: 63, source: 'okhttp', reqBody: <String, Object?>{'event': 'add_to_cart', 'sku': 'MAMA-KEDI-12KG'});
  s.ingest(buildLog(
      level: 'info',
      message: 'Sepet güncellendi',
      tag: 'cart',
      ts: next(40),
      data: <String, Object?>{'items': 3, 'total': 1849.7, 'currency': 'TRY'}));
  call('12', 'GET', '$api/v2/pets?owner=8812&page=1', status: 200, start: 900, took: 298, resBody: petsPage(1, seed: 3));
  s.ingest(buildLog(
      level: 'fatal',
      message: 'Unhandled exception: Bad state: Cart is empty',
      kind: 'crash',
      ts: next(500),
      error: buildErrorInfo(type: 'StateError', message: 'Bad state: Cart is empty', stack: _crashStack)));
  // Still waiting.
  s.ingest(buildNetRequest(id: '13', ts: end - 1800, method: 'GET', url: '$api/v2/notifications?unread=true', headers: auth));

  if (withMetrics) {
    for (var i = 0; i < 90; i++) {
      final jank = i == 22 || i == 23 || i == 58 || i == 71;
      s.ingest(buildMetric(
        ts: end - (90 - i) * 1000,
        fps: jank ? (i == 22 ? 31 : 44) : 58 + (i % 3).toDouble(),
        jankyFrames: jank ? (i == 22 ? 14 : 6) : (i % 17 == 0 ? 1 : 0),
        frameBuildMs: jank ? 21.5 : 3.2 + (i % 5) * 0.4,
        frameRasterMs: jank ? 18.3 : 4.1 + (i % 4) * 0.5,
        memoryMB: 182 + i * 0.6 + (jank ? 14 : 0),
        cpu: jank ? 61 : 9 + (i % 7) * 2.5,
        threads: 41,
      ));
    }
  }
  return s;
}

PendingBody textBody(String text) => jsonBody(text, contentType: 'text/plain; charset=utf-8');

/// A JPEG's first bytes and filler (a photo sent in chunks).
Uint8List jpegChunk(int size) {
  final b = Uint8List(size);
  const head = <int>[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48];
  for (var i = 0; i < size; i++) {
    b[i] = i < head.length ? head[i] : (i * 31 + 7) & 0xff;
  }
  return b;
}

/// A vet chat over the WebSocket of request [id], opened at [openTs]: sign
/// in, subscribe, history, messages both ways, a photo, keep-alives. The
/// last message arrives a few seconds before [end].
void addChatMessages(DurbunInspectorStore s, String id, double openTs, double end) {
  var at = openTs;
  void ws(String dir, double after, Object value, {String opcode = 'text'}) {
    at += after;
    final text = value is String ? value : jsonEncode(value);
    final body = textBody(text);
    s.ingest(buildNetWs(id: id, ts: at, dir: dir, opcode: opcode, size: body.size, body: body));
  }

  void control(String dir, double after, String opcode) {
    at += after;
    s.ingest(buildNetWs(id: id, ts: at, dir: dir, opcode: opcode, size: 0));
  }

  void binary(String dir, double after, int size) {
    at += after;
    final bytes = jpegChunk(size);
    s.ingest(buildNetWs(
        id: id,
        ts: at,
        dir: dir,
        opcode: 'binary',
        size: size,
        body: PendingBody(bytes: bytes, size: size, truncated: false, limit: 1 << 16, capture: true, contentType: 'application/octet-stream')));
  }

  ws('out', 38, <String, Object?>{'type': 'auth', 'token': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4ODEyIn0.c2lnbmF0dXJl'});
  ws('in', 61, <String, Object?>{'type': 'auth.ok', 'userId': 8812, 'session': 'ws_5d1e'});
  ws('out', 12, <String, Object?>{'type': 'subscribe', 'room': '8812', 'since': '2026-11-16T14:00:00Z'});
  ws('in', 84, <String, Object?>{
    'type': 'history',
    'room': '8812',
    'messages': <Object?>[
      <String, Object?>{'id': 'm_17', 'from': 'Dr. Elif Kaya', 'text': 'Merhaba Ayşe Hanım, Luna nasıl?', 'at': '2026-11-16T14:02:10+03:00'},
      <String, Object?>{'id': 'm_18', 'from': 'Ayşe Demir', 'text': 'İştahı yerinde, aşı sonrası biraz uyudu.', 'at': '2026-11-16T14:03:41+03:00'},
    ],
  });
  ws('in', 2400, <String, Object?>{'type': 'typing', 'from': 'Dr. Elif Kaya'});
  ws('in', 1900, <String, Object?>{
    'type': 'message',
    'id': 'm_19',
    'from': 'Dr. Elif Kaya',
    'text': 'Luna’nın aşı kartının fotoğrafını gönderebilir misiniz?',
    'at': '2026-11-16T14:31:02+03:00',
  });
  ws('out', 5200, <String, Object?>{'type': 'message', 'clientId': 'c_7', 'text': 'Tabii, hemen gönderiyorum.'});
  ws('in', 140, <String, Object?>{'type': 'ack', 'clientId': 'c_7', 'id': 'm_20'});
  binary('out', 3100, 18842);
  ws('in', 690, <String, Object?>{'type': 'upload.ok', 'fileId': 'f_311', 'size': 18842, 'mime': 'image/jpeg'});
  control('in', 9000, 'ping');
  control('out', 2, 'pong');
  ws('in', 4100, <String, Object?>{'type': 'presence', 'user': 'Dr. Elif Kaya', 'status': 'online'});
  ws('in', 6400, <String, Object?>{
    'type': 'message',
    'id': 'm_21',
    'from': 'Dr. Elif Kaya',
    'text': 'Teşekkürler, kart güncel. Bir sonraki karma aşı 21 Kasım’da.',
    'at': '2026-11-16T14:31:48+03:00',
  });
  ws('out', 3800, <String, Object?>{'type': 'typing', 'room': '8812'});
  ws('out', 2100, <String, Object?>{'type': 'message', 'clientId': 'c_8', 'text': 'Randevuyu 10:30’a alabilir miyiz?'});
  ws('in', 160, <String, Object?>{'type': 'ack', 'clientId': 'c_8', 'id': 'm_22'});
  control('in', 30000, 'ping');
  control('out', 2, 'pong');
  ws('in', 8200, <String, Object?>{'type': 'appointment.proposed', 'id': 'apt_91', 'date': '2026-11-21T10:30:00+03:00', 'clinic': 'Moda Veteriner'});
  ws('out', 4400, <String, Object?>{'type': 'appointment.accept', 'id': 'apt_91'});
  ws('in', 210, <String, Object?>{'type': 'appointment.confirmed', 'id': 'apt_91', 'reminder': '2026-11-20T18:00:00+03:00'});
  control('in', 30000, 'ping');
  control('out', 2, 'pong');
  ws('in', 1200, <String, Object?>{'type': 'read', 'upTo': 'm_22', 'by': 'Dr. Elif Kaya'});
  ws('in', (end - 6000 - at).clamp(500, 120000).toDouble(), <String, Object?>{'type': 'typing', 'from': 'Dr. Elif Kaya'});
}

/// A live feed of adoptions over the event stream of request [id].
void addAdoptionEvents(DurbunInspectorStore s, String id, double openTs, double end) {
  var at = openTs;
  void ev(double after, Object value, {String? event, String? eventId, int? retry}) {
    at += after;
    final text = value is String ? value : jsonEncode(value);
    final body = textBody(text);
    s.ingest(buildNetSse(id: id, ts: at, event: event, eventId: eventId, retry: retry, size: body.size, body: body));
  }

  ev(12, <String, Object?>{'listening': 'adoptions', 'region': 'istanbul'}, event: 'hello', retry: 3000);
  const pets = <(String, String, String)>[
    ('Boncuk', 'Kadıköy Barınağı', 'cat'),
    ('Karamel', 'Beşiktaş Hayvan Evi', 'dog'),
    ('Fıstık', 'Kadıköy Barınağı', 'cat'),
    ('Paşa', 'Üsküdar Barınağı', 'dog'),
    ('Maya', 'Moda Pati Evi', 'cat'),
    ('Leo', 'Beşiktaş Hayvan Evi', 'dog'),
  ];
  for (var i = 0; i < pets.length; i++) {
    final (name, shelter, species) = pets[i];
    ev(14000 + i * 3100, <String, Object?>{'petId': 512 + i * 7, 'name': name, 'species': species, 'shelter': shelter, 'status': 'adopted'},
        event: 'adoption', eventId: '${1041 + i}');
    if (i == 2) ev(15000, <String, Object?>{'adoptedToday': 14, 'waiting': 236}, event: 'stats', eventId: '1044s');
  }
}

/// Connections in every state, for the messages tab's renders: an open chat,
/// a tracking socket the server closed, a notification socket that broke, an
/// open socket without messages yet, an OkHttp socket this panel cannot
/// follow, a finished event stream and a busy ticker past the ring's size.
DurbunInspectorStore streamsStore({double? now}) {
  final end = now ?? DateTime.now().millisecondsSinceEpoch.toDouble();
  final s = DurbunInspectorStore(notifyDelay: Duration.zero, maxStreamMessages: 80)
    ..bodyResolver = wireBodyFromPending
    ..attached = true;
  s.ingest(patiHello());
  const api = 'https://api.pati.app';
  const upgrade = <List<String>>[
    <String>['Upgrade', 'websocket'],
    <String>['Connection', 'Upgrade'],
    <String>['Sec-WebSocket-Version', '13'],
  ];
  const switched = <List<String>>[
    <String>['Upgrade', 'websocket'],
    <String>['Connection', 'Upgrade'],
    <String>['Sec-WebSocket-Accept', 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='],
  ];
  Uint8List utf(Object v) => Uint8List.fromList(utf8.encode(v is String ? v : jsonEncode(v)));

  /// A WebSocket handshake the SDK follows (or not), opened at [at].
  double open(String id, String url, double at, {bool follow = true, String source = 'dart:io'}) {
    s.ingest(buildNetRequest(id: id, ts: at, method: 'GET', url: url, headers: upgrade, source: source));
    s.ingest(buildNetResponse(
        id: id,
        ts: at + 88,
        status: 101,
        statusText: 'Switching Protocols',
        headers: switched,
        protocol: 'HTTP/1.1',
        timings: <String, Object?>{'connect': 36, 'send': 1, 'wait': 51, 'receive': 0}));
    if (follow) s.streamOpened(id, kind: 'ws', ts: at + 88);
    return at + 88;
  }

  void get(String id, String path, double at) {
    s.ingest(buildNetRequest(id: id, ts: at, method: 'GET', url: '$api$path', headers: const <List<String>>[]));
    s.ingest(buildNetResponse(id: id, ts: at + 142, status: 200, headers: const <List<String>>[], body: jsonBody(<String, Object?>{'ok': true})));
  }

  final t0 = end - 6 * 60 * 1000;
  get('1', '/v2/pets?owner=8812', t0);

  // A courier's location, every 2 s, until the server restarts.
  var at = open('31', 'wss://api.pati.app/v2/tracking/order-7731', t0 + 900);
  for (var i = 0; i < 18; i++) {
    at += 2000;
    final v = utf(<String, Object?>{'orderId': 7731, 'lat': 41.0422 + i * 0.0004, 'lng': 29.0083 - i * 0.0003, 'etaMin': 14 - i ~/ 2});
    s.streamWs('31', at, 'in', 'text', v.length, v, null, null);
  }
  s.streamWs('31', at + 1400, 'in', 'close', 16, null, 1001, 'server restart');
  s.streamWs('31', at + 1403, 'out', 'close', 16, null, 1001, 'server restart');

  // Notifications: a few messages, then the connection resets.
  at = open('32', 'wss://api.pati.app/v2/notifications', t0 + 2100);
  for (final n in <Object>[
    <String, Object?>{'type': 'hello', 'unread': 3},
    <String, Object?>{'type': 'notification', 'id': 'n_88', 'title': 'Aşı hatırlatması', 'body': 'Luna’nın karma aşısı 5 gün sonra'},
    <String, Object?>{'type': 'notification', 'id': 'n_89', 'title': 'Sipariş yolda', 'body': '12 kg kedi maması'},
  ]) {
    at += 4300;
    final v = utf(n);
    s.streamWs('32', at, 'in', 'text', v.length, v, null, null);
  }
  s.streamEnded('32', at + 61000, error: 'SocketException: Connection reset by peer (OS Error: Connection reset by peer, errno = 104), address = api.pati.app, port = 51824');

  // A socket the SDK cannot follow (OkHttp, the Mac not recording).
  open('34', 'wss://events.pati.app/v1/stream', t0 + 2600, follow: false, source: 'okhttp');

  // An event stream the server finished.
  s.ingest(buildNetRequest(id: '35', ts: t0 + 3000, method: 'GET', url: '$api/v2/live/adoptions?region=istanbul', headers: const <List<String>>[
    <String>['Accept', 'text/event-stream'],
  ]));
  s.ingest(buildNetResponse(id: '35', ts: t0 + 3074, status: 200, headers: const <List<String>>[
    <String>['Content-Type', 'text/event-stream; charset=utf-8'],
  ]));
  s.streamOpened('35', kind: 'sse', ts: t0 + 3074);
  at = t0 + 3074;
  const pets = <String>['Boncuk', 'Karamel', 'Fıstık', 'Paşa', 'Maya', 'Leo', 'Zeytin', 'Duman', 'Kuki', 'Badem', 'Tarçın'];
  for (var i = 0; i < pets.length; i++) {
    at += 4200 + i * 900;
    final v = utf(<String, Object?>{'petId': 512 + i * 7, 'name': pets[i], 'shelter': i.isEven ? 'Kadıköy Barınağı' : 'Moda Pati Evi', 'status': 'adopted'});
    s.streamSse('35', at, 'adoption', '${1041 + i}', i == 0 ? 3000 : null, v.length, v);
  }
  s.streamEnded('35', at + 1200);

  // A price ticker: past the ring's 80 messages, the middle goes.
  at = open('36', 'wss://api.pati.app/v2/shop/ticker', t0 + 4000);
  for (var i = 0; i < 260; i++) {
    at += 650;
    final v = utf(<String, Object?>{'sku': 'MAMA-KEDI-12KG', 'price': 649.9 - (i % 7) * 2.5, 'stock': 120 - i ~/ 4, 'seq': i + 1});
    s.streamWs('36', at, 'in', 'text', v.length, v, null, null);
  }

  // Open, nothing sent yet.
  open('33', 'wss://api.pati.app/v2/live/vet-queue?clinic=moda', end - 20000);

  // The vet chat, still open.
  final chatAt = open('30', 'wss://api.pati.app/v2/chat?room=8812', end - 3 * 60 * 1000);
  addChatMessages(s, '30', chatAt, end);
  return s;
}
