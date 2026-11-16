import XCTest
@testable import Durbun

/// `DURDurbun`: the Objective-C names exist and reach the same SDK.
final class ObjCBridgeTests: SDKTestCase {
    func testObjectiveCNames() {
        let cls: AnyClass? = NSClassFromString("DURDurbun")
        XCTAssertNotNil(cls)
        for selector in [
            "start", "startWithHost:", "stop", "isRunning", "isConnected", "connectionStatusDescription",
            "setDesktopHost:", "log:level:tag:data:", "debug:tag:", "info:tag:", "warning:tag:", "error:tag:error:",
            "event:properties:", "addButtonWithId:label:handler:", "addToggleWithId:label:initialValue:handler:",
            "removeActionWithId:",
        ] {
            XCTAssertTrue((cls as AnyObject).responds(to: NSSelectorFromString(selector)), selector)
        }
    }

    func testLogsEventsAndButtonsReachTheDesktop() throws {
        startConnected()
        DurbunObjC.log("Cache miss", level: "debug", tag: "cache", data: ["key": "user/42"])
        DurbunObjC.warning("Slow", tag: "api")
        DurbunObjC.error("Payment failed", tag: "pay", error: NSError(domain: "Pay", code: 7))
        DurbunObjC.event("purchase", properties: ["amount": 49.9])

        let debug = try XCTUnwrap(desktop.waitForType("log") { ($0["message"] as? String) == "Cache miss" })
        XCTAssertEqual(debug["level"] as? String, "debug")
        XCTAssertEqual((debug["data"] as? [String: Any])?["key"] as? String, "user/42")
        XCTAssertEqual(desktop.waitForType("log") { ($0["message"] as? String) == "Slow" }?["level"] as? String, "warn")
        let error = try XCTUnwrap(desktop.waitForType("log") { ($0["message"] as? String) == "Payment failed" })
        XCTAssertNotNil(error["error"])
        XCTAssertNotNil(desktop.waitForType("event") { ($0["name"] as? String) == "purchase" })

        var pressed = false
        DurbunObjC.addButton(id: "app.objc", label: "From Objective-C") { pressed = true }
        XCTAssertNotNil(desktop.waitForType("actions") { message in
            ((message["actions"] as? [[String: Any]]) ?? []).contains { $0["id"] as? String == "app.objc" }
        })
        desktop.send(["type": "command", "id": "c1", "name": "app.objc"])
        XCTAssertTrue(waitUntil { pressed })
        DurbunObjC.removeAction(id: "app.objc")
    }

    func testLevelNames() {
        XCTAssertEqual(DurbunObjC.logLevel("warning"), .warning)
        XCTAssertEqual(DurbunObjC.logLevel("WARN"), .warning)
        XCTAssertEqual(DurbunObjC.logLevel("fatal"), .fatal)
        XCTAssertEqual(DurbunObjC.logLevel("loud"), .info)
        XCTAssertEqual(DurbunObjC.logLevel(nil), .info)
    }
}
