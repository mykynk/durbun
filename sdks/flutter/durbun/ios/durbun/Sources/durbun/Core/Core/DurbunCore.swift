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
    }

    /// Present in every Flutter app that uses `package:durbun` (the plugin carries a copy of this core).
    static let flutterPluginClass = "durbun.DurbunFlutterPlugin"

    var overrides = Overrides()

    let commands: CommandCenter

    private let lock = UnfairLock()
    /// Serializes start/stop (recursive: start() stops a running instance first).
    private let lifecycle = NSRecursiveLock()
    /// Bumped on every start/stop; transport callbacks from an older generation are ignored.
    private var generation = 0
    private var running = false
    private var connected = false
    private var transport: Transport?
    private var config = SdkConfig.defaults
    private var mocks: [MockRule] = []
    private var policy = NetworkCapturePolicy()
    private var environment: AppEnvironment?
    private var stdio: StdioCapture?
    private var metrics: MetricsReporter?
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
    var isConnected: Bool { lock.withLock { connected } }
    var sdkConfig: SdkConfig { lock.withLock { config } }
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
        guard options.enabled else { return }
        let overrides = self.overrides
        // Flutter apps: package:durbun starts this core from Dart (and keeps it off when Dart is off), so a
        // stray native call must not open a second session.
        if isHosted || (overrides.flutterPluginPresent ?? (NSClassFromString(Self.flutterPluginClass) != nil)) {
            Diagnostics.info("Durbun.start() is not needed in Flutter apps: package:durbun starts the native layer from Dart.")
            return
        }
        let debugBuild = overrides.releaseBuild.map { !$0 } ?? Self.buildAllowsRunning
        guard debugBuild || options.allowInReleaseBuilds else {
            Diagnostics.info("Dürbün is disabled in non-DEBUG builds (set allowInReleaseBuilds to force it).")
            return
        }
        let env = ProcessInfo.processInfo.environment
        // Explicit opt-out, and SwiftUI previews (no desktop there; stdout belongs to the preview agent).
        if env["DURBUN_DISABLED"] == "1" || env["XCODE_RUNNING_FOR_PREVIEWS"] == "1" { return }
        if isRunning { stop() }

        let generation: Int = lock.withLock {
            self.generation += 1
            return self.generation
        }
        let environment = AppEnvironment.current()
        let host = (options.host ?? env["DURBUN_HOST"])?.trimmingCharacters(in: .whitespacesAndNewlines)
        let isDevice = AppEnvironment.isPhysicalIOSDevice
        var configuration = Transport.Configuration()
        configuration.loopbackPort = (overrides.loopbackClient ?? !isDevice) ? options.port : nil
        configuration.host = (host?.isEmpty == false) ? host : nil
        configuration.hostPort = options.port
        configuration.listenerPorts = (overrides.deviceListener ?? isDevice) ? options.devicePorts : nil
        configuration.maxBufferedMessages = max(1, options.maxBufferedMessages)
        if let delay = overrides.reconnectMinDelay { configuration.reconnectMinDelay = delay }
        if let delay = overrides.reconnectMaxDelay { configuration.reconnectMaxDelay = delay }
        if let timeout = overrides.handshakeTimeout { configuration.handshakeTimeout = timeout }

        let transport = Transport(configuration: configuration, callbacks: Transport.Callbacks(
            hello: { [weak self] in self?.helloMessage() ?? .null },
            welcome: { [weak self] welcome, _ in self?.didConnect(welcome, generation: generation) },
            message: { [weak self] message in self?.handle(message, generation: generation) },
            disconnected: { [weak self] in self?.didDisconnect(generation: generation) }
        ))

        lock.withLock {
            running = true
            connected = false
            config = .defaults
            mocks = []
            captureConsole = options.captureStdout
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
        }

        // Start first: messages queued below are buffered until the handshake completes.
        transport.start()
        observeForeground(transport)
        if options.captureNetwork { NetworkCapture.install() }
        if options.captureCrashes {
            CrashCapture.install()
            lock.withLock { crashCapture = true }
            DispatchQueue.global(qos: .utility).async {
                for report in CrashCapture.prepareAndTakePendingReports() { transport.send(report) }
            }
        }
        if options.captureStdout {
            let capture = StdioCapture { [weak self] entries in self?.sendStdio(entries) }
            if capture.start() { lock.withLock { stdio = capture } }
        }
        if options.collectMetrics {
            let reporter = MetricsReporter { [weak self] message in self?.send(message) }
            lock.withLock { metrics = reporter }
        }
    }

    /// Hosted mode, started by the Flutter plugin: no socket, no metrics (Flutter reports frames itself).
    /// URLSession capture, crash capture and stdout/stderr capture run as usual; every message goes to
    /// `link`, and the desktop state comes from `applyHostState`. Returns false when it cannot run.
    @discardableResult
    func startHosted(options: DurbunOptions, link: HostLink, redactedHeaders: Set<String> = []) -> Bool {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        guard options.enabled else { return false }
        if isRunning { stop() }
        lock.withLock { generation += 1 }
        let environment = AppEnvironment.current()
        let relay = HostRelay(link: link, maxMessages: max(1, options.maxBufferedMessages))
        lock.withLock {
            running = true
            connected = false
            config = .defaults
            mocks = []
            requestCounter = 0
            captureConsole = options.captureStdout
            osLogAnnounced = false
            hostDeviceLogs = HostDeviceLogs()
            self.environment = environment
            self.transport = nil
            self.relay = relay
            self.hostLink = link
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
        let hosted: Bool = lock.withLock {
            guard running, relay != nil else { return false }
            if let newConfig = object["config"] as? [String: Any] {
                config = SdkConfig(json: newConfig, fallback: config)
            }
            if object["mocks"] != nil { mocks = MockRule.parseList(object["mocks"]) }
            if let isConnected = object["connected"] as? Bool { connected = isConnected }
            // See didDisconnect: rules from a peer that went away must not keep rewriting responses.
            if !connected { mocks = [] }
            if let wanted = object["deviceLogs"] as? [String: Any] {
                hostDeviceLogs = HostDeviceLogs(json: wanted, fallback: hostDeviceLogs)
            }
            return true
        }
        if hosted { applyDeviceLogs() }
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
        if options.captureNetwork { capabilities += ["network", "mocks"] }
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
        let (transport, stdio, metrics, crash, observer, relay, osLog) = lock.withLock {
            () -> (Transport?, StdioCapture?, MetricsReporter?, Bool, NSObjectProtocol?, HostRelay?, OSLogCapture?) in
            let result = (self.transport, self.stdio, self.metrics, crashCapture, foregroundObserver, self.relay, self.osLog)
            generation += 1
            running = false
            connected = false
            self.relay = nil
            self.hostLink = nil
            self.transport = nil
            self.stdio = nil
            self.metrics = nil
            self.osLog = nil
            crashCapture = false
            foregroundObserver = nil
            policy.active = false
            mocks = []
            return result
        }
        if let observer { NotificationCenter.default.removeObserver(observer) }
        metrics?.stop()
        stdio?.stop()
        osLog?.stop()
        if crash { CrashCapture.uninstall() }
        NetworkCapture.uninstall()
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

    // MARK: Sending

    func send(_ message: JSONValue) {
        let (transport, relay) = lock.withLock { running ? (self.transport, self.relay) : (nil, nil) }
        if let relay {
            relay.enqueue(JSONWriter.line(message))
        } else {
            transport?.send(message)
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

    private func didConnect(_ welcome: ServerWelcome, generation: Int) {
        let metrics: MetricsReporter? = lock.withLock {
            guard self.generation == generation else { return nil }
            connected = true
            config = welcome.config
            mocks = welcome.mocks
            return self.metrics
        }
        metrics?.start(intervalMs: welcome.config.metricsIntervalMs)
        applyDeviceLogs()
    }

    private func didDisconnect(generation: Int) {
        let metrics: MetricsReporter? = lock.withLock {
            guard self.generation == generation else { return nil }
            connected = false
            // Mock rules hold only while the peer that pushed them is connected: whoever answered the
            // hello is not authenticated yet. The desktop sends them again in its next welcome.
            mocks = []
            return self.metrics
        }
        metrics?.stop()
        // Paused, not lost: the next read starts where this one ended.
        applyDeviceLogs()
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
