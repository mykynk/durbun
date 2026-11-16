import Foundation

/// What `DurbunURLProtocol` needs on its hot path, read under one lock.
struct NetworkCapturePolicy {
    var active = false
    var interceptUploadTasks = true
    var ignoredHosts: [String] = []
    /// Lower-cased header names whose values are replaced before they leave the device.
    var redactedHeaders: Set<String> = []

    func ignores(host: String) -> Bool {
        guard !ignoredHosts.isEmpty else { return false }
        let host = host.lowercased()
        return ignoredHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

/// Central coordinator: owns the transport and every capture component. All public entry points
/// are thread-safe; nothing here blocks on I/O.
final class DurbunCore {
    static let shared = DurbunCore()

    /// `hello.session`: one random id per app launch (kept across stop/start in the same process,
    /// so the desktop reuses the app session).
    static let sessionId = UUID().uuidString.lowercased()

    /// Internal knobs for tests (the public options cover real apps).
    struct Overrides {
        /// Force the on-device USB listener on/off (default: physical iOS devices only).
        var deviceListener: Bool?
        /// Disable the 127.0.0.1 client (default: enabled except on physical iOS devices).
        var loopbackClient: Bool?
        var reconnectMinDelay: TimeInterval?
        var reconnectMaxDelay: TimeInterval?
        var handshakeTimeout: TimeInterval?
        /// Behave like a build without `DEBUG` (default: the real build configuration).
        var releaseBuild: Bool?
        /// Whether the Flutter plugin is part of the app (default: looked up at runtime).
        var flutterPluginPresent: Bool?
        /// Delay of the one console line explaining a missing connection (default 10 s).
        var consoleHintDelay: TimeInterval?
        /// The `DurbunHost` Info.plist value (default: the main bundle's).
        var infoPlistHost: String??
        /// Where the run-time address is kept (default: `UserDefaults.standard`).
        var defaults: UserDefaults?
        /// The `DurbunEnabled` Info.plist value (default: the main bundle's).
        var infoPlistEnabled: String??
        /// Simulator or a debugger attached (default: checked at run time).
        var debuggerAttached: Bool?
        /// `get-task-allow` of the embedded provisioning profile (default: read from the bundle).
        var developmentSigned: Bool??
    }

    /// Launch argument (`-DurbunHost 192.168.1.20`) and Info.plist key with the desktop address.
    static let hostArgumentKey = "DurbunHost"
    /// Where the address given at run time is kept for the next launches.
    static let savedHostKey = "dev.durbun.desktopHost"
    /// The newest MetricKit diagnostic already handled (seconds since 1970).
    static let diagnosticsHandledKey = "dev.durbun.diagnosticsHandled"

    /// Present in every Flutter app that uses `package:durbun` (the plugin carries a copy of this core).
    static let flutterPluginClass = "durbun.DurbunFlutterPlugin"

    var overrides = Overrides()

    let commands: CommandCenter

    private let lock = UnfairLock()
    /// Serializes start/stop (recursive: start() stops a running instance first).
    private let lifecycle = NSRecursiveLock()
    /// Bumped on every start/stop; transport callbacks from an older generation are ignored.
    private var generation = 0
    /// Bumped by every `start`, `startHosted` and `stop` call: a start that waits for the signing check
    /// goes ahead only when nothing else was asked for meanwhile.
    private var startRequest = 0
    /// `DurbunOptions.captureBodies` / `maxBodyBytes`: the app's values win over the desktop's.
    private var bodyOverride: (captureBodies: Bool?, maxBodyBytes: Int?) = (nil, nil)
    private var running = false
    /// A start waits for the signing check (`startIfDevelopmentSigned`).
    private var signingCheckPending = false
    private var connected = false
    private var transport: Transport?
    private var config = SdkConfig.defaults
    private var mocks: [MockRule] = []
    private var policy = NetworkCapturePolicy()
    private var environment: AppEnvironment?
    private var stdio: StdioCapture?
    private var metrics: MetricsReporter?
    /// Stops the launch-time watcher (and keeps it alive until then).
    private var stopLaunchTimer: (() -> Void)?
    private var crashCapture = false
    private var requestCounter = 0
    private var foregroundObserver: NSObjectProtocol?
    /// Hosted mode (Flutter plugin): the Dart SDK owns the connection; messages go through the relay.
    private var relay: HostRelay?
    private var hostLink: HostLink?
    /// This app's own os_log / Logger / NSLog lines (`OSLogCapture`, iOS 15+), created on first use.
    private var osLog: OSLogCapture?
    /// `captureStdout`: console output of every kind (stdout/stderr and the unified log).
    private var captureConsole = false
    private var osLogAnnounced = false
    /// Hosted: what the host wants of the os_log lines (`state.deviceLogs`).
    private var hostDeviceLogs = HostDeviceLogs()
    /// Lines seen on stdout/stderr: their NSLog copy in the unified log is sent once.
    private let recentConsole = RecentConsoleLines()

    /* connection diagnostics (see ConnectionReport) */
    private var attempts: [ConnectAttempt] = []
    private var failedRounds = 0
    private var everConnected = false
    private var via: String?
    private var basePort: UInt16 = 9751
    /// The address built into the app: options, the environment or Info.plist.
    private var buildHost: (address: DesktopAddress, source: String)?
    /// The address given at run time (`setDesktopHost`, the launch argument), kept in UserDefaults.
    private var runtimeHost: DesktopAddress?
    private var runtimeHostSet = false
    /// The Wi-Fi endpoint the transport uses now.
    private var appliedLan: String?
    /// Earlier launches' diagnostics from MetricKit, sent once a desktop is connected.
    private var pendingDiagnostics: [SystemDiagnosticReport] = []
    private var seenDiagnostics: Set<String> = []
    private var systemDiagnostics = false

    init() {
        let builtins = BuiltinActions()
        commands = CommandCenter(builtins: builtins)
        builtins.log = { [weak self] message, tag, data in
            self?.sendLog(ts: Clock.nowMs(), level: .debug, tag: tag, message: message, data: data)
        }
        commands.onChange = { [weak self] in
            guard let self, self.isRunning else { return }
            if let link = self.lock.withLock({ self.hostLink }) {
                // The host owns hello.actions: it merges ours with its own list.
                link.actionsChanged(self.describeActionsJSON())
            } else {
                self.send(WireMessage.actions(self.commands.descriptors()))
            }
        }
    }

    // MARK: State accessors (thread-safe)

    var isRunning: Bool { lock.withLock { running } }
    /// `DurbunWebView` may attach: the SDK runs, or a start is waiting for the signing check.
    var webViewBridgeAllowed: Bool { lock.withLock { running || signingCheckPending } }
    var isConnected: Bool { lock.withLock { connected } }
    /// The desktop's config with the app's own body settings applied (what network capture uses).
    var sdkConfig: SdkConfig {
        lock.withLock {
            var effective = config
            if let capture = bodyOverride.captureBodies { effective.captureBodies = capture }
            if let limit = bodyOverride.maxBodyBytes { effective.maxBodyBytes = min(max(0, limit), Self.maxBodyBytesCap) }
            return effective
        }
    }

    /// Bodies above this are always truncated, whatever is asked (keeps every frame well below 16 MiB).
    static let maxBodyBytesCap = 8 * 1024 * 1024
    /// The payload cap of one `net.ws` / `net.sse` message while the connected desktop asks for them
    /// (`config.captureStreams`); nil: send none. The app's `captureBodies` / `maxBodyBytes` options can
    /// only lower the desktop's cap.
    var streamMessageCap: Int? {
        lock.withLock {
            guard running, connected, policy.active, config.captureStreams else { return nil }
            var cap = max(0, config.maxStreamMessageBytes)
            if bodyOverride.captureBodies == false { cap = 0 }
            if let limit = bodyOverride.maxBodyBytes { cap = min(cap, max(0, limit)) }
            return cap
        }
    }

    var mockRules: [MockRule] { lock.withLock { mocks } }
    var networkPolicy: NetworkCapturePolicy { lock.withLock { policy } }
    var appIdentifier: String? { lock.withLock { environment?.app.id } }
    /// True while running hosted by the Flutter plugin.
    var isHosted: Bool { lock.withLock { running && relay != nil } }
    /// Diagnostics/tests: how often this app's own os_log lines are read right now.
    var osLogMode: OSLogCapture.Mode { lock.withLock { osLog }?.currentMode ?? .off }

    /// Diagnostics/tests: active link origin, bound USB listener port, buffered message count.
    var transportSnapshot: (activeOrigin: Transport.Origin?, listenerPort: UInt16?, buffered: Int)? {
        lock.withLock { transport }?.snapshot
    }

    /// Ids of requests a web view page reported (`DurbunWebView`).
    func nextWebViewRequestId() -> String {
        lock.withLock {
            requestCounter += 1
            return "webview-\(requestCounter)"
        }
    }

    func nextRequestId() -> String {
        lock.withLock {
            requestCounter += 1
            // Hosted: the Dart side numbers its own dart:io requests in the same session.
            return relay != nil ? "ios-\(requestCounter)" : String(requestCounter)
        }
    }

    /// Headers with the redacted names' values replaced (`DurbunOptions.redactHeaders`, and in hosted
    /// mode Flutter's `redactHeaders`). Same marker as the Android and Dart layers.
    func redacting(_ headers: [(String, String)]) -> [(String, String)] {
        let names = lock.withLock { policy.redactedHeaders }
        guard !names.isEmpty else { return headers }
        return headers.map { names.contains($0.0.lowercased()) ? ($0.0, "••••") : $0 }
    }

    // MARK: Lifecycle

    static var buildAllowsRunning: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    func start(options: DurbunOptions) {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        lock.withLock {
            startRequest += 1
            signingCheckPending = false
        }
        startLocked(options: options, developmentSigned: false)
    }

    static let releaseOffMessage =
        "Dürbün is off in this build: the Durbun package was compiled without DEBUG, no debugger is attached and the "
        + "app is not signed for development. Where Dürbün should run, set DurbunEnabled = YES in Info.plist (for "
        + "example from a build setting per configuration) or DurbunOptions(allowInReleaseBuilds: true)."

    /// `developmentSigned`: the signing check already ran and found a development build.
    private func startLocked(options: DurbunOptions, developmentSigned: Bool) {
        guard options.enabled else { return }
        let overrides = self.overrides
        // Flutter apps: package:durbun starts this core from Dart (and keeps it off when Dart is off), so a
        // stray native call must not open a second session.
        if isHosted || (overrides.flutterPluginPresent ?? (NSClassFromString(Self.flutterPluginClass) != nil)) {
            Diagnostics.info("Durbun.start() is not needed in Flutter apps: package:durbun starts the native layer from Dart.")
            return
        }
        let plistValue: Any? = overrides.infoPlistEnabled.map { $0 as Any? }
            ?? Bundle.main.object(forInfoDictionaryKey: BuildSignals.enabledInfoKey)
        let plistSwitch = BuildSignals.infoPlistSwitch(plistValue)
        if plistSwitch == false {
            Diagnostics.notice("Dürbün is off in this build: DurbunEnabled is NO in Info.plist.")
            return
        }
        let debugBuild = overrides.releaseBuild.map { !$0 } ?? Self.buildAllowsRunning
        if !(debugBuild || options.allowInReleaseBuilds || plistSwitch == true || developmentSigned) {
            // Xcode may compile the package without DEBUG for a custom configuration of a debug build: ask
            // the running process instead. Simulator and debugger are cheap checks; the signing check reads
            // a file, so it runs off this thread and starts the SDK from there.
            if overrides.debuggerAttached ?? (BuildSignals.isSimulator || BuildSignals.debuggerAttached) {
                Diagnostics.notice("Dürbün runs in this build without DEBUG because it runs in the Simulator or under a debugger.")
            } else {
                startIfDevelopmentSigned(options: options)
                return
            }
        }
        let env = ProcessInfo.processInfo.environment
        // Explicit opt-out, and SwiftUI previews (no desktop there; stdout belongs to the preview agent).
        if env["DURBUN_DISABLED"] == "1" || env["XCODE_RUNNING_FOR_PREVIEWS"] == "1" { return }
        if isRunning { stop() }

        let generation: Int = lock.withLock {
            self.generation += 1
            return self.generation
        }
        let environment = AppEnvironment.current().named(options.appName)
        let infoHost = overrides.infoPlistHost ?? (Bundle.main.object(forInfoDictionaryKey: Self.hostArgumentKey) as? String)
        let build = Self.buildHost(options: options.host, environment: env["DURBUN_HOST"], infoPlist: infoHost)
        let isDevice = AppEnvironment.isPhysicalIOSDevice
        var configuration = Transport.Configuration()
        configuration.loopbackPort = (overrides.loopbackClient ?? !isDevice) ? options.port : nil
        configuration.host = build?.address.host
        configuration.hostPort = build?.address.port ?? options.port
        configuration.listenerPorts = (overrides.deviceListener ?? isDevice) ? options.devicePorts : nil
        configuration.maxBufferedMessages = max(1, options.maxBufferedMessages)
        if let delay = overrides.reconnectMinDelay { configuration.reconnectMinDelay = delay }
        if let delay = overrides.reconnectMaxDelay { configuration.reconnectMaxDelay = delay }
        if let timeout = overrides.handshakeTimeout { configuration.handshakeTimeout = timeout }

        let transport = Transport(configuration: configuration, callbacks: Transport.Callbacks(
            hello: { [weak self] in self?.helloMessage() ?? .null },
            welcome: { [weak self] welcome, origin in self?.didConnect(welcome, origin: origin, generation: generation) },
            message: { [weak self] message in self?.handle(message, generation: generation) },
            disconnected: { [weak self] in self?.didDisconnect(generation: generation) },
            attemptsFailed: { [weak self] attempts in self?.didFailAttempts(attempts, generation: generation) }
        ))

        lock.withLock {
            running = true
            connected = false
            config = .defaults
            mocks = []
            captureConsole = options.captureOSLog ?? options.captureStdout
            bodyOverride = (options.captureBodies, options.maxBodyBytes)
            osLogAnnounced = false
            hostDeviceLogs = HostDeviceLogs()
            self.environment = environment
            self.transport = transport
            policy = NetworkCapturePolicy(
                active: options.captureNetwork,
                interceptUploadTasks: options.interceptUploadTasks,
                ignoredHosts: options.ignoredHosts.map { $0.lowercased() },
                redactedHeaders: Set(options.redactHeaders.map { $0.lowercased() })
            )
            resetConnectionReport(port: options.port, build: build)
            appliedLan = configuration.host.map { "\($0):\(configuration.hostPort)" }
        }

        // Start first: messages queued below are buffered until the handshake completes.
        transport.start()
        observeForeground(transport)
        DispatchQueue.global(qos: .utility).async { [weak self] in self?.loadRuntimeHost(generation: generation) }
        let hintDelay = overrides.consoleHintDelay ?? 10
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + hintDelay) { [weak self] in
            self?.consoleHintIfNeeded(generation: generation)
        }
        if options.captureNetwork { NetworkCapture.install() }
        if options.captureCrashes {
            CrashCapture.install()
            lock.withLock { crashCapture = true }
            DispatchQueue.global(qos: .utility).async {
                for report in CrashCapture.prepareAndTakePendingReports() { transport.send(report) }
            }
            startSystemDiagnostics(generation: generation)
        }
        if options.captureStdout {
            let capture = StdioCapture { [weak self] entries in self?.sendStdio(entries) }
            if capture.start() { lock.withLock { stdio = capture } }
        }
        if options.collectMetrics {
            let reporter = MetricsReporter { [weak self] message in self?.send(message) }
            lock.withLock { metrics = reporter }
            #if canImport(UIKit) && !os(watchOS)
            let launch = LaunchTimer { [weak self] props in self?.event(LaunchTiming.event, props: props) }
            lock.withLock { stopLaunchTimer = { launch.stop() } }
            #endif
        }
    }

    /// A build without `DEBUG`, outside the Simulator and without a debugger: runs when the app is signed
    /// for development (`get-task-allow`, read from the embedded profile off the calling thread). The SDK
    /// then starts a moment later, from that background queue, unless `start`/`stop` was called meanwhile.
    private func startIfDevelopmentSigned(options: DurbunOptions) {
        let request = lock.withLock { () -> Int in
            signingCheckPending = true
            return startRequest
        }
        let known = overrides.developmentSigned
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let signed = known ?? BuildSignals.provisioningAllowsDebugging()
            guard let self else { return }
            self.lifecycle.lock()
            defer { self.lifecycle.unlock() }
            let current = self.lock.withLock { () -> Bool in
                guard self.startRequest == request else { return false }
                self.signingCheckPending = false
                return true
            }
            guard current else { return }
            if signed == true {
                Diagnostics.notice("Dürbün runs in this build without DEBUG because the app is signed for development (get-task-allow).")
                self.startLocked(options: options, developmentSigned: true)
            } else {
                Diagnostics.notice(Self.releaseOffMessage)
            }
        }
    }

    /// Hosted mode, started by the Flutter plugin: no socket, no metrics (Flutter reports frames itself).
    /// URLSession capture, crash capture and stdout/stderr capture run as usual; every message goes to
    /// `link`, and the desktop state comes from `applyHostState`. Returns false when it cannot run.
    @discardableResult
    func startHosted(options: DurbunOptions, link: HostLink, redactedHeaders: Set<String> = []) -> Bool {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        lock.withLock { startRequest += 1 }
        guard options.enabled else { return false }
        if isRunning { stop() }
        let generation: Int = lock.withLock {
            self.generation += 1
            return self.generation
        }
        let environment = AppEnvironment.current().named(options.appName)
        let relay = HostRelay(link: link, maxMessages: max(1, options.maxBufferedMessages))
        lock.withLock {
            running = true
            connected = false
            config = .defaults
            mocks = []
            requestCounter = 0
            captureConsole = options.captureOSLog ?? options.captureStdout
            bodyOverride = (options.captureBodies, options.maxBodyBytes)
            osLogAnnounced = false
            hostDeviceLogs = HostDeviceLogs()
            self.environment = environment
            self.transport = nil
            self.relay = relay
            self.hostLink = link
            resetConnectionReport(port: options.port, build: nil)
            policy = NetworkCapturePolicy(
                active: options.captureNetwork,
                interceptUploadTasks: options.interceptUploadTasks,
                ignoredHosts: options.ignoredHosts.map { $0.lowercased() },
                redactedHeaders: Set((Array(redactedHeaders) + options.redactHeaders).map { $0.lowercased() })
            )
        }
        if options.captureNetwork { NetworkCapture.install() }
        if options.captureCrashes {
            CrashCapture.install()
            lock.withLock { crashCapture = true }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                for report in CrashCapture.prepareAndTakePendingReports() { self?.send(report) }
            }
            startSystemDiagnostics(generation: generation)
        }
        if options.captureStdout {
            let capture = StdioCapture { [weak self] entries in self?.sendStdio(entries) }
            if capture.start() { lock.withLock { stdio = capture } }
        }
        return true
    }

    /// Desktop state from the host: `{connected, config, mocks, deviceLogs, …}` (JSON). Missing fields
    /// keep their previous value, except the mock rules: they hold only while the host is connected.
    /// `deviceLogs: {read, fast, desktop}` says whether the host wants this app's os_log lines (its
    /// in-app panel, or a desktop that cannot read device logs), with or without a desktop.
    func applyHostState(_ json: String) {
        guard let data = json.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        let (hosted, connectionChanged, lostRelay): (Bool, Bool, HostRelay?) = lock.withLock {
            guard running, relay != nil else { return (false, false, nil) }
            if let newConfig = object["config"] as? [String: Any] {
                config = SdkConfig(json: newConfig, fallback: config)
                if config.captureStreams { WebSocketWatch.shared.checkSoon() }
            }
            if object["mocks"] != nil { mocks = MockRule.parseList(object["mocks"]) }
            let wasConnected = connected
            if let isConnected = object["connected"] as? Bool { connected = isConnected }
            // See didDisconnect: rules from a peer that went away must not keep rewriting responses.
            if !connected { mocks = [] }
            if let wanted = object["deviceLogs"] as? [String: Any] {
                hostDeviceLogs = HostDeviceLogs(json: wanted, fallback: hostDeviceLogs)
            }
            return (true, wasConnected != connected, wasConnected && !connected ? relay : nil)
        }
        lostRelay?.dropStreamLines()
        if hosted { applyDeviceLogs() }
        if connectionChanged {
            sendSystemDiagnostics()
            notifyStatus()
        }
    }

    /// A desktop `command` forwarded by the host (JSON); the result goes back as `command.result`.
    func handleHostCommand(_ json: String) {
        guard let data = json.data(using: .utf8), case let .command(id, name, params)? = ServerMessage.parse(data)
        else { return }
        let generation = lock.withLock { self.generation }
        handle(.command(id: id, name: name, params: params), generation: generation)
    }

    /// Native action descriptors as a JSON array (merged by the host into its hello).
    func describeActionsJSON() -> String {
        let line = JSONWriter.line(.array(commands.descriptors().map(\.json)))
        return String(decoding: line.dropLast(), as: UTF8.self)
    }

    /// Capabilities the native layer adds to the host's session.
    func hostedCapabilities(options: DurbunOptions) -> [String] {
        var capabilities = ["logs", "events", "commands"]
        if options.captureNetwork { capabilities += ["network", "mocks", "streams"] }
        if options.captureCrashes { capabilities.append("crash") }
        return capabilities
    }

    /// `hello.app` fields as the bundle reports them.
    var hostedAppInfo: [String: String] {
        let app = (lock.withLock { environment } ?? AppEnvironment.current()).app
        var info: [String: String] = ["name": app.name, "id": app.id]
        if let version = app.version { info["version"] = version }
        if let build = app.build { info["build"] = build }
        return info
    }

    func stop() {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        var stopLaunch: (() -> Void)?
        let (transport, stdio, metrics, crash, observer, relay, osLog) = lock.withLock {
            () -> (Transport?, StdioCapture?, MetricsReporter?, Bool, NSObjectProtocol?, HostRelay?, OSLogCapture?) in
            let result = (self.transport, self.stdio, self.metrics, crashCapture, foregroundObserver, self.relay, self.osLog)
            generation += 1
            startRequest += 1
            running = false
            signingCheckPending = false
            connected = false
            self.relay = nil
            self.hostLink = nil
            self.transport = nil
            self.stdio = nil
            self.metrics = nil
            self.osLog = nil
            stopLaunch = stopLaunchTimer
            stopLaunchTimer = nil
            crashCapture = false
            foregroundObserver = nil
            policy.active = false
            mocks = []
            return result
        }
        if let observer { NotificationCenter.default.removeObserver(observer) }
        stopSystemDiagnostics()
        notifyStatus()
        metrics?.stop()
        stopLaunch?()
        stdio?.stop()
        osLog?.stop()
        if crash { CrashCapture.uninstall() }
        NetworkCapture.uninstall()
        WebSocketCapture.forgetAll()
        transport?.stop()
        relay?.stop()
    }

    /// Re-attempts the connection when the app comes back to the foreground (iOS suspends sockets).
    private func observeForeground(_ transport: Transport) {
        let observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("UIApplicationWillEnterForegroundNotification"),
            object: nil,
            queue: nil
        ) { [weak transport] _ in
            transport?.nudge()
        }
        lock.withLock { foregroundObserver = observer }
    }

    // MARK: Connection status and the desktop address

    /// Under `lock`.
    private func resetConnectionReport(port: UInt16, build: (address: DesktopAddress, source: String)?) {
        attempts = []
        failedRounds = 0
        everConnected = false
        via = nil
        basePort = port
        buildHost = build
        runtimeHost = nil
        runtimeHostSet = false
        appliedLan = nil
        pendingDiagnostics = []
        seenDiagnostics = []
    }

    /// The address built into the app, best first: options, `DURBUN_HOST` (Xcode scheme), Info.plist.
    static func buildHost(options: String?, environment: String?, infoPlist: String?) -> (address: DesktopAddress, source: String)? {
        for (value, source) in [(options, "options"), (environment, "environment"), (infoPlist, "infoPlist")] {
            guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
                  !raw.hasPrefix("$(") // an Info.plist build setting that was not defined
            else { continue }
            return (DesktopAddress.parse(raw) ?? DesktopAddress(host: raw, port: nil), source)
        }
        return nil
    }

    private var defaults: UserDefaults { overrides.defaults ?? .standard }

    /// The address given at run time: the launch argument (`-DurbunHost 192.168.1.20`, kept for the
    /// next launches) or one saved by `setDesktopHost`. UserDefaults may touch the disk: utility queue.
    private func loadRuntimeHost(generation: Int) {
        let defaults = self.defaults
        var value = defaults.string(forKey: Self.savedHostKey)
        if let argument = defaults.volatileDomain(forName: UserDefaults.argumentDomain)[Self.hostArgumentKey] as? String {
            let trimmed = argument.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                defaults.removeObject(forKey: Self.savedHostKey)
                value = nil
            } else if let address = DesktopAddress.parse(trimmed) {
                defaults.set(address.description, forKey: Self.savedHostKey)
                value = address.description
            } else {
                Diagnostics.notice("Dürbün ignores the -\(Self.hostArgumentKey) launch argument \"\(argument)\": use the Mac's IP address, e.g. 192.168.1.20.")
            }
        }
        guard let address = DesktopAddress.parse(value) else { return }
        let apply: Bool = lock.withLock {
            guard self.generation == generation, running, relay == nil, !runtimeHostSet else { return false }
            runtimeHost = address
            return true
        }
        if apply { applyLan() }
    }

    /// See `Durbun.setDesktopHost`.
    func setDesktopHost(_ input: String?) -> Bool {
        let trimmed = input?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var address: DesktopAddress?
        if !trimmed.isEmpty {
            guard let parsed = DesktopAddress.parse(trimmed) else {
                Diagnostics.notice("Dürbün: \"\(trimmed)\" is not a desktop address (use the Mac's IP address, e.g. 192.168.1.20).")
                return false
            }
            address = parsed
        }
        if isHosted {
            Diagnostics.notice("In Flutter apps, set the Mac's address in the in-app panel (Tools → Mac connection).")
            return false
        }
        if let address {
            defaults.set(address.description, forKey: Self.savedHostKey)
        } else {
            defaults.removeObject(forKey: Self.savedHostKey)
        }
        let apply: Bool = lock.withLock {
            guard running, relay == nil else { return false }
            runtimeHost = address
            runtimeHostSet = true
            return true
        }
        if apply { applyLan() }
        return true
    }

    /// Hands the current Wi-Fi address to the transport when it changed.
    private func applyLan() {
        let change: (Transport, DesktopAddress?, UInt16)? = lock.withLock {
            guard running, let transport else { return nil }
            let lan = lanLocked()
            guard lan?.endpoint != appliedLan else { return nil }
            appliedLan = lan?.endpoint
            attempts = []
            failedRounds = 0
            return (transport, lan.map { DesktopAddress(host: $0.host, port: $0.port) }, basePort)
        }
        guard let change else { return }
        let (transport, address, port) = change
        Diagnostics.info(address.map { "Dürbün desktop address: \($0)" } ?? "Dürbün desktop address cleared")
        transport.setHost(address?.host, port: address?.port ?? port)
        notifyStatus()
    }

    /// Under `lock`: the Wi-Fi endpoint in use and where it comes from.
    private func lanLocked() -> (endpoint: String, host: String, port: UInt16, source: String)? {
        let chosen = runtimeHost.map { ($0, "runtime") } ?? buildHost.map { ($0.address, $0.source) }
        guard let chosen else { return nil }
        let (address, source) = chosen
        let port = address.port ?? basePort
        return ("\(address.host):\(port)", address.host, port, source)
    }

    /// Transport queue.
    private func didFailAttempts(_ latest: [ConnectAttempt], generation: Int) {
        let changed: Bool = lock.withLock {
            guard self.generation == generation, running, !connected else { return false }
            attempts = latest
            failedRounds += 1
            return true
        }
        if changed { notifyStatus() }
    }

    private func consoleHintIfNeeded(generation: Int) {
        let text: String? = lock.withLock {
            guard self.generation == generation, running, relay == nil, !connected, !everConnected else { return nil }
            let lan = lanLocked()
            return ConnectionDiagnosis.consoleHint(
                issueLocked(lan: lan?.endpoint), attempts: attempts, port: basePort, lanEndpoint: lan?.endpoint
            )
        }
        if let text { Diagnostics.notice(text) }
    }

    /// Under `lock`.
    private func issueLocked(lan: String?) -> ConnectIssue? {
        guard !connected else { return nil }
        let device = environment?.device
        let platform = device?.platform ?? "other"
        let physical = device?.isPhysical ?? true
        if attempts.isEmpty {
            // A physical iPhone without a Wi-Fi address only waits for the Mac over USB.
            return platform == "ios" && physical && lan == nil ? .iosUsbWaiting : nil
        }
        return ConnectionDiagnosis.diagnose(attempts: attempts, platform: platform, isPhysical: physical, lanEndpoint: lan)
    }

    var connectionStatus: DurbunConnectionStatus {
        lock.withLock {
            guard running else { return .notStarted }
            if relay != nil {
                return DurbunConnectionStatus(
                    isConnected: connected, via: nil, desktopHost: nil, desktopHostSource: nil, issue: nil,
                    hint: connected ? nil : "The Flutter SDK owns the connection: its in-app panel explains it under Tools → Mac connection.",
                    failedAttempts: 0
                )
            }
            let lan = lanLocked()
            let issue = issueLocked(lan: lan?.endpoint)
            return DurbunConnectionStatus(
                isConnected: connected,
                via: connected ? via : nil,
                desktopHost: lan?.endpoint,
                desktopHostSource: lan?.source,
                issue: issue?.rawValue,
                hint: issue.map { ConnectionDiagnosis.nextStep($0, port: basePort, lanEndpoint: lan?.endpoint) },
                failedAttempts: connected ? 0 : failedRounds
            )
        }
    }

    private func notifyStatus() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Durbun.connectionStatusDidChangeNotification, object: nil)
        }
    }

    // MARK: Earlier launches (MetricKit)

    private func startSystemDiagnostics(generation: Int) {
        let defaults = self.defaults
        let started = SystemDiagnostics.start { [weak self] reports in
            guard let self else { return }
            let handled = defaults.double(forKey: Self.diagnosticsHandledKey)
            let fresh = reports.filter { $0.timestamp > handled }
            guard !fresh.isEmpty else { return }
            let current: Bool = self.lock.withLock {
                guard self.generation == generation, self.running else { return false }
                for report in fresh where self.seenDiagnostics.insert(report.key).inserted {
                    self.pendingDiagnostics.append(report)
                }
                return true
            }
            if current { self.sendSystemDiagnostics() }
        }
        lock.withLock { systemDiagnostics = started }
    }

    private func stopSystemDiagnostics() {
        let started: Bool = lock.withLock {
            let was = systemDiagnostics
            systemDiagnostics = false
            pendingDiagnostics = []
            return was
        }
        if started { SystemDiagnostics.stop() }
    }

    /// Sends earlier launches' diagnostics once a desktop is connected. Crash reports are left out when
    /// the desktop reads the device's own crash logs (USB): it shows them already.
    private func sendSystemDiagnostics() {
        let (reports, desktopReads): ([SystemDiagnosticReport], Bool) = lock.withLock {
            guard running, connected, !pendingDiagnostics.isEmpty else { return ([], false) }
            let reports = pendingDiagnostics
            pendingDiagnostics = []
            return (reports, config.deviceLogsAvailable)
        }
        guard !reports.isEmpty else { return }
        for report in reports where !(report.desktopReadsIt && desktopReads) {
            send(report.message)
        }
        let newest = reports.map(\.timestamp).max() ?? 0
        let defaults = self.defaults
        if newest > defaults.double(forKey: Self.diagnosticsHandledKey) {
            defaults.set(newest, forKey: Self.diagnosticsHandledKey)
        }
    }

    // MARK: Sending

    func send(_ message: JSONValue) {
        let (transport, relay) = lock.withLock { running ? (self.transport, self.relay) : (nil, nil) }
        if let relay {
            relay.enqueue(JSONWriter.line(message))
        } else {
            transport?.send(message)
        }
    }

    /// A `net.ws` / `net.sse` message: goes out only on the connection that is up now, never kept for a
    /// later one, and is dropped before other messages when the buffers are full.
    func sendStream(_ message: JSONValue) {
        let (transport, relay) = lock.withLock { running && connected ? (self.transport, self.relay) : (nil, nil) }
        if let relay {
            relay.enqueue(JSONWriter.line(message), stream: true)
        } else {
            transport?.send(message, stream: true)
        }
    }

    func flush(timeout: TimeInterval) -> Bool {
        let (transport, relay) = lock.withLock { running ? (self.transport, self.relay) : (nil, nil) }
        if let relay { return relay.flush(timeout: timeout) }
        return transport?.flush(timeout: timeout) ?? false
    }

    func log(_ message: String, level: DurbunLogLevel, tag: String?, data: Any?, error: Error?) {
        var errorInfo: WireErrorInfo?
        if let error {
            errorInfo = WireErrorInfo(
                type: JSONConversion.typeName(of: error),
                message: JSONConversion.describe(error),
                stack: Self.callerStack()
            )
        }
        sendLog(
            ts: Clock.nowMs(),
            level: level,
            tag: tag,
            message: message,
            data: data.map { JSONConversion.value(from: $0) },
            error: errorInfo,
            tid: ThreadInfo.currentThreadId()
        )
    }

    /// Call stack of the code that called the public API (the SDK's own frames removed). The SDK is
    /// usually linked statically, so frames are recognized by the mangled module name.
    static func callerStack() -> String? {
        let frames = Thread.callStackSymbols
        let callerFrames = frames.drop { $0.contains("6Durbun") || $0.contains(" Durbun ") }
        let stack = (callerFrames.isEmpty ? frames[...] : callerFrames).prefix(64).joined(separator: "\n")
        return stack.isEmpty ? nil : stack
    }

    func event(_ name: String, props: [String: Any]?) {
        send(WireMessage.event(ts: Clock.nowMs(), name: name, props: props.map { JSONConversion.object(from: $0) }))
    }

    private func sendLog(
        ts: Double,
        level: DurbunLogLevel,
        tag: String?,
        message: String,
        data: JSONValue? = nil,
        error: WireErrorInfo? = nil,
        kind: String? = nil,
        tid: Int? = nil
    ) {
        send(WireMessage.log(ts: ts, level: level, tag: tag, message: message, data: data, error: error, kind: kind, tid: tid))
    }

    private func sendStdio(_ entries: [StdioCapture.Entry]) {
        let hosted = lock.withLock { relay != nil }
        for entry in entries {
            // Hosted by Flutter: the engine echoes Dart's print() as "flutter: …"; Dart sends those itself.
            if hosted && entry.text.hasPrefix("flutter: ") { continue }
            recentConsole.remember(entry.text, ts: entry.ts)
            let firstLine = entry.text.prefix(while: { $0 != "\n" })
            let classification = OutputFormatting.classify(String(firstLine))
            sendLog(
                ts: entry.ts,
                level: classification.level,
                tag: entry.stream.rawValue,
                message: entry.text,
                kind: classification.kind
            )
        }
    }

    // MARK: The app's own unified log (os_log / Logger / NSLog)

    /// Standalone: forwards this app's os_log lines while the desktop cannot read the device's logs
    /// (Wi-Fi). Hosted: reads them while the host asks (its in-app panel shows them; the host decides
    /// what reaches the desktop). `OSLogStore` needs iOS 15; older systems get a one-time note instead.
    private func applyDeviceLogs() {
        let (mode, announce, capture): (OSLogCapture.Mode, Bool, OSLogCapture?) = lock.withLock {
            guard running, captureConsole else { return (.off, false, osLog) }
            let toDesktop: Bool
            let mode: OSLogCapture.Mode
            if relay != nil {
                toDesktop = hostDeviceLogs.read && hostDeviceLogs.desktop
                mode = hostDeviceLogs.read ? (hostDeviceLogs.fast ? .fast : .slow) : .off
            } else {
                toDesktop = connected && !config.deviceLogsAvailable
                mode = toDesktop ? .fast : .off
            }
            let announce = toDesktop && !osLogAnnounced
            if announce { osLogAnnounced = true }
            if mode != .off, osLog == nil, OSLogCapture.isAvailable {
                osLog = OSLogCapture { [weak self] entries in self?.sendDeviceLogs(entries) }
            }
            return (mode, announce, osLog)
        }
        if announce {
            let message = OSLogCapture.isAvailable
                ? "The desktop cannot read this device's logs, so Dürbün forwards this app's own os_log / Logger / NSLog lines over the SDK connection."
                : "The desktop cannot read this device's logs, and reading this app's own os_log / Logger lines needs iOS 15: print, stdout/stderr and Durbun.log still come through."
            sendLog(ts: Clock.nowMs(), level: .info, tag: "durbun", message: message, kind: "text")
        }
        capture?.setMode(mode)
    }

    private func sendDeviceLogs(_ entries: [OSLogCapture.Entry]) {
        let link: HostLink? = lock.withLock { running ? hostLink : nil }
        var lines: [String] = []
        for entry in entries where !recentConsole.contains(entry.message, near: entry.ts) {
            let message = WireMessage.log(
                ts: entry.ts, level: entry.level, tag: entry.tag, message: entry.message,
                data: nil, error: nil, kind: "text", tid: entry.tid
            )
            guard link != nil else {
                send(message)
                continue
            }
            let line = JSONWriter.line(message)
            lines.append(String(decoding: line.last == 0x0A ? line.dropLast() : line[...], as: UTF8.self))
        }
        guard let link else { return }
        var start = 0
        while start < lines.count {
            let end = min(start + 256, lines.count)
            link.deliverDeviceLogs(Array(lines[start..<end]))
            start = end
        }
    }

    // MARK: Transport callbacks (transport queue)

    func helloMessage() -> JSONValue {
        let environment = lock.withLock { self.environment } ?? AppEnvironment.current()
        return WireMessage.hello(
            app: environment.app,
            device: environment.device,
            session: Self.sessionId,
            actions: commands.descriptors(),
            sdkVersion: Durbun.version,
            ts: Clock.nowMs()
        )
    }

    private func didConnect(_ welcome: ServerWelcome, origin: Transport.Origin, generation: Int) {
        let (current, metrics): (Bool, MetricsReporter?) = lock.withLock {
            guard self.generation == generation else { return (false, nil) }
            connected = true
            config = welcome.config
            mocks = welcome.mocks
            everConnected = true
            attempts = []
            failedRounds = 0
            switch origin {
            case .usb: via = "usb"
            case .loopback: via = "127.0.0.1:\(basePort)"
            case .host: via = appliedLan
            }
            return (true, self.metrics)
        }
        guard current else { return }
        metrics?.start(intervalMs: welcome.config.metricsIntervalMs)
        if welcome.config.captureStreams { WebSocketWatch.shared.checkSoon() }
        applyDeviceLogs()
        sendSystemDiagnostics()
        notifyStatus()
    }

    private func didDisconnect(generation: Int) {
        let (current, metrics): (Bool, MetricsReporter?) = lock.withLock {
            guard self.generation == generation else { return (false, nil) }
            connected = false
            via = nil
            // Mock rules hold only while the peer that pushed them is connected: whoever answered the
            // hello is not authenticated yet. The desktop sends them again in its next welcome.
            mocks = []
            return (true, self.metrics)
        }
        guard current else { return }
        metrics?.stop()
        // Paused, not lost: the next read starts where this one ended.
        applyDeviceLogs()
        notifyStatus()
    }

    private func handle(_ message: ServerMessage, generation: Int) {
        guard lock.withLock({ self.generation == generation }) else { return }
        switch message {
        case let .mocks(rules):
            lock.withLock { mocks = rules }
        case let .config(newConfig):
            let (metrics, isConnected): (MetricsReporter?, Bool) = lock.withLock {
                config = newConfig
                return (self.metrics, connected)
            }
            if isConnected { metrics?.start(intervalMs: newConfig.metricsIntervalMs) }
            // Open WebSockets are reported from now on (their handshake first), without waiting for traffic.
            if newConfig.captureStreams { WebSocketWatch.shared.checkSoon() }
            applyDeviceLogs()
        case let .command(id, name, params):
            commands.handle(name: name, params: params) { [weak self] result in
                self?.send(WireMessage.commandResult(id: id, ok: result.ok, data: result.data, error: result.error))
            }
        case .welcome, .ping:
            break
        }
    }
}
