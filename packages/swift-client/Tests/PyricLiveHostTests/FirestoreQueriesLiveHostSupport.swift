import Foundation
import Testing
@testable import PyricFirestore

extension FirestoreQueriesLiveHostConformanceTests {
    func liveQueriesEndpoint() throws -> (host: String, port: Int)? {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return nil
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)
        return (host, port)
    }

    func makeQueriesLiveApp(prefix: String, host: String, port: Int) -> FirebaseApp {
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

    func awaitQueryCompletion(
        _ register: (@escaping @Sendable (QuerySnapshot?, Error?) -> Void) -> Void
    ) async throws -> QuerySnapshot {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<QuerySnapshot, Error>) in
            register { snapshot, error in
                if let error {
                    cont.resume(throwing: error)
                } else if let snapshot {
                    cont.resume(returning: snapshot)
                } else {
                    cont.resume(throwing: PyricFirestoreError.invalidArgument("Missing QuerySnapshot and Error."))
                }
            }
        }
    }

    func expectQueryBridgeCode(
        _ expected: FirestoreErrorCode,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            Issue.record("Expected PyricBridgeError(\(expected.rawValue)), but operation succeeded")
        } catch let err as PyricBridgeError {
            #expect(err.code == expected, "Expected \(expected.rawValue), got \(err.rawCode): \(err.message)")
        } catch {
            Issue.record("Expected PyricBridgeError(\(expected.rawValue)), got: \(error)")
        }
    }
}

internal final class QuerySnapshotCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [QuerySnapshot] = []
    private var errors: [Error] = []
    private var waiters: [(target: Int, cont: CheckedContinuation<Void, Never>)] = []
    private var errorWaiters: [CheckedContinuation<Error, Never>] = []

    var snapshots: [QuerySnapshot] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    func record(snapshot: QuerySnapshot?, error: Error?) {
        lock.lock()
        if let error {
            errors.append(error)
            let pending = errorWaiters
            errorWaiters.removeAll()
            lock.unlock()
            for cont in pending {
                cont.resume(returning: error)
            }
            return
        }
        guard let snapshot else {
            lock.unlock()
            return
        }
        items.append(snapshot)
        let count = items.count
        var ready: [CheckedContinuation<Void, Never>] = []
        waiters.removeAll { waiter in
            if count >= waiter.target {
                ready.append(waiter.cont)
                return true
            }
            return false
        }
        lock.unlock()
        for cont in ready {
            cont.resume()
        }
    }

    func waitForSnapshotCount(_ target: Int) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if items.count >= target {
                lock.unlock()
                cont.resume()
                return
            }
            waiters.append((target: target, cont: cont))
            lock.unlock()
        }
    }

    func waitForFirstError() async -> Error {
        await withCheckedContinuation { (cont: CheckedContinuation<Error, Never>) in
            lock.lock()
            if let existing = errors.first {
                lock.unlock()
                cont.resume(returning: existing)
                return
            }
            errorWaiters.append(cont)
            lock.unlock()
        }
    }
}
