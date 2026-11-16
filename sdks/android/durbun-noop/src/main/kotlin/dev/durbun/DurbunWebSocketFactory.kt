package dev.durbun

import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** No-op WebSocket factory for release builds: opens every socket exactly as [delegate] does, untouched. */
class DurbunWebSocketFactory(
    private val delegate: WebSocket.Factory,
) : WebSocket.Factory {
    override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
        delegate.newWebSocket(request, listener)
}
