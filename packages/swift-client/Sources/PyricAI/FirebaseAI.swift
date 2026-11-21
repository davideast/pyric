import Foundation
import PyricFirestore

/// Entry point for the Firebase AI Logic Swift SDK (`PyricAI`),
/// mirroring `FirebaseAILogic.FirebaseAI` (`13.2.0`).
public final class FirebaseAI: Sendable {
    private struct InstanceKey: Hashable, Sendable {
        let appName: String
        let backend: Backend
        let useLimitedUseAppCheckTokens: Bool
    }

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [InstanceKey: FirebaseAI] = [:]

    /// Associated `FirebaseApp` instance.
    public let app: FirebaseApp

    /// Configured backend (`Backend.googleAI()` or `Backend.vertexAI(location:)`).
    public let backend: Backend

    /// Whether each AI request mints a single-use limited-use App Check token.
    public let useLimitedUseAppCheckTokens: Bool

    package let engineConfig: PyricAIEngineConfig?
    package let enforceAppCheck: Bool
    package let explicitBridgeClient: PyricBridgeClient?
    package let session: AiBridgeSession

    package init(
        app: FirebaseApp,
        backend: Backend,
        useLimitedUseAppCheckTokens: Bool,
        engineConfig: PyricAIEngineConfig? = nil,
        enforceAppCheck: Bool = false,
        explicitBridgeClient: PyricBridgeClient? = nil,
        transport: (any WebSocketTransport)? = nil
    ) {
        self.app = app
        self.backend = backend
        self.useLimitedUseAppCheckTokens = useLimitedUseAppCheckTokens
        self.engineConfig = engineConfig
        self.enforceAppCheck = enforceAppCheck
        self.explicitBridgeClient = explicitBridgeClient
        self.session = AiBridgeSession(fixedTransport: transport)
    }

    // MARK: - Public Factory APIs

    /// Returns the `FirebaseAI` instance for `app`, `backend`, and `useLimitedUseAppCheckTokens`.
    public static func firebaseAI(
        app: FirebaseApp? = nil,
        backend: Backend = .googleAI(),
        useLimitedUseAppCheckTokens: Bool = false
    ) -> FirebaseAI {
        let resolvedApp = app ?? FirebaseApp.app()
        let key = InstanceKey(
            appName: resolvedApp.name,
            backend: backend,
            useLimitedUseAppCheckTokens: useLimitedUseAppCheckTokens
        )

        var evicted: FirebaseAI?
        let instance: FirebaseAI = {
            registryLock.lock()
            defer { registryLock.unlock() }
            if let existing = instances[key] {
                if existing.app === resolvedApp {
                    return existing
                }
                evicted = existing
            }
            let created = FirebaseAI(
                app: resolvedApp,
                backend: backend,
                useLimitedUseAppCheckTokens: useLimitedUseAppCheckTokens
            )
            instances[key] = created
            return created
        }()
        if let evicted {
            Task { await evicted.session.disconnect() }
        }
        return instance
    }

    /// Creates an isolated `FirebaseAI` instance with optional Pyric engine configuration,
    /// App Check enforcement, or custom `WebSocketTransport` for unit and conformance tests.
    public static func firebaseAI(
        app: FirebaseApp? = nil,
        backend: Backend = .googleAI(),
        useLimitedUseAppCheckTokens: Bool = false,
        engine: PyricAIEngineConfig? = nil,
        enforceAppCheck: Bool = false,
        bridgeClient: PyricBridgeClient? = nil,
        transport: (any WebSocketTransport)? = nil
    ) -> FirebaseAI {
        let resolvedApp = app ?? FirebaseApp.app()
        return FirebaseAI(
            app: resolvedApp,
            backend: backend,
            useLimitedUseAppCheckTokens: useLimitedUseAppCheckTokens,
            engineConfig: engine,
            enforceAppCheck: enforceAppCheck,
            explicitBridgeClient: bridgeClient,
            transport: transport
        )
    }

    /// Evicts all cached `FirebaseAI` instances and disconnects their active bridge sessions.
    public static func reset() {
        let current: [FirebaseAI] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            let snapshot = Array(instances.values)
            instances.removeAll()
            return snapshot
        }()
        for item in current {
            Task { await item.session.disconnect() }
        }
    }

    /// Disconnects this `FirebaseAI` instance's underlying WebSocket session.
    public func disconnect() async {
        await session.disconnect()
    }

    // MARK: - Model Construction

    /// Initializes a `GenerativeModel` with the specified configuration, safety settings, tools, and system instruction.
    public func generativeModel(
        modelName: String,
        generationConfig: GenerationConfig? = nil,
        safetySettings: [SafetySetting]? = nil,
        tools: [Tool]? = nil,
        toolConfig: ToolConfig? = nil,
        systemInstruction: ModelContent? = nil,
        requestOptions: RequestOptions = RequestOptions()
    ) -> GenerativeModel {
        let modelResourceName = backend.normalizedModelResourceName(for: modelName)
        return GenerativeModel(
            modelName: modelName,
            modelResourceName: modelResourceName,
            firebaseAI: self,
            generationConfig: generationConfig,
            safetySettings: safetySettings,
            tools: tools,
            toolConfig: toolConfig,
            systemInstruction: systemInstruction,
            requestOptions: requestOptions
        )
    }

    package func activeBridgeClient() -> PyricBridgeClient {
        explicitBridgeClient ?? app.sharedBridgeClient()
    }
}
