import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class UnaryRaceState: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<FunctionsHTTPResponse, any Error>?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var timerTask: Task<Void, Never>?
    private var settled = false
    private var callerCancelled = false
    private var timedOut = false

    var didTimeOut: Bool {
        lock.lock()
        defer { lock.unlock() }
        return timedOut
    }

    func install(
        continuation: CheckedContinuation<FunctionsHTTPResponse, any Error>,
        task: URLSessionDataTask,
        session: URLSession,
        timerTask: Task<Void, Never>
    ) {
        let shouldCancelImmediately: Bool = {
            lock.lock()
            defer { lock.unlock() }
            self.continuation = continuation
            self.task = task
            self.session = session
            self.timerTask = timerTask
            return callerCancelled || settled
        }()
        if shouldCancelImmediately {
            timerTask.cancel()
            task.cancel()
            session.invalidateAndCancel()
        } else {
            task.resume()
        }
    }

    func markTimedOutAndCancel(url: URL) {
        let pending: (CheckedContinuation<FunctionsHTTPResponse, any Error>?, URLSessionDataTask?, URLSession?) = {
            lock.lock()
            defer { lock.unlock() }
            if settled {
                return (nil, nil, nil)
            }
            settled = true
            timedOut = true
            let cont = continuation
            let currentTask = task
            let currentSession = session
            continuation = nil
            task = nil
            session = nil
            timerTask = nil
            return (cont, currentTask, currentSession)
        }()
        pending.1?.cancel()
        pending.2?.invalidateAndCancel()
        pending.0?.resume(throwing: FunctionsError(.deadlineExceeded, url: url))
    }

    func cancelFromCaller() {
        let pending: (CheckedContinuation<FunctionsHTTPResponse, any Error>?, URLSessionDataTask?, URLSession?, Task<Void, Never>?) = {
            lock.lock()
            defer { lock.unlock() }
            callerCancelled = true
            if settled {
                return (nil, nil, nil, nil)
            }
            guard let cont = continuation else {
                return (nil, task, session, timerTask)
            }
            settled = true
            let currentTask = task
            let currentSession = session
            let currentTimer = timerTask
            continuation = nil
            task = nil
            session = nil
            timerTask = nil
            return (cont, currentTask, currentSession, currentTimer)
        }()
        pending.3?.cancel()
        pending.1?.cancel()
        pending.2?.invalidateAndCancel()
        pending.0?.resume(throwing: FunctionsError(.cancelled))
    }

    func finish(with result: Result<FunctionsHTTPResponse, FunctionsError>) {
        let pending: (CheckedContinuation<FunctionsHTTPResponse, any Error>?, Task<Void, Never>?) = {
            lock.lock()
            defer { lock.unlock() }
            if settled {
                return (nil, nil)
            }
            settled = true
            let cont = continuation
            let currentTimer = timerTask
            continuation = nil
            task = nil
            session = nil
            timerTask = nil
            return (cont, currentTimer)
        }()
        pending.1?.cancel()
        switch result {
        case .success(let response):
            pending.0?.resume(returning: response)
        case .failure(let error):
            pending.0?.resume(throwing: error)
        }
    }
}

#if canImport(FoundationNetworking)
final class LinuxSSEDataDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncThrowingStream<String, Error>.Continuation
    private let region: String
    private let reportedURL: URL
    private let serializer: FunctionsSerializer

    private weak var session: URLSession?
    private var task: URLSessionDataTask?
    private var statusCode: Int = 200
    private var errorBuffer = Data()
    private var accumulator = SSELineAccumulator()
    private var consumerCancelled = false
    private var finished = false

    init(
        continuation: AsyncThrowingStream<String, Error>.Continuation,
        region: String,
        reportedURL: URL,
        serializer: FunctionsSerializer
    ) {
        self.continuation = continuation
        self.region = region
        self.reportedURL = reportedURL
        self.serializer = serializer
        super.init()
    }

    func attach(session: URLSession, task: URLSessionDataTask) {
        let shouldCancel: Bool = {
            lock.lock()
            defer { lock.unlock() }
            self.session = session
            self.task = task
            return consumerCancelled
        }()
        if shouldCancel {
            task.cancel()
            session.invalidateAndCancel()
        }
    }

    func cancelFromConsumer() {
        let current: (URLSessionDataTask?, URLSession?) = {
            lock.lock()
            defer { lock.unlock() }
            consumerCancelled = true
            return (task, session)
        }()
        current.0?.cancel()
        current.1?.invalidateAndCancel()
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        _ = session
        _ = dataTask
        if let http = response as? HTTPURLResponse {
            lock.lock()
            statusCode = http.statusCode
            lock.unlock()
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        _ = session
        _ = dataTask
        let linesToYield: [String] = {
            lock.lock()
            defer { lock.unlock() }
            if finished || consumerCancelled {
                return []
            }
            if !(200...299).contains(statusCode) {
                errorBuffer.append(data)
                return []
            }
            return accumulator.append(data)
        }()
        for line in linesToYield {
            continuation.yield(line)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        _ = task
        session.finishTasksAndInvalidate()

        enum CompletionOutcome {
            case alreadyDone
            case success([String])
            case failure(FunctionsError)
        }

        let outcome: CompletionOutcome = {
            lock.lock()
            defer { lock.unlock() }
            if finished {
                return .alreadyDone
            }
            finished = true
            self.task = nil
            self.session = nil

            if consumerCancelled {
                return .failure(FunctionsError(.cancelled, region: region, url: reportedURL))
            }
            if let error {
                let mapped = URLSessionFunctionsHTTPTransport.mapTransportError(
                    error,
                    timedOutByTimer: false,
                    region: region,
                    url: reportedURL
                )
                return .failure(mapped)
            }
            if !(200...299).contains(statusCode) {
                let mapped = FunctionsError.fromResponse(
                    httpStatusCode: statusCode,
                    region: region,
                    url: reportedURL,
                    body: errorBuffer,
                    serializer: serializer
                ) ?? FunctionsError(
                    FunctionsErrorCode(httpStatusCode: statusCode),
                    region: region,
                    url: reportedURL
                )
                return .failure(mapped)
            }
            return .success(accumulator.flush())
        }()

        switch outcome {
        case .alreadyDone:
            return
        case .success(let trailing):
            for line in trailing {
                continuation.yield(line)
            }
            continuation.finish()
        case .failure(let fnError):
            continuation.finish(throwing: fnError)
        }
    }
}
#endif
