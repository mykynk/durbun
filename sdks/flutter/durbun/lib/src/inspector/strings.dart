/// Texts of the in-app inspector: Turkish when the app (or the phone) is in
/// Turkish, English otherwise.
library;

import 'package:flutter/widgets.dart';

class InspectorStrings {
  const InspectorStrings._(this.tr);

  final bool tr;

  static InspectorStrings of(BuildContext context) {
    final locale = Localizations.maybeLocaleOf(context) ??
        WidgetsBinding.instance.platformDispatcher.locale;
    return InspectorStrings._(locale.languageCode == 'tr');
  }

  String _(String tr, String en) => this.tr ? tr : en;

  String get title => 'Dürbün';
  String get network => _('Ağ', 'Network');
  String get logs => _('Loglar', 'Logs');
  String get errors => _('Hatalar', 'Errors');
  String get performance => _('Performans', 'Performance');
  String get info => _('Bilgi', 'Info');
  String get close => _('Kapat', 'Close');
  String get clear => _('Temizle', 'Clear');
  String get search => _('Ara', 'Search');
  String get onlyFailures => _('Yalnızca hatalı', 'Failures only');
  String get all => _('Tümü', 'All');
  String get warnAndUp => _('Uyarı ve üstü', 'Warnings and up');
  String get errorAndUp => _('Hata ve üstü', 'Errors and up');
  String get copied => _('Kopyalandı', 'Copied');
  String get copyCurl => _('cURL olarak kopyala', 'Copy as cURL');
  String get copyAll => _('Tümünü metin olarak kopyala', 'Copy all as text');
  String get copy => _('Kopyala', 'Copy');
  String get summary => _('Özet', 'Summary');
  String get request => _('İstek', 'Request');
  String get response => _('Yanıt', 'Response');
  String get headers => _('Başlıklar', 'Headers');
  String get body => _('Gövde', 'Body');
  String get noHeaders => _('Başlık yok', 'No headers');
  String get noBody => _('Gövde yok', 'No body');
  String get waiting => _('Yanıt bekleniyor…', 'Waiting for the response…');
  String get status => _('Durum', 'Status');
  String get duration => _('Süre', 'Duration');
  String get source => _('Kaynak', 'Source');
  String get time => _('Zaman', 'Time');
  String get mocked => _('Mock', 'Mock');
  String get protocol => _('Protokol', 'Protocol');
  String get remoteAddress => _('Sunucu adresi', 'Remote address');
  String get size => _('Boyut', 'Size');
  String get stack => _('Yığın izi', 'Stack trace');
  String get data => _('Veri', 'Data');
  String get event => _('Olay', 'Event');
  String get crash => _('Çökme', 'Crash');
  String get native => _('Native', 'Native');
  String get fps => 'FPS';
  String get jank => _('Takılan kare', 'Janky frames');
  String get build => _('Build süresi', 'Build time');
  String get raster => _('Raster süresi', 'Raster time');
  String get memory => _('Bellek', 'Memory');
  String get heap => _('Dart heap', 'Dart heap');
  String get cpu => 'CPU';
  String get threads => _('İş parçacığı', 'Threads');
  String get app => _('Uygulama', 'App');
  String get device => _('Cihaz', 'Device');
  String get desktop => _('Masaüstü', 'Desktop');
  String get layers => _('Yakalanan katmanlar', 'Captured layers');
  String get activeMocks => _('Etkin mock kuralı', 'Active mock rules');
  String get kept => _('Telefonda tutulan', 'Kept on the phone');
  String get imagePreview => _('Görsel önizleme', 'Image preview');

  String connected(String? via) =>
      _('Bağlı', 'Connected') + (via == null ? '' : ' · $via');
  String get notConnected => _(
        'Bağlı değil. Veriler yine de burada görünür.',
        'Not connected. Data still shows here.',
      );

  String noRequests(bool filtered) => filtered
      ? _('Bu filtreye uyan istek yok.', 'No request matches this filter.')
      : _(
          'Henüz istek yok. dart:io, Dio, OkHttp ve URLSession istekleri burada görünür.',
          'No requests yet. dart:io, Dio, OkHttp and URLSession requests show up here.',
        );

  String noLogs(bool filtered) => filtered
      ? _('Bu filtreye uyan log yok.', 'No log matches this filter.')
      : _(
          'Henüz log yok. Durbun.log, print, Flutter hataları ve native loglar burada görünür.',
          'No logs yet. Durbun.log, print, Flutter errors and native logs show up here.',
        );

  String get noErrors => _('Hata yok. Çökmeler ve hata logları burada görünür.',
      'No errors. Crashes and error logs show up here.');

  String get noMetrics => _(
        'Henüz ölçüm yok. Kare süreleri uygulama çizim yaptıkça gelir.',
        'No samples yet. Frame timings arrive while the app draws.',
      );

  String dropped(int n) => _(
        'En eski $n kayıt yer açmak için silindi.',
        'The oldest $n entries were removed to make room.',
      );

  String get bodiesDropped => _(
        'Bu isteğin gövdesi bellek sınırı yüzünden silindi.',
        'This request’s body was removed to stay within the memory limit.',
      );

  String truncated(String size) => _(
        'Gövde kısaltıldı (toplam $size).',
        'Body truncated (total $size).',
      );

  String binary(String size) => _('İkili veri, $size', 'Binary data, $size');

  String get bodyNotCaptured => _(
        'Gövde kaydedilmedi (masaüstünde gövde kaydı kapalı).',
        'Body not captured (body capture is off on the desktop).',
      );

  String get disabled => _(
        'Dürbün bu derlemede kapalı. Açmak için --dart-define=DURBUN=true ya da DurbunOptions(enabled: true).',
        'Dürbün is off in this build. Turn it on with --dart-define=DURBUN=true or DurbunOptions(enabled: true).',
      );
}
