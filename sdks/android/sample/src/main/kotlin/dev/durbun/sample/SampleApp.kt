package dev.durbun.sample

import android.app.Application
import dev.durbun.Durbun
import dev.durbun.DurbunAction
import dev.durbun.DurbunEventListenerFactory
import dev.durbun.DurbunInterceptor
import dev.durbun.DurbunOptions
import dev.durbun.DurbunWebSocketFactory
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class SampleApp : Application() {
    override fun onCreate() {
        super.onCreate()

        // 1. Start Dürbün as early as possible. Over USB and on an emulator nothing else is needed; for Wi-Fi,
        //    pass DurbunOptions(host = "<the Mac's IP address>") or use Durbun.setDesktopHost(...).
        Durbun.start(
            this,
            DurbunOptions(
                appName = "Dürbün sample",
                redactHeaders = setOf("Authorization"), // shown as •••• in the Mac app; the request is unchanged
            ),
        )

        server = DemoServer.start()

        // 2. One OkHttpClient for the whole app, with the interceptor last among the application interceptors.
        client = OkHttpClient.Builder()
            .addInterceptor(DurbunInterceptor())
            .eventListenerFactory(DurbunEventListenerFactory()) // DNS, connect, TLS, send and wait times
            .readTimeout(15, TimeUnit.SECONDS)
            .build()

        // 3. WebSockets go through the factory so their messages show up too.
        webSockets = DurbunWebSocketFactory(client)

        // 4. The app's own tools, under App tools in the Mac app's Device tab. Handlers run on the main thread.
        Durbun.addAction(DurbunAction.button("sample.runAll", "Run every request") { Demo.runAll() })
        Durbun.addAction(
            DurbunAction.toggle("sample.verbose", "Verbose logging", initial = Demo.verbose) { on ->
                Demo.verbose = on
                Durbun.i("sample", "Verbose logging is ${if (on) "on" else "off"}")
            },
        )
        Durbun.addAction(
            DurbunAction.select(
                "sample.items",
                "Items per JSON response",
                listOf(DurbunAction.Option("3", "3"), DurbunAction.Option("50", "50"), DurbunAction.Option("500", "500")),
                initial = Demo.items.toString(),
            ) { value -> Demo.items = value.toInt() },
        )
    }

    companion object {
        lateinit var server: DemoServer
            private set
        lateinit var client: OkHttpClient
            private set
        lateinit var webSockets: DurbunWebSocketFactory
            private set
    }
}
