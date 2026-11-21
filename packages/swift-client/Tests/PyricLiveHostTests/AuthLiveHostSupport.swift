import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

extension AuthLiveHostConformanceTests {

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

    func awaitCompletion(
        _ register: (@escaping @Sendable (AuthDataResult?, Error?) -> Void) -> Void
    ) async throws -> AuthDataResult {
        try await withCheckedThrowingContinuation { continuation in
            register { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(throwing: AuthError(code: .internalError, message: "Missing AuthDataResult"))
                }
            }
        }
    }

    func awaitTokenCompletion(
        _ register: (@escaping @Sendable (String?, Error?) -> Void) -> Void
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            register { token, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let token {
                    continuation.resume(returning: token)
                } else {
                    continuation.resume(throwing: AuthError(code: .internalError, message: "Missing token string"))
                }
            }
        }
    }

    func awaitTokenResultCompletion(
        _ register: (@escaping @Sendable (AuthTokenResult?, Error?) -> Void) -> Void
    ) async throws -> AuthTokenResult {
        try await withCheckedThrowingContinuation { continuation in
            register { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(throwing: AuthError(code: .internalError, message: "Missing AuthTokenResult"))
                }
            }
        }
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

    func expectAuthError(_ operation: () async throws -> Void) async -> AuthError? {
        do {
            try await operation()
            Issue.record("Expected AuthError, but operation succeeded")
            return nil
        } catch let authErr as AuthError {
            return authErr
        } catch {
            Issue.record("Expected AuthError, got: \(error)")
            return nil
        }
    }

    func expectSignedOutSnapshot(_ snapshot: User??) {
        #expect(snapshot != nil && snapshot! == nil)
    }

    func expectBridgeDenied(_ operation: () async throws -> Void) async {
        do {
            try await operation()
            Issue.record("Expected permission-denied error, but operation succeeded")
        } catch let bridgeError as PyricBridgeError {
            let isDenied = bridgeError.code == .permissionDenied
                || bridgeError.rawCode == "PERMISSION_DENIED"
                || bridgeError.rawCode == "permission-denied"
            #expect(isDenied, "Unexpected bridge error code: \(bridgeError.rawCode)")
        } catch {
            Issue.record("Expected PyricBridgeError permission-denied, got: \(error)")
        }
    }
}

final class LockedRecorder<Element: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []

    var values: [Element] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    func append(_ element: Element) {
        lock.lock()
        items.append(element)
        lock.unlock()
    }
}
