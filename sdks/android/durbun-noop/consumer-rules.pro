# OkHttp/Okio are optional for apps: DurbunInterceptor is only loaded when the app uses it. Only the classes the
# SDK itself references are listed, so R8 still reports missing OkHttp/Okio classes the app's own code needs.
# Keep in sync with the SDK's references (javap -v over the compiled classes).
-dontwarn okhttp3.Call
-dontwarn okhttp3.EventListener
-dontwarn okhttp3.EventListener$Factory
-dontwarn okhttp3.Interceptor
-dontwarn okhttp3.Interceptor$Chain
-dontwarn okhttp3.Request
-dontwarn okhttp3.Response
-dontwarn okhttp3.WebSocket
-dontwarn okhttp3.WebSocket$Factory
-dontwarn okhttp3.WebSocketListener
