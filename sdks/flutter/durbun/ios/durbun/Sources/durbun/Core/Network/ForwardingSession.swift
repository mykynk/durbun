import Foundation

/// The internal URLSession that performs intercepted requests for real. One session for all
/// requests; delegate callbacks (serial queue) are routed to the owning protocol instance.
final class ForwardingSession: NSObject, URLSessionDataDelegate {
    static let shared = ForwardingSession()

    private let lock = UnfairLock()
    private var owners: [Int: DurbunURLProtocol] = [:]
    private var session: URLSession?

    private func currentSession() -> URLSession {
        lock.withLock {
            if let session { return session }
            let configuration = URLSessionConfiguration.default
            configuration.protocolClasses = (configuration.protocolClasses ?? []).filter {
                ObjectIdentifier($0) != ObjectIdentifier(DurbunURLProtocol.self)
            }
            // The app's own task keeps enforcing its real timeouts (verified: both the session's
            // timeoutIntervalForRequest and a request's timeoutInterval fire on the outer task), so
            // the inner task must never time out first.
            configuration.timeoutIntervalForRequest = 3600
            configuration.timeoutIntervalForResource = 7 * 24 * 3600
            let queue = OperationQueue()
            queue.name = "dev.durbun.forwarding"
            queue.maxConcurrentOperationCount = 1
            queue.qualityOfService = .utility
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
        completionHandler(proposedResponse)
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
