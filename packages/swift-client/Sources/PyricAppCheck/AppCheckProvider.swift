import Foundation
import PyricFirestore

/// Defines the methods implemented by a Firebase App Check attestation provider,
/// mirroring `FIRAppCheckProvider` (`AppCheckProvider`).
public protocol AppCheckProvider: AnyObject {
    /// Requests a new Firebase App Check token.
    func getToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void)

    /// Requests a new limited-use Firebase App Check token.
    /// Custom providers that do not override this method fall back to `getToken(completion:)`.
    func getLimitedUseToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void)
}

extension AppCheckProvider {
    public func getLimitedUseToken(
        completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void
    ) {
        getToken(completion: handler)
    }

    public func getToken() async throws -> AppCheckToken {
        try await withCheckedThrowingContinuation { continuation in
            let box = SingleCompletionGate(continuation)
            getToken { token, error in
                box.resolve(token: token, error: error)
            }
        }
    }

    public func getLimitedUseToken() async throws -> AppCheckToken {
        try await withCheckedThrowingContinuation { continuation in
            let box = SingleCompletionGate(continuation)
            getLimitedUseToken { token, error in
                box.resolve(token: token, error: error)
            }
        }
    }
}

/// Factory interface creating `AppCheckProvider` instances for a `FirebaseApp`,
/// mirroring `FIRAppCheckProviderFactory` (`AppCheckProviderFactory`).
public protocol AppCheckProviderFactory: AnyObject {
    func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)?
}

final class SingleCompletionGate: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private let continuation: CheckedContinuation<AppCheckToken, Error>

    init(_ continuation: CheckedContinuation<AppCheckToken, Error>) {
        self.continuation = continuation
    }

    func resolve(token: AppCheckToken?, error: Error?) {
        lock.lock()
        if completed {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()

        if let error {
            continuation.resume(throwing: AppCheckError.from(error))
            return
        }
        if let token {
            continuation.resume(returning: token)
            return
        }
        continuation.resume(
            throwing: AppCheckError(
                code: .unknown,
                message: "AppCheckProvider completed with neither token nor error."
            )
        )
    }
}
