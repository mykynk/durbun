# What is not captured

Traffic and output the SDK cannot see, and why.

## Network

- **Background URLSessions** (`.background(withIdentifier:)`) run out of process and cannot be intercepted.
- **Upload tasks**, by default: URLProtocol cannot report their `didSendBodyData` progress, so they run untouched
  unless ``DurbunOptions/interceptUploadTasks`` is `true` (then they are shown and mocked, without progress).
- **Sessions created before** ``Durbun/start(options:)`` (other than `URLSession.shared`).
- **WKWebView** traffic does not go through URLSession. Attach ``DurbunWebView`` to see the page's `fetch` and
  `XMLHttpRequest` calls; what the page loads by itself (documents, images, scripts) stays out of reach.
- **AVPlayer** media traffic.
- **Networking outside URLSession**: Starscream's own engine, SocketRocket, Socket.IO, raw sockets and
  Network.framework. Starscream with `useCustomEngine: false` runs on `URLSessionWebSocketTask` and is captured.
- Pings a WebSocket server sends and their automatic answers.
- In an app that creates more than 32 session configurations that differ in more than their headers, later ones
  are not captured; the Mac app shows one line saying so.

## Crashes and diagnostics

- Swift runtime traps and fatal signals cannot be sent while the app dies: they arrive on the next launch.
- Memory (jetsam) kills and other terminations iOS only counts are not single events in MetricKit.
- MetricKit stacks are not symbolicated; the full tree is in the line's data for symbolication with the dSYM.

## Logs

- iOS does not keep `debug` entries of `os_log`, so they cannot be read back from the log store over Wi-Fi.
