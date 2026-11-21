import Foundation
import Testing
@testable import PyricFirestore

extension FirestoreTransactionsLiveHostConformanceTests {
    func liveTransactionsEndpoint() throws -> (host: String, port: Int)? {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return nil
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)
        return (host, port)
    }

    func makeTransactionsLiveApp(prefix: String, host: String, port: Int) -> FirebaseApp {
        let app = FirebaseApp(
            name: "swift-\(prefix)-\(UUID().uuidString)",
            options: FirebaseOptions(
                projectID: "demo-swift-live",
                databaseURL: "https://demo-swift-live-default-rtdb.firebaseio.com",
                apiKey: "swift-live-key",
                googleAppID: "1:500:ios:live"
            )
        )
        app.useEmulator(withHost: host, port: port)
        return app
    }

    func expectTxnBridgeCode(
        _ expected: FirestoreErrorCode,
        operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            Issue.record("Expected PyricBridgeError(\(expected)), but operation succeeded")
        } catch let error as PyricBridgeError {
            #expect(error.code == expected)
        } catch {
            Issue.record("Expected PyricBridgeError(\(expected)), got \(error)")
        }
    }

    func awaitTxnVoidCompletion(
        _ invoke: (@escaping @Sendable (Error?) -> Void) -> Void
    ) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            invoke { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume()
                }
            }
        }
    }
}

internal struct TxnItemRecord: Codable, Equatable, Sendable {
    var title: String
    var qty: Int
}

internal final class TxnAttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }
}

internal final class StreamStepSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var reachedSteps: Set<Int> = []
    private var waiters: [(step: Int, cont: CheckedContinuation<Void, Never>)] = []

    func mark(_ step: Int) {
        lock.lock()
        reachedSteps.insert(step)
        var ready: [CheckedContinuation<Void, Never>] = []
        waiters.removeAll { item in
            if reachedSteps.contains(item.step) {
                ready.append(item.cont)
                return true
            }
            return false
        }
        lock.unlock()
        for cont in ready {
            cont.resume()
        }
    }

    func wait(for step: Int) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if reachedSteps.contains(step) {
                lock.unlock()
                cont.resume()
                return
            }
            waiters.append((step: step, cont: cont))
            lock.unlock()
        }
    }
}
