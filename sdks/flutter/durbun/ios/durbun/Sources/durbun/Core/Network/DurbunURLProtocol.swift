import Foundation

/// Intercepts http(s) URLSession traffic: reports request/response/error to the desktop, applies
/// mock rules and otherwise performs the request through `ForwardingSession`, teeing every
/// callback back to the app unchanged.
///
/// Client callbacks are delivered on the thread that called `startLoading` (Apple's URLProtocol
/// contract). A request property marks forwarded requests so they are never intercepted twice.
final class DurbunURLProtocol: URLProtocol {
    static let handledKey = "dev.durbun.handled"

    private static let bodyQueue = DispatchQueue(label: "dev.durbun.request-body", qos: .utility, attributes: .concurrent)
    private static let timerQueue = DispatchQueue(label: "dev.durbun.mock-timers", qos: .utility)

    // MARK: Registration decisions

    override class func canInit(with request: URLRequest) -> Bool {
        let policy = DurbunCore.shared.networkPolicy
        guard policy.active,
              let url = request.url,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              URLProtocol.property(forKey: handledKey, in: request) == nil
        else { return false }
        if let host = url.host, policy.ignores(host: host) { return false }
        return true
    }

    override class func canInit(with task: URLSessionTask) -> Bool {
        if task is URLSessionWebSocketTask || task is URLSessionStreamTask { return false }
        if task is URLSessionUploadTask && !DurbunCore.shared.networkPolicy.interceptUploadTasks { return false }
        guard let request = task.currentRequest ?? task.originalRequest else { return false }
        return canInit(with: request)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    // MARK: State (guarded by `state`)

    private let state = UnfairLock()
    private var clientThread: Thread?
    private var runLoopModes: [String] = [RunLoop.Mode.default.rawValue]
    private var requestId = ""
    private var startTs = 0.0
    private var config = SdkConfig.defaults
    private var appliedRule: MockRule?
    private var innerTask: URLSessionTask?
    private var pendingWork: DispatchWorkItem?
    private var stopped = false
    private var clientDone = false
    private var reported = false
    /// `net.request` was sent; a final report arriving earlier (cancel during a slow body read)
    /// waits in `deferredFinal` so the desktop always sees request → error in order.
    private var requestSent = false
    private var deferredFinal: JSONValue?
    private var response: URLResponse?
    private var responseBody = BodyAccumulator(limit: 0)
    private var metrics: URLSessionTaskMetrics?
    private var challengeSenders: [ChallengeSender] = []

    // MARK: URLProtocol

    override func startLoading() {
        var modes = [RunLoop.Mode.default.rawValue]
        if let current = RunLoop.current.currentMode, current != .default { modes.append(current.rawValue) }
        let core = DurbunCore.shared
        let config = core.sdkConfig
        let id = core.nextRequestId()
        let thread = Thread.current
        state.withLock {
            clientThread = thread
            runLoopModes = modes
            requestId = id
            startTs = Clock.nowMs()
            self.config = config
            responseBody = BodyAccumulator(limit: config.captureBodies ? config.maxBodyBytes : 0)
        }
        let request = self.request
        let captureLimit = config.captureBodies ? config.maxBodyBytes : 0
        if request.httpBodyStream != nil {
            // Reading may block on an app-fed stream: keep CFNetwork's protocol thread free.
            Self.bodyQueue.async {
                self.begin(request, body: RequestBody.read(request, captureLimit: captureLimit))
            }
        } else {
            begin(request, body: RequestBody.read(request, captureLimit: captureLimit))
        }
    }

    override func stopLoading() {
        let (task, work, wasDone) = state.withLock { () -> (URLSessionTask?, DispatchWorkItem?, Bool) in
            stopped = true
            let done = clientDone
            clientDone = true
            let task = innerTask
            innerTask = nil
            let work = pendingWork
            pendingWork = nil
            return (task, work, done)
        }
        work?.cancel()
        task?.cancel()
        guard !wasDone else { return }
        // The app's task stops us both for cancel() and for its own timeouts: tell them apart.
        if let outer = self.task?.error as NSError?,
           !(outer.domain == NSURLErrorDomain && outer.code == NSURLErrorCancelled)
        {
            report(error: outer, cancelled: false)
        } else {
            report(error: URLError(.cancelled), cancelled: true)
        }
    }

    // MARK: Request flow

    private func begin(_ request: URLRequest, body: RequestBody.Result) {
        let core = DurbunCore.shared
        let (id, ts, config) = state.withLock { (requestId, startTs, self.config) }
        let method = request.httpMethod ?? "GET"
        let url = request.url?.absoluteString ?? ""
        let headers = HTTPHeaders.sorted(request.allHTTPHeaderFields)
        let wireBody = BodyCapture.wireBody(
            captured: body.captured,
            totalSize: body.totalSize,
            contentType: HTTPHeaders.value("Content-Type", in: headers),
            limit: config.captureBodies ? config.maxBodyBytes : 0
        )
        core.send(WireMessage.netRequest(id: id, ts: ts, method: method, url: url, headers: core.redacting(headers), body: wireBody))
        let deferred: JSONValue? = state.withLock {
            requestSent = true
            defer { deferredFinal = nil }
            return deferredFinal
        }
        if let deferred { core.send(deferred) }
        if state.withLock({ stopped }) {
            discard(body.forward)
            return
        }

        if case let .failed(error) = body.forward {
            fail(with: error)
            return
        }
        let rule = MockRule.first(in: core.mockRules, method: method, url: url, appId: core.appIdentifier)
        guard let rule else {
            forward(request, body: body.forward)
            return
        }
        switch rule.action {
        case let .respond(status, headers, responseBody, encoding, delayMs):
            state.withLock { appliedRule = rule }
            discard(body.forward)
            schedule(afterMs: delayMs) {
                self.deliverMockResponse(status: status, headers: headers, body: responseBody, encoding: encoding)
            }
        case let .fail(kind, message, delayMs):
            state.withLock { appliedRule = rule }
            discard(body.forward)
            schedule(afterMs: delayMs) {
                self.fail(with: MockFailure.error(kind: kind, message: message, url: request.url, ruleId: rule.id))
            }
        case let .delay(delayMs):
            state.withLock { appliedRule = rule }
            schedule(afterMs: delayMs) { self.forward(request, body: body.forward) }
        case .unsupported:
            forward(request, body: body.forward)
        }
    }

    private func forward(_ request: URLRequest, body: RequestBody.Forward) {
        guard let forwarded = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else { return }
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: forwarded)
        forwarded.timeoutInterval = 3600
        switch body {
        case .none:
            break
        case let .data(data):
            forwarded.httpBodyStream = nil
            forwarded.httpBody = data
        case let .stream(stream):
            forwarded.httpBodyStream = stream
        case .failed:
            return
        }
        let session = ForwardingSession.shared
        let task = session.makeTask(with: forwarded as URLRequest, owner: self)
        let alreadyStopped: Bool = state.withLock {
            if stopped { return true }
            innerTask = task
            return false
        }
        if alreadyStopped {
            session.discard(task)
        } else {
            task.resume()
        }
    }

    private func schedule(afterMs delayMs: Double?, _ work: @escaping () -> Void) {
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.state.withLock({ self.stopped }) else { return }
            work()
        }
        let registered: Bool = state.withLock {
            if stopped { return false }
            pendingWork = item
            return true
        }
        guard registered else { return }
        let delay = max(0, delayMs ?? 0)
        if delay > 0 {
            Self.timerQueue.asyncAfter(deadline: .now() + delay / 1000, execute: item)
        } else {
            Self.timerQueue.async(execute: item)
        }
    }

    /// A mocked request never reads a replayed body stream: close it so its feeder thread exits.
    private func discard(_ body: RequestBody.Forward) {
        if case let .stream(stream) = body {
            stream.open()
            stream.close()
        }
    }

    private func deliverMockResponse(status: Int, headers: [(String, String)], body: String?, encoding: String?) {
        let url = request.url ?? URL(fileURLWithPath: "/")
        let data: Data
        if let body {
            data = encoding == "base64" ? (Data(base64Encoded: body, options: .ignoreUnknownCharacters) ?? Data()) : Data(body.utf8)
        } else {
            data = Data()
        }
        var fields: [String: String] = [:]
        for (name, value) in headers {
            if let key = fields.keys.first(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
                fields[key] = fields[key]! + ", " + value
            } else {
                fields[name] = value
            }
        }
        let hasContentType = fields.keys.contains { $0.caseInsensitiveCompare("Content-Type") == .orderedSame }
        if !hasContentType, !data.isEmpty, (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil {
            fields["Content-Type"] = "application/json; charset=utf-8"
        }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields) else {
            fail(with: URLError(.badServerResponse))
            return
        }
        state.withLock {
            self.response = response
            responseBody.append(data)
        }
        reportResponse()
        onClientThread {
            guard self.markClientDone() else { return }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !data.isEmpty { self.client?.urlProtocol(self, didLoad: data) }
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    private func fail(with error: Error) {
        report(error: error, cancelled: false)
        onClientThread {
            guard self.markClientDone() else { return }
            self.client?.urlProtocol(self, didFailWithError: error)
        }
    }

    // MARK: Inner task callbacks (ForwardingSession's serial delegate queue)

    func innerDidReceive(response: URLResponse) {
        state.withLock { self.response = response }
        onClientThread {
            guard !self.isClientDone else { return }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
    }

    func innerDidReceive(data: Data) {
        state.withLock { responseBody.append(data) }
        onClientThread {
            guard !self.isClientDone else { return }
            self.client?.urlProtocol(self, didLoad: data)
        }
    }

    func innerDidCollect(_ metrics: URLSessionTaskMetrics) {
        state.withLock { self.metrics = metrics }
    }

    func innerDidComplete(error: Error?) {
        if let error {
            // Our own cancellation (stopLoading, redirect) was already reported.
            guard !state.withLock({ stopped }) else { return }
            fail(with: error)
        } else {
            reportResponse()
            onClientThread {
                guard self.markClientDone() else { return }
                self.client?.urlProtocolDidFinishLoading(self)
            }
        }
    }

    /// Reports this hop with its 3xx response, hands the redirect to the app's session (which asks
    /// its delegate) and stops: the URL loading system starts a new protocol instance — and thus a
    /// new network entry — for the redirected request.
    func innerWillRedirect(response: HTTPURLResponse, newRequest: URLRequest, completion: @escaping (URLRequest?) -> Void) {
        state.withLock { self.response = response }
        reportResponse()
        let originalTimeout = request.timeoutInterval
        onClientThread {
            guard self.markClientDone(), let redirect = (newRequest as NSURLRequest).mutableCopy() as? NSMutableURLRequest else {
                completion(nil)
                return
            }
            URLProtocol.removeProperty(forKey: Self.handledKey, in: redirect)
            redirect.timeoutInterval = originalTimeout
            self.client?.urlProtocol(self, wasRedirectedTo: redirect as URLRequest, redirectResponse: response)
            let task: URLSessionTask? = self.state.withLock {
                self.stopped = true
                defer { self.innerTask = nil }
                return self.innerTask
            }
            task?.cancel()
            self.client?.urlProtocol(self, didFailWithError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
            completion(nil)
        }
    }

    /// Server-trust and credential challenges go to the app's session delegate, so certificate
    /// pinning and client certificates keep working.
    func innerDidReceive(challenge: URLAuthenticationChallenge, completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        onClientThread {
            guard !self.isClientDone, let client = self.client else {
                completion(.cancelAuthenticationChallenge, nil)
                return
            }
            let sender = ChallengeSender(completion: completion)
            self.state.withLock { self.challengeSenders.append(sender) }
            client.urlProtocol(self, didReceive: URLAuthenticationChallenge(authenticationChallenge: challenge, sender: sender))
        }
    }

    // MARK: Reporting

    private func claimReport() -> Bool {
        state.withLock {
            if reported { return false }
            reported = true
            return true
        }
    }

    private func reportResponse() {
        guard claimReport() else { return }
        let (id, response, body, metrics, rule, config) = state.withLock {
            (requestId, self.response, responseBody, self.metrics, appliedRule, self.config)
        }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 200
        let headers = http.map { HTTPHeaders.sorted($0.allHeaderFields) } ?? []
        let wireBody = BodyCapture.wireBody(
            captured: body.data,
            totalSize: body.totalSize,
            contentType: HTTPHeaders.value("Content-Type", in: headers) ?? response?.mimeType,
            limit: config.captureBodies ? config.maxBodyBytes : 0
        )
        let timing = NetworkTimings.from(metrics)
        DurbunCore.shared.send(WireMessage.netResponse(
            id: id,
            ts: Clock.nowMs(),
            status: status,
            statusText: HTTPStatusText.text(for: status),
            headers: DurbunCore.shared.redacting(headers),
            body: wireBody,
            protocolName: timing.protocolName,
            remoteAddress: timing.remoteAddress,
            timings: timing.timings,
            mocked: rule != nil,
            mockRuleId: rule?.id
        ))
    }

    private func report(error: Error, cancelled: Bool) {
        guard claimReport() else { return }
        let message: JSONValue? = state.withLock {
            let message = WireMessage.netError(
                id: requestId,
                ts: Clock.nowMs(),
                error: cancelled ? "Cancelled" : NetworkErrorText.describe(error),
                cancelled: cancelled,
                mocked: appliedRule != nil,
                mockRuleId: appliedRule?.id
            )
            guard requestSent else {
                deferredFinal = message
                return nil
            }
            return message
        }
        if let message { DurbunCore.shared.send(message) }
    }

    // MARK: Client thread

    private var isClientDone: Bool { state.withLock { clientDone } }

    /// Marks the final client callback as delivered; false if it already was (or we were stopped).
    private func markClientDone() -> Bool {
        state.withLock {
            if clientDone { return false }
            clientDone = true
            return true
        }
    }

    private func onClientThread(_ block: @escaping () -> Void) {
        let (thread, modes) = state.withLock { (clientThread, runLoopModes) }
        guard let thread, thread !== Thread.current else {
            block()
            return
        }
        perform(#selector(durbunRunBlock(_:)), on: thread, with: BlockBox(block), waitUntilDone: false, modes: modes)
    }

    @objc private func durbunRunBlock(_ box: BlockBox) {
        box.block()
    }
}

private final class BlockBox: NSObject {
    let block: () -> Void

    init(_ block: @escaping () -> Void) {
        self.block = block
    }
}

/// Maps the app session's answer to a forwarded challenge back to the inner task.
private final class ChallengeSender: NSObject, URLAuthenticationChallengeSender {
    private let lock = UnfairLock()
    private var completion: ((URLSession.AuthChallengeDisposition, URLCredential?) -> Void)?

    init(completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        self.completion = completion
    }

    private func finish(_ disposition: URLSession.AuthChallengeDisposition, _ credential: URLCredential?) {
        let handler = lock.withLock { () -> ((URLSession.AuthChallengeDisposition, URLCredential?) -> Void)? in
            defer { completion = nil }
            return completion
        }
        handler?(disposition, credential)
    }

    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {
        finish(.useCredential, credential)
    }

    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {
        finish(.useCredential, nil)
    }

    func cancel(_ challenge: URLAuthenticationChallenge) {
        finish(.cancelAuthenticationChallenge, nil)
    }

    func performDefaultHandling(for challenge: URLAuthenticationChallenge) {
        finish(.performDefaultHandling, nil)
    }

    func rejectProtectionSpaceAndContinue(with challenge: URLAuthenticationChallenge) {
        finish(.rejectProtectionSpace, nil)
    }
}

/// Natural URL loading errors for `fail` mock actions.
enum MockFailure {
    static func error(kind: MockRule.FailKind, message: String?, url: URL?, ruleId: String) -> NSError {
        let code: Int
        let defaultMessage: String
        switch kind {
        case .timeout:
            code = NSURLErrorTimedOut
            defaultMessage = "The request timed out."
        case .connection:
            code = NSURLErrorCannotConnectToHost
            defaultMessage = "Could not connect to the server."
        case .dns:
            code = NSURLErrorCannotFindHost
            defaultMessage = "A server with the specified hostname could not be found."
        case .tls:
            code = NSURLErrorSecureConnectionFailed
            defaultMessage = "An SSL error has occurred and a secure connection to the server cannot be made."
        case .custom:
            code = NSURLErrorUnknown
            defaultMessage = "The request failed (simulated by a Dürbün mock)."
        }
        var userInfo: [String: Any] = [
            NSLocalizedDescriptionKey: (message?.isEmpty == false ? message : nil) ?? defaultMessage,
            "DurbunMockRuleId": ruleId,
        ]
        if let url {
            userInfo[NSURLErrorFailingURLErrorKey] = url
            userInfo[NSURLErrorFailingURLStringErrorKey] = url.absoluteString
        }
        return NSError(domain: NSURLErrorDomain, code: code, userInfo: userInfo)
    }
}
