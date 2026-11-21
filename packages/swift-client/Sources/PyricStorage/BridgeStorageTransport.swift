import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

/// Package-internal Storage RPC and HTTP byte-route transport over `PyricBridgeClient`.
package enum BridgeStorageTransport {
    package static let maxStorageOpBytes: Int = 8 * 1024 * 1024
    package static let maxStoragePartBytes: Int = 4 * 1024 * 1024
    package static let maxStorageObjectBytes: Int64 = 512 * 1024 * 1024
    private static let storageRoutePrefix = "/__pyric/storage/v0/b/"

    // MARK: - Upload

    package static func uploadData(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        data: Data,
        metadata: StorageMetadata?,
        chunkSizeBytes: Int64,
        timeout: TimeInterval,
        onProgress: (@Sendable (Progress?) -> Void)?
    ) async throws -> StorageMetadata {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: putData cannot operate on the root reference."
            )
        }
        let totalBytes = Int64(data.count)
        if totalBytes > maxStorageObjectBytes {
            await client.pass(turn: turn)
            throw StorageErrorCode.quotaExceeded
        }
        try Task.checkCancellation()

        let settable = metadata?.toUploadSettableWire() ?? (contentType: nil, metadata: nil)
        let effectiveSliceBytes = resolvedSliceSize(chunkSizeBytes: chunkSizeBytes)

        if client.hasInjectedChannel {
            return try await uploadViaFrames(
                reference: reference,
                client: client,
                turn: turn,
                actAs: actAs,
                data: data,
                settable: settable,
                sliceBytes: effectiveSliceBytes,
                timeout: timeout,
                onProgress: onProgress
            )
        }

        var beginParams = reference.bucketWireParams
        beginParams["path"] = .string(reference.fullPath)
        beginParams["size"] = .int(totalBytes)
        if let contentType = settable.contentType {
            beginParams["contentType"] = .string(contentType)
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
        guard let beginDict = beginRes.dictionaryValue,
              let uploadId = beginDict["uploadId"]?.stringValue,
              !uploadId.isEmpty else {
            throw StorageErrorCode(
                code: .internalError,
                message: "storage.beginUpload did not return an uploadId."
            )
        }
        let uploadUrlPath = beginDict["uploadUrl"]?.stringValue

        do {
            try Task.checkCancellation()
            if !data.isEmpty {
                var routedOverHTTP = false
                let clientEndpoint = await client.endpoint
                let clientHeaders = await client.headers
                if let uploadUrlPath,
                   let targetURL = resolveByteRouteURL(endpoint: clientEndpoint, relativePath: uploadUrlPath) {
                    routedOverHTTP = try await sendSlicesOverHTTPOrFallback(
                        targetURL: targetURL,
                        headers: clientHeaders,
                        data: data,
                        sliceBytes: effectiveSliceBytes,
                        timeout: timeout,
                        onProgress: onProgress
                    )
                }
                if !routedOverHTTP {
                    try await sendPartsOverFrames(
                        client: client,
                        uploadId: uploadId,
                        actAs: actAs,
                        data: data,
                        sliceBytes: effectiveSliceBytes,
                        timeout: timeout,
                        onProgress: onProgress
                    )
                }
            } else if let onProgress {
                let progress = Progress(totalUnitCount: 0)
                progress.completedUnitCount = 0
                onProgress(progress)
            }

            try Task.checkCancellation()
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

    // MARK: - Download

    package static func downloadData(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        maxSize: Int64,
        timeout: TimeInterval
    ) async throws -> Data {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: data(maxSize:) cannot operate on the root reference."
            )
        }
        if maxSize < 0 {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "maxSize must be greater than or equal to zero."
            )
        }
        try Task.checkCancellation()

        if client.hasInjectedChannel {
            return try await downloadViaFrames(
                reference: reference,
                client: client,
                turn: turn,
                actAs: actAs,
                maxSize: maxSize,
                timeout: timeout
            )
        }

        for attempt in 0..<2 {
            try Task.checkCancellation()
            var metaParams = reference.bucketWireParams
            metaParams["path"] = .string(reference.fullPath)
            let rawMeta: AnySendable
            if attempt == 0 {
                rawMeta = try await client.op(
                    turn: turn,
                    method: "storage.getMetadata",
                    params: metaParams,
                    actAs: actAs,
                    timeout: timeout
                )
            } else {
                rawMeta = try await client.op(
                    method: "storage.getMetadata",
                    params: metaParams,
                    actAs: actAs,
                    timeout: timeout
                )
            }

            let meta = try StorageMetadata.fromWire(rawMeta, fallbackBucket: reference.bucket)
            if meta.size > maxSize {
                throw StorageErrorCode.downloadSizeExceeded(total: meta.size, maxSize: maxSize)
            }
            if meta.size == 0 {
                return Data()
            }

            let generationString = rawMeta.dictionaryValue?["generation"]?.stringValue ?? "\(meta.generation)"
            let objectBucket = meta.bucket.isEmpty ? reference.bucket : meta.bucket
            let clientEndpoint = await client.endpoint
            if let routeURL = buildObjectByteRouteURL(
                endpoint: clientEndpoint,
                bucket: objectBucket,
                fullPath: reference.fullPath,
                generation: generationString
            ) {
                var headers = await client.headers
                headers["x-pyric-byte-route"] = "1"
                if let sessionToken = ProcessInfo.processInfo.environment["PYRIC_SESSION_TOKEN"],
                   !sessionToken.isEmpty {
                    headers["x-pyric-session-token"] = sessionToken
                }
                let httpOutcome = try await performHTTPRequest(
                    url: routeURL,
                    method: "GET",
                    headers: headers,
                    body: nil,
                    timeout: timeout
                )
                if httpOutcome.statusCode == 412 && attempt == 0 {
                    continue
                }
                if httpOutcome.statusCode == 404,
                   let text = String(data: httpOutcome.body, encoding: .utf8),
                   text.contains("Not a byte route path") {
                    return try await downloadViaFramesAfterMetadata(
                        reference: reference,
                        client: client,
                        actAs: actAs,
                        meta: meta,
                        generation: generationString,
                        maxSize: maxSize,
                        timeout: timeout
                    )
                }
                guard (200..<300).contains(httpOutcome.statusCode) else {
                    throw mapHTTPFailure(statusCode: httpOutcome.statusCode, path: reference.fullPath, body: httpOutcome.body)
                }
                if Int64(httpOutcome.body.count) > maxSize {
                    throw StorageErrorCode.downloadSizeExceeded(total: Int64(httpOutcome.body.count), maxSize: maxSize)
                }
                return httpOutcome.body
            }

            return try await downloadViaFramesAfterMetadata(
                reference: reference,
                client: client,
                actAs: actAs,
                meta: meta,
                generation: generationString,
                maxSize: maxSize,
                timeout: timeout
            )
        }

        throw StorageErrorCode.retryLimitExceeded
    }

    // MARK: - Metadata, Download URL, Delete, List

    package static func getDownloadURL(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async throws -> URL {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: downloadURL cannot operate on the root reference."
            )
        }
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        let res = try await client.op(
            turn: turn,
            method: "storage.getDownloadURL",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
        guard let rawPath = res.dictionaryValue?["path"]?.stringValue, !rawPath.isEmpty else {
            throw StorageErrorCode(
                code: .internalError,
                message: "storage.getDownloadURL did not return a non-empty path."
            )
        }
        if rawPath.hasPrefix("http://") || rawPath.hasPrefix("https://") || rawPath.hasPrefix("data:") {
            guard let direct = URL(string: rawPath) else {
                throw StorageErrorCode(code: .internalError, message: "Malformed download URL: \(rawPath)")
            }
            return direct
        }
        let clientEndpoint = await client.endpoint
        guard let resolved = resolveByteRouteURL(endpoint: clientEndpoint, relativePath: rawPath) else {
            throw StorageErrorCode(code: .internalError, message: "Unable to resolve download URL path: \(rawPath)")
        }
        return resolved
    }

    package static func getMetadata(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async throws -> StorageMetadata {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: getMetadata cannot operate on the root reference."
            )
        }
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        let res = try await client.op(
            turn: turn,
            method: "storage.getMetadata",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
        return try StorageMetadata.fromWire(res, fallbackBucket: reference.bucket)
    }

    package static func updateMetadata(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        metadata: StorageMetadata,
        timeout: TimeInterval
    ) async throws -> StorageMetadata {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: updateMetadata cannot operate on the root reference."
            )
        }

        if client.hasInjectedChannel {
            let patch = metadata.toAdminPatchWire(existingCustomKeys: [])
            var params = reference.bucketWireParams
            params["path"] = .string(reference.fullPath)
            params["patch"] = .dictionary(patch)
            do {
                let direct = try await client.op(
                    turn: turn,
                    method: "storage.setMetadata",
                    params: params,
                    actAs: actAs,
                    timeout: timeout
                )
                return try StorageMetadata.fromWire(direct, fallbackBucket: reference.bucket)
            } catch let bridgeErr as PyricBridgeError where bridgeErr.message.contains("admin plane") {
                return try await updateMetadataWithRulesGate(
                    reference: reference,
                    client: client,
                    turn: nil,
                    actAs: actAs,
                    metadata: metadata,
                    timeout: timeout
                )
            }
        }

        return try await updateMetadataWithRulesGate(
            reference: reference,
            client: client,
            turn: turn,
            actAs: actAs,
            metadata: metadata,
            timeout: timeout
        )
    }

    package static func deleteObject(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async throws {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: delete cannot operate on the root reference."
            )
        }
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        _ = try await client.op(
            turn: turn,
            method: "storage.deleteObject",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
    }

    package static func list(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        maxResults: Int64?,
        pageToken: String?,
        timeout: TimeInterval
    ) async throws -> StorageListResult {
        if let maxResults, (maxResults <= 0 || maxResults > 1000) {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "Argument 'maxResults' must be between 1 and 1000 inclusive."
            )
        }
        let startIndex: Int
        if let pageToken {
            guard let parsed = Int(pageToken), parsed >= 0 else {
                await client.pass(turn: turn)
                throw StorageErrorCode(
                    code: .invalidArgument,
                    message: "Invalid pagination pageToken: '\(pageToken)'."
                )
            }
            startIndex = parsed
        } else {
            startIndex = 0
        }

        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        let res = try await client.op(
            turn: turn,
            method: "storage.listAll",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
        guard let dict = res.dictionaryValue else {
            throw StorageErrorCode(
                code: .internalError,
                message: "storage.listAll response from Pyric bridge was not an object."
            )
        }

        let allPrefixes = decodeListReferences(dict["prefixes"]?.arrayValue, parent: reference)
        let allItems = decodeListReferences(dict["items"]?.arrayValue, parent: reference)

        guard let maxResults else {
            return StorageListResult(prefixes: allPrefixes, items: allItems, pageToken: nil)
        }

        let limit = Int(maxResults)
        let totalCount = allPrefixes.count + allItems.count
        guard startIndex < totalCount else {
            return StorageListResult(prefixes: [], items: [], pageToken: nil)
        }

        let endIndex = min(startIndex + limit, totalCount)
        var pagePrefixes: [StorageReference] = []
        var pageItems: [StorageReference] = []
        for idx in startIndex..<endIndex {
            if idx < allPrefixes.count {
                pagePrefixes.append(allPrefixes[idx])
            } else {
                pageItems.append(allItems[idx - allPrefixes.count])
            }
        }
        let nextToken: String? = (endIndex < totalCount) ? "\(endIndex)" : nil
        return StorageListResult(prefixes: pagePrefixes, items: pageItems, pageToken: nextToken)
    }
}
