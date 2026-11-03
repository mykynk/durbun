/// Texts of the in-app inspector, worded like the desktop UI
/// (`packages/ui/src/features/*/i18n.ts`): Turkish when the app (or the
/// phone) is in Turkish, English otherwise.
library;

import 'package:flutter/widgets.dart';

import 'format.dart' show formatBytes;

class InspectorStrings {
  const InspectorStrings._(this.tr);

  final bool tr;

  static InspectorStrings of(BuildContext context) {
    final locale = Localizations.maybeLocaleOf(context) ?? WidgetsBinding.instance.platformDispatcher.locale;
    return InspectorStrings._(locale.languageCode == 'tr');
  }

  String _(String tr, String en) => this.tr ? tr : en;

  /* shell */
  String get title => 'Dürbün';
  String get logs => _('Loglar', 'Logs');
  String get network => _('Ağ', 'Network');
  String get mocks => _('Mock’lar', 'Mocks');
  String get performance => _('Performans', 'Performance');
  String get device => _('Cihaz', 'Device');
  String get errors => _('Hatalar', 'Errors');
  String get requests => _('İstekler', 'Requests');
  String get clear => _('Temizle', 'Clear');
  String get close => _('Kapat', 'Close');
  String get desktopConnected => _('Masaüstü bağlı', 'Desktop connected');
  String get onPhoneOnly => _('Yalnızca telefonda', 'On the phone only');
  String newItems(int n) => _('$n yeni', '$n new');
  String dropped(int n) => _('Yer açmak için en eski $n kayıt silindi.', 'The oldest $n entries were removed to make room.');
  String get pause => _('Duraklat', 'Pause');
  String get resume => _('Devam et', 'Resume');
  String get noMatchTitle => _('Filtreye uyan kayıt yok', 'Nothing matches the filter');
  String get noMatchBody => _('Aramayı ya da filtreleri değiştirin.', 'Change the search or the filters.');
  String get copied => _('Kopyalandı', 'Copied');
  String get copy => _('Kopyala', 'Copy');
  String get on => _('Açık', 'On');
  String get clearSearch => _('Aramayı temizle', 'Clear search');
  String get queryHelp => _('Arama ifadeleri', 'Search words');
  String get queryHelpBody => _(
    'Düz kelime her yerde arar. Birden çok kelime birlikte aranır; başına - koymak hariç tutar. Eklemek için dokunun.',
    'A plain word searches everywhere. Several words must all match; a leading - excludes. Tap one to add it.',
  );
  String get filters => _('Filtreler', 'Filters');
  String get done => _('Tamam', 'Done');
  String get remove => _('Kaldır', 'Remove');
  String get clearFilters => _('Filtreleri temizle', 'Clear filters');
  String get off => _('Kapalı', 'Off');

  /* logs */
  String get logSearchHint => _('Mesaj, etiket ya da hata ara', 'Search messages, tags, errors');
  String get logFilters => _('Log filtreleri', 'Log filters');
  List<(String, String)> get logQueryHints => <(String, String)>[
    ('tag:auth', _('Etiketi “auth” içerenler', 'Tag contains “auth”')),
    ('level:warn', _('Uyarı ve üstü', 'Warning and above')),
    ('is:error', _('Hatalar ve çökmeler', 'Errors and crashes')),
    ('is:crash', _('Yalnızca çökmeler', 'Crashes only')),
    ('is:event', _('Olaylar (Durbun.event)', 'Events (Durbun.event)')),
    ('is:native', _('Kotlin/Swift logları', 'Kotlin/Swift logs')),
    ('message:"token"', _('Yalnızca mesajda ara', 'Search the message only')),
    ('-tag:analytics', _('Bu etiketi hariç tut', 'Leave this tag out')),
    ('"tam ifade"', _('Boşluklu ifadeyi bir arada ara', 'Search a phrase with spaces')),
  ];
  String get level => _('Seviye', 'Level');
  String get levelHint => _('Seçilen seviye ve üstü gösterilir.', 'The chosen level and above are shown.');
  String get allLevels => _('Tümü', 'All');
  String levelAtLeast(String name) => _('$name+', '$name+');
  String levelName(String level) => switch (level) {
    'verbose' => _('Ayrıntı', 'Verbose'),
    'debug' => 'Debug',
    'info' => _('Bilgi', 'Info'),
    'warn' => _('Uyarı', 'Warning'),
    'error' => _('Hata', 'Error'),
    _ => _('Ölümcül', 'Fatal'),
  };
  String get show => _('Göster', 'Show');
  String get allSources => _('Tümü', 'All');
  String get flutterSource => _('Flutter (Dart)', 'Flutter (Dart)');
  String get nativeSource => _('Native (Kotlin/Swift)', 'Native (Kotlin/Swift)');
  String get showRequests => _('İstekleri akışta göster', 'Show requests in the stream');
  String get showRequestsHint => _('Ağ istekleri loglarla aynı zaman sırasında görünür.', 'Requests appear between the logs, in time order.');
  String get requestsHidden => _('İstekler gizli', 'Requests hidden');
  String get hiddenTagsTitle => _('Gizli etiketler', 'Hidden tags');
  String get hiddenTagsHint => _('Dokunun: yeniden gösterilir.', 'Tap one to show it again.');
  String get onlyErrorsHint => _('Hata, ölümcül ve çökme kayıtları', 'Error, fatal and crash lines');
  String get crashesHint => _('Yakalanmamış hatalar ve Flutter hata kutuları', 'Uncaught errors and Flutter error boxes');
  String get eventsHint => _('Durbun.event ile gönderilenler', 'Sent with Durbun.event');
  String get errorsOnly => _('Sadece hatalar', 'Errors only');
  String get crashes => _('Çökmeler', 'Crashes');
  String get events => _('Olaylar', 'Events');
  String get native => 'Native';
  String get nativeLayer => _('Native katman', 'Native layer');
  String hiddenTags(int n) => _('$n etiket gizli', '$n tags hidden');
  String get noLogsTitle => _('Henüz log yok', 'No logs yet');
  String get noLogsBody => _(
    'Durbun.log, print, debugPrint, Flutter hataları, olaylar ve Kotlin/Swift logları burada akar.',
    'Durbun.log, print, debugPrint, Flutter errors, events and Kotlin/Swift logs stream here.',
  );
  String get event => _('Olay', 'Event');
  String messageCut(int n) => _(
    'Mesajın son $n karakteri telefonda tutulmadı (masaüstüne tamamı gider).',
    'The last $n characters are not kept on the phone (the desktop gets all of it).',
  );
  String get crash => _('Çökme', 'Crash');
  String get message => _('Mesaj', 'Message');
  String get data => _('Veri', 'Data');
  String get stack => _('Yığın izi', 'Stack trace');
  String moreFrames(int n) => _('… $n satır daha', '… $n more frames');
  String repeated(int n) => _('$n kez tekrarlandı', 'repeated $n times');
  String get tagActions => _('Etiket', 'Tag');
  String onlyThisTag(String tag) => _('Yalnızca “$tag”', 'Only “$tag”');
  String hideThisTag(String tag) => _('“$tag” etiketini gizle', 'Hide “$tag”');

  /* network */
  String get netSearchHint => _('Endpoint, host ya da hata ara', 'Search endpoints, hosts, errors');
  String get netFilters => _('İstek filtreleri', 'Request filters');

  /* compare (desktop: network.compare.*) */
  String get compare => _('Karşılaştır', 'Compare');
  String get compareEllipsis => _('Karşılaştır…', 'Compare…');
  String get compareTitle => _('İstekleri karşılaştır', 'Compare requests');
  String get comparePickTitle => _('İkinci isteği seçin', 'Pick the second request');
  String comparePickBase(String name) => _('İlk istek: $name', 'First: $name');
  String get sameEndpoint => _('Aynı endpoint', 'Same endpoint');
  String get otherRequests => _('Diğer istekler', 'Other requests');
  String get noOtherRequests => _('Karşılaştıracak başka istek yok', 'No other request to compare with');
  String get noOtherRequestsBody => _('Aynı isteği uygulamada bir kez daha tetikleyin; burada görünür.', 'Trigger the request once more in the app; it shows up here.');
  String get swap => _('Yer değiştir', 'Swap');
  String get responseBody => _('Yanıt gövdesi', 'Response body');
  String get requestBody => _('İstek gövdesi', 'Request body');
  String get field => _('Alan', 'Field');
  String get missing => _('yok', 'missing');
  String get onlyChanges => _('Yalnızca farklar', 'Only changes');
  String get sortKeys => _('JSON anahtarlarını sırala', 'Sort JSON keys');
  String get requestHeaders => _('İstek başlıkları', 'Request headers');
  String get responseHeaders => _('Yanıt başlıkları', 'Response headers');
  String headerStats(int changed, int total) => _('$changed / $total farklı', '$changed / $total differ');
  String get headersSame => _('Başlıklar aynı.', 'Headers are the same.');
  String get fieldsSame => _('Tüm alanlar aynı.', 'All fields are the same.');
  String get identicalBodies => _('Gövdeler aynı', 'Bodies are identical');
  String get linesChanged => _('satır değişti', 'lines changed');
  String get diffApproximate => _('Çok büyük olduğu için bazı bölümler kaba karşılaştırıldı', 'Some parts were compared coarsely because they are very large');
  String get diffTooLong => _('Yalnızca ilk 20.000 satır karşılaştırıldı', 'Only the first 20,000 lines were compared');
  String get bodyTruncatedOne => _('Gövdelerden biri kesik yakalanmış', 'One of the bodies was captured truncated');
  String get binarySame => _('İkili gövdeler aynı', 'Binary bodies are identical');
  String get binaryDifferent => _('İkili gövdeler farklı', 'Binary bodies differ');
  String binarySizes(String a, String b) => 'A: $a · B: $b';
  String get noRequestBodies => _('İki istekte de gövde yok', 'Neither request has a body');
  String get noResponseBodies => _('İki yanıtta da gövde yok', 'Neither response has a body');
  String showHidden(int n) => _('⋯ $n aynı satırı göster', '⋯ show $n unchanged lines');
  String get comparing => _('Karşılaştırılıyor…', 'Comparing…');
  String get yes => _('Evet', 'Yes');
  String get responseType => _('Yanıt türü', 'Response type');
  String get errorMessage => _('Hata mesajı', 'Error message');
  List<(String, String)> get netQueryHints => <(String, String)>[
    ('/users', _('Yolunda “/users” geçenler (düz kelime URL’de arar)', 'Path has “/users” (a plain word searches the URL)')),
    ('status:4xx', _('4xx yanıtlar (2xx…5xx)', '4xx responses (2xx…5xx)')),
    ('status:>=500', _('Durum kodu 500 ve üstü', 'Status 500 and above')),
    ('status:fail', _('Bağlantı hataları', 'Transport errors')),
    ('method:post', _('POST istekleri (method:get,put da olur)', 'POST requests (method:get,put works too)')),
    ('host:api', _('Host adında “api” geçenler', 'Host contains “api”')),
    ('path:/login', _('Yalnızca yolda ara', 'Search the path only')),
    ('is:slow', _('1 sn’den uzun sürenler', 'Took longer than 1 s')),
    ('is:failed', _('Başarısız istekler', 'Failed requests')),
    ('is:mocked', _('Mock ile yanıtlananlar', 'Answered by a mock')),
    ('is:graphql', _('GraphQL istekleri', 'GraphQL requests')),
    ('op:Login', _('GraphQL işlem adı', 'GraphQL operation name')),
    ('source:okhttp', _('Kaynağa göre (dart, dio, okhttp, urlsession)', 'By source (dart, dio, okhttp, urlsession)')),
    ('-host:analytics', _('Bu host’u hariç tut', 'Leave this host out')),
  ];
  String get searchBodies => _('Gövdelerde de ara', 'Search bodies too');
  String get searchBodiesHint => _('Arama, istek ve yanıt gövdelerinin içine de bakar.', 'The search also looks inside request and response bodies.');
  String get inBodies => _('Gövdede ara', 'In bodies');
  String get statusTitle => _('Durum', 'Status');
  String get host => 'Host';
  String get flags => _('Diğer', 'Other');
  String get failedHint => _('4xx, 5xx ya da bağlantı hatası', '4xx, 5xx or a transport error');
  String get other => _('Diğer', 'Other');
  String get failed => _('Başarısız', 'Failed');
  String get slowOnly => _('Yavaş ≥ 1 sn', 'Slow ≥ 1 s');
  String get mockedOnly => _('Mock’lananlar', 'Mocked');
  String get allHosts => _('Tüm hostlar', 'All hosts');
  String get resetFilters => _('Filtreleri sıfırla', 'Reset filters');
  String get noRequestsTitle => _('Henüz istek yok', 'No requests yet');
  String get noRequestsBody => _(
    'dart:io, package:http, Dio, OkHttp ve URLSession istekleri burada görünür.',
    'dart:io, package:http, Dio, OkHttp and URLSession requests show up here.',
  );
  String get mock => 'Mock';
  String get cancelledShort => _('İPTAL', 'CANCEL');
  String get cancelled => _('İptal edildi', 'Cancelled');
  String get pending => _('Bekliyor', 'Pending');
  String get waitingResponse => _('Yanıt henüz gelmedi.', 'The response has not arrived yet.');
  String shortError(String key) => switch (key) {
    'timeout' => _('Zaman aşımı', 'Timed out'),
    'dns' => _('DNS çözümlenemedi', 'DNS lookup failed'),
    'refused' => _('Bağlantı reddedildi', 'Connection refused'),
    'tls' => _('TLS / sertifika hatası', 'TLS / certificate error'),
    'reset' => _('Bağlantı koptu', 'Connection reset'),
    'offline' => _('İnternet yok', 'Offline'),
    'cancelled' => _('İptal edildi', 'Cancelled'),
    _ => _('İstek başarısız', 'Request failed'),
  };
  String get general => _('Genel', 'General');
  String get request => _('İstek', 'Request');
  String get response => _('Yanıt', 'Response');
  String get timing => _('Zamanlama', 'Timing');
  String get body => _('Gövde', 'Body');
  String get headers => _('Başlıklar', 'Headers');
  String get cookies => _('Çerezler', 'Cookies');
  String get query => _('Sorgu', 'Query');
  String get noHeaders => _('Başlık yok', 'No headers');
  String get noCookies => _('Çerez yok', 'No cookies');
  String get noQuery => _('Sorgu parametresi yok', 'No query parameters');
  String get preview => _('Önizleme', 'Preview');
  String get code => _('Kod', 'Code');
  String get hex => 'Hex';
  String get searchJson => _('JSON’da ara…', 'Search JSON…');
  String get expandAll => _('Tümünü aç', 'Expand all');
  String get collapseAll => _('Tümünü kapat', 'Collapse all');
  String get noBody => _('Gövde yok', 'No body');
  String get noBodyHint => _('Bu istekte gövde gönderilmedi ya da boş geldi.', 'No body was sent, or it was empty.');
  String get bodyNotCaptured => _('Gövde kaydedilmedi', 'Body not captured');
  String get bodyNotCapturedHint => _(
    'Masaüstünde gövde kaydı kapalı ya da gövde boyut sınırını aştı; yalnızca boyutu biliniyor.',
    'Body capture is off on the desktop or the body was over the size limit; only its size is known.',
  );
  String get bodiesDropped => _('Bu isteğin gövdesi telefondaki bellek sınırı yüzünden silindi.', 'This request’s body was removed to stay within the memory limit on the phone.');
  String truncated(String size) => _('Gövde kısaltıldı (toplam $size).', 'Body truncated (total $size).');
  String get imageUnreadable => _('Görsel açılamadı', 'The image could not be decoded');
  String get noResponseBody => _('Yanıt gelmedi; gösterilecek başlık ya da gövde yok.', 'No response arrived; there are no headers or body to show.');
  String get method => _('Metot', 'Method');
  String get status => _('Durum', 'Status');
  String get protocol => _('Protokol', 'Protocol');
  String get remoteAddress => _('Sunucu adresi', 'Remote address');
  String get source => _('Kaynak', 'Source');
  String get app => _('Uygulama', 'App');
  String get started => _('Başlangıç', 'Started');
  String get duration => _('Süre', 'Duration');
  String get requestSize => _('İstek boyutu', 'Request size');
  String get responseSize => _('Yanıt boyutu', 'Response size');
  String get contentType => _('İçerik türü', 'Content type');
  String get mockedTitle => _('Bu yanıtı bir mock kuralı üretti', 'A mock rule produced this response');
  String get mockedBody => _('İstek sunucuya gitmedi; kural masaüstünün Mock’lar sekmesinden geliyor.', 'The request did not reach the server; the rule comes from the desktop’s Mocks tab.');
  String get replay => _('Tekrar gönder', 'Replay');
  String get replaying => _('Gönderiliyor…', 'Sending…');
  String get replaySent => _('İstek yeniden gönderildi; listede yeni satır olarak görünür.', 'Request sent again; it shows up as a new row.');
  String replayFailed(String e) => _('Yeniden gönderilen istek başarısız oldu: $e', 'The replayed request failed: $e');
  String get copyAs => _('Farklı kopyala', 'Copy as');
  String copyAsFormat(String f) => switch (f) {
    'curl' => 'cURL',
    'fetch' => 'fetch (JavaScript)',
    'dio' => 'Dart (dio)',
    'swift' => 'Swift (URLSession)',
    'kotlin' => 'Kotlin (OkHttp)',
    _ => f,
  };
  String get copyUrl => _('URL’yi kopyala', 'Copy URL');
  String get copyAll => _('Tümünü metin olarak kopyala', 'Copy all as text');
  String get copyResponseBody => _('Yanıt gövdesini kopyala', 'Copy response body');
  String copyNote(Object note) => switch ('$note'.split('.').last) {
    'bodyNotCaptured' => _('gövde kaydedilmemişti', 'body was not captured'),
    'bodyTruncated' => _('gövde kısaltılmıştı', 'body was truncated'),
    _ => _('ikili gövde body.bin olarak bekleniyor', 'binary body expected as body.bin'),
  };
  String get totalTime => _('Toplam süre', 'Total time');
  String phase(String p) => switch (p) {
    'queue' => _('Kuyruk / bekleme', 'Queueing / stalled'),
    'dns' => _('DNS çözümleme', 'DNS lookup'),
    'connect' => _('Bağlantı', 'Connection'),
    'tls' => _('TLS el sıkışma', 'TLS handshake'),
    'send' => _('İstek gönderimi', 'Request sent'),
    'wait' => _('Bekleme (TTFB)', 'Waiting (TTFB)'),
    _ => _('Yanıtın indirilmesi', 'Content download'),
  };
  String get noPhasesTitle => _('Aşama süreleri yok', 'No phase timings');
  String get noPhasesPending => _('İstek bitince zamanlama görünür.', 'Timing shows once the request finishes.');
  String noPhasesBody(String source) => _(
    '“$source” kaynağı DNS, bağlantı ve bekleme sürelerini ayrı bildirmiyor; yalnızca toplam süre biliniyor.',
    'The “$source” source does not report DNS, connection and waiting times separately; only the total is known.',
  );

  /* mocks */
  String get noMocksTitle => _('Etkin mock kuralı yok', 'No active mock rules');
  String get noMocksConnected => _('Masaüstünün Mock’lar sekmesinde kural eklediğinizde burada görünür ve bu uygulamaya hemen uygulanır.', 'Rules you add in the desktop’s Mocks tab show up here and apply to this app at once.');
  String get noMocksOffline => _('Mock kuralları masaüstünden gelir ve yalnızca masaüstü bağlıyken geçerlidir.', 'Mock rules come from the desktop and hold only while it is connected.');
  String get mocksFromDesktop => _('Kurallar masaüstünden geliyor', 'Rules come from the desktop');
  String get mocksFromDesktopBody => _('Düzenlemek için Mac’teki Dürbün’ün Mock’lar sekmesini kullanın. Bağlantı koparsa kurallar devre dışı kalır.', 'Edit them in the Mocks tab of Dürbün on the Mac. They stop applying when the connection drops.');
  String mockRespond(String status, int delay) => delay > 0 ? _('$status ile yanıtla · $delay ms', 'Respond $status · $delay ms') : _('$status ile yanıtla', 'Respond $status');
  String mockDelay(int ms) => _('$ms ms geciktir', 'Delay $ms ms');
  String mockFail(String kind) => _('Hata ver: $kind', 'Fail: $kind');
  String mockHits(int n) => _('$n kez uygulandı', 'applied $n times');

  /* performance */
  String get noMetricsTitle => _('Henüz ölçüm yok', 'No samples yet');
  String get noMetricsBody => _('Kare süreleri ve bellek, uygulama çizim yaptıkça saniyede bir gelir.', 'Frame timings and memory arrive every second while the app draws.');
  String get jank => _('Takılan kare', 'Janky frames');
  String get buildTime => 'Build';
  String get rasterTime => 'Raster';
  String get memory => _('Bellek', 'Memory');
  String get heap => _('Dart heap', 'Dart heap');
  String get threads => _('İş parçacığı', 'Threads');
  String get frameTimes => _('Kare süreleri', 'Frame times');
  String avg(String? v) => _('ort. ${v ?? '—'}', 'avg ${v ?? '—'}');
  String peak(String v) => _('en yüksek $v MB', 'peak $v MB');
  String inWindow(int n) => _('pencerede $n', '$n in window');
  String perfWindow(int n) => _('Son $n saniye. Kesikli çizgi: 60 FPS ve 16,7 ms kare bütçesi.', 'Last $n seconds. Dashed line: 60 FPS and the 16.7 ms frame budget.');

  /* device / info */
  String get desktop => _('Masaüstü', 'Desktop');
  String connectedVia(String? via) => via == null ? _('Bağlı', 'Connected') : _('Bağlı · $via', 'Connected · $via');
  String get notConnected => _('Bağlı değil', 'Not connected');
  String get simulator => _('Simülatör / emülatör', 'Simulator / emulator');
  String get bodyCapture => _('Gövde kaydı', 'Body capture');
  String get kept => _('Telefonda', 'On the phone');
  String get offlineTitle => _('Mac olmadan da çalışır', 'Works without the Mac');
  String get offlineBody => _(
    'Her şey bu telefonda tutulur. Masaüstü bağlanınca aynı veriler orada da akar; mock kuralları ve gövde ayarı yalnızca masaüstünden gelir.',
    'Everything is kept on this phone. When the desktop connects the same data streams there too; mock rules and the body setting only come from the desktop.',
  );
  String get whatYouSee => _('Neler görünüyor?', 'What is captured?');
  String get srcDartHttp => _('Dart HTTP istekleri', 'Dart HTTP requests');
  String get srcNetworkOff => _('DurbunOptions(captureNetwork: false) ile kapatılmış.', 'Turned off with DurbunOptions(captureNetwork: false).');
  String get srcDio => _('Dio (NativeAdapter dahil)', 'Dio (NativeAdapter included)');
  String get srcDioHint => _('Varsayılan Dio, dart:io üzerinden zaten yakalanır. NativeAdapter için durbun_dio ekleyin.', 'Plain Dio is captured through dart:io. Add durbun_dio for NativeAdapter.');
  String get srcOkHttp => _('Android OkHttp', 'Android OkHttp');
  String get srcOkHttpHint => _('Native kodunuzdaki istemciye DurbunInterceptor() eklenince görünür.', 'Shows once DurbunInterceptor() is added to your native client.');
  String get srcUrlSession => _('iOS URLSession', 'iOS URLSession');
  String get srcAutomatic => _('otomatik', 'automatic');
  String get srcNoNative => _('Native katman başlamadı (plugin kayıtlı değil ya da bu platform değil).', 'The native layer did not start (plugin not registered, or another platform).');
  String get srcAppLogs => _('Uygulama logları', 'App logs');
  String get srcNativeLogs => _('Native loglar', 'Native logs');
  String get srcCrashes => _('Hatalar ve çökmeler', 'Errors and crashes');
  String get srcCrashesDetail => _('Flutter hataları · Dart · Kotlin · Swift', 'Flutter errors · Dart · Kotlin · Swift');
  String get srcCrashesHint => _('Native çökmeler bir sonraki açılışta gelir.', 'Native crashes arrive on the next launch.');
  String get srcErrorsOff => _('DurbunOptions(captureErrors: false) ile kapatılmış.', 'Turned off with DurbunOptions(captureErrors: false).');
  String get srcMetrics => _('Performans ölçümleri', 'Performance samples');
  String get srcMetricsOff => _('DurbunOptions(metrics: false) ile kapatılmış.', 'Turned off with DurbunOptions(metrics: false).');

  String get disabled => _(
    'Dürbün bu derlemede kapalı. Açmak için --dart-define=DURBUN=true ya da DurbunOptions(enabled: true).',
    'Dürbün is off in this build. Turn it on with --dart-define=DURBUN=true or DurbunOptions(enabled: true).',
  );

  String size(int bytes) => formatBytes(bytes);
}
