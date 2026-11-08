## 0.1.0

- First release: `DurbunDioInterceptor` reports Dio requests made through
  adapters that bypass dart:io (`NativeAdapter`, cronet_http) to Dürbün and
  applies the desktop's mock rules (`respond`, `delay`, `fail`).
- `dio:` is required: requests on Dio's default dart:io adapter are left to
  `package:durbun` (no duplicates, no double mock delays), and on iOS
  URLSession-based adapters are left to the plugin's native layer.
- Bodies are encoded only up to the desktop's body limit.
