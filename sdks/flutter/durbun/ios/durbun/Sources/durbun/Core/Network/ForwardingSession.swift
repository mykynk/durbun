import Foundation

/// An internal URLSession that performs intercepted requests for real. There is one per originating
/// session configuration (see `SessionBinding`): the inner session runs with a copy of the app
/// session's configuration — its URL cache (or none), cookie storage, credential storage, proxy,
/// TLS limits, connectivity and cellular/expensive/constrained rules, connection limits — so a
/// request behaves as it would without Dürbün. `shared` serves `URLSession.shared` and other
/// requests that reach the globally registered `DurbunURLProtocol` (default configuration).
/// Delegate callbacks (serial queue) are routed to the owning protocol instance.
final class ForwardingSession: NSObject, URLSessionDataDelegate {
    static let shared = ForwardingSession(configuration: nil)

    /// The forwarding session for a protocol instance's class (`object_getClass`, so the
    /// per-configuration subclasses are told apart).
    static func serving(_ protocolClass: AnyClass?) -> ForwardingSession {
        protocolClass.flatMap(SessionBinding.forwarding(for:)) ?? shared
    }

    private let template: URLSessionConfiguration?
    private let lock = UnfairLock()
    private var owners: [Int: DurbunURLProtocol] = [:]
    private var session: URLSession?

    /// `configuration`: the app session's settings (already without Dürbün's protocol classes);
    /// nil = the default configuration.
    init(configuration: URLSessionConfiguration?) {
        template = configuration
        super.init()
    }

    private func currentSession() -> URLSession {
        lock.withLock {
            if let session { return session }
            let configuration = (template?.copy() as? URLSessionConfiguration) ?? URLSessionConfiguration.default
            configuration.protocolClasses = SessionBinding.withoutDurbun(configuration.protocolClasses)
            // The app's own task keeps enforcing its real timeouts (verified: both the session's
            // timeoutIntervalForRequest and a request's timeoutInterval fire on the outer task), so
            // the inner task must never time out first.
            configuration.timeoutIntervalForRequest = 3600
            configuration.timeoutIntervalForResource = 7 * 24 * 3600
            let queue = OperationQueue()
            queue.name = "dev.durbun.forwarding"
            queue.maxConcurrentOperationCount = 1
            // Callbacks feed the app's own task: never run them below the app's priority.
            queue.qualityOfService = .userInitiated
            let created = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
            session = created
            return created
        }
    }

    func makeTask(with request: URLRequest, owner: DurbunURLProtocol) -> URLSessionDataTask {
        let task = currentSession().dataTask(with: request)
        lock.withLock { owners[task.taskIdentifier] = owner }
        return task
    }

    /// Forgets a task that will never be resumed.
    func discard(_ task: URLSessionTask) {
        _ = lock.withLock { owners.removeValue(forKey: task.taskIdentifier) }
        task.cancel()
    }

    private func owner(of task: URLSessionTask) -> DurbunURLProtocol? {
        lock.withLock { owners[task.taskIdentifier] }
    }

    // MARK: URLSessionDataDelegate

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let owner = owner(of: task) else {
            completionHandler(request)
            return
        }
        owner.innerWillRedirect(response: response, newRequest: request, completion: completionHandler)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let owner = owner(of: task) else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        owner.innerDidReceive(challenge: challenge, completion: completionHandler)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        owner(of: dataTask)?.innerDidReceive(response: response)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        owner(of: dataTask)?.innerDidReceive(data: data)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        willCacheResponse proposedResponse: CachedURLResponse,
        completionHandler: @escaping (CachedURLResponse?) -> Void
    ) {
        // The app's own task stores it (DurbunURLProtocol hands it the storage policy), through the
        // app delegate's willCacheResponse; storing it here as well would bypass that delegate.
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        needNewBodyStream completionHandler: @escaping (InputStream?) -> Void
    ) {
        // Only streamed (huge) bodies get here; they cannot be rewound.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        owner(of: task)?.innerDidCollect(metrics)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let owner = lock.withLock { owners.removeValue(forKey: task.taskIdentifier) }
        owner?.innerDidComplete(error: error)
    }
}
