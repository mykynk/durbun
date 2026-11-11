import type { FlowNodeGroup } from '@durbun/protocol';

/**
 * Turkish texts of the flow node catalog (FLOW_NODE_SPECS) and the short param labels of both languages.
 * English titles, descriptions, hints, options and outputs come from the catalog itself.
 * `catalogText.test.ts` keeps this file complete against the catalog (types, params, options, outputs, template tokens).
 */
export interface ParamTextTr {
  label: string;
  /** Translation of the catalog param description. */
  hint: string;
  /** option value → Turkish label (every option of a select param). */
  options?: Record<string, string>;
  /** Only when the catalog param has a placeholder that needs translating (keep URLs/ids as is, skip otherwise). */
  placeholder?: string;
}

export interface NodeTextTr {
  title: string;
  description: string;
  params: Record<string, ParamTextTr>;
  /** output name → Turkish description (every catalog output, including '<name>'). */
  outputs: Record<string, string>;
}

/* ────────────────────────────── Shared Turkish pieces ────────────────────────────── */

const METHOD_OPTIONS_TR: Record<string, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
};
const ANY_METHOD_OPTIONS_TR: Record<string, string> = { '*': 'Tüm metotlar', ...METHOD_OPTIONS_TR };

const URL_MATCH_TR: Record<string, string> = {
  contains: 'İçerir',
  exact: 'Tam',
  glob: 'Glob (* ve ?)',
  regex: 'Düzenli ifade',
};

const SINCE_TR: Record<string, string> = {
  previous: 'Önceki adım başladığından beri',
  run: 'Çalıştırma başladığından beri',
  now: 'Şu andan itibaren',
};

/** Level names stay as they are (the Logs tab shows them the same way). */
const LOG_LEVELS_TR: Record<string, string> = {
  verbose: 'verbose',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

const methodTr = (options: Record<string, string>): ParamTextTr => ({ label: 'Metot', hint: 'HTTP metodu.', options });
const urlPatternTr: ParamTextTr = { label: 'URL kalıbı', hint: 'URL kalıbı.' };
const urlMatchTr: ParamTextTr = { label: 'Eşleşme türü', hint: '`url` kalıbının nasıl eşleşeceği.', options: URL_MATCH_TR };

const appIdTr = (description = 'Uygulamanın bundle id’si / paket kimliği.'): ParamTextTr => ({
  label: 'Uygulama',
  hint: `${description} Varsayılan: çalıştırmanın uygulaması ({{target.appId}}).`,
});

const timeoutTr: ParamTextTr = { label: 'Zaman aşımı (ms)', hint: 'Bu kadar milisaniyeden sonra vazgeçilir.' };

const sinceTr: ParamTextTr = {
  label: 'Zaman aralığı',
  hint:
    "Hangi olaylar sayılır: 'previous' (varsayılan) önceki adım çalışırken olanları da yakalar (ör. bir deep link’in tetiklediği istek), 'run' çalıştırma başladığından beri olan her şeyi, 'now' yalnızca bu adım başladıktan sonra olanları.",
  options: SINCE_TR,
};

const HTTP_OUTPUTS_TR: Record<string, string> = {
  status: 'HTTP durum kodu (sayı)',
  statusText: 'Durum metni',
  ok: '2xx için true',
  headers: "Küçük harfli ada göre yanıt başlıkları, ör. headers['content-type']",
  body: 'Ayrıştırılmış JSON gövde; JSON değilse metin',
  bodyText: 'Gövdenin metni',
  durationMs: 'Süre (ms)',
  url: 'Son URL (yönlendirmelerden sonra)',
  method: 'HTTP metodu',
};

/* ────────────────────────────── Turkish catalog ────────────────────────────── */

export const NODE_TEXT_TR: Record<string, NodeTextTr> = {
  /* ── triggers ── */
  'trigger.manual': {
    title: 'Elle başlatma',
    description: 'Biri Çalıştır’a bastığında çalıştırma buradan başlar. Akış girdileri {{input.<name>}} olarak okunur.',
    params: {},
    outputs: {},
  },
  'trigger.event': {
    title: 'Bir şey olduğunda',
    description:
      'Bağlı bir cihazda bu olay olduğunda akışı kendiliğinden başlatır (yalnızca akışın otomasyon anahtarı açıkken ve Dürbün açıkken). Çalıştırma, olayın geldiği cihazı ve uygulamayı hedefler. Olay verisi {{trigger.<field>}} olarak okunur.',
    params: {
      event: {
        label: 'Olay',
        hint: 'Akışı başlatan olay.',
        options: {
          crash: 'Uygulama çökmesi, ANR ya da Flutter hatası',
          logMatch: 'Bir log satırı eşleşir',
          networkError: 'Bir istek başarısız olur (ağ hatası ya da 5xx)',
          networkMatch: 'Bir istek eşleşir',
          appConnected: 'Uygulama bağlanır (SDK)',
          deviceConnected: 'Bir cihaz bağlanır',
        },
      },
      text: { label: 'Log metni', hint: 'Log satırında geçen metin (`regex` açıksa düzenli ifade).' },
      regex: { label: 'Düzenli ifade', hint: '`text` değerini düzenli ifade olarak yorumlar.' },
      level: { label: 'En düşük seviye', hint: 'Sayılan en düşük log seviyesi.', options: LOG_LEVELS_TR },
      method: methodTr(ANY_METHOD_OPTIONS_TR),
      url: urlPatternTr,
      match: urlMatchTr,
      status: { label: 'Durum kodu', hint: "Durum kodu filtresi: '2xx', '404', '400-499', '500,502' (boş = hepsi)." },
      appId: {
        label: 'Uygulama',
        hint: 'Yalnızca bu uygulama (bundle id / paket kimliği). Boş = akışın hedef uygulaması; akışın hedefi yoksa tüm uygulamalar.',
      },
    },
    outputs: {
      event: 'Olayın değeri',
      deviceId: 'Olayın geldiği cihaz',
      appId: 'Uygulamanın bundle id’si / paket kimliği (biliniyorsa)',
      message: 'Log satırının metni / istek satırı / çökme başlığı',
      log: 'Log kaydı (log ve çökme olaylarında)',
      request: 'İstek: method, url, status, error alanları (ağ olaylarında)',
      app: 'Uygulama: name, id, version alanları (appConnected)',
      device: 'Cihaz: id, name, platform alanları (deviceConnected)',
    },
  },

  /* ── HTTP ── */
  'http.request': {
    title: 'HTTP isteği',
    description:
      'İsteği Mac’ten gönderir (uygulamanın üzerinden değil; bu yüzden her derlemeyle çalışır). Yanıt adımın çıktısıdır; Ağ sekmesinde “Masaüstü” altında da görünür.',
    params: {
      method: methodTr(METHOD_OPTIONS_TR),
      url: { label: 'URL', hint: 'Tam http(s) adresi; genellikle {{env.baseUrl}} ile başlar.' },
      query: { label: 'Sorgu parametreleri', hint: 'URL’ye eklenen sorgu parametreleri.' },
      headers: { label: 'Başlıklar', hint: 'İstek başlıkları.' },
      bodyType: {
        label: 'Gövde türü',
        hint: 'İstekle ne gönderilir: hiçbir şey, JSON ya da düz metin (`body` alanı) veya form alanları (`form`, x-www-form-urlencoded).',
        options: { none: 'Yok', json: 'JSON', text: 'Metin', form: 'Form (urlencoded)' },
      },
      body: { label: 'Gövde', hint: 'Gönderilecek JSON ya da metin. Metin değerlerinde şablon kullanılabilir. Gövde türü seçilmemişse nesne ya da liste JSON, metin düz metin olarak gider; adım bunu not eder.' },
      form: { label: 'Form alanları', hint: 'Form olarak gönderilecek alanlar.' },
      expectStatus: {
        label: 'Beklenen durum kodu',
        hint: "Durum kodu bununla eşleşmezse adım başarısız olur: '2xx', '200', '200,201', '200-299'. Boş = her durum kodu geçer.",
      },
      extract: { label: 'Değişkene kaydet', hint: 'Yanıttaki değerleri değişken olarak kaydeder ({{vars.<name>}}).' },
      timeoutMs: timeoutTr,
      followRedirects: { label: 'Yönlendirmeleri izle', hint: '3xx yönlendirmeleri izlenir.' },
    },
    outputs: HTTP_OUTPUTS_TR,
  },

  /* ── logic ── */
  'logic.condition': {
    title: 'Koşul',
    description: 'Kuralları kontrol eder ve `true` ya da `false` çıkışından devam eder.',
    params: {
      mode: {
        label: 'Sağlanması gereken',
        hint: "'all' = her kural sağlanmalı, 'any' = biri yeterli.",
        options: { all: 'Tüm kurallar', any: 'Herhangi bir kural' },
      },
      rules: { label: 'Kurallar', hint: 'Kurallar: sol değer, karşılaştırma, sağ değer.' },
    },
    outputs: { result: 'true ya da false' },
  },
  'logic.repeat': {
    title: 'Tekrarla',
    description:
      '`loop` çıkışına bağlı her şeyi en fazla `count` kez çalıştırır (bir tur, adımları bitince ya da bu adıma geri dönünce biter), sonra `done` çıkışından devam eder. `until` kuralları varsa, kurallar sağlanır sağlanmaz durur; bir şey olana kadar tekrar tekrar kontrol etmek için kullanın (“sipariş hazır olana kadar”). Tur numarası {{<id>.index}} (0’dan başlar).',
    params: {
      count: {
        label: 'Kaç kez',
        hint: 'En fazla tur sayısı (0 = hiç). Liste veren bir şablon (ör. {{getOrders.body.items}}) ya da metin içindeki bir JSON listesi her öğe için bir kez çalışır; öğe {{item}} olarak okunur.',
      },
      until: { label: 'Durma koşulu', hint: 'Bu kuralların hepsi sağlanınca erken durur (her turdan sonra kontrol edilir).' },
      delayMs: { label: 'Bekleme (ms)', hint: 'Turlar arasında bekleme (ms).' },
      failIfNotMet: { label: 'Sağlanmazsa başarısız', hint: '`until` kuralları `count` tur içinde hiç sağlanmazsa başarısız olur.' },
    },
    outputs: {
      index: 'Geçerli tur (0’dan başlar)',
      iterations: 'Çalışan tur sayısı (done çıkışından sonra)',
      met: '`until` kuralları sağlandı mı',
    },
  },
  'logic.setVariables': {
    title: 'Değişken ata',
    description: 'Çalıştırmanın devamında {{vars.<name>}} olarak okunan değişkenler atar.',
    params: {
      assignments: { label: 'Değişkenler', hint: 'ad = değer (şablon ya da sabit değer).' },
    },
    outputs: { '<name>': 'Atanan her değer' },
  },
  'logic.delay': {
    title: 'Bekle',
    description: 'Sabit bir süre bekler.',
    params: {
      durationMs: { label: 'Süre (ms)', hint: 'Beklenecek milisaniye.' },
    },
    outputs: {},
  },
  'check.assert': {
    title: 'Kontrol et',
    description: 'Bir kontrol sağlanmazsa çalıştırma başarısız olur. Test ederken elle doğrulayacağınız şeyler için kullanın.',
    params: {
      assertions: { label: 'Kontroller', hint: 'Sol değer, karşılaştırma, sağ değer ve isteğe bağlı bir mesaj.' },
    },
    outputs: { passed: 'Sağlanan kontrol sayısı' },
  },
  'check.noErrors': {
    title: 'Şu ana kadar hata yok',
    description:
      'Çalıştırma sırasında hedef cihazda uygulama çöktüyse başarısız olur; varsayılan olarak istekleri başarısız olduysa ya da 5xx yanıt aldıysa da, isteğe bağlı olarak error/fatal log yazdıysa da.',
    params: {
      networkFailures: { label: 'Başarısız istekler', hint: 'Uygulamanın başarısız isteklerinde ve 5xx yanıtlarında da başarısız olur.' },
      errorLogs: { label: 'Hata logları', hint: 'Uygulamanın error/fatal log satırlarında da başarısız olur.' },
      since: {
        label: 'Zaman aralığı',
        hint: "'run' (varsayılan, çalıştırmanın başından beri) ya da 'previous' (önceki adımdan beri).",
        options: { previous: SINCE_TR.previous, run: SINCE_TR.run },
      },
    },
    outputs: { problems: 'Bulunanlar (metin listesi)' },
  },
  'flow.call': {
    title: 'Başka bir akışı çalıştır',
    description:
      'Başka bir akışı (alt akış) girdilerle çalıştırır ve onun çıktılarıyla devam eder: {{<id>.outputs.<name>}}. Alt akış aynı cihazı, uygulamayı ve ortamı kullanır.',
    params: {
      flowId: { label: 'Akış', hint: 'Çalıştırılacak akışın kimliği.' },
      inputs: { label: 'Girdiler', hint: 'Alt akışın girdileri için değerler: { ad: şablon }.' },
    },
    outputs: {
      outputs: 'Alt akışın ada göre çıktıları',
      status: 'Alt akışın sonucu',
    },
  },
  'flow.end': {
    title: 'Çalıştırmayı bitir',
    description: 'Çalıştırmayı burada başarılı ya da başarısız olarak bitirir. Bir alt akışın içindeyse yalnız o alt akışı bitirir: başarısız, çağıran adımı başarısız yapar (onun hata bağlantısı bunu karşılayabilir); başarılı, çağırana döner.',
    params: {
      status: { label: 'Sonuç', hint: 'Sonuç.', options: { passed: 'Başarılı', failed: 'Başarısız' } },
      message: { label: 'Mesaj', hint: 'Raporda gösterilir.' },
    },
    outputs: {},
  },

  /* ── device ── */
  'device.openUrl': {
    title: 'Bağlantı aç (deep link)',
    description: 'Cihazda bir URL ya da deep link açar.',
    params: {
      url: { label: 'Adres', hint: 'URL ya da deep link.' },
    },
    outputs: {},
  },
  'device.launchApp': {
    title: 'Uygulamayı başlat',
    description: 'Uygulamayı başlatır (çalışıyorsa öne getirir).',
    params: { appId: appIdTr() },
    outputs: {},
  },
  'device.stopApp': {
    title: 'Uygulamayı durdur',
    description: 'Uygulamayı zorla durdurur.',
    params: { appId: appIdTr() },
    outputs: {},
  },
  'device.restartApp': {
    title: 'Uygulamayı yeniden başlat',
    description: 'Uygulamayı durdurup yeniden başlatır.',
    params: { appId: appIdTr() },
    outputs: {},
  },
  'device.clearData': {
    title: 'Uygulama verilerini temizle',
    description: 'Uygulamanın verilerini siler (ilk kurulum durumu). Geri alınamaz.',
    params: { appId: appIdTr() },
    outputs: {},
  },
  'device.installApp': {
    title: 'Derleme kur',
    description: 'Bu Mac’teki bir yoldan .apk / .ipa / .app kurar.',
    params: {
      file: { label: 'Dosya yolu', hint: 'Derlemenin bu Mac’teki tam yolu.' },
    },
    outputs: {},
  },
  'device.uninstallApp': {
    title: 'Uygulamayı kaldır',
    description: 'Uygulamayı ve verilerini cihazdan siler. Geri alınamaz.',
    params: { appId: appIdTr() },
    outputs: {},
  },
  'device.screenshot': {
    title: 'Ekran görüntüsü al',
    description: 'Ekran görüntüsü alır ve kanıt olarak çalıştırmayla birlikte saklar.',
    params: {
      name: { label: 'Ad', hint: 'Raporda gösterilen ad.', placeholder: 'Sipariş ekranı' },
    },
    outputs: { url: 'Görüntünün adresi' },
  },
  'device.startRecording': {
    title: 'Ekran kaydını başlat',
    description:
      'Ekranı kaydetmeye başlar; “Ekran kaydını durdur” adımı (ya da çalıştırmanın sonu) videoyu çalıştırmayla birlikte saklar.',
    params: {
      maxSeconds: {
        label: 'En uzun süre (sn)',
        hint: 'Bu kadar saniye sonra kendiliğinden durur (platform sınırları: Android 180, iOS 600).',
      },
    },
    outputs: {},
  },
  'device.stopRecording': {
    title: 'Ekran kaydını durdur',
    description: 'Kaydı durdurur ve videoyu çalıştırmayla birlikte saklar.',
    params: {
      name: { label: 'Ad', hint: 'Raporda gösterilen ad.' },
    },
    outputs: { url: 'Videonun adresi' },
  },
  'device.appearance': {
    title: 'Koyu / açık görünüm',
    description: 'Sistem görünümünü değiştirir.',
    params: {
      mode: { label: 'Görünüm', hint: 'Görünüm.', options: { dark: 'Koyu', light: 'Açık' } },
    },
    outputs: {},
  },
  'device.fontScale': {
    title: 'Yazı boyutu',
    description: 'Sistem yazı ölçeğini ayarlar (1 = varsayılan).',
    params: {
      scale: { label: 'Ölçek', hint: 'Ölçek, 0.85–2 arası.' },
    },
    outputs: {},
  },
  'device.location': {
    title: 'Konum ayarla',
    description: 'Simüle edilen konumu değiştirir (simülatörler ve emülatörler).',
    params: {
      lat: { label: 'Enlem', hint: 'Enlem.' },
      lon: { label: 'Boylam', hint: 'Boylam.' },
    },
    outputs: {},
  },
  'device.pushNotification': {
    title: 'Push bildirimi gönder',
    description: 'Uygulamaya bir push içeriği iletir (iOS simülatörü).',
    params: {
      appId: appIdTr(),
      payload: { label: 'İçerik', hint: 'APNs içeriği (JSON).' },
    },
    outputs: {},
  },
  'device.inputText': {
    title: 'Metin yaz',
    description: 'Odaktaki alana yazar (Android).',
    params: {
      text: { label: 'Metin', hint: 'Yazılacak metin.' },
    },
    outputs: {},
  },
  'device.keyEvent': {
    title: 'Tuşa bas',
    description: 'Bir donanım ya da sistem tuşuna basar (Android).',
    params: {
      key: {
        label: 'Tuş',
        hint: 'Tuş.',
        options: {
          back: 'Geri',
          home: 'Ana ekran',
          recents: 'Son uygulamalar',
          enter: 'Enter',
          delete: 'Sil',
          menu: 'Menü',
          power: 'Güç',
          'volume-up': 'Ses +',
          'volume-down': 'Ses −',
        },
      },
    },
    outputs: {},
  },
  'device.statusBar': {
    title: 'Temiz durum çubuğu',
    description: 'Ekran görüntüleri için temiz bir durum çubuğu gösterir ya da varsayılana döndürür (iOS simülatörü).',
    params: {
      mode: {
        label: 'Durum çubuğu',
        hint: 'clean (temiz) ya da reset (varsayılana döndür).',
        options: { clean: 'Temiz', reset: 'Varsayılana döndür' },
      },
    },
    outputs: {},
  },
  'device.animations': {
    title: 'Sistem animasyonları',
    description: 'Sistem animasyonlarını açar ya da kapatır (Android).',
    params: {
      enabled: { label: 'Animasyonlar açık', hint: 'Animasyonlar açık.' },
    },
    outputs: {},
  },

  /* ── wait ── */
  'wait.network': {
    title: 'Uygulama isteğini bekle',
    description:
      'Test edilen uygulama eşleşen bir istek yapıp istek tamamlanana kadar bekler, sonra onu HTTP isteği adımı gibi çıktı olarak verir (status, headers, body…). Uygulamanın ağ trafiğini yakalaması gerekir (Dürbün SDK).',
    params: {
      method: methodTr(ANY_METHOD_OPTIONS_TR),
      url: urlPatternTr,
      match: urlMatchTr,
      status: {
        label: 'Durum kodu',
        hint: "Yalnızca bu durum kodlu yanıtlar: '2xx', '200,201' (boş = hepsi, başarısız istekler dahil).",
      },
      timeoutMs: timeoutTr,
      since: sinceTr,
    },
    outputs: {
      ...HTTP_OUTPUTS_TR,
      request: 'Uygulama isteğinin request.headers ve request.body alanları',
      error: 'Başarısız olduysa ağ hatasının metni',
    },
  },
  'wait.log': {
    title: 'Log satırını bekle',
    description: 'Hedef cihazda eşleşen bir log satırı görünene kadar bekler (cihaz logları SDK olmadan da çalışır).',
    params: {
      text: { label: 'Log metni', hint: 'Satırda geçen metin (`regex` açıksa düzenli ifade).' },
      regex: { label: 'Düzenli ifade', hint: '`text` değerini düzenli ifade olarak yorumlar; 1. grup {{<id>.match}}, tüm gruplar {{<id>.groups}} olur.' },
      level: { label: 'En düşük seviye', hint: 'Sayılan en düşük seviye.', options: LOG_LEVELS_TR },
      tag: { label: 'Etiket', hint: 'Yalnızca bu etiket (tam eşleşme, büyük/küçük harf fark etmez).' },
      appOnly: { label: 'Yalnızca uygulama', hint: 'Yalnızca çalıştırmanın uygulamasının satırları.' },
      timeoutMs: timeoutTr,
      since: sinceTr,
    },
    outputs: {
      message: 'Satırın kendisi',
      match: 'Düzenli ifadenin 1. grubu (ya da eşleşmenin tamamı)',
      groups: 'Düzenli ifadenin tüm grupları: groups[0] eşleşmenin tamamı, groups[1] 1. grup',
      level: 'Seviye',
      tag: 'Etiket',
      data: 'Yapılandırılmış veri (SDK satırları)',
    },
  },
  'wait.event': {
    title: 'Uygulama olayını bekle',
    description: 'Uygulamanın Dürbün SDK ile gönderdiği özel bir olayı bekler (Durbun.event(name, props)).',
    params: {
      name: { label: 'Olay adı', hint: 'Olay adı.' },
      timeoutMs: timeoutTr,
      since: sinceTr,
    },
    outputs: {
      name: 'Olay adı',
      props: 'Olay özellikleri',
    },
  },

  /* ── mock ── */
  'mock.add': {
    title: 'Mock ekle',
    description:
      'Uygulamanın SDK’sının eşleşen isteklere uyguladığı bir mock kuralı ekler: sahte yanıt döner, gecikme ekler ya da hata verir. `keep` açık değilse çalıştırma bitince kaldırılır. Uygulamada Dürbün SDK’sı gerekir.',
    params: {
      name: { label: 'Ad', hint: 'Kural adı.' },
      method: methodTr(ANY_METHOD_OPTIONS_TR),
      url: urlPatternTr,
      match: urlMatchTr,
      action: {
        label: 'Eylem',
        hint: "'respond' = sahte yanıt, 'delay' = gerçek isteği yavaşlat, 'fail' = ağ hatası.",
        options: { respond: 'Yanıt ver', delay: 'Geciktir', fail: 'Hata simüle et' },
      },
      status: { label: 'Durum kodu', hint: 'Sahte yanıtın durum kodu.' },
      headers: { label: 'Yanıt başlıkları', hint: 'Sahte yanıtın başlıkları.' },
      body: { label: 'Yanıt gövdesi', hint: 'Sahte yanıtın gövdesi.' },
      delayMs: { label: 'Gecikme (ms)', hint: 'Milisaniye cinsinden gecikme.' },
      error: {
        label: 'Hata türü',
        hint: 'Simüle edilen hatanın türü.',
        options: { timeout: 'Zaman aşımı', connection: 'Bağlantı reddedildi', dns: 'DNS çözümlenemedi', tls: 'TLS / sertifika hatası' },
      },
      appOnly: { label: 'Yalnızca uygulama', hint: 'Yalnızca çalıştırmanın uygulamasına uygulanır.' },
      keep: { label: 'Kuralı koru', hint: 'Kural çalıştırmadan sonra da kalır.' },
    },
    outputs: { ruleId: 'Kuralın kimliği' },
  },
  'mock.toggle': {
    title: 'Mock’u aç/kapat',
    description: 'Var olan bir mock kuralını (kimliği ya da adıyla) açar veya kapatır. `keep` açık değilse çalıştırmadan sonra eski haline döner.',
    params: {
      rule: { label: 'Kural', hint: 'Kuralın kimliği ya da adı.' },
      enabled: { label: 'Açık', hint: 'Açık ya da kapalı.' },
      keep: { label: 'Değişikliği koru', hint: 'Değişiklik çalıştırmadan sonra da kalır.' },
    },
    outputs: {},
  },
  'mock.remove': {
    title: 'Mock’u kaldır',
    description: 'Bir mock kuralını (kimliği ya da adıyla) kaldırır; bu çalıştırmada daha önce eklenen bir kuralı da.',
    params: {
      rule: { label: 'Kural', hint: 'Kuralın kimliği ya da adı.' },
    },
    outputs: {},
  },

  /* ── output ── */
  'output.marker': {
    title: 'Log işareti',
    description: 'Cihazın log akışına bir işaret çizgisi ekler; böylece çalıştırma loglarda kolayca bulunur.',
    params: {
      label: { label: 'İşaret metni', hint: 'İşaretin metni.' },
    },
    outputs: {},
  },
  'output.slack': {
    title: 'Slack’e gönder',
    description: 'Ekibin Slack kanalına bir mesaj gönderir (Ayarlar → Slack); istenirse şu ana kadarki çalıştırma özetini de ekler.',
    params: {
      text: { label: 'Mesaj', hint: 'Mesaj.' },
      includeSummary: { label: 'Özeti ekle', hint: 'Şu ana kadarki adımları ekler.' },
    },
    outputs: {},
  },
  'output.note': {
    title: 'Not',
    description: 'Çalıştırma raporuna bir satır yazar (ör. “{{vars.orderId}} siparişi oluşturuldu”).',
    params: {
      text: { label: 'Metin', hint: 'Metin.' },
    },
    outputs: { text: 'Şablonları doldurulmuş metin' },
  },
};

/* ────────────────────────────── English param labels ────────────────────────────── */

const APP_ID_EN = { appId: 'App' };
const TIMEOUT_EN = { timeoutMs: 'Timeout (ms)' };
const SINCE_EN = { since: 'Time range' };
const URL_RULE_EN = { method: 'Method', url: 'URL pattern', match: 'Match type' };

/** Short English param labels: type → param name → label (sentence case, 1–3 words). */
export const PARAM_LABELS_EN: Record<string, Record<string, string>> = {
  'trigger.manual': {},
  'trigger.event': {
    event: 'Event',
    text: 'Log text',
    regex: 'Regular expression',
    level: 'Minimum level',
    ...URL_RULE_EN,
    status: 'Status code',
    ...APP_ID_EN,
  },
  'http.request': {
    method: 'Method',
    url: 'URL',
    query: 'Query parameters',
    headers: 'Headers',
    bodyType: 'Body type',
    body: 'Body',
    form: 'Form fields',
    expectStatus: 'Expected status',
    extract: 'Save to variables',
    ...TIMEOUT_EN,
    followRedirects: 'Follow redirects',
  },
  'logic.condition': { mode: 'Must hold', rules: 'Rules' },
  'logic.repeat': { count: 'Times', until: 'Stop when', delayMs: 'Delay (ms)', failIfNotMet: 'Fail if not met' },
  'logic.setVariables': { assignments: 'Variables' },
  'logic.delay': { durationMs: 'Duration (ms)' },
  'check.assert': { assertions: 'Checks' },
  'check.noErrors': { networkFailures: 'Failed requests', errorLogs: 'Error logs', ...SINCE_EN },
  'flow.call': { flowId: 'Flow', inputs: 'Inputs' },
  'flow.end': { status: 'Result', message: 'Message' },
  'device.openUrl': { url: 'URL' },
  'device.launchApp': APP_ID_EN,
  'device.stopApp': APP_ID_EN,
  'device.restartApp': APP_ID_EN,
  'device.clearData': APP_ID_EN,
  'device.installApp': { file: 'File path' },
  'device.uninstallApp': APP_ID_EN,
  'device.screenshot': { name: 'Name' },
  'device.startRecording': { maxSeconds: 'Max duration (s)' },
  'device.stopRecording': { name: 'Name' },
  'device.appearance': { mode: 'Appearance' },
  'device.fontScale': { scale: 'Scale' },
  'device.location': { lat: 'Latitude', lon: 'Longitude' },
  'device.pushNotification': { ...APP_ID_EN, payload: 'Payload' },
  'device.inputText': { text: 'Text' },
  'device.keyEvent': { key: 'Key' },
  'device.statusBar': { mode: 'Status bar' },
  'device.animations': { enabled: 'Animations on' },
  'wait.network': { ...URL_RULE_EN, status: 'Status code', ...TIMEOUT_EN, ...SINCE_EN },
  'wait.log': {
    text: 'Log text',
    regex: 'Regular expression',
    level: 'Minimum level',
    tag: 'Tag',
    appOnly: 'App only',
    ...TIMEOUT_EN,
    ...SINCE_EN,
  },
  'wait.event': { name: 'Event name', ...TIMEOUT_EN, ...SINCE_EN },
  'mock.add': {
    name: 'Name',
    ...URL_RULE_EN,
    action: 'Action',
    status: 'Status code',
    headers: 'Response headers',
    body: 'Response body',
    delayMs: 'Delay (ms)',
    error: 'Error kind',
    appOnly: 'App only',
    keep: 'Keep rule',
  },
  'mock.toggle': { rule: 'Rule', enabled: 'On', keep: 'Keep change' },
  'mock.remove': { rule: 'Rule' },
  'output.marker': { label: 'Marker text' },
  'output.slack': { text: 'Message', includeSummary: 'Include summary' },
  'output.note': { text: 'Text' },
};

export const GROUP_TEXT: Record<'tr' | 'en', Record<FlowNodeGroup, string>> = {
  tr: {
    trigger: 'Başlangıç',
    http: 'HTTP',
    logic: 'Mantık ve kontroller',
    device: 'Cihaz',
    wait: 'Uygulamayı bekle',
    mock: 'Mock’lar',
    output: 'Çıktı',
  },
  en: {
    trigger: 'Start',
    http: 'HTTP',
    logic: 'Logic and checks',
    device: 'Device',
    wait: 'Wait for the app',
    mock: 'Mocks',
    output: 'Output',
  },
};
