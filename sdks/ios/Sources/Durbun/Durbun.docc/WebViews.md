# Web views

Requests and console output of the pages inside a `WKWebView`.

## Overview

`WKWebView` loads pages in a separate process, so its traffic does not go through URLSession. Attach
``DurbunWebView`` to a web view and the page's `fetch` and `XMLHttpRequest` calls appear in the Network tab
(client `webview:fetch` / `webview:xhr`), and its `console.*` lines and uncaught errors in the log stream (tag
`webview`).

```swift
let configuration = WKWebViewConfiguration()
DurbunWebView.attach(to: configuration)          // before the web view is created
let webView = WKWebView(frame: .zero, configuration: configuration)
```

``DurbunWebView/attach(_:)`` attaches to an existing web view instead; pages it loads from then on are reported.

## How it works

A small script runs at document start in every frame, before the page's own scripts. It wraps `fetch`,
`XMLHttpRequest` and `console` without changing what the page sees: the original runs with the same arguments
and returns the same result, response bodies are read from clones (`Response.clone()`), and the script's own
errors are swallowed. It reports through one script message handler and exposes nothing else.

- Bodies follow the SDK's capture settings (``DurbunOptions/captureBodies``, ``DurbunOptions/maxBodyBytes``) and
  are cut at 64 KB by the script; ``DurbunOptions/ignoredHosts`` and ``DurbunOptions/redactHeaders`` apply.
- Timings are measured in the page: `wait` until the response headers, `receive` until the body was read.
- Event-stream responses are reported at their headers, without their events.
- Messages are limited in size and rate; when a page sends too many, the Mac app shows one line saying how many
  were dropped.
- While Dürbün is not running, `attach` returns `false` and changes nothing.

> Important: The page can post to the same handler, so an entry from a web view is whatever the page claims.
> Treat it as page content, not as a record of what went over the network.

## Not captured

WebSocket and EventSource connections of the page, `navigator.sendBeacon`, and what the page loads by itself
(documents, images, scripts, styles).
