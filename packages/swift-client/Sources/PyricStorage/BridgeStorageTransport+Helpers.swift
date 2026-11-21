import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

extension BridgeStorageTransport {
    private static let uriComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    package struct HTTPOutcome: Sendable {
        package let statusCode: Int
        package let headers: [String: String]
        package let body: Data
    }

    static func updateMetadataWithRulesGate(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn?,
        actAs: AuthLens?,
        metadata: StorageMetadata,
        timeout: TimeInterval
    ) async throws -> StorageMetadata {
        // Pre-read existing object metadata internally before probing Storage Rules so
        // partial updates evaluate `request.resource.size`, `request.resource.contentType`,
        // and `request.resource.metadata` against the merged post-patch object without
        // leaking existence prior to authorization.
        var readParams = reference.bucketWireParams
        readParams["path"] = .string(reference.fullPath)
        let preReadRaw: AnySendable?
        if let turn {
            preReadRaw = try? await client.op(
                turn: turn,
                method: "storage.getMetadata",
                params: readParams,
                actAs: .admin,
                timeout: timeout
            )
        } else {
            preReadRaw = try? await client.op(
                method: "storage.getMetadata",
                params: readParams,
                actAs: .admin,
                timeout: timeout
            )
        }

        let mergedGate = metadata.toMergedRulesGateWire(existingRaw: preReadRaw)
        var gateParams = reference.bucketWireParams
        gateParams["path"] = .string(reference.fullPath)
        gateParams["size"] = .int(mergedGate.size)
        if let ct = mergedGate.contentType {
            gateParams["contentType"] = .string(ct)
        }
        if let metaWire = mergedGate.metadata {
            gateParams["metadata"] = .dictionary(metaWire)
        }

        let gateRes = try await client.op(
            method: "storage.beginUpload",
            params: gateParams,
            actAs: actAs,
            timeout: timeout
        )
        if let uploadId = gateRes.dictionaryValue?["uploadId"]?.stringValue, !uploadId.isEmpty {
            _ = try? await client.op(
                method: "storage.abortUpload",
                params: ["uploadId": .string(uploadId)],
                actAs: actAs,
                timeout: 5.0
            )
        }

        let existingRaw: AnySendable
        if let preReadRaw {
            existingRaw = preReadRaw
        } else {
            existingRaw = try await client.op(
                method: "storage.getMetadata",
                params: readParams,
                actAs: .admin,
                timeout: timeout
            )
        }
        let existingCustom = existingRaw.dictionaryValue?["customMetadata"]?.dictionaryValue
        let existingKeys: Set<String> = existingCustom.map { Set($0.keys) } ?? []

        let patch = metadata.toAdminPatchWire(existingCustomKeys: existingKeys)
        var patchParams = reference.bucketWireParams
        patchParams["path"] = .string(reference.fullPath)
        patchParams["patch"] = .dictionary(patch)
        let updatedRaw = try await client.op(
            method: "storage.setMetadata",
            params: patchParams,
            actAs: .admin,
            timeout: timeout
        )
        return try StorageMetadata.fromWire(updatedRaw, fallbackBucket: reference.bucket)
    }

    static func decodeListReferences(
        _ entries: [AnySendable]?,
        parent: StorageReference
    ) -> [StorageReference] {
        guard let entries else { return [] }
        return entries.compactMap { entry in
            guard let fullPath = entry.dictionaryValue?["fullPath"]?.stringValue else {
                return nil
            }
            return StorageReference(
                storage: parent.storage,
                bucket: parent.bucket,
                fullPath: fullPath,
                isNamedBucket: parent.isNamedBucket
            )
        }
    }

    package static func resolveByteRouteURL(endpoint: URL, relativePath: String) -> URL? {
        guard let origin = httpOrigin(of: endpoint) else {
            return nil
        }
        if relativePath.hasPrefix("/") {
            return URL(string: "\(origin)\(relativePath)")
        }
        return URL(string: "\(origin)/\(relativePath)")
    }

    package static func buildObjectByteRouteURL(
        endpoint: URL,
        bucket: String,
        fullPath: String,
        generation: String
    ) -> URL? {
        guard let origin = httpOrigin(of: endpoint),
              let encodedBucket = bucket.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed),
              let encodedPath = fullPath.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed),
              let encodedGen = generation.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) else {
            return nil
        }
        return URL(
            string: "\(origin)/__pyric/storage/v0/b/\(encodedBucket)/o/\(encodedPath)?alt=media&generation=\(encodedGen)"
        )
    }

    package static func httpOrigin(of endpoint: URL) -> String? {
        guard let rawHost = endpoint.host, !rawHost.isEmpty else {
            return nil
        }
        let scheme = (endpoint.scheme?.lowercased() == "wss" || endpoint.scheme?.lowercased() == "https")
            ? "https"
            : "http"
        let formattedHost = (rawHost.contains(":") && !rawHost.hasPrefix("[")) ? "[\(rawHost)]" : rawHost
        if let port = endpoint.port {
            return "\(scheme)://\(formattedHost):\(port)"
        }
        return "\(scheme)://\(formattedHost)"
    }

    package static func mapHTTPFailure(statusCode: Int, path: String, body: Data) -> StorageErrorCode {
        let detail = String(data: body, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch statusCode {
        case 401:
            return StorageErrorCode(
                code: .unauthenticated,
                message: detail.isEmpty ? "Unauthenticated byte-route request for '\(path)'." : detail
            )
        case 403:
            return StorageErrorCode(
                code: .unauthorized,
                message: detail.isEmpty ? "Unauthorized byte-route request for '\(path)'." : detail
            )
        case 404:
            return StorageErrorCode(
                code: .objectNotFound,
                message: detail.isEmpty ? "Object '\(path)' does not exist." : detail
            )
        case 413:
            return StorageErrorCode(
                code: .quotaExceeded,
                message: detail.isEmpty ? "Payload exceeds Storage quota for '\(path)'." : detail
            )
        default:
            return StorageErrorCode(
                code: .unknown,
                message: detail.isEmpty ? "Storage byte route answered HTTP \(statusCode) for '\(path)'." : detail
            )
        }
    }

    package static func performHTTPRequest(
        url: URL,
        method: String,
        headers: [String: String],
        body: Data?,
        timeout: TimeInterval
    ) async throws -> HTTPOutcome {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = max(5.0, timeout)
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.httpBody = body

        let taskBox = DataTaskBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let dataTask = URLSession.shared.dataTask(with: request) { data, response, error in
                    if let error {
                        continuation.resume(throwing: StorageErrorCode.from(error))
                        return
                    }
                    guard let http = response as? HTTPURLResponse else {
                        continuation.resume(
                            throwing: StorageErrorCode(code: .unknown, message: "Non-HTTP response from Storage byte route.")
                        )
                        return
                    }
                    var loweredHeaders: [String: String] = [:]
                    for (rawKey, rawVal) in http.allHeaderFields {
                        let key = String(describing: rawKey).lowercased()
                        loweredHeaders[key] = String(describing: rawVal)
                    }
                    continuation.resume(
                        returning: HTTPOutcome(
                            statusCode: http.statusCode,
                            headers: loweredHeaders,
                            body: data ?? Data()
                        )
                    )
                }
                taskBox.install(dataTask)
            }
        } onCancel: {
            taskBox.cancel()
        }
    }
}

private final class DataTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionDataTask?

    func install(_ nextTask: URLSessionDataTask) {
        let shouldCancelImmediately: Bool = {
            lock.lock()
            defer { lock.unlock() }
            task = nextTask
            return cancelled
        }()
        if shouldCancelImmediately {
            nextTask.cancel()
        } else {
            nextTask.resume()
        }
    }

    func cancel() {
        let current: URLSessionDataTask? = {
            lock.lock()
            defer { lock.unlock() }
            cancelled = true
            return task
        }()
        current?.cancel()
    }
}
