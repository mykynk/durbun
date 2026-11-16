import Foundation

/// Configuration for `Durbun.start(options:)`. Every property has a sensible default, so
/// `Durbun.start()` is enough for the simulator and for physical devices connected over USB.
public struct DurbunOptions: Sendable {
    /// Desktop address for Wi-Fi connections, e.g. `"192.168.1.20"`. When nil the `DURBUN_HOST`
    /// environment variable (set it in the Xcode scheme) is used. Requires
    /// `NSLocalNetworkUsageDescription` in Info.plist and, in the Mac app, Settings →
    /// "Allow local network (Wi-Fi) connections".
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
    /// Header names (case-insensitive) whose values are shown as `••••` in captured requests and
    /// responses, e.g. `["Authorization", "Cookie"]`. The real request is unchanged. Default none.
    public var redactHeaders: [String]
    /// Outgoing messages kept while the desktop is not connected (oldest dropped first). Default 5000.
    public var maxBufferedMessages: Int
    /// Allow running in builds compiled without `DEBUG`. Default false: such builds run only when they
    /// are development builds (Simulator, a debugger attached, signed for development) or when
    /// Info.plist says `DurbunEnabled = YES`.
    public var allowInReleaseBuilds: Bool
    /// Overrides the desktop's "capture bodies" setting: `false` records sizes only. Default nil
    /// (follow the desktop).
    public var captureBodies: Bool?
    /// Overrides the desktop's per-body capture limit in bytes (at most 8 MB). Default nil (follow the
    /// desktop, 1 MB unless changed there).
    public var maxBodyBytes: Int?
    /// Name shown on the desktop. Default nil: the bundle's display name.
    public var appName: String?
    /// Forward this app's own `os_log` / `Logger` / `NSLog` lines when the desktop cannot read the
    /// device's logs (Wi-Fi). Default nil: the same as `captureStdout`.
    public var captureOSLog: Bool?

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
        redactHeaders: [String] = [],
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
        self.redactHeaders = redactHeaders
        self.maxBufferedMessages = maxBufferedMessages
        self.allowInReleaseBuilds = allowInReleaseBuilds
        self.captureBodies = nil
        self.maxBodyBytes = nil
        self.appName = nil
        self.captureOSLog = nil
    }

    /// Every option, including the ones added after the first release.
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
        redactHeaders: [String] = [],
        maxBufferedMessages: Int = 5000,
        allowInReleaseBuilds: Bool = false,
        captureBodies: Bool? = nil,
        maxBodyBytes: Int? = nil,
        appName: String? = nil,
        captureOSLog: Bool? = nil
    ) {
        self.init(
            host: host,
            port: port,
            devicePorts: devicePorts,
            enabled: enabled,
            captureStdout: captureStdout,
            captureNetwork: captureNetwork,
            captureCrashes: captureCrashes,
            collectMetrics: collectMetrics,
            interceptUploadTasks: interceptUploadTasks,
            ignoredHosts: ignoredHosts,
            redactHeaders: redactHeaders,
            maxBufferedMessages: maxBufferedMessages,
            allowInReleaseBuilds: allowInReleaseBuilds
        )
        self.captureBodies = captureBodies
        self.maxBodyBytes = maxBodyBytes
        self.appName = appName
        self.captureOSLog = captureOSLog
    }
}
