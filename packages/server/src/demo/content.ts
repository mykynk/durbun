/** Static content for the demo apps: pets, products, people, stack traces, Flutter error boxes. */

export interface DemoPet {
  id: number;
  name: string;
  species: 'dog' | 'cat' | 'bird' | 'rabbit';
  breed: string;
  sex: 'female' | 'male';
  ageMonths: number;
  city: string;
  district: string;
}

const PET_ROWS: [string, DemoPet['species'], string, DemoPet['sex'], number, string, string][] = [
  ['Pamuk', 'cat', 'Van Kedisi', 'female', 14, 'İstanbul', 'Kadıköy'],
  ['Karabaş', 'dog', 'Kangal', 'male', 30, 'Ankara', 'Çankaya'],
  ['Boncuk', 'cat', 'Tekir', 'female', 7, 'İzmir', 'Karşıyaka'],
  ['Zeytin', 'cat', 'British Shorthair', 'male', 22, 'İstanbul', 'Beşiktaş'],
  ['Fıstık', 'dog', 'Golden Retriever', 'female', 11, 'Bursa', 'Nilüfer'],
  ['Tarçın', 'dog', 'Labrador Retriever', 'male', 40, 'Antalya', 'Muratpaşa'],
  ['Maviş', 'bird', 'Muhabbet Kuşu', 'female', 9, 'Eskişehir', 'Tepebaşı'],
  ['Duman', 'cat', 'Ankara Kedisi', 'male', 18, 'Ankara', 'Yenimahalle'],
  ['Paşa', 'dog', 'Akbaş', 'male', 52, 'Trabzon', 'Ortahisar'],
  ['Lokum', 'rabbit', 'Hollanda Lop', 'female', 5, 'İstanbul', 'Üsküdar'],
  ['Mırnav', 'cat', 'Melez', 'female', 3, 'İzmir', 'Bornova'],
  ['Badem', 'dog', 'Beagle', 'female', 26, 'İstanbul', 'Sarıyer'],
  ['Kömür', 'cat', 'Bombay', 'male', 33, 'Kocaeli', 'İzmit'],
  ['Bal', 'dog', 'Melez', 'female', 16, 'Mersin', 'Yenişehir'],
  ['Leblebi', 'dog', 'Jack Russell Terrier', 'male', 20, 'Ankara', 'Etimesgut'],
  ['Şans', 'dog', 'Melez', 'male', 60, 'İstanbul', 'Maltepe'],
  ['Minnoş', 'cat', 'Scottish Fold', 'female', 12, 'Muğla', 'Bodrum'],
  ['Kartopu', 'dog', 'Samoyed', 'male', 24, 'Erzurum', 'Yakutiye'],
  ['Limon', 'bird', 'Kanarya', 'male', 13, 'Denizli', 'Pamukkale'],
  ['Cesur', 'dog', 'Alman Çoban Köpeği', 'male', 44, 'Konya', 'Selçuklu'],
];

export const PETS: DemoPet[] = PET_ROWS.map(([name, species, breed, sex, ageMonths, city, district], i) => ({
  id: 40 + i * 3,
  name,
  species,
  breed,
  sex,
  ageMonths,
  city,
  district,
}));

export const TOTAL_PETS = 163;

export const PEOPLE = [
  'Deniz Yılmaz',
  'Ece Kaya',
  'Mert Demir',
  'Zeynep Arslan',
  'Can Öztürk',
  'Elif Şahin',
  'Burak Aydın',
  'Selin Koç',
  'Emre Çelik',
  'İrem Doğan',
];

export const ME = { id: 4821, name: 'Deniz Yılmaz', email: 'deniz.yilmaz@example.com', city: 'İstanbul' };

export interface DemoProduct {
  sku: string;
  name: string;
  price: number;
  category: string;
}

export const PRODUCTS: DemoProduct[] = [
  { sku: 'MAMA-KEDI-2KG', name: 'Yavru Kedi Maması 2 kg', price: 649.9, category: 'mama' },
  { sku: 'MAMA-KOPEK-15KG', name: 'Kuzu Etli Yetişkin Köpek Maması 15 kg', price: 1899, category: 'mama' },
  { sku: 'KUM-10L', name: 'Bentonit Kedi Kumu 10 L', price: 289.5, category: 'bakim' },
  { sku: 'OYUN-TUY', name: 'Tüylü Olta Oyuncak', price: 89.9, category: 'oyuncak' },
  { sku: 'TASMA-M', name: 'Reflektörlü Tasma (M)', price: 179, category: 'aksesuar' },
  { sku: 'ODUL-DIS', name: 'Diş Bakım Ödülü 150 g', price: 119.9, category: 'mama' },
  { sku: 'TIRMALAMA', name: 'Tırmalama Tahtası 70 cm', price: 749, category: 'aksesuar' },
  { sku: 'SAMPUAN', name: 'Hipoalerjenik Şampuan 250 ml', price: 159.9, category: 'bakim' },
];

export const STORY_CAPTIONS = [
  'Pamuk ilk kez bahçede! 🌿',
  "Karabaş'ın yeni oyuncağı",
  'Sabah yürüyüşü ☀️',
  'Veteriner kontrolü tamam ✅',
  'Boncuk kutudan çıkmıyor 📦',
  'Kartopu karda ❄️',
  'Sahiplendirme günü için hazırız 🐾',
  'Maviş bugün çok konuşkan',
];

export const SEARCH_TERMS = ['golden retriever', 'van kedisi', 'yavru kedi', 'kangal', 'muhabbet kuşu', 'tavşan', 'sahiplen kadıköy', 'kısırlaştırılmış'];

export const MARKET_STORES = [
  { id: 311, name: 'Moda Şarküteri', district: 'Kadıköy', rating: 4.7 },
  { id: 318, name: 'Yeldeğirmeni Fırını', district: 'Kadıköy', rating: 4.9 },
  { id: 402, name: 'Bebek Manav', district: 'Beşiktaş', rating: 4.5 },
  { id: 517, name: 'Kuzguncuk Bakkal', district: 'Üsküdar', rating: 4.8 },
];

export const MARKET_PRODUCTS = [
  { id: 90211, name: 'Ezine Peyniri 500 g', price: 214.9 },
  { id: 90230, name: 'Köy Yumurtası (15li)', price: 129.5 },
  { id: 90245, name: 'Ekşi Mayalı Ekmek', price: 65 },
  { id: 90302, name: 'Kabak Çiçeği (demet)', price: 48 },
  { id: 90315, name: 'Taze Kahve 250 g', price: 189 },
  { id: 90333, name: 'Süzme Bal 850 g', price: 455 },
];

/* ───────────── stack traces ───────────── */

export const DART_PAYMENT_STACK = `#0      PaymentService.charge (package:pati/core/payment/payment_service.dart:88:7)
<asynchronous suspension>
#1      CheckoutController.submit (package:pati/features/checkout/checkout_controller.dart:142:22)
<asynchronous suspension>
#2      _CheckoutPageState._onPayPressed (package:pati/features/checkout/checkout_page.dart:63:5)
<asynchronous suspension>`;

export const DART_NULL_CHECK_STACK = `#0      PetDetailPage.build.<anonymous closure> (package:pati/features/pets/pet_detail_page.dart:118:41)
#1      StreamBuilder.build (package:flutter/src/widgets/async.dart:442:81)
#2      _StreamBuilderBaseState.build (package:flutter/src/widgets/async.dart:124:48)
#3      StatefulElement.build (package:flutter/src/widgets/framework.dart:5841:27)
#4      ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5733:15)
#5      StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5892:11)
#6      Element.rebuild (package:flutter/src/widgets/framework.dart:5445:7)
#7      BuildScope._tryRebuild (package:flutter/src/widgets/framework.dart:2704:15)
#8      BuildScope._flushDirtyElements (package:flutter/src/widgets/framework.dart:2762:11)
#9      BuildOwner.buildScope (package:flutter/src/widgets/framework.dart:3066:18)
#10     WidgetsBinding.drawFrame (package:flutter/src/widgets/binding.dart:1229:21)
#11     RendererBinding._handlePersistentFrameCallback (package:flutter/src/rendering/binding.dart:482:5)
#12     SchedulerBinding._invokeFrameCallback (package:flutter/src/scheduler/binding.dart:1442:15)
#13     SchedulerBinding.handleDrawFrame (package:flutter/src/scheduler/binding.dart:1355:9)
#14     SchedulerBinding._handleDrawFrame (package:flutter/src/scheduler/binding.dart:1208:5)
#15     _invoke (dart:ui/hooks.dart:316:13)
#16     PlatformDispatcher._drawFrame (dart:ui/platform_dispatcher.dart:428:5)
#17     _drawFrame (dart:ui/hooks.dart:288:31)`;

export const DART_SOCKET_STACK = `#0      _NativeSocket.startConnect (dart:io-patch/socket_patch.dart:829:35)
#1      _RawSocket.startConnect (dart:io-patch/socket_patch.dart:2236:26)
#2      RawSocket.startConnect (dart:io-patch/socket_patch.dart:41:23)
#3      Socket._startConnect (dart:io-patch/socket_patch.dart:2508:22)
#4      _HttpClient._openUrl (dart:_http/http_impl.dart:2877:16)
#5      PatiApiClient._send (package:pati/core/network/api_client.dart:74:28)
<asynchronous suspension>
#6      FeedRepository.loadNext (package:pati/features/feed/feed_repository.dart:51:19)
<asynchronous suspension>`;

export const JAVA_BASKET_CRASH = `FATAL EXCEPTION: main
Process: com.mykynk.mahalle, PID: {pid}
java.lang.IllegalStateException: Fragment BasketFragment{4a1c2e9} (2b3c71f0-8d5e-4c1a-9f0e-5b7a1d2c3e4f) not attached to a context.
	at androidx.fragment.app.Fragment.requireContext(Fragment.java:972)
	at androidx.fragment.app.Fragment.getResources(Fragment.java:1036)
	at androidx.fragment.app.Fragment.getString(Fragment.java:1058)
	at com.mykynk.mahalle.ui.basket.BasketFragment.renderTotals(BasketFragment.kt:214)
	at com.mykynk.mahalle.ui.basket.BasketFragment.access$renderTotals(BasketFragment.kt:48)
	at com.mykynk.mahalle.ui.basket.BasketFragment$onViewCreated$3.invokeSuspend(BasketFragment.kt:121)
	at kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:33)
	at kotlinx.coroutines.DispatchedTask.run(DispatchedTask.kt:108)
	at android.os.Handler.handleCallback(Handler.java:959)
	at android.os.Handler.dispatchMessage(Handler.java:100)
	at android.os.Looper.loopOnce(Looper.java:232)
	at android.os.Looper.loop(Looper.java:317)
	at android.app.ActivityThread.main(ActivityThread.java:8699)
	at java.lang.reflect.Method.invoke(Native Method)
	at com.android.internal.os.RuntimeInit$MethodAndArgsCaller.run(RuntimeInit.java:580)
	at com.android.internal.os.ZygoteInit.main(ZygoteInit.java:886)
	Suppressed: kotlinx.coroutines.internal.DiagnosticCoroutineContextException: [StandaloneCoroutine{Cancelling}@8f3a2b1, Dispatchers.Main.immediate]`;

export const JAVA_BASKET_CRASH_SDK_STACK = JAVA_BASKET_CRASH.split('\n').slice(3).join('\n');

export const JAVA_TIMEOUT_STACK = `java.net.SocketTimeoutException: timeout
	at okhttp3.internal.http2.Http2Stream$StreamTimeout.newTimeoutException(Http2Stream.kt:675)
	at okhttp3.internal.http2.Http2Stream$StreamTimeout.exitAndThrowIfTimedOut(Http2Stream.kt:684)
	at okhttp3.internal.http2.Http2Stream.takeHeaders(Http2Stream.kt:143)
	at okhttp3.internal.http2.Http2ExchangeCodec.readResponseHeaders(Http2ExchangeCodec.kt:97)
	at okhttp3.internal.connection.Exchange.readResponseHeaders(Exchange.kt:110)
	at okhttp3.internal.http.CallServerInterceptor.intercept(CallServerInterceptor.kt:93)
	at okhttp3.internal.http.RealInterceptorChain.proceed(RealInterceptorChain.kt:109)
	at dev.durbun.DurbunInterceptor.intercept(DurbunInterceptor.kt:58)
	at okhttp3.internal.http.RealInterceptorChain.proceed(RealInterceptorChain.kt:109)
	at okhttp3.internal.connection.RealCall.getResponseWithInterceptorChain$okhttp(RealCall.kt:201)
	at okhttp3.internal.connection.RealCall$AsyncCall.run(RealCall.kt:517)
	at java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1145)
	at java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:644)
	at java.lang.Thread.run(Thread.java:1012)`;

export const STRICT_MODE_VIOLATION = `StrictMode policy violation; ~duration=48 ms: android.os.strictmode.DiskReadViolation
	at android.os.StrictMode$AndroidBlockGuardPolicy.onReadFromDisk(StrictMode.java:1666)
	at libcore.io.BlockGuardOs.access(BlockGuardOs.java:74)
	at libcore.io.ForwardingOs.access(ForwardingOs.java:128)
	at android.app.ActivityThread$AndroidOs.access(ActivityThread.java:8417)
	at java.io.UnixFileSystem.checkAccess(UnixFileSystem.java:332)
	at java.io.File.exists(File.java:829)
	at android.app.ContextImpl.ensurePrivateDirExists(ContextImpl.java:790)
	at android.app.ContextImpl.getSharedPreferences(ContextImpl.java:589)
	at com.mykynk.mahalle.data.prefs.SessionPrefs.<init>(SessionPrefs.kt:22)
	at com.mykynk.mahalle.MahalleApp.onCreate(MahalleApp.kt:41)`;

export const GMS_BROKER_ERROR = `Failed to get service from broker.
java.lang.SecurityException: Unknown calling package name 'com.google.android.gms'.
	at android.os.Parcel.createExceptionOrNull(Parcel.java:3242)
	at android.os.Parcel.createException(Parcel.java:3226)
	at android.os.Parcel.readException(Parcel.java:3209)
	at android.os.Parcel.readException(Parcel.java:3151)
	at bfrq.a(:com.google.android.gms@244735035@24.47.35 (260400-703785403):36)
	at bfpw.z(:com.google.android.gms@244735035@24.47.35 (260400-703785403):143)
	at bewd.run(:com.google.android.gms@244735035@24.47.35 (260400-703785403):42)
	at android.os.Handler.handleCallback(Handler.java:959)
	at android.os.Handler.dispatchMessage(Handler.java:100)
	at cfxd.mN(:com.google.android.gms@244735035@24.47.35 (260400-703785403):1)
	at android.os.Looper.loopOnce(Looper.java:232)
	at android.os.Looper.loop(Looper.java:317)
	at android.os.HandlerThread.run(HandlerThread.java:85)`;

export function anrReport(pkg: string, pid: number, now: Date): string {
  const t0 = now.toISOString().replace('T', ' ').slice(0, 23);
  const t1 = new Date(now.getTime() + 6412).toISOString().replace('T', ' ').slice(0, 23);
  return `ANR in ${pkg} (${pkg}/.ui.MainActivity)
PID: ${pid}
Reason: Input dispatching timed out (8f2c1a0 ${pkg}/${pkg}.ui.MainActivity (server) is not responding. Waited 5001ms for MotionEvent(deviceId=4, source=TOUCHSCREEN, displayId=0, action=DOWN, pointers=[0: (540.0, 1622.0)]))
ErrorId: 6b1d3a8e-0d34-4a4f-8e1c-2f6d9b1e7c55
Frozen: false
Load: 6.12 / 5.48 / 4.97
----- Output from /proc/pressure/memory -----
some avg10=0.00 avg60=0.00 avg300=0.00 total=148214
full avg10=0.00 avg60=0.00 avg300=0.00 total=60234
----- End output from /proc/pressure/memory -----
CPU usage from 0ms to 6412ms later (${t0} to ${t1}):
  98% ${pid}/${pkg}: 91% user + 6.9% kernel / faults: 3121 minor 12 major
  21% 1043/system_server: 12% user + 8.9% kernel / faults: 4410 minor
  6.4% 512/surfaceflinger: 3.1% user + 3.3% kernel / faults: 212 minor
  2.1% 1420/com.android.systemui: 1.5% user + 0.6% kernel / faults: 388 minor
33% TOTAL: 24% user + 8.1% kernel + 0.4% iowait + 0.5% irq + 0.2% softirq`;
}

/* ───────────── Flutter error boxes (as printed by FlutterError.dumpErrorToConsole) ───────────── */

const STRIPES = '◢◤'.repeat(48);
const RULE = '═'.repeat(100);

export const FLUTTER_OVERFLOW_ERROR = `══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════════════════════════════════════════════════
The following assertion was thrown during layout:
A RenderFlex overflowed by 38 pixels on the right.

The relevant error-causing widget was:
  Row Row:file:///Users/deniz/dev/pati/lib/features/pets/widgets/pet_card.dart:57:16

The overflowing RenderFlex has an orientation of Axis.horizontal.
The edge of the RenderFlex that is overflowing has been marked in the rendering with a yellow and
black striped pattern. This is usually caused by the contents being too big for the RenderFlex.
Consider applying a flex factor (e.g. using an Expanded widget) to force the children of the
RenderFlex to fit within the available space instead of being sized to their natural size.
This is considered an error condition because it indicates that there is content that cannot be
seen. If the content is legitimately bigger than the available space, consider clipping it with a
ClipRect widget before putting it in the flex, or using a scrollable container rather than a Flex,
like a ListView.
The specific RenderFlex in question is: RenderFlex#4f2a1 relayoutBoundary=up4 OVERFLOWING:
  creator: Row ← Padding ← DecoratedBox ← Container ← PetCard ← RepaintBoundary ← IndexedSemantics ←
    _SelectionKeepAlive ← NotificationListener<KeepAliveNotification> ← KeepAlive ←
    AutomaticKeepAlive ← KeyedSubtree ← ⋯
  parentData: offset=Offset(12.0, 8.0) (can use size)
  constraints: BoxConstraints(0.0<=w<=171.0, 0.0<=h<=Infinity)
  size: Size(171.0, 24.0)
  direction: horizontal
  mainAxisAlignment: start
  mainAxisSize: max
  crossAxisAlignment: center
  textDirection: ltr
  verticalDirection: down
${STRIPES}
${RULE}`;

export const FLUTTER_IMAGE_ERROR = (url: string) => `══╡ EXCEPTION CAUGHT BY IMAGE RESOURCE SERVICE ╞════════════════════════════════════════════════════
The following NetworkImageLoadException was thrown resolving an image codec:
HTTP request failed, statusCode: 404, ${url}

When the exception was thrown, this was the stack:
#0      NetworkImage._loadAsync (package:flutter/src/painting/_network_image_io.dart:117:9)
<asynchronous suspension>
#1      MultiFrameImageStreamCompleter._handleCodecReady (package:flutter/src/painting/image_stream.dart:1027:3)
<asynchronous suspension>

Image provider: NetworkImage("${url}", scale: 1.0)
Image key: NetworkImage("${url}", scale: 1.0)
${RULE}`;

export const FLUTTER_SETSTATE_ERROR = `══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═══════════════════════════════════════════════════════════
The following assertion was thrown while finalizing the widget tree:
setState() called after dispose(): _StoryViewerState#a83f1(lifecycle state: defunct, not mounted)
This error happens if you call setState() on a State object for a widget that no longer appears in
the widget tree (e.g., whose parent widget no longer includes the widget in its build). This error
can occur when code calls setState() from a timer or an animation callback.
The preferred solution is to cancel the timer or stop listening to the animation in the dispose()
callback. Another solution is to check the "mounted" property of this object before calling
setState() to ensure the object is still in the tree.

When the exception was thrown, this was the stack:
#0      State.setState.<anonymous closure> (package:flutter/src/widgets/framework.dart:1167:9)
#1      State.setState (package:flutter/src/widgets/framework.dart:1202:6)
#2      _StoryViewerState._onTick (package:pati/features/stories/story_viewer.dart:96:5)
#3      _Timer._runTimers (dart:isolate-patch/timer_impl.dart:410:19)
#4      _RawReceivePort._handleMessage (dart:isolate-patch/isolate_patch.dart:184:12)
${RULE}`;

export const WIDGET_TREE_DUMP = `[root](renderObject: RenderView#1a2b3)
└View-[GlobalObjectKey _FlutterViewState#5c6d7]
 └RawView(state: _RawViewState#8e9f0)
  └PatiApp
   └ProviderScope(state: ProviderScopeState#11a2b)
    └MaterialApp.router(state: _MaterialAppState#3c4d5)
     └ScrollConfiguration(behavior: MaterialScrollBehavior)
      └HeroControllerScope
       └Router<Object>(state: _RouterState<Object>#6e7f8)
        └Navigator-[GlobalObjectKey<NavigatorState> _CustomNavigatorState#9a0b1](state: NavigatorState#2c3d4(tickers: tracking 2 tickers))
         └HomePage(state: _HomePageState#5e6f7)
          └Scaffold(state: ScaffoldState#8a9b0(tickers: tracking 2 tickers))
           ├AppBar(title: Text("Dostlar"))
           ├PetGrid(itemCount: 20)
           │└SliverGrid(delegate: SliverChildBuilderDelegate#c1d2e(estimated child count: 20))
           │ ├PetCard(pet: Pamuk)
           │ ├PetCard(pet: Karabaş)
           │ ├PetCard(pet: Boncuk)
           │ └PetCard(pet: Zeytin)
           └NavigationBar(selectedIndex: 0, destinations: 4)`;

export const RENDER_TREE_DUMP = `RenderView#1a2b3
 │ debug mode enabled - android
 │ view size: Size(1080.0, 2400.0) (in physical pixels)
 │ device pixel ratio: 2.6 (physical pixels per logical pixel)
 │ configuration: BoxConstraints(w=415.4, h=923.1) at 2.625x (in logical pixels)
 │
 └─child: RenderSemanticsAnnotations#7f8e9
   │ creator: Semantics ← _FocusInheritedScope ← Focus ← HeroControllerScope ← ScrollConfiguration ←
   │   MaterialApp ← ProviderScope ← PatiApp ← RawView ← View ← [root]
   │ parentData: <none>
   │ constraints: BoxConstraints(w=415.4, h=923.1)
   │ size: Size(415.4, 923.1)
   │
   └─child: RenderCustomPaint#2b3c4
     │ size: Size(415.4, 923.1)
     │
     └─child: RenderFlex#5d6e7
         direction: vertical
         mainAxisAlignment: start
         size: Size(415.4, 923.1)`;

export const FEATURE_FLAGS_TEXT = `Remote config (v87, fetched 312 ms ago):
  newCheckout: true
  petStories: true
  adoptionWizardV2: false
  maxUploadMB: 10
  feedPageSize: 20
  imageCdn: "cdn.pati.app"`;
