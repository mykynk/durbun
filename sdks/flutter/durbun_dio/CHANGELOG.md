## Unreleased

- New `DurbunDioAdapter(inner)`: wraps your adapter (`NativeAdapter`, cronet_http) and reports every request
  that reaches the network, retries included. Every row ends, whatever other interceptors do. The response body
  and size are the bytes the adapter delivered, and the time runs until the last byte. Mock rules apply there
  too. This is now the recommended setup.
- `DurbunDioInterceptor`: a request that another interceptor answers and sends again (a token refresh) no longer
  stays "pending"; its row ends with a note when the retry starts. It also stays out of the way of a
  `DurbunDioAdapter` on the same Dio.
- Server-Sent Events read with `ResponseType.stream` through `DurbunDioAdapter` or `DurbunDioInterceptor` show
  each event under the request while the Mac app asks for them; a stream your code stops reading shows as
  cancelled. Needs the `durbun` release that ships with this one.
- Mock rules limited to one GraphQL operation match on the body Dio sends (a `Map` / `List` encoded as JSON, a
  `String`, bytes). A `FormData` or `Stream` body never matches such a rule. Needs the `durbun` release that
  ships with this one.

## 0.2.0

- Requires `durbun: ^0.2.0`. No changes of its own: every Dürbün part
  carries the same version.

## 0.1.0

- First release: `DurbunDioInterceptor` reports Dio requests made through
  adapters that bypass dart:io (`NativeAdapter`, cronet_http) to Dürbün and
  applies the desktop's mock rules (`respond`, `delay`, `fail`).
- `dio:` is required: requests on Dio's default dart:io adapter are left to
  `package:durbun` (no duplicates, no double mock delays), and on iOS
  URLSession-based adapters are left to the plugin's native layer.
- Bodies are encoded only up to the desktop's body limit.
