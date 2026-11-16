package dev.durbun;

import static org.junit.Assert.assertSame;

import okhttp3.Request;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.junit.Test;

/** The stream API reads naturally from Java. */
public class JavaApiTest {
    @Test
    public void webSocketFactoryFromJava() {
        final Request request = new Request.Builder().url("ws://localhost/chat").build();
        final WebSocket opened = new WebSocket() {
            @Override public Request request() { return request; }
            @Override public long queueSize() { return 0; }
            @Override public boolean send(String text) { return true; }
            @Override public boolean send(ByteString bytes) { return true; }
            @Override public boolean close(int code, String reason) { return true; }
            @Override public void cancel() { }
        };
        WebSocket.Factory delegate = new WebSocket.Factory() {
            @Override
            public WebSocket newWebSocket(Request r, WebSocketListener l) {
                return opened;
            }
        };
        // Dürbün is not started here: the factory opens exactly what the delegate opens.
        WebSocket socket = new DurbunWebSocketFactory(delegate).newWebSocket(request, new WebSocketListener() {
        });
        assertSame(opened, socket);
    }
}
