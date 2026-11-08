# OkHttp/Okio are optional for apps: DurbunInterceptor is only loaded when the app uses it. Only the classes the
# SDK itself references are listed, so R8 still reports missing OkHttp/Okio classes the app's own code needs.
# Keep in sync with the SDK's references (javap -v over the compiled classes).
-dontwarn okhttp3.Call
-dontwarn okhttp3.Connection
-dontwarn okhttp3.FormBody
-dontwarn okhttp3.Headers
-dontwarn okhttp3.Headers$Builder
-dontwarn okhttp3.HttpUrl
-dontwarn okhttp3.Interceptor
-dontwarn okhttp3.Interceptor$Chain
-dontwarn okhttp3.MediaType
-dontwarn okhttp3.Protocol
-dontwarn okhttp3.Request
-dontwarn okhttp3.Request$Builder
-dontwarn okhttp3.RequestBody
-dontwarn okhttp3.Response
-dontwarn okhttp3.Response$Builder
-dontwarn okhttp3.ResponseBody
-dontwarn okhttp3.Route
-dontwarn okio.Buffer
-dontwarn okio.BufferedSink
-dontwarn okio.BufferedSource
-dontwarn okio.Okio
-dontwarn okio.Sink
-dontwarn okio.Source
-dontwarn okio.Timeout
# Durbun.start() looks this class up by name to leave Flutter apps to package:durbun (no-op elsewhere).
-keepnames class dev.durbun.flutter.DurbunFlutterPlugin
