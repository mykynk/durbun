import Foundation
#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

/// Static facts about the app and the device that go into `hello`.
struct AppEnvironment {
    var app: WireAppInfo
    var device: WireDeviceHints

    /// True on a physical iPhone/iPad, where the desktop reaches the SDK through the on-device
    /// listener (usbmux) instead of 127.0.0.1:9751.
    static var isPhysicalIOSDevice: Bool {
        #if os(iOS) && !targetEnvironment(simulator) && !targetEnvironment(macCatalyst)
        return true
        #else
        return false
        #endif
    }

    static func current(bundle: Bundle = .main, processInfo: ProcessInfo = .processInfo) -> AppEnvironment {
        let info = bundle.infoDictionary ?? [:]
        let processName = processInfo.processName
        let bundleId = bundle.bundleIdentifier ?? processName
        let displayName = nonEmpty(info["CFBundleDisplayName"] as? String)
            ?? nonEmpty(info["CFBundleName"] as? String)
            ?? processName
        #if DEBUG
        let debugBuild = true
        #else
        let debugBuild = false
        #endif
        let app = WireAppInfo(
            name: displayName,
            id: bundleId,
            version: nonEmpty(info["CFBundleShortVersionString"] as? String),
            build: nonEmpty(info["CFBundleVersion"] as? String),
            pid: Int(processInfo.processIdentifier),
            processName: nonEmpty((info["CFBundleExecutable"] as? String)) ?? processName,
            debug: debugBuild
        )
        return AppEnvironment(app: app, device: deviceHints(processInfo: processInfo))
    }

    private static func deviceHints(processInfo: ProcessInfo) -> WireDeviceHints {
        let env = processInfo.environment
        let os = processInfo.operatingSystemVersion
        let osVersion = os.patchVersion > 0
            ? "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
            : "\(os.majorVersion).\(os.minorVersion)"
        #if targetEnvironment(simulator)
        return WireDeviceHints(
            platform: "ios",
            model: nonEmpty(env["SIMULATOR_MODEL_IDENTIFIER"]) ?? machineIdentifier(),
            manufacturer: "Apple",
            name: nonEmpty(env["SIMULATOR_DEVICE_NAME"]) ?? mainThreadDeviceName(),
            osVersion: osVersion,
            isPhysical: false,
            simulatorUdid: nonEmpty(env["SIMULATOR_UDID"])
        )
        #elseif os(iOS) && !targetEnvironment(macCatalyst)
        return WireDeviceHints(
            platform: "ios",
            model: machineIdentifier(),
            manufacturer: "Apple",
            name: mainThreadDeviceName(),
            osVersion: osVersion,
            isPhysical: true,
            simulatorUdid: nil
        )
        #else
        // macOS app, Mac Catalyst or the test runner: a Mac, which the protocol calls 'other'.
        return WireDeviceHints(
            platform: "other",
            model: sysctlString("hw.model") ?? machineIdentifier(),
            manufacturer: "Apple",
            // kern.hostname is instant; Host.current() / hostName may block on DNS lookups.
            name: sysctlString("kern.hostname").map { $0.hasSuffix(".local") ? String($0.dropLast(6)) : $0 },
            osVersion: "macOS " + osVersion,
            isPhysical: true,
            simulatorUdid: nil
        )
        #endif
    }

    /// `uname().machine`, e.g. "iPhone16,2" on a device or "arm64" on a Mac.
    static func machineIdentifier() -> String? {
        var systemInfo = utsname()
        guard uname(&systemInfo) == 0 else { return nil }
        let machine = withUnsafeBytes(of: &systemInfo.machine) { raw -> String in
            let bytes = raw.prefix { $0 != 0 }
            return String(decoding: bytes, as: UTF8.self)
        }
        return nonEmpty(machine)
    }

    static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        return nonEmpty(String(cString: buffer))
    }

    /// `UIDevice.name` may only be read on the main thread; on other threads it is skipped (the
    /// desktop knows the device name from usbmux / simctl anyway).
    private static func mainThreadDeviceName() -> String? {
        #if canImport(UIKit) && !os(watchOS)
        guard Thread.isMainThread else { return nil }
        return MainActor.assumeIsolated { nonEmpty(UIDevice.current.name) }
        #else
        return nil
        #endif
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}
