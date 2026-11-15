import Foundation
#if canImport(MetricKit) && os(iOS)
import MetricKit
#endif

/// One diagnostic of an earlier launch as iOS reports it through MetricKit (iOS 14+): crashes the
/// SDK's own handlers cannot see (watchdog kills, launch failures), main-thread hangs, CPU and disk
/// write exceptions, slow launches. Plain values so the wording is tested on macOS.
struct SystemDiagnosticRecord {
    enum Kind: String {
        case crash, hang, cpuException, diskWriteException, slowLaunch
    }

    var kind: Kind
    /// End of the reporting window (seconds since 1970).
    var timestamp: Double
    var appVersion: String?
    var appBuild: String?
    var osVersion: String?
    var signal: Int?
    var exceptionType: Int?
    var exceptionCode: Int?
    var terminationReason: String?
    var exceptionName: String?
    var exceptionMessage: String?
    /// Hang or launch duration in seconds.
    var duration: Double?
    var cpuSeconds: Double?
    var sampledSeconds: Double?
    var writtenMB: Double?
    /// `MXCallStackTree.jsonRepresentation()` (unsymbolicated: binary name, UUID, offset).
    var callStackTree: Data?
}

/// A log line for one diagnostic, and whether the desktop reads the same record from the device itself.
struct SystemDiagnosticReport {
    /// Tells the same diagnostic apart when iOS hands it over twice (delivered and in the past payloads).
    var key: String
    var timestamp: Double
    var message: JSONValue
    var desktopReadsIt: Bool
}

enum SystemDiagnosticReports {
    static let tag = "app-diagnostics"
    private static let maxTreeBytes = 64 * 1024

    /// The report for `record`, or nil for crashes the SDK's own signal / exception handlers already
    /// reported ("Crash in previous launch: …") when `caughtSignals` holds their signal.
    static func report(for record: SystemDiagnosticRecord, caughtSignals: Set<Int32>) -> SystemDiagnosticReport? {
        var data = JSONObjectBuilder()
        data.set("previousLaunch", true)
        data.set("source", "MetricKit")
        data.set("diagnostic", record.kind.rawValue)
        data.set("appVersion", record.appVersion)
        data.set("appBuild", record.appBuild)
        data.set("osVersion", record.osVersion)
        let stack = record.callStackTree.flatMap(stackText(fromTreeJSON:))
        if let tree = record.callStackTree, tree.count <= maxTreeBytes,
           let object = try? JSONSerialization.jsonObject(with: tree)
        {
            data.set("callStackTree", JSONConversion.value(from: object))
        }
        let level: DurbunLogLevel
        let message: String
        var kind = "text"
        var tag = Self.tag
        var error: WireErrorInfo?
        var desktopReadsIt = false
        switch record.kind {
        case .crash:
            let reason = record.terminationReason?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let signal = record.signal, caughtSignals.contains(Int32(signal)), reason?.isEmpty ?? true,
               record.exceptionName == nil
            {
                return nil
            }
            data.set("signal", record.signal)
            data.set("exceptionType", record.exceptionType)
            data.set("exceptionCode", record.exceptionCode)
            data.set("terminationReason", reason)
            let signalName = record.signal.map { SignalReport.name(of: Int32($0)) }
            if let reason, reason.lowercased().contains("8badf00d") {
                message = "Earlier launch was ended by the iOS watchdog (0x8badf00d): the app did not respond in time "
                    + "(at launch, on resume or with a blocked main thread)."
            } else if let name = record.exceptionName {
                message = "Earlier launch crashed with an uncaught exception \(name): \(record.exceptionMessage ?? "")"
            } else {
                message = "Earlier launch crashed (reported by iOS): "
                    + [signalName, reason].compactMap { $0 }.joined(separator: " · ")
            }
            level = .fatal
            kind = "crash"
            tag = "crash"
            error = WireErrorInfo(type: record.exceptionName ?? signalName ?? "Crash", message: reason ?? record.exceptionMessage, stack: stack)
            desktopReadsIt = true
        case .hang:
            data.set("durationSeconds", record.duration)
            message = "The main thread hung for \(seconds(record.duration)) in an earlier launch (reported by iOS)."
            level = .warning
            error = stack.map { WireErrorInfo(type: "Hang", message: message, stack: $0) }
        case .cpuException:
            data.set("cpuSeconds", record.cpuSeconds)
            data.set("sampledSeconds", record.sampledSeconds)
            message = "An earlier launch used \(seconds(record.cpuSeconds)) of CPU in \(seconds(record.sampledSeconds)) "
                + "(reported by iOS as a CPU exception)."
            level = .warning
            error = stack.map { WireErrorInfo(type: "CPU exception", message: message, stack: $0) }
        case .diskWriteException:
            data.set("writtenMB", record.writtenMB)
            message = "An earlier launch wrote \(record.writtenMB.map { String(format: "%.0f", $0) } ?? "?") MB to disk "
                + "(reported by iOS as a disk write exception)."
            level = .warning
            error = stack.map { WireErrorInfo(type: "Disk writes", message: message, stack: $0) }
        case .slowLaunch:
            data.set("durationSeconds", record.duration)
            message = "An earlier launch took \(seconds(record.duration)) to start (reported by iOS)."
            level = .warning
        }
        let line = WireMessage.log(
            ts: (record.timestamp * 1000).rounded(),
            level: level,
            tag: tag,
            message: message,
            data: data.value,
            error: error,
            kind: kind
        )
        let key = "\(record.kind.rawValue)|\(record.timestamp)|\(record.signal ?? 0)|\(record.duration ?? 0)|"
            + "\(record.cpuSeconds ?? 0)|\(record.writtenMB ?? 0)|\(record.callStackTree?.count ?? 0)"
        return SystemDiagnosticReport(key: key, timestamp: record.timestamp, message: line, desktopReadsIt: desktopReadsIt)
    }

    private static func seconds(_ value: Double?) -> String {
        guard let value else { return "? s" }
        return String(format: "%.1f s", value)
    }

    /// A readable (unsymbolicated) stack from a call stack tree: the attributed thread (or the first
    /// one), following the most sampled frame at each level.
    static func stackText(fromTreeJSON data: Data) -> String? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let stacks = root["callStacks"] as? [[String: Any]], !stacks.isEmpty
        else { return nil }
        let stack = stacks.first { ($0["threadAttributed"] as? Bool) == true } ?? stacks[0]
        guard var frames = stack["callStackRootFrames"] as? [[String: Any]], !frames.isEmpty else { return nil }
        var lines: [String] = []
        while let frame = frames.max(by: { sampleCount($0) < sampleCount($1) }), lines.count < 128 {
            var line = frame["binaryName"] as? String ?? "???"
            if let address = (frame["address"] as? NSNumber)?.uint64Value { line += "  0x" + String(address, radix: 16) }
            if let offset = (frame["offsetIntoBinaryTextSegment"] as? NSNumber)?.int64Value { line += " + \(offset)" }
            lines.append(line)
            frames = frame["subFrames"] as? [[String: Any]] ?? []
        }
        guard !lines.isEmpty else { return nil }
        // In MetricKit's order: the root frame (the top of the stack) first, then its callers.
        return lines.enumerated().map { "\($0.offset)  \($0.element)" }.joined(separator: "\n")
    }

    private static func sampleCount(_ frame: [String: Any]) -> Int {
        (frame["sampleCount"] as? NSNumber)?.intValue ?? 1
    }
}

/// Subscribes to MetricKit's diagnostic payloads (iOS 14+; MetricKit delivers on real devices, not
/// in the simulator). Reports go to the sink on a background queue.
enum SystemDiagnostics {
    /// Returns false when MetricKit diagnostics are not available on this system.
    static func start(_ sink: @escaping ([SystemDiagnosticReport]) -> Void) -> Bool {
        #if canImport(MetricKit) && os(iOS)
        if #available(iOS 14.0, *) {
            MetricKitSubscriber.shared.start(sink)
            return true
        }
        #endif
        return false
    }

    static func stop() {
        #if canImport(MetricKit) && os(iOS)
        if #available(iOS 14.0, *) {
            MetricKitSubscriber.shared.stop()
        }
        #endif
    }
}

#if canImport(MetricKit) && os(iOS)
@available(iOS 14.0, *)
private final class MetricKitSubscriber: NSObject, MXMetricManagerSubscriber {
    static let shared = MetricKitSubscriber()

    private let lock = UnfairLock()
    private var sink: (([SystemDiagnosticReport]) -> Void)?
    private var subscribed = false

    func start(_ sink: @escaping ([SystemDiagnosticReport]) -> Void) {
        let subscribe: Bool = lock.withLock {
            self.sink = sink
            if subscribed { return false }
            subscribed = true
            return true
        }
        DispatchQueue.global(qos: .utility).async {
            let manager = MXMetricManager.shared
            if subscribe { manager.add(self) }
            // Delivered before this launch subscribed (the SDK skips what it already handled).
            self.deliver(manager.pastDiagnosticPayloads)
        }
    }

    func stop() {
        let unsubscribe: Bool = lock.withLock {
            sink = nil
            let was = subscribed
            subscribed = false
            return was
        }
        if unsubscribe {
            DispatchQueue.global(qos: .utility).async { MXMetricManager.shared.remove(self) }
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        deliver(payloads)
    }

    private func deliver(_ payloads: [MXDiagnosticPayload]) {
        guard let sink = lock.withLock({ sink }), !payloads.isEmpty else { return }
        let caught = Set(SignalCrashRecorder.fatalSignals)
        let reports = payloads.flatMap(Self.records(from:)).compactMap {
            SystemDiagnosticReports.report(for: $0, caughtSignals: caught)
        }
        if !reports.isEmpty { sink(reports) }
    }

    private static func records(from payload: MXDiagnosticPayload) -> [SystemDiagnosticRecord] {
        let ts = payload.timeStampEnd.timeIntervalSince1970
        func base(_ kind: SystemDiagnosticRecord.Kind, _ diagnostic: MXDiagnostic) -> SystemDiagnosticRecord {
            SystemDiagnosticRecord(
                kind: kind,
                timestamp: ts,
                appVersion: diagnostic.applicationVersion,
                appBuild: diagnostic.metaData.applicationBuildVersion,
                osVersion: diagnostic.metaData.osVersion
            )
        }
        var out: [SystemDiagnosticRecord] = []
        for crash in payload.crashDiagnostics ?? [] {
            var record = base(.crash, crash)
            record.signal = crash.signal?.intValue
            record.exceptionType = crash.exceptionType?.intValue
            record.exceptionCode = crash.exceptionCode?.intValue
            record.terminationReason = crash.terminationReason
            if #available(iOS 17.0, *), let reason = crash.exceptionReason {
                record.exceptionName = reason.exceptionName
                record.exceptionMessage = reason.composedMessage
            }
            record.callStackTree = crash.callStackTree.jsonRepresentation()
            out.append(record)
        }
        for hang in payload.hangDiagnostics ?? [] {
            var record = base(.hang, hang)
            record.duration = hang.hangDuration.converted(to: .seconds).value
            record.callStackTree = hang.callStackTree.jsonRepresentation()
            out.append(record)
        }
        for cpu in payload.cpuExceptionDiagnostics ?? [] {
            var record = base(.cpuException, cpu)
            record.cpuSeconds = cpu.totalCPUTime.converted(to: .seconds).value
            record.sampledSeconds = cpu.totalSampledTime.converted(to: .seconds).value
            record.callStackTree = cpu.callStackTree.jsonRepresentation()
            out.append(record)
        }
        for disk in payload.diskWriteExceptionDiagnostics ?? [] {
            var record = base(.diskWriteException, disk)
            record.writtenMB = disk.totalWritesCaused.converted(to: .megabytes).value
            record.callStackTree = disk.callStackTree.jsonRepresentation()
            out.append(record)
        }
        if #available(iOS 16.0, *) {
            for launch in payload.appLaunchDiagnostics ?? [] {
                var record = base(.slowLaunch, launch)
                record.duration = launch.launchDuration.converted(to: .seconds).value
                out.append(record)
            }
        }
        return out
    }
}
#endif
