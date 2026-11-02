import Foundation

/// What `DurbunURLProtocol` needs on its hot path, read under one lock.
struct NetworkCapturePolicy {
    var active = false
    var interceptUploadTasks = true
    var ignoredHosts: [String] = []

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
    }

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

    init() {
        let builtins = BuiltinActions()
        commands = CommandCenter(builtins: builtins)
        builtins.log = { [weak self] message, tag, data in
            self?.sendLog(ts: Clock.nowMs(), level: .debug, tag: tag, message: message, data: data)
        }
        commands.onChange = { [weak self] in
            guard let self, self.isRunning else { return }
            self.send(WireMessage.actions(self.commands.descriptors()))
        }
    }

    // MARK: State accessors (thread-safe)

    var isRunning: Bool { lock.withLock { running } }
    var isConnected: Bool { lock.withLock { connected } }
    var sdkConfig: SdkConfig { lock.withLock { config } }
    var mockRules: [MockRule] { lock.withLock { mocks } }
    var networkPolicy: NetworkCapturePolicy { lock.withLock { policy } }
    var appIdentifier: String? { lock.withLock { environment?.app.id } }

    /// Diagnostics/tests: active link origin, bound USB listener port, buffered message count.
    var transportSnapshot: (activeOrigin: Transport.Origin?, listenerPort: UInt16?, buffered: Int)? {
        lock.withLock { transport }?.snapshot
    }

    func nextRequestId() -> String {
        lock.withLock {
            requestCounter += 1
            return String(requestCounter)
        }
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
        guard Self.buildAllowsRunning || options.allowInReleaseBuilds else {
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
        let overrides = self.overrides
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
            self.environment = environment
            self.transport = transport
            policy = NetworkCapturePolicy(
                active: options.captureNetwork,
                interceptUploadTasks: options.interceptUploadTasks,
                ignoredHosts: options.ignoredHosts.map { $0.lowercased() }
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

    func stop() {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        let (transport, stdio, metrics, crash, observer) = lock.withLock {
            () -> (Transport?, StdioCapture?, MetricsReporter?, Bool, NSObjectProtocol?) in
            let result = (self.transport, self.stdio, self.metrics, crashCapture, foregroundObserver)
            generation += 1
            running = false
            connected = false
            self.transport = nil
            self.stdio = nil
            self.metrics = nil
            crashCapture = false
            foregroundObserver = nil
            policy.active = false
            mocks = []
            return result
        }
        if let observer { NotificationCenter.default.removeObserver(observer) }
        metrics?.stop()
        stdio?.stop()
        if crash { CrashCapture.uninstall() }
        NetworkCapture.uninstall()
        transport?.stop()
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
        let transport = lock.withLock { running ? self.transport : nil }
        transport?.send(message)
    }

    func flush(timeout: TimeInterval) -> Bool {
        let transport = lock.withLock { running ? self.transport : nil }
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
        for entry in entries {
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
    }

    private func didDisconnect(generation: Int) {
        let metrics: MetricsReporter? = lock.withLock {
            guard self.generation == generation else { return nil }
            connected = false
            return self.metrics
        }
        metrics?.stop()
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
        case let .command(id, name, params):
            commands.handle(name: name, params: params) { [weak self] result in
                self?.send(WireMessage.commandResult(id: id, ok: result.ok, data: result.data, error: result.error))
            }
        case .welcome, .ping:
            break
        }
    }
}
