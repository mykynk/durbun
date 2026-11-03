# OkHttp/Okio are optional for apps: DurbunInterceptor is only loaded when the app uses it.
-dontwarn okhttp3.**
-dontwarn okio.**
# Durbun.start() looks this class up by name to leave Flutter apps to package:durbun (no-op elsewhere).
-keepnames class dev.durbun.flutter.DurbunFlutterPlugin
