# Mock rules

A mock rule changes what the app receives for some of its requests: a fake answer, a slower answer, or a
network failure. You define rules on the Mac in the **Mocks** tab; the Dürbün SDK inside the app applies them.
No proxy and no certificate are involved, and the server never sees a request that a rule answered.

Mock rules need an app connected through the Dürbün SDK (the **SDK** label in the sidebar). Apps watched only
through their device log, or Flutter debug apps attached through the Dart VM Service without the SDK, show
their requests but cannot be mocked. The **Connected apps** list at the bottom of the Mocks tab says which
connected apps support mocks.

## Your first rule

The quickest way starts from a real request:

1. In the **Network** tab, right-click a request and choose **Create mock**.
2. The editor opens with a rule built from that request: the same method, the exact URL, the status code,
   content type and body the server returned, and only this app. A request that failed becomes a
   **Simulate failure** rule with the same kind of error.
3. Change what you need, for example the body or the status code, and click **Create rule**.

The rule works from the next matching request on. To start from scratch instead, click **New rule** in the
Mocks tab.

New rules go to the top of the list, so they match first.

## The parts of a rule

### Match

| Field | What it does |
|---|---|
| **Method** | `GET`, `POST`… or **Any method**. Compared without regard to case |
| **URL pattern** and **Match type** | Which URLs the rule catches; see the table below. The URL is the full address the app requested: scheme, host, path and query |
| **Apps** | **All apps**, or only the apps you pick (by bundle id or package name, for example `com.example.app`). You can add an id by hand for an app that has not connected yet |

| Match type | Rule | Example pattern | Matches |
|---|---|---|---|
| **Contains** | The URL contains the text, ignoring case | `/v1/pets` | `https://api.example.com/v1/pets?page=2` |
| **Exact** | The whole URL, query included, ignoring case | `https://api.example.com/v1/pets?page=1` | only that URL |
| **Glob** | `*` is any text (slashes included), `?` one character; the whole URL must match, ignoring case | `https://api.*.com/v1/pets/*` | `https://api.staging.com/v1/pets/42?x=1` |
| **Regex** | A regular expression searched anywhere in the URL, case-sensitive | `^https://api\.example\.com/v1/pets/\d+$` | `https://api.example.com/v1/pets/42` |

An empty **Contains** pattern matches nothing. A regular expression that does not compile matches nothing.

### Action

| Action | What the app gets |
|---|---|
| **Respond** | A response made inside the app: **Status code**, **Response headers**, **Response body** (text, or base64 for binary content; **Load from file** takes files up to 8 MB). **Response delay** returns it after a wait. The request never reaches the server |
| **Delay** | The real request, sent after waiting the given time (at most 10 minutes). If the app has its own time limit for the whole request, it may give up first |
| **Simulate failure** | The platform's own error, as if the network had failed: **Timeout**, **Connection refused**, **DNS lookup failed**, **TLS / certificate error**, or **Custom message**. **Delay before failing** waits first; without it the error comes at once |

For a JSON body the editor checks the JSON and offers **Format** and **Minify**. It warns when a body is set
for a status code that carries none (204, 304).

### Name and on/off

A name helps you find the rule later (for example "Empty product list"). The switch on each row turns a rule
off without deleting it.

## Which rule wins

- **Order matters: a request gets the first rule in the list that matches.** Drag rows, or use Alt+↑ and
  Alt+↓, to reorder. Reordering is off while the search box is in use.
- A rule matches when it is on, the app is in its scope, the method matches and the URL matches.
- **All mocks** at the top turns every rule off at once; turning it back on restores the rules that were on.
  The Mocks tab title shows how many rules are on.

The **Live test** panel in the editor answers "which recent requests would this rule catch?" It lists the
captured requests that match and marks those that another rule above catches first, those outside the app
scope and those with a different method. **Try a URL** tests an address you type.

## What happens inside the app

1. When the app connects, Dürbün sends it the rules that are on and apply to that app. Every later change is
   sent at once to every connected app.
2. For each request the SDK finds the first matching rule before the request leaves the app.
3. A matched request still appears in the Network tab with a **mock** badge. Its detail shows which rule
   answered (**Open the rule in the Mocks tab**), and shared reports say the response came from a mock rule.
   The **Mocked** quick filter in Network lists them all.
4. Each rule row counts its hits in the traffic kept in memory; **Show the matching requests in the Network
   tab** lists them.
5. When the connection to the Mac drops, the app drops the rules at once. Requests made while disconnected go
   to the real server. The rules come back when the app reconnects.

Requests made at the very start, before the app has connected, go to the real server. The Flutter SDK can
wait for the Mac before starting the app: `DurbunOptions(waitForDesktop: …)`.

### How each platform reports a mock

| Platform | Respond | Simulate failure |
|---|---|---|
| Android (OkHttp with `DurbunInterceptor`) | A response made by the interceptor. Added with `addNetworkInterceptor`, **Respond** is skipped (OkHttp does not allow it there); delays and failures still work | `SocketTimeoutException`, `ConnectException`, `UnknownHostException`, `SSLHandshakeException`; a custom message gives an `IOException` |
| iOS (URLSession) | A response made inside the app; a JSON body without a `Content-Type` gets `application/json` | `URLError.timedOut`, `.cannotConnectToHost`, `.cannotFindHost`, `.secureConnectionFailed`; a custom message gives `.unknown` |
| Flutter (dart:io, `package:http`, Dio's default adapter) | A response that carries an `x-durbun-mock` header | `SocketException` ("Connection refused", "Failed host lookup", "Connection timed out"; Dio reports the timeout as `connectionTimeout`), `HandshakeException`; a custom message gives an `HttpException`. Redirect hops that dart:io follows by itself are not mocked |
| Flutter native layers | As Android and iOS above | As Android and iOS above |
| React Native (`fetch`, axios) | A response made inside the app | `Network request failed` |

Regular expressions run on each platform's own engine. Plain patterns behave the same everywhere; rarely used
syntax may differ.

## Recipes

**The payment request fails with 502.** Method `POST`, Contains `/payments`, Respond, status `502`, body
`{"error":"bad_gateway"}` with `Content-Type: application/json`.

**An empty list.** Create mock on the list request, change the body to `{"items": []}`.

**A slow search.** Contains `/search`, Delay, `3000` ms.

**A timeout after 10 seconds.** Contains `/checkout`, Simulate failure → Timeout, Delay before failing
`10000` ms.

**Only with one query value.** Regex `[?&]category=shoes(&|$)`. Contains would depend on the order of the
query parameters; the regular expression does not.

**Session expired everywhere except the login call.** Regex `^https://api\.example\.com/(?!auth/login)`,
Respond, status `401`.

**An image host is down.** Glob `https://cdn.example.com/*`, Simulate failure → DNS lookup failed.

**One app only.** Under Apps, pick the app. Rules for all apps also catch requests from other apps you have
connected, for example a second app that calls the same API.

## Rules in flows

A flow can switch rules on for one scenario: the **Add a mock**, **Turn a mock on/off** and **Remove a mock**
steps in the Mocks group. A rule added by a flow goes to the top of the list and applies only to the run's app
by default (**App only**); it is removed when the run ends, and a rule switched by a flow returns to its
earlier state, unless the step's **Keep rule** / **Keep change** option is on. In a flow step a delay is at
most 2 minutes. See [Flows](../../README.md#flows).

## Saving and sharing rules

- Rules are kept in `~/.durbun/mocks.json` and survive a restart.
- **Export** writes all rules into a `durbun-mocks-<date>.json` file. **Import** reads such a file (or a
  `.durbun` package) and either adds the rules to yours or replaces yours; rules it cannot read are listed and
  skipped.
- **Share your setup…** and **Back up everything…** (Import / export button in the top bar) carry mock rules
  together with flows, environments and settings.

## Limits

- A rule matches on method, URL and app, plus an optional GraphQL operation: not on headers or other parts of
  the request body.
- GraphQL requests share one URL. Add the **GraphQL operation** condition (name, optionally query / mutation /
  subscription) to answer one operation only. The app's SDK reads the operation from the request body it
  already holds as text; a body it cannot read (a stream, a file, more than 65,536 characters) is not matched and goes to the
  network. Every SDK reads operations (Android, iOS, Flutter, React Native / JavaScript); an app built with an
  older SDK is never sent such a rule, and the Mocks tab says which apps did not get it.
- Only requests the SDK captures can be mocked. A client that is not captured (for example `HttpURLConnection`
  on Android, a background `URLSession` on iOS, a Flutter request in a background isolate) is not mocked
  either; see [What gets captured](../../README.md#what-gets-captured).
- Rules apply while the app is connected to this Mac.
- At most 1,000 rules; delays up to 10 minutes.

## When a rule does not apply

1. The app has the **SDK** label in the sidebar and is connected now.
2. The rule and **All mocks** are on.
3. The **Live test** with the request's URL says "Matches — this rule applies". If it names another rule
   ("Matches, but … applies first"), move yours up. If it says the app is out of scope or the method differs,
   fix those fields.
4. The URL in the rule is the one the app requests, including the query for **Exact**. Copy it from the
   request in the Network tab.
5. The request is not made before the app connects (see [What happens inside the app](#what-happens-inside-the-app)).
6. Android: `DurbunInterceptor` is an application interceptor (`addInterceptor`) if you need **Respond**.
