import Foundation
import FirebaseAuth
import PyricAppCheck
import PyricFirestore

/// Entry point for Cloud Functions for Firebase (`PyricFunctions`),
/// matching `FirebaseFunctions.Functions` (`13.2.0`).
open class Functions: NSObject, @unchecked Sendable {
    private static let appCheckHeader = "X-Firebase-AppCheck"

    private struct InstanceKey: Hashable, Sendable {
        let appName: String
        let region: String
        let customDomain: String?
    }

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [InstanceKey: Functions] = [:]

    /// Associated `FirebaseApp` instance.
    public let app: FirebaseApp

    /// Configured Cloud Functions region (defaults to `"us-central1"`).
    public let region: String

    /// Optional custom domain URL configured for HTTP callable triggers.
    public let customDomain: String?

    private let stateLock = NSLock()
    private var _emulatorOrigin: String?
    private var _allowInsecureTokenAttachment = false

    package let serializer = FunctionsSerializer()
    package let httpTransport: any FunctionsHTTPTransport
    package let environment: [String: String]

    /// The current emulator origin (`"http://<host>:<port>"`), or `nil` when unset.
    open var emulatorOrigin: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _emulatorOrigin
    }

    /// Allows Auth and App Check tokens to be attached over non-loopback `http://` connections during local testing.
    public var allowInsecureTokenAttachment: Bool {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _allowInsecureTokenAttachment
        }
        set {
            stateLock.lock()
            _allowInsecureTokenAttachment = newValue
            stateLock.unlock()
        }
    }

    package init(
        app: FirebaseApp,
        region: String = FunctionsURLResolver.defaultRegion,
        customDomain: String? = nil,
        httpTransport: (any FunctionsHTTPTransport)? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.app = app
        self.region = region
        self.customDomain = customDomain
        self.httpTransport = httpTransport ?? URLSessionFunctionsHTTPTransport()
        self.environment = environment
        super.init()
    }

    // MARK: - Public Static Factory APIs

    /// Returns a shared `Functions` instance for `FirebaseApp.app()` in `"us-central1"`.
    open class func functions() -> Functions {
        functions(
            app: FirebaseApp.app(),
            region: FunctionsURLResolver.defaultRegion,
            customDomain: nil
        )
    }

    /// Returns a shared `Functions` instance for `app` in `"us-central1"`.
    open class func functions(app: FirebaseApp) -> Functions {
        functions(
            app: app,
            region: FunctionsURLResolver.defaultRegion,
            customDomain: nil
        )
    }

    /// Returns a shared `Functions` instance for `FirebaseApp.app()` and `region` (or custom domain URL).
    open class func functions(region: String) -> Functions {
        let parsed = FunctionsURLResolver.parseRegionOrCustomDomain(region)
        return functions(
            app: FirebaseApp.app(),
            region: parsed.region,
            customDomain: parsed.customDomain
        )
    }

    /// Returns a shared `Functions` instance for `FirebaseApp.app()` and `customDomain`.
    open class func functions(customDomain: String) -> Functions {
        functions(
            app: FirebaseApp.app(),
            region: FunctionsURLResolver.defaultRegion,
            customDomain: FunctionsURLResolver.normalizeCustomDomain(customDomain)
        )
    }

    /// Returns a shared `Functions` instance for `app` and `region` (or custom domain URL).
    open class func functions(app: FirebaseApp, region: String) -> Functions {
        let parsed = FunctionsURLResolver.parseRegionOrCustomDomain(region)
        return functions(
            app: app,
            region: parsed.region,
            customDomain: parsed.customDomain
        )
    }

    /// Returns a shared `Functions` instance for `app` and `customDomain`.
    open class func functions(app: FirebaseApp, customDomain: String) -> Functions {
        functions(
            app: app,
            region: FunctionsURLResolver.defaultRegion,
            customDomain: FunctionsURLResolver.normalizeCustomDomain(customDomain)
        )
    }

    private class func functions(
        app: FirebaseApp,
        region: String,
        customDomain: String?
    ) -> Functions {
        let normalizedRegion = region.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? FunctionsURLResolver.defaultRegion
            : region.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = InstanceKey(
            appName: app.name,
            region: normalizedRegion,
            customDomain: customDomain
        )
        registryLock.lock()
        defer { registryLock.unlock() }
        if let existing = instances[key], existing.app === app {
            return existing
        }
        let created = Functions(
            app: app,
            region: normalizedRegion,
            customDomain: customDomain
        )
        instances[key] = created
        return created
    }

    /// Evicts cached `Functions` instances managed by `PyricFunctions`.
    public static func reset() {
        registryLock.lock()
        instances.removeAll()
        registryLock.unlock()
    }

    // MARK: - Emulator Configuration

    /// Points this `Functions` instance at a local Cloud Functions emulator (`10.0.2.2` normalized to `127.0.0.1`).
    open func useEmulator(withHost host: String, port: Int) {
        let formatted = FunctionsURLResolver.formatEmulatorOrigin(host: host, port: port)
        stateLock.lock()
        _emulatorOrigin = formatted
        stateLock.unlock()
    }

    // MARK: - Callable Reference Factories

    /// Creates an untyped `HTTPSCallable` reference for `name`.
    open func httpsCallable(_ name: String) -> HTTPSCallable {
        HTTPSCallable(functions: self, targetSpec: .named(name), options: nil)
    }

    /// Creates an untyped `HTTPSCallable` reference for `name` and `options`.
    public func httpsCallable(_ name: String, options: HTTPSCallableOptions) -> HTTPSCallable {
        HTTPSCallable(functions: self, targetSpec: .named(name), options: options)
    }

    /// Creates an untyped `HTTPSCallable` reference for `url`.
    open func httpsCallable(_ url: URL) -> HTTPSCallable {
        HTTPSCallable(functions: self, targetSpec: .url(url), options: nil)
    }

    /// Creates an untyped `HTTPSCallable` reference for `url` and `options`.
    public func httpsCallable(_ url: URL, options: HTTPSCallableOptions) -> HTTPSCallable {
        HTTPSCallable(functions: self, targetSpec: .url(url), options: options)
    }

    /// Convenience labeled URL overload (`httpsCallable(URL:options:)`).
    public func httpsCallable(URL url: URL, options: HTTPSCallableOptions? = nil) -> HTTPSCallable {
        HTTPSCallable(functions: self, targetSpec: .url(url), options: options)
    }

    /// Creates a typed `Codable` `Callable<Request, Response>` reference for `name`.
    open func httpsCallable<Request: Encodable, Response: Decodable>(
        _ name: String,
        requestAs: Request.Type = Request.self,
        responseAs: Response.Type = Response.self,
        encoder: FirebaseDataEncoder = FirebaseDataEncoder(),
        decoder: FirebaseDataDecoder = FirebaseDataDecoder()
    ) -> Callable<Request, Response> {
        _ = requestAs
        _ = responseAs
        return Callable(
            callable: httpsCallable(name),
            encoder: encoder,
            decoder: decoder
        )
    }

    /// Creates a typed `Codable` `Callable<Request, Response>` reference for `name` and `options`.
    open func httpsCallable<Request: Encodable, Response: Decodable>(
        _ name: String,
        options: HTTPSCallableOptions,
        requestAs: Request.Type = Request.self,
        responseAs: Response.Type = Response.self,
        encoder: FirebaseDataEncoder = FirebaseDataEncoder(),
        decoder: FirebaseDataDecoder = FirebaseDataDecoder()
    ) -> Callable<Request, Response> {
        _ = requestAs
        _ = responseAs
        return Callable(
            callable: httpsCallable(name, options: options),
            encoder: encoder,
            decoder: decoder
        )
    }

    /// Creates a typed `Codable` `Callable<Request, Response>` reference for `url`.
    open func httpsCallable<Request: Encodable, Response: Decodable>(
        _ url: URL,
        requestAs: Request.Type = Request.self,
        responseAs: Response.Type = Response.self,
        encoder: FirebaseDataEncoder = FirebaseDataEncoder(),
        decoder: FirebaseDataDecoder = FirebaseDataDecoder()
    ) -> Callable<Request, Response> {
        _ = requestAs
        _ = responseAs
        return Callable(
            callable: httpsCallable(url),
            encoder: encoder,
            decoder: decoder
        )
    }

    /// Creates a typed `Codable` `Callable<Request, Response>` reference for `url` and `options`.
    open func httpsCallable<Request: Encodable, Response: Decodable>(
        _ url: URL,
        options: HTTPSCallableOptions,
        requestAs: Request.Type = Request.self,
        responseAs: Response.Type = Response.self,
        encoder: FirebaseDataEncoder = FirebaseDataEncoder(),
        decoder: FirebaseDataDecoder = FirebaseDataDecoder()
    ) -> Callable<Request, Response> {
        _ = requestAs
        _ = responseAs
        return Callable(
            callable: httpsCallable(url, options: options),
            encoder: encoder,
            decoder: decoder
        )
    }

    // MARK: - Internal Execution

    package func resolveTarget(for spec: HTTPSCallable.TargetSpec) throws -> ResolvedCallableTarget {
        let projectID = (app.options.projectID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let currentEmulator = emulatorOrigin
        let defaultGateway = FunctionsURLResolver.resolveDefaultGatewayOrigin(
            app: app,
            environment: environment
        )
        switch spec {
        case .named(let name):
            return try FunctionsURLResolver.resolveNamedTarget(
                name: name,
                projectID: projectID,
                region: region,
                customDomain: customDomain,
                emulatorOrigin: currentEmulator,
                gatewayOrigin: defaultGateway
            )
        case .url(let url):
            return try FunctionsURLResolver.resolveURLTarget(
                url: url,
                projectID: projectID,
                region: region,
                emulatorOrigin: currentEmulator,
                gatewayOrigin: defaultGateway
            )
        }
    }

    package func executeCall(
        targetSpec: HTTPSCallable.TargetSpec,
        data: UncheckedSendableBox,
        options: HTTPSCallableOptions?,
        timeout: TimeInterval
    ) async throws -> HTTPSCallableResult {
        let encodedPayload = try encodeRequestEnvelope(data: data.value, reportedURL: nil)
        let target = try resolveTarget(for: targetSpec)
        let headers = try await buildHeaders(
            for: target.fetchURL,
            reportedURL: target.reportedURL,
            options: options,
            acceptSSE: false
        )

        let response = try await httpTransport.postJSON(
            url: target.fetchURL,
            headers: headers,
            body: encodedPayload,
            timeout: timeout
        )

        if let responseError = FunctionsError.fromResponse(
            httpStatusCode: response.statusCode,
            region: region,
            url: target.reportedURL,
            body: response.body,
            serializer: serializer
        ) {
            throw responseError
        }

        return try decodeCallableResult(from: response.body, reportedURL: target.reportedURL)
    }

    package func executeStream(
        targetSpec: HTTPSCallable.TargetSpec,
        data: UncheckedSendableBox,
        options: HTTPSCallableOptions?,
        timeout: TimeInterval
    ) -> AsyncThrowingStream<StreamResponse<Any, HTTPSCallableResult>, Error> {
        AsyncThrowingStream { continuation in
            let worker = Task {
                do {
                    let encodedPayload = try self.encodeRequestEnvelope(data: data.value, reportedURL: nil)
                    let target = try self.resolveTarget(for: targetSpec)
                    let headers = try await self.buildHeaders(
                        for: target.fetchURL,
                        reportedURL: target.reportedURL,
                        options: options,
                        acceptSSE: true
                    )

                    let rawSSE = self.httpTransport.postSSE(
                        url: target.fetchURL,
                        headers: headers,
                        body: encodedPayload,
                        timeout: timeout,
                        region: self.region,
                        reportedURL: target.reportedURL,
                        serializer: self.serializer
                    )

                    for try await jsonLine in rawSSE {
                        try Task.checkCancellation()
                        let events = try self.parseSSEPayloadLine(
                            jsonLine,
                            reportedURL: target.reportedURL
                        )
                        for event in events {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(
                        throwing: FunctionsError(.cancelled, region: self.region)
                    )
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { @Sendable _ in
                worker.cancel()
            }
        }
    }

    private func encodeRequestEnvelope(data: Any?, reportedURL: URL?) throws -> Data {
        do {
            let encoded = try serializer.encode(data)
            let envelope: [String: Any] = ["data": encoded]
            return try JSONSerialization.data(withJSONObject: envelope, options: [])
        } catch let fnError as FunctionsError {
            throw fnError
        } catch {
            throw FunctionsError(
                .invalidArgument,
                message: error.localizedDescription,
                region: region,
                url: reportedURL,
                underlyingError: error
            )
        }
    }

    private func buildHeaders(
        for fetchURL: URL,
        reportedURL: URL,
        options: HTTPSCallableOptions?,
        acceptSSE: Bool
    ) async throws -> [String: String] {
        var headers: [String: String] = [
            "Content-Type": "application/json"
        ]
        if acceptSSE {
            headers["Accept"] = "text/event-stream"
        }

        let context = await FunctionsContextProvider.resolveContext(
            app: app,
            requireLimitedUseAppCheckTokens: options?.requireLimitedUseAppCheckTokens == true
        )

        let canAttach = FunctionsURLResolver.isSecureOrLoopback(fetchURL) || allowInsecureTokenAttachment
        if !canAttach {
            if context.hasCredentials && fetchURL.scheme?.lowercased() == "http" {
                throw FunctionsError(
                    .unauthenticated,
                    message: "Refusing to send Auth and AppCheck tokens over HTTP to non-loopback host.",
                    region: region,
                    url: reportedURL
                )
            }
            return headers
        }

        if let authIDToken = context.authIDToken {
            headers["Authorization"] = "Bearer \(authIDToken)"
        }
        if let appCheckToken = context.appCheckToken {
            headers[Self.appCheckHeader] = appCheckToken
        }
        return headers
    }

    private func decodeCallableResult(
        from body: Data,
        reportedURL: URL
    ) throws -> HTTPSCallableResult {
        guard !body.isEmpty else {
            throw FunctionsError(
                .internal,
                message: "Response is missing data field.",
                region: region,
                url: reportedURL
            )
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: body, options: []),
              let dict = parsed as? [String: Any] else {
            throw FunctionsError(
                .internal,
                message: "Response was not a dictionary.",
                region: region,
                url: reportedURL
            )
        }
        let rawPayload: Any
        if let dataField = dict["data"] {
            rawPayload = dataField
        } else if let resultField = dict["result"] {
            rawPayload = resultField
        } else {
            throw FunctionsError(
                .internal,
                message: "Response is missing data field.",
                region: region,
                url: reportedURL
            )
        }
        do {
            let decoded = try serializer.decode(rawPayload)
            return HTTPSCallableResult(data: decoded)
        } catch {
            throw FunctionsError(
                .internal,
                message: error.localizedDescription,
                region: region,
                url: reportedURL,
                underlyingError: error
            )
        }
    }

    private func parseSSEPayloadLine(
        _ jsonLine: String,
        reportedURL: URL
    ) throws -> [StreamResponse<Any, HTTPSCallableResult>] {
        guard let lineData = jsonLine.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: lineData, options: []),
              let dict = parsed as? [String: Any] else {
            throw FunctionsError(
                .internal,
                message: "Response was not a dictionary.",
                region: region,
                url: reportedURL
            )
        }

        if dict["error"] != nil {
            let mapped = FunctionsError.fromErrorEnvelope(
                defaultCode: .internal,
                region: region,
                url: reportedURL,
                json: dict,
                serializer: serializer
            ) ?? FunctionsError(.internal, region: region, url: reportedURL)
            throw mapped
        }

        var yielded: [StreamResponse<Any, HTTPSCallableResult>] = []
        if let rawMessage = dict["message"] {
            let decodedChunk = try serializer.decode(rawMessage)
            yielded.append(.message(decodedChunk))
        }
        if let rawResult = dict["result"] {
            let decodedFinal = try serializer.decode(rawResult)
            yielded.append(.result(HTTPSCallableResult(data: decodedFinal)))
        }
        return yielded
    }
}
