import Foundation
import FirebaseAuth
import PyricAppCheck
import PyricFirestore

package struct FunctionsRequestContext: Sendable {
    package let authIDToken: String?
    package let appCheckToken: String?

    package var hasCredentials: Bool {
        authIDToken != nil || appCheckToken != nil
    }
}

/// Zero-socket in-memory channel probing `PyricBridgeClient.opWithAppCheck` so `PyricFunctions`
/// reads an initialized `AppCheck` token for `app` without lazily instantiating a default
/// `DeviceCheckProvider` when `AppCheck` has not been configured for `app`.
private final class InMemoryFunctionsAppCheckProbeChannel: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inboundQueue: [String] = []
    private var waiters: [CheckedContinuation<String, any Error>] = []
    private var closed = false
    private var capturedToken: String?

    func send(_ string: String) async throws {
        guard let data = string.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = frame["type"]?.stringValue else {
            return
        }
        if type == "attach" {
            enqueue("{\"type\":\"attach-ack\",\"protocol\":1,\"peerConnected\":true,\"clientSessionId\":\"fn-ac-probe\"}")
        } else if type == "worker-op" {
            let id = frame["id"]?.stringValue ?? "rop-1"
            let token = frame["op"]?["appCheckToken"]?.stringValue
            recordCapturedToken(token)
            enqueue("{\"type\":\"worker-res\",\"id\":\"\(id)\",\"ok\":true,\"value\":null}")
        } else if type == "ping", let id = frame["id"]?.stringValue {
            enqueue("{\"type\":\"pong\",\"id\":\"\(id)\"}")
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if closed {
                lock.unlock()
                continuation.resume(throwing: CancellationError())
                return
            }
            if !inboundQueue.isEmpty {
                let next = inboundQueue.removeFirst()
                lock.unlock()
                continuation.resume(returning: next)
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func close(closeCode: Int, reason: String?) async {
        _ = closeCode
        _ = reason
        let pending: [CheckedContinuation<String, any Error>] = {
            lock.lock()
            defer { lock.unlock() }
            closed = true
            let current = waiters
            waiters.removeAll()
            return current
        }()
        for waiter in pending {
            waiter.resume(throwing: CancellationError())
        }
    }

    func takeCapturedToken() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return capturedToken
    }

    private func recordCapturedToken(_ token: String?) {
        lock.lock()
        capturedToken = token
        lock.unlock()
    }

    private func enqueue(_ raw: String) {
        let waiter: CheckedContinuation<String, any Error>? = {
            lock.lock()
            defer { lock.unlock() }
            if !waiters.isEmpty {
                return waiters.removeFirst()
            }
            inboundQueue.append(raw)
            return nil
        }()
        waiter?.resume(returning: raw)
    }
}

/// Resolves active `FirebaseAuth` ID tokens (`Authorization: Bearer <jwt>`) and standard or
/// single-use `AppCheck` tokens (`X-Firebase-AppCheck: <jwt>`) for a `FirebaseApp`.
package enum FunctionsContextProvider {
    private static let placeholderAppCheckToken = "eyJlcnJvciI6IlVOS05PV05fRVJST1IifQ=="

    package static func resolveContext(
        app: FirebaseApp,
        requireLimitedUseAppCheckTokens: Bool
    ) async -> FunctionsRequestContext {
        let authToken = await resolveAuthIDToken(app: app)
        let appCheckToken = await resolveAppCheckToken(
            app: app,
            requireLimitedUse: requireLimitedUseAppCheckTokens
        )
        return FunctionsRequestContext(
            authIDToken: authToken,
            appCheckToken: appCheckToken
        )
    }

    private static func resolveAuthIDToken(app: FirebaseApp) async -> String? {
        guard let activeUser = Auth.auth(app: app).currentUser else {
            return nil
        }
        guard let token = try? await activeUser.getIDToken(forcingRefresh: false),
              !token.isEmpty else {
            return nil
        }
        return token
    }

    private static func resolveAppCheckToken(
        app: FirebaseApp,
        requireLimitedUse: Bool
    ) async -> String? {
        let probeChannel = InMemoryFunctionsAppCheckProbeChannel()
        let probeClient = PyricBridgeClient(channel: probeChannel)
        _ = try? await probeClient.opWithAppCheck(app: app, method: "functions.probe", params: [:])
        let standardToken = probeChannel.takeCapturedToken()
        await probeClient.disconnect()

        guard let standardToken else {
            return nil
        }
        if !requireLimitedUse {
            return standardToken
        }
        guard let appCheck = AppCheck.appCheck(app: app) else {
            return standardToken
        }
        do {
            return try await appCheck.limitedUseToken().token
        } catch {
            return placeholderAppCheckToken
        }
    }
}
