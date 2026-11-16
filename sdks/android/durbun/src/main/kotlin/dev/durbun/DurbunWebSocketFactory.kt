package dev.durbun

import dev.durbun.internal.WebSocketCapture
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Opens OkHttp WebSockets whose messages show up in Dürbün: text, binary and close frames in both directions, in
 * the order the app saw them, under the connection's handshake entry. OkHttp hands WebSocket messages to no
 * interceptor, so the socket is opened through this factory instead of `client.newWebSocket(...)`:
 *
 * ```kotlin
 * val webSockets = DurbunWebSocketFactory(client)              // the app's OkHttpClient
 * val socket = webSockets.newWebSocket(request, listener)      // instead of client.newWebSocket(request, listener)
 * ```
 *
 * It is an `okhttp3.WebSocket.Factory`, so it also goes where a library takes one (Ktor's OkHttp engine:
 * `webSocketFactory = DurbunWebSocketFactory(client)`). The app's listener gets every callback, on OkHttp's
 * threads, with the `WebSocket` this factory returned; [WebSocket.request] is the app's own request.
 *
 * With [DurbunInterceptor] on the client, the handshake entry is the interceptor's (mocks apply to it); without
 * it, the factory reports the handshake itself. Messages are sent while the Dürbün desktop asks for them (newer
 * desktops, with stream capture on in its settings). Until [Durbun.start] has run (and always in release builds,
 * with [DurbunOptions.captureNetwork] off, or for [DurbunOptions.ignoredHosts]) it opens the socket exactly as
 * [delegate] would.
 *
 * @param delegate what opens the socket: usually the `OkHttpClient` itself.
 */
class DurbunWebSocketFactory(
    private val delegate: WebSocket.Factory,
) : WebSocket.Factory {
    override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket {
        val core = Durbun.coreOrNull()
        if (core == null || !core.options.captureNetwork) return delegate.newWebSocket(request, listener)
        return WebSocketCapture.open(core, delegate, request, listener)
    }
}
