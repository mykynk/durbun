import XCTest
@testable import Durbun

/// Base class for end-to-end tests: a fake desktop on a random port and an SDK started against it
/// with fast reconnects. Every capture is off unless a test turns it on.
class SDKTestCase: XCTestCase {
    var desktop: FakeDesktop!

    override func setUpWithError() throws {
        try super.setUpWithError()
        desktop = FakeDesktop()
        try desktop.start()
        var overrides = DurbunCore.Overrides()
        overrides.deviceListener = false
        overrides.loopbackClient = true
        overrides.reconnectMinDelay = 0.05
        overrides.reconnectMaxDelay = 0.2
        overrides.handshakeTimeout = 3
        DurbunCore.shared.overrides = overrides
    }

    override func tearDown() {
        Durbun.stop()
        desktop?.stop()
        desktop = nil
        DurbunCore.shared.overrides = DurbunCore.Overrides()
        super.tearDown()
    }

    func options(
        port: UInt16? = nil,
        network: Bool = false,
        stdout: Bool = false,
        crashes: Bool = false,
        metrics: Bool = false,
        maxBuffered: Int = 5000,
        ignoredHosts: [String] = []
    ) -> DurbunOptions {
        DurbunOptions(
            port: port ?? desktop.port,
            captureStdout: stdout,
            captureNetwork: network,
            captureCrashes: crashes,
            collectMetrics: metrics,
            ignoredHosts: ignoredHosts,
            maxBufferedMessages: maxBuffered
        )
    }

    /// Starts the SDK and waits for the hello → welcome handshake.
    func startConnected(_ options: DurbunOptions? = nil, file: StaticString = #filePath, line: UInt = #line) {
        Durbun.start(options: options ?? self.options())
        XCTAssertNotNil(desktop.waitForType("hello"), "no hello", file: file, line: line)
        XCTAssertTrue(waitUntil { Durbun.isConnected }, "not connected", file: file, line: line)
    }

    /// Polls `condition` until true or timeout (the main run loop keeps running).
    func waitUntil(timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
        spinUntil(timeout: timeout, condition)
    }
}
