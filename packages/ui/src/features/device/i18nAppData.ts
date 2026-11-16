import { registerMessages } from '../../i18n';

/** Device tab: copying an app's data folder; the iPhone's own full report (sysdiagnose) guide. */
registerMessages('device', {
  tr: {
    appData: {
      title: 'Uygulama verisi',
      hintAndroid: 'Shared preferences, veritabanları ve dosyalar tek bir .tar.gz dosyasında; önbellek klasörleri hariç. Yalnızca debug derlemelerde çalışır.',
      hintSim: 'Documents ve Library (Preferences, Application Support) tek bir .tar.gz dosyasında; önbellek ve tmp hariç.',
      notDebug: 'Uygulama listesi bunu debug derlemesi olarak göstermiyor; Android yalnızca debug derlemelerin verisini verir.',
      pull: 'Veriyi al',
      running: 'Kopyalanıyor · {time}',
      runningHint: 'Büyük verilerde birkaç dakika sürebilir.',
      otherApp: 'Bu cihazdan şu an {app} verisi kopyalanıyor.',
      done: '{app} verisi kaydedildi',
      failed: '{app} verisi alınamadı',
      file: '{size} · {time} sürdü · 24 saat bu Mac’te kalır',
      download: 'İndir',
    },
    iphoneReport: {
      title: 'Tam cihaz raporu (sysdiagnose)',
      hint: 'iOS’un kendi tanılama paketi: sistem logları, çökme ve takılma kayıtları, ağ ve pil durumu. iOS bunu yalnızca telefonun tuşlarıyla başlatır; Dürbün’de düğmesi yoktur.',
      stepsLabel: '{device} için sysdiagnose adımları',
      steps: {
        press: 'İki ses tuşuna ve yan (ya da üst) tuşa birlikte 1–1,5 saniye basılı tutup bırakın. Telefon kısa bir titrer; aynı anda bir ekran görüntüsü de alınabilir.',
        wait: 'Paket arka planda hazırlanır, yaklaşık 10 dakika sürer. Bu sürede telefonu yeniden başlatmayın.',
        find: 'Ayarlar → Gizlilik ve Güvenlik → Analiz ve Geliştirmeler → Analiz Verileri’nde “sysdiagnose_” ile başlayan dosyayı açın.',
        share: 'Paylaş düğmesiyle AirDrop’la bu Mac’e gönderin ya da Dosyalar’a kaydedin.',
      },
      note: 'Paket büyüktür (çoğu zaman yüzlerce MB) ve telefondaki kişisel bilgileri de içerebilir.',
    },
  },
  en: {
    appData: {
      title: 'App data',
      hintAndroid: 'Shared preferences, databases and files in one .tar.gz file; cache folders are left out. Works for debug builds only.',
      hintSim: 'Documents and Library (Preferences, Application Support) in one .tar.gz file; caches and tmp are left out.',
      notDebug: 'The app list does not show this as a debug build; Android gives the data of debug builds only.',
      pull: 'Copy data',
      running: 'Copying · {time}',
      runningHint: 'Large data can take a few minutes.',
      otherApp: 'The data of {app} is being copied from this device now.',
      done: 'Data of {app} saved',
      failed: 'Could not copy the data of {app}',
      file: '{size} · took {time} · kept on this Mac for 24 hours',
      download: 'Download',
    },
    iphoneReport: {
      title: 'Full device report (sysdiagnose)',
      hint: 'iOS’s own diagnostics bundle: system logs, crash and hang records, network and battery state. iOS starts it only from the phone’s buttons, so there is no button for it in Dürbün.',
      stepsLabel: 'sysdiagnose steps for {device}',
      steps: {
        press: 'Press both volume buttons and the side (or top) button together for 1–1.5 seconds, then let go. The phone vibrates briefly; a screenshot may be taken at the same time.',
        wait: 'The bundle is made in the background and takes about 10 minutes. Do not restart the phone meanwhile.',
        find: 'Open the file that starts with “sysdiagnose_” in Settings → Privacy & Security → Analytics & Improvements → Analytics Data.',
        share: 'Use the share button to AirDrop it to this Mac, or save it to Files.',
      },
      note: 'The bundle is large (often hundreds of MB) and can also hold personal information from the phone.',
    },
  },
});
