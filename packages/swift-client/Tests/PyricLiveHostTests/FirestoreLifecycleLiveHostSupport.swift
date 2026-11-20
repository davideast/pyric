import Foundation
import Testing
@testable import PyricFirestore

extension FirestoreLifecycleLiveHostConformanceTests {
    func liveHostEndpoint() throws -> (host: String, port: Int)? {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return nil
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)
        return (host, port)
    }

    func makeLiveApp(prefix: String, host: String, port: Int) -> FirebaseApp {
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

    func awaitVoidCompletion(
        _ register: (@escaping @Sendable (Error?) -> Void) -> Void
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            register { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    func expectBridgeCode(
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

    func encodeBundleElements(_ elements: [[String: Any]]) -> Data {
        var out = Data()
        for el in elements {
            let jsonBytes = (try? JSONSerialization.data(withJSONObject: el, options: [.sortedKeys])) ?? Data()
            let prefix = Data("\(jsonBytes.count)".utf8)
            out.append(prefix)
            out.append(jsonBytes)
        }
        return out
    }

    func makeSampleBundle(uid: String) -> Data {
        let root = "projects/demo-swift-live/databases/(default)/documents"
        let bodyElements: [[String: Any]] = [
            [
                "namedQuery": [
                    "name": "active-items",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "bundledQuery": [
                        "parent": "\(root)/users/\(uid)",
                        "structuredQuery": [
                            "from": [["collectionId": "items"]],
                            "where": [
                                "fieldFilter": [
                                    "field": ["fieldPath": "active"],
                                    "op": "EQUAL",
                                    "value": ["booleanValue": true]
                                ]
                            ],
                            "orderBy": [
                                ["field": ["fieldPath": "rank"], "direction": "ASCENDING"]
                            ]
                        ],
                        "limitType": "FIRST"
                    ]
                ]
            ],
            [
                "documentMetadata": [
                    "name": "\(root)/users/\(uid)/items/bundle-alpha",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": true,
                    "queries": ["active-items"]
                ]
            ],
            [
                "document": [
                    "name": "\(root)/users/\(uid)/items/bundle-alpha",
                    "fields": [
                        "title": ["stringValue": "Bundled Alpha"],
                        "active": ["booleanValue": true],
                        "rank": ["integerValue": "1"],
                        "score": ["doubleValue": 9.5],
                        "publishedAt": ["timestampValue": "2026-01-15T12:00:00.125000000Z"],
                        "coords": ["geoPointValue": ["latitude": 37.7749, "longitude": -122.4194]],
                        "payload": ["bytesValue": Data([0x41, 0x42, 0x43]).base64EncodedString()],
                        "tags": ["arrayValue": ["values": [["stringValue": "swift"], ["stringValue": "bundle"]]]],
                        "meta": ["mapValue": ["fields": ["source": ["stringValue": "cdn"]]]]
                    ]
                ]
            ],
            [
                "documentMetadata": [
                    "name": "\(root)/users/\(uid)/items/bundle-beta",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": true,
                    "queries": []
                ]
            ],
            [
                "document": [
                    "name": "\(root)/users/\(uid)/items/bundle-beta",
                    "fields": [
                        "title": ["stringValue": "Bundled Beta"],
                        "active": ["booleanValue": false],
                        "rank": ["integerValue": "2"]
                    ]
                ]
            ],
            [
                "documentMetadata": [
                    "name": "\(root)/users/\(uid)/items/bundle-ghost",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": false,
                    "queries": []
                ]
            ]
        ]
        let bodyData = encodeBundleElements(bodyElements)
        let headerData = encodeBundleElements([
            [
                "metadata": [
                    "id": "items-bundle-v1",
                    "createTime": "2026-01-15T12:00:00.000000000Z",
                    "version": 1,
                    "totalDocuments": 3,
                    "totalBytes": bodyData.count
                ]
            ]
        ])
        var full = Data()
        full.append(headerData)
        full.append(bodyData)
        return full
    }

    func makeSingleDocBundle(docPath: String, title: String) -> Data {
        let fullName = "projects/demo-swift-live/databases/(default)/documents/\(docPath)"
        let bodyData = encodeBundleElements([
            [
                "documentMetadata": [
                    "name": fullName,
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": true
                ]
            ],
            [
                "document": [
                    "name": fullName,
                    "fields": [
                        "title": ["stringValue": title]
                    ]
                ]
            ]
        ])
        let headerData = encodeBundleElements([
            [
                "metadata": [
                    "id": "single-doc-bundle",
                    "version": 1,
                    "totalDocuments": 1,
                    "totalBytes": bodyData.count
                ]
            ]
        ])
        var full = Data()
        full.append(headerData)
        full.append(bodyData)
        return full
    }
}

internal final class FlagBox: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }

    func set() {
        lock.lock()
        flag = true
        lock.unlock()
    }
}

internal final class SyncEventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    private var waiters: [(target: Int, cont: CheckedContinuation<Void, Never>)] = []

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    func append(_ event: String) {
        lock.lock()
        entries.append(event)
        let currentCount = entries.count
        var ready: [CheckedContinuation<Void, Never>] = []
        waiters.removeAll { item in
            if currentCount >= item.target {
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

    func waitForCount(_ target: Int) async throws {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if entries.count >= target {
                lock.unlock()
                cont.resume()
                return
            }
            waiters.append((target: target, cont: cont))
            lock.unlock()
        }
    }
}

internal final class SyncProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [LoadBundleTaskProgress] = []
    private var terminalWaiters: [CheckedContinuation<Void, Never>] = []

    var values: [LoadBundleTaskProgress] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    func append(_ progress: LoadBundleTaskProgress) {
        lock.lock()
        items.append(progress)
        let isDone = (progress.state == .success || progress.state == .error)
        let waiters: [CheckedContinuation<Void, Never>]
        if isDone {
            waiters = terminalWaiters
            terminalWaiters.removeAll()
        } else {
            waiters = []
        }
        lock.unlock()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func waitForTerminalState() async throws {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if let last = items.last, last.state == .success || last.state == .error {
                lock.unlock()
                cont.resume()
                return
            }
            terminalWaiters.append(cont)
            lock.unlock()
        }
    }
}
