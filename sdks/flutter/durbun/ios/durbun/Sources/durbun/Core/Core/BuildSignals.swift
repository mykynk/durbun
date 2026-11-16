import Foundation

/// What the running build says about itself at run time. The package's own `DEBUG` flag only says how
/// Xcode compiled the package, which for custom configurations (Staging, Debug-Dev…) can differ from
/// how the app was built; these signals decide for builds the package sees without `DEBUG`.
enum BuildSignals {
    /// Info.plist key that turns the SDK on (`YES`) or off (`NO`) per build configuration, usually
    /// through a build setting: `<key>DurbunEnabled</key><string>$(DURBUN_ENABLED)</string>`.
    static let enabledInfoKey = "DurbunEnabled"

    /// The `DurbunEnabled` value as a switch; nil when absent, empty or an undefined build setting.
    static func infoPlistSwitch(_ value: Any?) -> Bool? {
        if let number = value as? NSNumber { return number.boolValue }
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !text.isEmpty, !text.hasPrefix("$(")
        else { return nil }
        switch text {
        case "yes", "true", "1": return true
        case "no", "false", "0": return false
        default: return nil
        }
    }

    /// Running in the Simulator, which only ever runs development builds.
    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    /// A debugger (Xcode's Run) is attached to this process. One `sysctl`, no file access.
    static var debuggerAttached: Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return false }
        return (info.kp_proc.p_flag & P_TRACED) != 0
    }

    /// `get-task-allow` of the provisioning profile embedded in the app: true for builds signed for
    /// development (Xcode's Run and Profile, a development export), false for ad hoc and enterprise
    /// builds, nil when there is no profile (App Store, TestFlight, macOS). Reads a file: call it off
    /// the main thread.
    static func provisioningAllowsDebugging(bundle: Bundle = .main) -> Bool? {
        #if os(iOS)
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url, options: .mappedIfSafe)
        else { return nil }
        return profileAllowsDebugging(data)
        #else
        return nil
        #endif
    }

    /// The profile is a signed (CMS) envelope around an XML property list; only the plist is read.
    static func profileAllowsDebugging(_ data: Data) -> Bool? {
        guard let start = data.range(of: Data("<?xml".utf8)) ?? data.range(of: Data("<plist".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex)
        else { return nil }
        let plistData = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = (try? PropertyListSerialization.propertyList(from: plistData, format: nil)) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any]
        else { return nil }
        return (entitlements["get-task-allow"] as? Bool) ?? false
    }
}
