import Dispatch
import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

extension FirestoreCrudLiveHostConformanceTests {
    func withLiveCrudSession(
        prefix: String,
        body: (Firestore, String) async throws -> Void
    ) async throws {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)

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
        let db = Firestore.firestore(app: app)
        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()

        do {
            let session = try await auth.createUser(withEmail: "crud-\(tag)@example.test", password: "CorrectHorse!99")
            try await body(db, session.user.uid)
            await app.disconnectSharedBridge()
        } catch {
            await app.disconnectSharedBridge()
            throw error
        }
    }

    func makePeerApp(prefix: String, email: String, password: String) async throws -> (FirebaseApp, Firestore) {
        let rawBridgeURL = try #require(ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"])
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)
        let peerApp = FirebaseApp(
            name: "swift-\(prefix)-\(UUID().uuidString)",
            options: FirebaseOptions(
                projectID: "demo-swift-live",
                databaseURL: "https://demo-swift-live-default-rtdb.firebaseio.com",
                apiKey: "swift-live-key",
                googleAppID: "1:500:ios:live"
            )
        )
        peerApp.useEmulator(withHost: host, port: port)
        _ = try await Auth.auth(app: peerApp).signIn(withEmail: email, password: password)
        return (peerApp, Firestore.firestore(app: peerApp))
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

    func awaitSnapshotCompletion(
        _ register: (@escaping @Sendable (DocumentSnapshot?, Error?) -> Void) -> Void
    ) async throws -> DocumentSnapshot {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<DocumentSnapshot, Error>) in
            register { snap, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let snap {
                    continuation.resume(returning: snap)
                } else {
                    continuation.resume(throwing: PyricFirestoreError.internalError("Missing snapshot and error"))
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
}

internal struct RecordedDocEvent: Sendable {
    let exists: Bool
    let step: String?
    let hasPendingWrites: Bool
    let isFromCache: Bool
}

internal final class DocEventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [RecordedDocEvent] = []
    private var capturedError: Error?

    var snapshotCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return events.count
    }

    func record(snap: DocumentSnapshot?, err: Error?) {
        lock.lock()
        if let err {
            capturedError = err
        } else if let snap {
            let stepVal = (snap.data()?["step"] as? String) ?? (snap.data()?["phase"] as? String)
            events.append(
                RecordedDocEvent(
                    exists: snap.exists,
                    step: stepVal,
                    hasPendingWrites: snap.metadata.hasPendingWrites,
                    isFromCache: snap.metadata.isFromCache
                )
            )
        }
        lock.unlock()
    }

    func waitForCount(_ target: Int, timeoutNanoseconds: UInt64 = 5_000_000_000) async throws -> [RecordedDocEvent] {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        while DispatchTime.now().uptimeNanoseconds < deadline {
            let state: ([RecordedDocEvent], Error?) = {
                lock.lock()
                defer { lock.unlock() }
                return (events, capturedError)
            }()
            if let err = state.1 {
                throw err
            }
            if state.0.count >= target {
                return state.0
            }
            try await Task.sleep(nanoseconds: 15_000_000)
        }
        throw PyricFirestoreError.internalError("Timed out waiting for \(target) document snapshot events")
    }

    func waitForWhere(
        timeoutNanoseconds: UInt64 = 5_000_000_000,
        predicate: (RecordedDocEvent) -> Bool
    ) async throws -> RecordedDocEvent {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        while DispatchTime.now().uptimeNanoseconds < deadline {
            let state: ([RecordedDocEvent], Error?) = {
                lock.lock()
                defer { lock.unlock() }
                return (events, capturedError)
            }()
            if let err = state.1 {
                throw err
            }
            if let match = state.0.last(where: predicate) {
                return match
            }
            try await Task.sleep(nanoseconds: 15_000_000)
        }
        throw PyricFirestoreError.internalError("Timed out waiting for matching document snapshot event")
    }

    func waitForError(timeoutNanoseconds: UInt64 = 5_000_000_000) async throws -> Error {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        while DispatchTime.now().uptimeNanoseconds < deadline {
            let err: Error? = {
                lock.lock()
                defer { lock.unlock() }
                return capturedError
            }()
            if let err {
                return err
            }
            try await Task.sleep(nanoseconds: 15_000_000)
        }
        throw PyricFirestoreError.internalError("Timed out waiting for listener error")
    }
}
