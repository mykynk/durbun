# Network capture

Every `URLSession` request, with headers, bodies, timings and errors.

## Overview

`URLSession.shared` and every session created **after** ``Durbun/start(options:)`` are captured, Alamofire
included: headers, bodies, redirects, timings (DNS, TCP, TLS, wait, receive), the protocol (h2, h3), errors and
cancellations. Requests are forwarded untouched; timeouts and certificate validation (pinning) are still enforced
by your own session.

- An intercepted request runs with a copy of the configuration of the session that started it: the same
  `URLCache`, cookie and credential storage, proxy, TLS limits and network rules.
- Stream (`httpBodyStream`) and file upload bodies are held in memory only up to the capture limit plus 256 KB;
  larger ones are streamed through and cannot be resent for a 307/308 redirect.
- URLProtocol cannot report upload progress: set ``DurbunOptions/interceptUploadTasks`` to `false` when your UI
  relies on `didSendBodyData`.

## Mask and skip

- ``DurbunOptions/redactHeaders`` masks header values as `••••` in what the Mac app shows (for example
  `["Authorization", "Cookie"]`); the real request is unchanged.
- ``DurbunOptions/ignoredHosts`` leaves hosts and their subdomains out: they are not captured and mock rules do
  not apply to them.
- ``DurbunOptions/captureBodies`` and ``DurbunOptions/maxBodyBytes`` override the Mac app's body settings
  (at most 8 MB per body).

## Mock rules

Rules are defined in the Mac app and pushed to the SDK live. Mocked requests are marked in the Mac app.

| Action | What the app sees |
|---|---|
| `respond` | A synthesized response that never touches the network |
| `delay` | The real request, after waiting the given time |
| `fail` | `timeout` → `URLError.timedOut`, `connection` → `.cannotConnectToHost`, `dns` → `.cannotFindHost`, `tls` → `.secureConnectionFailed`, `custom` → `.unknown` |

When the connection to the Mac drops, the rules it pushed are removed at once.
