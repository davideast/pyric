import Dispatch
import Foundation
import Testing
@testable import PyricFirestore

extension FirestoreInstanceLiveHostConformanceTests {
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

    func makeNamedQueryBundle(uid: String) -> Data {
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
                            ],
                            "limit": 2
                        ],
                        "limitType": "FIRST"
                    ]
                ]
            ],
            [
                "namedQuery": [
                    "name": "owner-entries-group",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "bundledQuery": [
                        "parent": root,
                        "structuredQuery": [
                            "from": [["collectionId": "entries", "allDescendants": true]],
                            "where": [
                                "fieldFilter": [
                                    "field": ["fieldPath": "ownerUid"],
                                    "op": "EQUAL",
                                    "value": ["stringValue": uid]
                                ]
                            ],
                            "orderBy": [
                                ["field": ["fieldPath": "seq"], "direction": "ASCENDING"]
                            ]
                        ],
                        "limitType": "FIRST"
                    ]
                ]
            ],
            [
                "documentMetadata": [
                    "name": "\(root)/users/\(uid)/items/nq-alpha",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": true,
                    "queries": ["active-items"]
                ]
            ],
            [
                "document": [
                    "name": "\(root)/users/\(uid)/items/nq-alpha",
                    "fields": [
                        "title": ["stringValue": "Alpha"],
                        "active": ["booleanValue": true],
                        "rank": ["integerValue": "1"]
                    ]
                ]
            ],
            [
                "documentMetadata": [
                    "name": "\(root)/users/\(uid)/items/nq-beta",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": true,
                    "queries": []
                ]
            ],
            [
                "document": [
                    "name": "\(root)/users/\(uid)/items/nq-beta",
                    "fields": [
                        "title": ["stringValue": "Beta"],
                        "active": ["booleanValue": false],
                        "rank": ["integerValue": "2"]
                    ]
                ]
            ],
            [
                "documentMetadata": [
                    "name": "\(root)/users/\(uid)/items/nq-gamma",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": true,
                    "queries": ["active-items"]
                ]
            ],
            [
                "document": [
                    "name": "\(root)/users/\(uid)/items/nq-gamma",
                    "fields": [
                        "title": ["stringValue": "Gamma"],
                        "active": ["booleanValue": true],
                        "rank": ["integerValue": "3"]
                    ]
                ]
            ],
            [
                "documentMetadata": [
                    "name": "\(root)/users/\(uid)/rooms/r1/entries/ge-1",
                    "readTime": "2026-01-15T12:00:00.000000000Z",
                    "exists": true,
                    "queries": ["owner-entries-group"]
                ]
            ],
            [
                "document": [
                    "name": "\(root)/users/\(uid)/rooms/r1/entries/ge-1",
                    "fields": [
                        "ownerUid": ["stringValue": uid],
                        "seq": ["integerValue": "10"]
                    ]
                ]
            ]
        ]
        let bodyData = encodeBundleElements(bodyElements)
        let headerData = encodeBundleElements([
            [
                "metadata": [
                    "id": "named-query-bundle-v1",
                    "createTime": "2026-01-15T12:00:00.000000000Z",
                    "version": 1,
                    "totalDocuments": 4,
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

internal final class IntBox: @unchecked Sendable {
    private let lock = NSLock()
    private var raw = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return raw
    }

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        raw += 1
        return raw
    }
}
