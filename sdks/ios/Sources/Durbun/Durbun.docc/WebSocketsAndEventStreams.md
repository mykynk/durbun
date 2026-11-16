# WebSockets and event streams

Long-lived connections as one entry each, with every message in the order the app saw it.

## Overview

When the Mac app asks for them (it does by default), each `URLSessionWebSocketTask` and each
`text/event-stream` response is one entry in the Network tab with its messages.

| Stack | Captured without code changes |
|---|---|
| `URLSessionWebSocketTask` (completion handlers and `async` `send` / `receive`) | The handshake, every text and binary message both ways, `sendPing` and its pong, the close frame from either side with code and reason, failures and `cancel()` |
| Server-Sent Events over URLSession: a delegate's `didReceive data`, `bytes(for:)` / `bytes(from:)` and libraries built on them | The response as soon as its first bytes arrive, then one row per event (`event`, `id`, `retry`, the data lines), the normal end, a broken stream and cancelling the reader |

- The messages are a copy: nothing is consumed, reordered or delayed, and the app's blocks run on their usual
  threads.
- Payloads are cut at the Mac app's limit (64 KB by default); sizes are always exact. With
  ``DurbunOptions/captureBodies`` set to `false` only sizes are sent.
- Only what URLSession shows is reported: pings the server sends and their automatic answers are not, and a pong
  is read only while a `receive` is pending.
- To find the task class it hooks, the SDK creates one WebSocket task at start and never resumes it.

WebSocket libraries with their own networking (raw sockets, Network.framework) are not captured; see
<doc:WhatIsNotCaptured>.
