import Foundation
import Testing
@testable import PyricFirestore

extension FirestoreSnapshotsLiveHostConformanceTests {
    func liveSnapshotsEndpoint() throws -> (host: String, port: Int)? {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return nil
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)
        return (host, port)
    }

    func makeSnapshotsLiveApp(prefix: String, host: String, port: Int) -> FirebaseApp {
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
}

internal final class SnapshotsQueryCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [QuerySnapshot] = []
    private var waiters: [(predicate: @Sendable ([QuerySnapshot]) -> Bool, cont: CheckedContinuation<Void, Never>)] = []

    var snapshots: [QuerySnapshot] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    func append(_ snapshot: QuerySnapshot?) {
        guard let snapshot else { return }
        lock.lock()
        items.append(snapshot)
        let current = items
        var ready: [CheckedContinuation<Void, Never>] = []
        waiters.removeAll { waiter in
            if waiter.predicate(current) {
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

    func waitForCount(_ target: Int) async {
        await waitUntil { $0.count >= target }
    }

    func waitUntil(_ predicate: @escaping @Sendable ([QuerySnapshot]) -> Bool) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if predicate(items) {
                lock.unlock()
                cont.resume()
                return
            }
            waiters.append((predicate: predicate, cont: cont))
            lock.unlock()
        }
    }
}
