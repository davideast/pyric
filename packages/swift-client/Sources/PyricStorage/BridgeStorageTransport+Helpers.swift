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

    static func resolvedSliceSize(chunkSizeBytes: Int64) -> Int {
        let cap = Int64(maxStoragePartBytes)
        if chunkSizeBytes <= 0 || chunkSizeBytes == .max {
            return maxStoragePartBytes
        }
        return Int(min(chunkSizeBytes, cap))
    }

    static func uploadViaFrames(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        data: Data,
        settable: (contentType: String?, metadata: [String: AnySendable]?),
        sliceBytes: Int,
        timeout: TimeInterval,
        onProgress: (@Sendable (Progress?) -> Void)?
    ) async throws -> StorageMetadata {
        if data.count <= sliceBytes {
            var params = reference.bucketWireParams
            params["path"] = .string(reference.fullPath)
            params["dataB64"] = .string(data.base64EncodedString())
            if let ct = settable.contentType {
                params["contentType"] = .string(ct)
            }
            if let metaWire = settable.metadata {
                params["metadata"] = .dictionary(metaWire)
            }
            let res = try await client.op(
                turn: turn,
                method: "storage.putBytes",
                params: params,
                actAs: actAs,
                timeout: timeout
            )
            if let onProgress {
                let progress = Progress(totalUnitCount: Int64(data.count))
                progress.completedUnitCount = Int64(data.count)
                onProgress(progress)
            }
            return try StorageMetadata.fromWire(res, fallbackBucket: reference.bucket)
        }

        var beginParams = reference.bucketWireParams
        beginParams["path"] = .string(reference.fullPath)
        beginParams["size"] = .int(Int64(data.count))
        if let ct = settable.contentType {
            beginParams["contentType"] = .string(ct)
        }
        if let metaWire = settable.metadata {
            beginParams["metadata"] = .dictionary(metaWire)
        }
        let beginRes = try await client.op(
            turn: turn,
            method: "storage.beginUpload",
            params: beginParams,
            actAs: actAs,
            timeout: timeout
        )
        guard let uploadId = beginRes.dictionaryValue?["uploadId"]?.stringValue, !uploadId.isEmpty else {
            throw StorageErrorCode(code: .internalError, message: "storage.beginUpload did not return uploadId.")
        }

        do {
            try await sendPartsOverFrames(
                client: client,
                uploadId: uploadId,
                actAs: actAs,
                data: data,
                sliceBytes: sliceBytes,
                timeout: timeout,
                onProgress: onProgress
            )
            let finishRes = try await client.op(
                method: "storage.finishUpload",
                params: ["uploadId": .string(uploadId)],
                actAs: actAs,
                timeout: timeout
            )
            return try StorageMetadata.fromWire(finishRes, fallbackBucket: reference.bucket)
        } catch {
            _ = try? await client.op(
                method: "storage.abortUpload",
                params: ["uploadId": .string(uploadId)],
                actAs: actAs,
                timeout: 5.0
            )
            throw error
        }
    }

    static func sendPartsOverFrames(
        client: PyricBridgeClient,
        uploadId: String,
        actAs: AuthLens?,
        data: Data,
        sliceBytes: Int,
        timeout: TimeInterval,
        onProgress: (@Sendable (Progress?) -> Void)?
    ) async throws {
        var offset = 0
        var partIndex = 0
        let total = Int64(data.count)
        while offset < data.count {
            try Task.checkCancellation()
            let nextOffset = min(offset + sliceBytes, data.count)
            let chunk = data.subdata(in: offset..<nextOffset)
            _ = try await client.op(
                method: "storage.putPart",
                params: [
                    "uploadId": .string(uploadId),
                    "partIndex": .int(Int64(partIndex)),
                    "dataB64": .string(chunk.base64EncodedString())
                ],
                actAs: actAs,
                timeout: timeout
            )
            offset = nextOffset
            partIndex += 1
            if let onProgress {
                let progress = Progress(totalUnitCount: total)
                progress.completedUnitCount = Int64(offset)
                onProgress(progress)
            }
        }
    }

    /// Sends upload slices over the HTTP byte route. Returns `false` if the host has no byte route.
    static func sendSlicesOverHTTPOrFallback(
        targetURL: URL,
        headers: [String: String],
        data: Data,
        sliceBytes: Int,
        timeout: TimeInterval,
        onProgress: (@Sendable (Progress?) -> Void)?
    ) async throws -> Bool {
        var offset = 0
        let total = data.count
        while offset < total {
            try Task.checkCancellation()
            let endExclusive = min(offset + sliceBytes, total)
            let slice = data.subdata(in: offset..<endExclusive)
            var sliceHeaders = headers
            sliceHeaders["Content-Range"] = "bytes \(offset)-\(endExclusive - 1)/\(total)"
            sliceHeaders["Content-Length"] = "\(slice.count)"

            let outcome = try await performHTTPRequest(
                url: targetURL,
                method: "PUT",
                headers: sliceHeaders,
                body: slice,
                timeout: timeout
            )
            if outcome.statusCode == 404,
               let text = String(data: outcome.body, encoding: .utf8),
               text.contains("Not a byte route path") {
                return false
            }
            guard outcome.statusCode == 200 || outcome.statusCode == 308 || outcome.statusCode == 409 else {
                throw mapHTTPFailure(statusCode: outcome.statusCode, path: targetURL.path, body: outcome.body)
            }
            if outcome.statusCode == 200 {
                offset = total
            } else if let rangeHeader = outcome.headers["range"],
                      let parsedEnd = parseReceivedRangeEnd(rangeHeader) {
                offset = parsedEnd + 1
            } else {
                offset = endExclusive
            }
            if let onProgress {
                let progress = Progress(totalUnitCount: Int64(total))
                progress.completedUnitCount = Int64(offset)
                onProgress(progress)
            }
        }
        return true
    }

    static func downloadViaFrames(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        maxSize: Int64,
        timeout: TimeInterval
    ) async throws -> Data {
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        do {
            let res = try await client.op(
                turn: turn,
                method: "storage.getBytes",
                params: params,
                actAs: actAs,
                timeout: timeout
            )
            return try decodeBytesPayload(res, maxSize: maxSize)
        } catch let bridgeErr as PyricBridgeError where bridgeErr.rawCode == "payload-too-large" {
            let rawMeta = try await client.op(
                method: "storage.getMetadata",
                params: params,
                actAs: actAs,
                timeout: timeout
            )
            let meta = try StorageMetadata.fromWire(rawMeta, fallbackBucket: reference.bucket)
            let gen = rawMeta.dictionaryValue?["generation"]?.stringValue ?? "\(meta.generation)"
            return try await downloadViaFramesAfterMetadata(
                reference: reference,
                client: client,
                actAs: actAs,
                meta: meta,
                generation: gen,
                maxSize: maxSize,
                timeout: timeout
            )
        }
    }

    static func downloadViaFramesAfterMetadata(
        reference: StorageReference,
        client: PyricBridgeClient,
        actAs: AuthLens?,
        meta: StorageMetadata,
        generation: String,
        maxSize: Int64,
        timeout: TimeInterval
    ) async throws -> Data {
        if meta.size > maxSize {
            throw StorageErrorCode.downloadSizeExceeded(total: meta.size, maxSize: maxSize)
        }
        if meta.size == 0 {
            return Data()
        }
        if meta.size <= Int64(maxStoragePartBytes) {
            var params = reference.bucketWireParams
            params["path"] = .string(reference.fullPath)
            let res = try await client.op(
                method: "storage.getBytes",
                params: params,
                actAs: actAs,
                timeout: timeout
            )
            return try decodeBytesPayload(res, maxSize: maxSize)
        }

        var assembled = Data()
        assembled.reserveCapacity(Int(meta.size))
        var offset: Int64 = 0
        while offset < meta.size {
            try Task.checkCancellation()
            let length = min(Int64(maxStoragePartBytes), meta.size - offset)
            var chunkParams = reference.bucketWireParams
            chunkParams["path"] = .string(reference.fullPath)
            chunkParams["offset"] = .int(offset)
            chunkParams["length"] = .int(length)
            chunkParams["expectedGeneration"] = .string(generation)
            let chunkRes = try await client.op(
                method: "storage.getBytes",
                params: chunkParams,
                actAs: actAs,
                timeout: timeout
            )
            let slice = try decodeBytesPayload(chunkRes, maxSize: maxSize)
            assembled.append(slice)
            if Int64(assembled.count) > maxSize {
                throw StorageErrorCode.downloadSizeExceeded(total: Int64(assembled.count), maxSize: maxSize)
            }
            offset += length
        }
        return assembled
    }

    static func updateMetadataWithRulesGate(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn?,
        actAs: AuthLens?,
        metadata: StorageMetadata,
        timeout: TimeInterval
    ) async throws -> StorageMetadata {
        let settable = metadata.toUploadSettableWire()
        var gateParams = reference.bucketWireParams
        gateParams["path"] = .string(reference.fullPath)
        gateParams["size"] = .int(0)
        if let ct = settable.contentType {
            gateParams["contentType"] = .string(ct)
        }
        if let metaWire = settable.metadata {
            gateParams["metadata"] = .dictionary(metaWire)
        }

        let gateRes: AnySendable
        if let turn {
            gateRes = try await client.op(
                turn: turn,
                method: "storage.beginUpload",
                params: gateParams,
                actAs: actAs,
                timeout: timeout
            )
        } else {
            gateRes = try await client.op(
                method: "storage.beginUpload",
                params: gateParams,
                actAs: actAs,
                timeout: timeout
            )
        }
        if let uploadId = gateRes.dictionaryValue?["uploadId"]?.stringValue, !uploadId.isEmpty {
            _ = try? await client.op(
                method: "storage.abortUpload",
                params: ["uploadId": .string(uploadId)],
                actAs: actAs,
                timeout: 5.0
            )
        }

        var readParams = reference.bucketWireParams
        readParams["path"] = .string(reference.fullPath)
        let existingRaw = try await client.op(
            method: "storage.getMetadata",
            params: readParams,
            actAs: .admin,
            timeout: timeout
        )
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

    private static func decodeBytesPayload(_ raw: AnySendable, maxSize: Int64) throws -> Data {
        guard let dict = raw.dictionaryValue,
              let dataB64 = dict["dataB64"]?.stringValue,
              let decoded = Data(base64Encoded: dataB64) else {
            throw StorageErrorCode(
                code: .internalError,
                message: "storage.getBytes response lacked valid base64 payload."
            )
        }
        if Int64(decoded.count) > maxSize {
            throw StorageErrorCode.downloadSizeExceeded(total: Int64(decoded.count), maxSize: maxSize)
        }
        return decoded
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

    private static func parseReceivedRangeEnd(_ header: String) -> Int? {
        let trimmed = header.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("bytes=0-") else {
            return nil
        }
        return Int(trimmed.dropFirst("bytes=0-".count))
    }

    package static func mapHTTPFailure(statusCode: Int, path: String, body: Data) -> StorageErrorCode {
        let detail = String(data: body, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch statusCode {
        case 401:
            return StorageErrorCode(code: .unauthenticated, message: detail.isEmpty ? "Unauthenticated byte-route request for '\(path)'." : detail)
        case 403:
            return StorageErrorCode(code: .unauthorized, message: detail.isEmpty ? "Unauthorized byte-route request for '\(path)'." : detail)
        case 404:
            return StorageErrorCode(code: .objectNotFound, message: detail.isEmpty ? "Object '\(path)' does not exist." : detail)
        case 413:
            return StorageErrorCode(code: .quotaExceeded, message: detail.isEmpty ? "Payload exceeds Storage quota for '\(path)'." : detail)
        default:
            return StorageErrorCode(code: .unknown, message: detail.isEmpty ? "Storage byte route answered HTTP \(statusCode) for '\(path)'." : detail)
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
