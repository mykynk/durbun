import Foundation

/// Configuration for `Durbun.start(options:)`. Every property has a sensible default, so
/// `Durbun.start()` is enough for the simulator and for physical devices connected over USB.
public struct DurbunOptions: Sendable {
    /// Desktop address for Wi-Fi connections, e.g. `"192.168.1.20"`. When nil the `DURBUN_HOST`
    /// environment variable (set it in the Xcode scheme) is used. Requires
    /// `NSLocalNetworkUsageDescription` in Info.plist and `durbun --lan` on the desktop.
    public var host: String?
    /// Desktop SDK port used for the simulator (127.0.0.1) and for `host`. Default 9751.
    public var port: UInt16
    /// On-device listener ports the desktop reaches over USB (usbmux) on physical devices.
    /// The first free port is used. Default 9752...9755.
    public var devicePorts: ClosedRange<UInt16>
    /// Master switch. When false, `Durbun.start` does nothing.
    public var enabled: Bool
    /// Capture `print`, stdout and stderr (still written to the Xcode console). Default true.
    public var captureStdout: Bool
    /// Capture URLSession traffic (shared and custom sessions) and apply mock rules. Default true.
    public var captureNetwork: Bool
    /// Report uncaught Objective-C exceptions immediately and fatal signals (Swift runtime traps,
    /// EXC_BAD_ACCESS…) on the next launch. Default true.
    public var captureCrashes: Bool
    /// Send CPU, memory and FPS / janky-frame samples while connected. Default true.
    public var collectMetrics: Bool
    /// Intercept `URLSessionUploadTask`s too. URLProtocol cannot report upload progress, so set this
    /// to false if your UI relies on `didSendBodyData` while debugging. Default true.
    public var interceptUploadTasks: Bool
    /// Hosts that are never captured, e.g. `["analytics.example.com"]`. Subdomains match too.
    public var ignoredHosts: [String]
    /// Outgoing messages kept while the desktop is not connected (oldest dropped first). Default 5000.
    public var maxBufferedMessages: Int
    /// Allow running in builds compiled without `DEBUG`. Default false: release builds stay inert
    /// even when `Durbun.start()` is called.
    public var allowInReleaseBuilds: Bool

    public init(
        host: String? = nil,
        port: UInt16 = 9751,
        devicePorts: ClosedRange<UInt16> = 9752...9755,
        enabled: Bool = true,
        captureStdout: Bool = true,
        captureNetwork: Bool = true,
        captureCrashes: Bool = true,
        collectMetrics: Bool = true,
        interceptUploadTasks: Bool = true,
        ignoredHosts: [String] = [],
        maxBufferedMessages: Int = 5000,
        allowInReleaseBuilds: Bool = false
    ) {
        self.host = host
        self.port = port
        self.devicePorts = devicePorts
        self.enabled = enabled
        self.captureStdout = captureStdout
        self.captureNetwork = captureNetwork
        self.captureCrashes = captureCrashes
        self.collectMetrics = collectMetrics
        self.interceptUploadTasks = interceptUploadTasks
        self.ignoredHosts = ignoredHosts
        self.maxBufferedMessages = maxBufferedMessages
        self.allowInReleaseBuilds = allowInReleaseBuilds
    }
}
