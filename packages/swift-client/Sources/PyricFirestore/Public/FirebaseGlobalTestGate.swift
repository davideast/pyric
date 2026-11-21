import Foundation

/// Process-wide FIFO async gate for tests across SwiftPM test targets that read or
/// reset global Firebase singletons (`[DEFAULT]` `FirebaseApp`, `Auth.reset()`,
/// `Database.reset()`, `Firestore.shared` / `Firestore.reset()`, and `AppCheck`).
package final class FirebaseGlobalTestGate: Sendable {
    package static let shared = FirebaseGlobalTestGate()

    private final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var isLocked = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func acquire() async {
            await withCheckedContinuation { continuation in
                lock.lock()
                if !isLocked {
                    isLocked = true
                    lock.unlock()
                    continuation.resume()
                    return
                }
                waiters.append(continuation)
                lock.unlock()
            }
        }

        func release() {
            lock.lock()
            if waiters.isEmpty {
                isLocked = false
                lock.unlock()
                return
            }
            let next = waiters.removeFirst()
            lock.unlock()
            next.resume()
        }
    }

    private let state = State()

    private init() {}

    package func withExclusiveAccess<T>(
        isolation: isolated (any Actor)? = #isolation,
        _ operation: () async throws -> T
    ) async rethrows -> T {
        _ = isolation
        await state.acquire()
        defer { state.release() }
        return try await operation()
    }
}
