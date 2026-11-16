# Tools in the Mac app

Run code inside the app from the Mac app's Device tab.

## Overview

Built in, under App tools: light or dark appearance, slow animations, a view hierarchy dump and a UserDefaults
dump. Add your own with ``Durbun/registerAction(_:handler:)``: a button, a toggle or a picker.

```swift
Durbun.registerAction(DurbunAction(id: "app.clearCache", label: "Clear image cache")) { _ in
    ImageCache.shared.removeAll()
    return nil
}
Durbun.registerAction(DurbunAction(id: "app.mockLogin", label: "Mock login", kind: .toggle(false))) { params in
    FeatureFlags.mockLogin = params["value"] as? Bool ?? false
    return nil
}
```

- Handlers run on the main thread. Toggles receive their new value as `Bool` and pickers as `String` in
  `params["value"]`.
- Return a value to send it back as the result, or throw a ``DurbunActionError`` to report a readable failure.
- Registering an existing id replaces the tool; ``Durbun/removeAction(id:)`` removes it. Ids that start with
  `ios.` are reserved for the built-in tools.
