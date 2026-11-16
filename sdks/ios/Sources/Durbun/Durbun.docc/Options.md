# Options

What ``DurbunOptions`` changes.

## Overview

Every option has a default, so `Durbun.start()` is enough in the Simulator and over USB.

| Option | Default | What it does |
|---|---|---|
| ``DurbunOptions/host`` | `nil` (`DURBUN_HOST`) | The Mac's IP address for Wi-Fi |
| ``DurbunOptions/port`` | `9751` | Simulator and Wi-Fi port |
| ``DurbunOptions/devicePorts`` | `9752...9755` | USB listener ports on a physical device |
| ``DurbunOptions/enabled`` | `true` | If `false`, `start` does nothing |
| ``DurbunOptions/captureStdout`` | `true` | Capture `print`, stdout and stderr |
| ``DurbunOptions/captureOSLog`` | `nil` (same as `captureStdout`) | Forward the app's own `os_log` lines when the Mac app cannot read device logs |
| ``DurbunOptions/captureNetwork`` | `true` | Capture URLSession traffic and apply mock rules |
| ``DurbunOptions/captureCrashes`` | `true` | Crash reports and MetricKit diagnostics |
| ``DurbunOptions/collectMetrics`` | `true` | CPU, memory and FPS samples, and the launch time |
| ``DurbunOptions/interceptUploadTasks`` | `true` | Intercept upload tasks; `false` keeps `didSendBodyData` progress |
| ``DurbunOptions/ignoredHosts`` | `[]` | Hosts never captured (subdomains included) |
| ``DurbunOptions/redactHeaders`` | `[]` | Header names masked as `••••` |
| ``DurbunOptions/captureBodies`` | `nil` | Overrides the Mac app's setting (`false` records sizes only) |
| ``DurbunOptions/maxBodyBytes`` | `nil` | Capture limit per body, at most 8 MB |
| ``DurbunOptions/appName`` | `nil` | Name shown in the Mac app |
| ``DurbunOptions/maxBufferedMessages`` | `5000` | Messages kept while disconnected |
| ``DurbunOptions/allowInReleaseBuilds`` | `false` | Run in every build, also those that are not development builds |
