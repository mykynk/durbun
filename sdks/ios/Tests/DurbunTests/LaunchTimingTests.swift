import XCTest
@testable import Durbun

final class LaunchTimingTests: XCTestCase {
    func testColdStartRunsFromProcessStartToFirstFrame() throws {
        let props = try XCTUnwrap(LaunchTiming.props(
            processStartMs: 1_000_000,
            sdkStartMs: 1_000_180,
            firstFrameMs: 1_000_640.4,
            prewarmed: false,
            screen: "RootViewController"
        ))
        XCTAssertEqual(props["kind"] as? String, "cold")
        XCTAssertEqual(props["ms"] as? Int, 640)
        XCTAssertEqual(props["to"] as? String, "firstFrame")
        XCTAssertEqual(props["from"] as? String, "processStart")
        XCTAssertEqual(props["screen"] as? String, "RootViewController")
    }

    func testPrewarmedLaunchSaysSoWithoutADuration() throws {
        let props = try XCTUnwrap(LaunchTiming.props(
            processStartMs: 1_000_000,
            sdkStartMs: 1_090_000,
            firstFrameMs: 1_090_400,
            prewarmed: true,
            screen: nil
        ))
        XCTAssertEqual(props["kind"] as? String, "prewarmed")
        XCTAssertNil(props["ms"])
        XCTAssertTrue(LaunchTiming.isPrewarmed(["ActivePrewarm": "1"]))
        XCTAssertFalse(LaunchTiming.isPrewarmed([:]))
    }

    func testNoNumberWhenItWouldNotDescribeALaunch() {
        // Dürbün started long after the process.
        XCTAssertNil(LaunchTiming.props(processStartMs: 0 + 1_000, sdkStartMs: 1_000 + LaunchTiming.maxStartAgeMs + 1,
                                        firstFrameMs: 20_000, prewarmed: false, screen: nil))
        // First frame implausibly late.
        XCTAssertNil(LaunchTiming.props(processStartMs: 1_000, sdkStartMs: 1_100,
                                        firstFrameMs: 1_000 + LaunchTiming.maxLaunchMs + 1, prewarmed: false, screen: nil))
        // Unknown or inconsistent clocks.
        XCTAssertNil(LaunchTiming.props(processStartMs: nil, sdkStartMs: 1_100, firstFrameMs: 1_200, prewarmed: false, screen: nil))
        XCTAssertNil(LaunchTiming.props(processStartMs: 2_000, sdkStartMs: 1_100, firstFrameMs: 2_200, prewarmed: false, screen: nil))
        XCTAssertNil(LaunchTiming.props(processStartMs: 1_000, sdkStartMs: 1_100, firstFrameMs: 1_050, prewarmed: false, screen: nil))
    }

    func testProcessStartComesFromTheKernel() throws {
        let start = try XCTUnwrap(LaunchTiming.processStartMs())
        let now = Clock.nowMs()
        XCTAssertLessThanOrEqual(start, now)
        XCTAssertGreaterThan(start, now - 24 * 3_600_000) // a test run is younger than a day
    }
}
