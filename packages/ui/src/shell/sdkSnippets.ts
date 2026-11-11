/**
 * SDK setup snippets. Every API line mirrors the real SDKs (sdks/flutter/durbun + durbun_dio, sdks/android,
 * sdks/ios, sdks/js — READMEs and public APIs). Two sources: the package registries (pub.dev, Maven
 * Central, SwiftPM / CocoaPods, npm) and a local clone of this repository (`repo`, an absolute path that
 * may contain spaces). Only the source lines and the comment language change.
 */
import type { Lang } from '../i18n/core';

declare const __DURBUN_RN_VERSION__: string;
declare const __DURBUN_SDK_VERSION__: string;

/** Published SDK version (Flutter, Android, iOS) at build time. */
export const SDK_VERSION: string = typeof __DURBUN_SDK_VERSION__ === 'string' && __DURBUN_SDK_VERSION__ ? __DURBUN_SDK_VERSION__ : '0.2.0';
export const REPO_URL = 'https://github.com/mykynk/durbun';
/** Maven Central group of the Android SDK (sdks/android publishing). */
export const MAVEN_GROUP = 'io.github.mykynk';

/** `@durbun/react-native` version at build time → `npm pack` file name. */
const RN_VERSION: string = typeof __DURBUN_RN_VERSION__ === 'string' && __DURBUN_RN_VERSION__ ? __DURBUN_RN_VERSION__ : '0.2.0';
export const RN_TGZ = `durbun-react-native-${RN_VERSION}.tgz`;

const c = (lang: Lang, tr: string, en: string) => (lang === 'tr' ? tr : en);

/* ───────────── Flutter ───────────── */

export function flutterPubspecRegistry(): string {
  return `dependencies:
  durbun: ^${SDK_VERSION}`;
}

export function flutterDioPubspecRegistry(): string {
  return `dependencies:
  durbun_dio: ^${SDK_VERSION}`;
}

export function flutterPubspec(repo: string): string {
  return `dependencies:
  durbun:
    path: "${repo}/sdks/flutter/durbun"`;
}

export function flutterMain(lang: Lang): string {
  return `import 'package:durbun/durbun.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized(); // ${c(lang, 'zone içinde çağırın', 'call it inside the zone')}
    runApp(const MyApp());
  });
}`;
}

/**
 * Release builds with the SDK on: the team picks the builds (Firebase, ad hoc, store), the guide states the commands.
 * `flutter build ipa` exports for the App Store by default; Firebase App Distribution / ad-hoc needs `--export-method
 * ad-hoc`.
 */
export function flutterReleaseFlag(lang: Lang): string {
  return `# Android
flutter build apk --release --dart-define=DURBUN=true
# iOS
flutter build ipa --release --dart-define=DURBUN=true
# ${c(lang, 'iOS · Firebase App Distribution ya da ad-hoc dağıtım', 'iOS · Firebase App Distribution or ad-hoc distribution')}
flutter build ipa --release --export-method ad-hoc --dart-define=DURBUN=true`;
}

/** Android native layer of a Flutter app: one line on the app's own OkHttp clients. */
export function flutterNativeAndroid(lang: Lang): string {
  return `import dev.durbun.DurbunInterceptor

val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())   // ${c(lang, 'tek satır', 'the one line')}
    .build()`;
}

export function flutterUsage(lang: Lang): string {
  return `Durbun.log('${c(lang, 'Kullanıcı giriş yaptı', 'User signed in')}', tag: 'auth', data: {'userId': 42});
Durbun.d('${c(lang, 'Önbellek ısındı', 'Cache warmed up')}');            // v / d / i / w / e / f
Durbun.e('${c(lang, 'Ödeme başarısız', 'Payment failed')}', error: e, stackTrace: st);
Durbun.event('purchase', {'amount': 49.9});`;
}

export function flutterDioPubspec(repo: string): string {
  return `dependencies:
  durbun_dio:
    path: "${repo}/sdks/flutter/durbun_dio"`;
}

export const FLUTTER_DIO = `import 'package:durbun_dio/durbun_dio.dart';

final dio = Dio()..httpClientAdapter = NativeAdapter();
dio.interceptors.add(DurbunDioInterceptor(dio: dio));`;

export function flutterWifi(host: string, sdkPort?: number): string {
  return `flutter run --dart-define=DURBUN_HOST=${host}${sdkPort ? `:${sdkPort}` : ''}`;
}

/* ───────────── Android ───────────── */

export function androidSettings(repo: string): string {
  return `include(":durbun", ":durbun-noop")
project(":durbun").projectDir = file("${repo}/sdks/android/durbun")
project(":durbun-noop").projectDir = file("${repo}/sdks/android/durbun-noop")`;
}

export function androidSettingsGroovy(repo: string): string {
  return `include ':durbun', ':durbun-noop'
project(':durbun').projectDir = new File('${repo}/sdks/android/durbun')
project(':durbun-noop').projectDir = new File('${repo}/sdks/android/durbun-noop')`;
}

export function androidDependenciesRegistry(lang: Lang): string {
  return `dependencies {
    debugImplementation("${MAVEN_GROUP}:durbun:${SDK_VERSION}")        // ${c(lang, 'gerçek SDK yalnızca debug’da', 'the real SDK in debug only')}
    releaseImplementation("${MAVEN_GROUP}:durbun-noop:${SDK_VERSION}") // ${c(lang, 'release’te aynı API, boş gövdeler', 'same API, empty bodies in release')}
    // ${c(lang, 'Flutter host uygulamalarında “profile” build type’ı da vardır:', 'Flutter host apps also have a “profile” build type:')}
    // "profileImplementation"("${MAVEN_GROUP}:durbun-noop:${SDK_VERSION}")
}
// ${c(lang, 'Depo: mavenCentral() (Android projelerinde varsayılan olarak tanımlıdır)', 'Repository: mavenCentral() (declared by default in Android projects)')}`;
}

export function androidDependencies(lang: Lang): string {
  return `dependencies {
    debugImplementation(project(":durbun"))        // ${c(lang, 'gerçek SDK yalnızca debug’da', 'the real SDK in debug only')}
    releaseImplementation(project(":durbun-noop")) // ${c(lang, 'release’te aynı API, boş gövdeler', 'same API, empty bodies in release')}
    // ${c(lang, 'Flutter host uygulamalarında “profile” build type’ı da vardır:', 'Flutter host apps also have a “profile” build type:')}
    // "profileImplementation"(project(":durbun-noop"))
}`;
}

export function androidStart(lang: Lang): string {
  return `import dev.durbun.*

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Durbun.start(this)   // ${c(lang, 'USB ve emülatör için başka ayar gerekmez', 'nothing else needed for USB and emulators')}
    }
}

val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())   // ${c(lang, 'Retrofit’e de bu client’ı verin', 'give this client to Retrofit too')}
    .build()`;
}

export function androidUsage(lang: Lang): string {
  return `Durbun.log(Level.INFO, "auth", "${c(lang, 'Kullanıcı giriş yaptı', 'User signed in')}", data = mapOf("userId" to 42))
Durbun.e("payment", "${c(lang, 'Ödeme başarısız', 'Payment failed')}", throwable = e)
Durbun.event("purchase", mapOf("amount" to 49.9))`;
}

export function androidWifi(host: string, sdkPort?: number): string {
  return `Durbun.start(this, DurbunOptions(host = "${host}"${sdkPort ? `, port = ${sdkPort}` : ''}))`;
}

/* ───────────── iOS ───────────── */

export function iosPackageRegistry(lang: Lang): string {
  return `// Package.swift
dependencies: [
    .package(url: "${REPO_URL}", from: "${SDK_VERSION}"),
],
// ${c(lang, 'hedefin bağımlılığı', 'target dependency')}
.product(name: "Durbun", package: "durbun")`;
}

export function iosPodfile(lang: Lang): string {
  return `# Podfile
pod 'Durbun', '~> ${SDK_VERSION}'
# ${c(lang, 'Yalnızca debug derlemelerinde isterseniz:', 'Only in debug builds, if you prefer:')}
# pod 'Durbun', '~> ${SDK_VERSION}', :configurations => ['Debug']`;
}

export function iosPackage(repo: string, lang: Lang): string {
  return `// Package.swift
dependencies: [
    .package(path: "${repo}/sdks/ios"),
],
// ${c(lang, 'hedefin bağımlılığı — yerel pakette paket kimliği klasör adıdır: "ios"', 'target dependency — for a local package the identity is the folder name: "ios"')}
.product(name: "Durbun", package: "ios")`;
}

export function iosStart(lang: Lang): string {
  return `import Durbun

@main
struct MyApp: App {
    init() {
        #if DEBUG
        Durbun.start()   // ${c(lang, 'simülatör ve USB: ayar gerekmez', 'simulator and USB: nothing to configure')}
        #endif
    }
    var body: some Scene { WindowGroup { ContentView() } }
}
// ${c(lang, 'UIKit: application(_:didFinishLaunchingWithOptions:) içinde aynı satırlar.', 'UIKit: the same lines in application(_:didFinishLaunchingWithOptions:).')}`;
}

export function iosUsage(lang: Lang): string {
  return `Durbun.log("${c(lang, 'Giriş yapıldı', 'Logged in')}", level: .info, tag: "auth", data: ["userId": 42])
Durbun.debug("${c(lang, 'Önbellekten okundu', 'Read from cache')}", tag: "cache")
Durbun.warning("${c(lang, 'Yavaş yanıt', 'Slow response')}", tag: "api", data: ["ms": 2300])
Durbun.error("${c(lang, 'Ödeme başarısız', 'Payment failed')}", error: error, tag: "payment")
Durbun.event("purchase", ["amount": 49.9])`;
}

export function iosWifi(host: string, sdkPort?: number): string {
  return `Durbun.start(options: .init(host: "${host}"${sdkPort ? `, port: ${sdkPort}` : ''}))`;
}

export function iosLocalNetwork(lang: Lang): string {
  return `<key>NSLocalNetworkUsageDescription</key>
<string>${c(lang, 'Dürbün geliştirici aracına bağlanmak için', 'To connect to the Dürbün developer tool')}</string>`;
}

/* ───────────── React Native ───────────── */

export function rnInstallRegistry(): string {
  return `npm install @durbun/react-native`;
}

export function rnPack(repo: string, lang: Lang): string {
  return `cd "${repo}/sdks/js" && npm pack   # → ${RN_TGZ} (${c(lang, 'prepack derler', 'prepack builds it')})`;
}

export function rnInstall(repo: string, lang: Lang): string {
  return `npm install "${repo}/sdks/js/${RN_TGZ}"
# ${c(lang, 'ya da klasörden (önce npm run build; Metro için watchFolders gerekir):', 'or from the folder (npm run build first; Metro needs watchFolders):')}
# npm install "${repo}/sdks/js"`;
}

export function rnStart(lang: Lang): string {
  return `import { AppRegistry } from 'react-native';
import { Durbun } from '@durbun/react-native';
import App from './App';
import { name as appName } from './app.json';

Durbun.start(); // ${c(lang, '__DEV__ değilse hiçbir şey yapmaz (enabled varsayılanı __DEV__)', 'does nothing unless __DEV__ (enabled defaults to __DEV__)')}

AppRegistry.registerComponent(appName, () => App);`;
}

export function rnUsage(lang: Lang): string {
  return `Durbun.log('${c(lang, 'Kullanıcı giriş yaptı', 'User signed in')}', { tag: 'auth', data: { userId: 42 } });
Durbun.error('${c(lang, 'Ödeme başarısız', 'Payment failed')}', e);
Durbun.event('purchase', { amount: 49.9 });`;
}

export function rnWifi(host: string, httpPort?: number): string {
  return `Durbun.start({ host: '${host}${httpPort ? `:${httpPort}` : ''}' });`;
}
