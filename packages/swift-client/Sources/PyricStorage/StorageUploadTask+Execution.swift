import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

extension StorageUploadTask {
    package func runUpload(
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        configuredChunkSize: Int64,
        timeout: TimeInterval
    ) async {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            completeWithFailure(
                StorageErrorCode(
                    code: .invalidArgument,
                    message: "storage/invalid-root-operation: upload cannot operate on the root reference."
                )
            )
            return
        }

        let resolvedSource: (totalBytes: Int64, inferredContentType: String?)
        do {
            resolvedSource = try validateAndMeasureSource()
        } catch {
            await client.pass(turn: turn)
            completeWithFailure(error)
            return
        }

        let totalBytes = resolvedSource.totalBytes
        if totalBytes > BridgeStorageTransport.maxStorageObjectBytes {
            await client.pass(turn: turn)
            completeWithFailure(StorageErrorCode.quotaExceeded)
            return
        }

        let sliceBytes = Self.resolveTransferSliceBytes(configuredChunkSize)
        stateLock.withLock {
            _totalBytes = totalBytes
        }

        guard await gate.waitUntilRunnable() else {
            await client.pass(turn: turn)
            return
        }

        var settable = requestedMetadata?.toUploadSettableWire() ?? (contentType: nil, metadata: nil)
        if settable.contentType == nil, let inferred = resolvedSource.inferredContentType {
            settable.contentType = inferred
            var metaDict = settable.metadata ?? [:]
            if metaDict["contentType"] == nil {
                metaDict["contentType"] = .string(inferred)
            }
            settable.metadata = metaDict
        }

        emitProgress(completedBytes: 0, totalBytes: totalBytes)

        // Preserve single-frame `storage.putBytes` compatibility on injected mock channels
        // when uploading small in-memory Data with default chunk settings.
        if client.hasInjectedChannel,
           case .data(let rawData) = source,
           configuredChunkSize == .max,
           rawData.count <= sliceBytes {
            await runSingleFrameMockUpload(
                client: client,
                turn: turn,
                actAs: actAs,
                data: rawData,
                settable: settable,
                timeout: timeout
            )
            return
        }

        await runChunkedResumableUpload(
            client: client,
            turn: turn,
            actAs: actAs,
            totalBytes: totalBytes,
            sliceBytes: sliceBytes,
            settable: settable,
            timeout: timeout
        )
    }

    private func runSingleFrameMockUpload(
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        data: Data,
        settable: (contentType: String?, metadata: [String: AnySendable]?),
        timeout: TimeInterval
    ) async {
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        params["dataB64"] = .string(data.base64EncodedString())
        params["rollback"] = .bool(true)
        if let ct = settable.contentType {
            params["contentType"] = .string(ct)
        }
        if let meta = settable.metadata {
            params["metadata"] = .dictionary(meta)
        }

        let commitTask = Task<CommittedOutcome, Error> {
            let res = try await client.op(
                turn: turn,
                method: "storage.putBytes",
                params: params,
                actAs: actAs,
                timeout: timeout
            )
            let token = res.dictionaryValue?["rollbackToken"]?.stringValue
            let decoded = try StorageMetadata.fromWire(res, fallbackBucket: reference.bucket)
            return CommittedOutcome(metadata: decoded, rollbackToken: token)
        }
        stateLock.withLock {
            inFlightCommitTask = commitTask
        }

        do {
            let committed = try await commitTask.value
            emitProgress(completedBytes: Int64(data.count), totalBytes: Int64(data.count))
            deliverOrHoldCommitOutcome(.success(committed))
        } catch {
            if !gate.isCancelled {
                deliverOrHoldCommitOutcome(.failure(error))
            }
        }
    }

    private func runChunkedResumableUpload(
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        totalBytes: Int64,
        sliceBytes: Int,
        settable: (contentType: String?, metadata: [String: AnySendable]?),
        timeout: TimeInterval
    ) async {
        var beginParams = reference.bucketWireParams
        beginParams["path"] = .string(reference.fullPath)
        beginParams["size"] = .int(totalBytes)
        if let ct = settable.contentType {
            beginParams["contentType"] = .string(ct)
        }
        if let meta = settable.metadata {
            beginParams["metadata"] = .dictionary(meta)
        }

        let uploadId: String
        let uploadUrlPath: String?
        do {
            let beginRes = try await client.op(
                turn: turn,
                method: "storage.beginUpload",
                params: beginParams,
                actAs: actAs,
                timeout: timeout
            )
            guard let dict = beginRes.dictionaryValue,
                  let id = dict["uploadId"]?.stringValue,
                  !id.isEmpty else {
                throw StorageErrorCode(code: .internalError, message: "storage.beginUpload did not return an uploadId.")
            }
            uploadId = id
            uploadUrlPath = dict["uploadUrl"]?.stringValue
            stateLock.withLock {
                stagedUploadId = id
            }
        } catch {
            if !gate.isCancelled {
                completeWithFailure(error)
            }
            return
        }

        let clientEndpoint = await client.endpoint
        let clientBaseHeaders = await client.headers
        var useHTTPByteRoute = !client.hasInjectedChannel
        let byteRouteURL: URL?
        if let uploadUrlPath {
            byteRouteURL = BridgeStorageTransport.resolveByteRouteURL(
                endpoint: clientEndpoint,
                relativePath: uploadUrlPath
            )
        } else {
            byteRouteURL = nil
        }
        if byteRouteURL == nil {
            useHTTPByteRoute = false
        }

        do {
            var offset: Int64 = 0
            var partIndex = 0

            while offset < totalBytes {
                guard await gate.waitUntilRunnable() else {
                    return
                }

                if useHTTPByteRoute, gate.consumeResyncFlag(), let targetURL = byteRouteURL {
                    if let confirmed = try? await queryByteRouteOffset(
                        targetURL: targetURL,
                        headers: clientBaseHeaders,
                        totalBytes: totalBytes,
                        timeout: timeout
                    ) {
                        offset = confirmed
                        emitProgress(completedBytes: offset, totalBytes: totalBytes)
                        if offset >= totalBytes {
                            break
                        }
                    }
                }

                let chunkLen = Int(min(Int64(sliceBytes), totalBytes - offset))
                let chunkData = try readSourceSlice(offset: offset, length: chunkLen)

                do {
                    if useHTTPByteRoute, let targetURL = byteRouteURL {
                        let sliceOffset = offset
                        let nextOffsetBox = LockedInt64Box(sliceOffset)
                        let fallbackBox = LockedBoolBox(false)
                        try await gate.runInterruptibleSlice {
                            let endExclusive = sliceOffset + Int64(chunkData.count)
                            var headers = clientBaseHeaders
                            headers["Content-Range"] = "bytes \(sliceOffset)-\(endExclusive - 1)/\(totalBytes)"
                            headers["Content-Length"] = "\(chunkData.count)"
                            let outcome = try await BridgeStorageTransport.performHTTPRequest(
                                url: targetURL,
                                method: "PUT",
                                headers: headers,
                                body: chunkData,
                                timeout: timeout
                            )
                            if outcome.statusCode == 404,
                               let bodyStr = String(data: outcome.body, encoding: .utf8),
                               bodyStr.contains("Not a byte route path") {
                                fallbackBox.value = true
                                return
                            }
                            guard outcome.statusCode == 200 || outcome.statusCode == 308 || outcome.statusCode == 409 else {
                                throw BridgeStorageTransport.mapHTTPFailure(
                                    statusCode: outcome.statusCode,
                                    path: targetURL.path,
                                    body: outcome.body
                                )
                            }
                            if outcome.statusCode == 200 {
                                nextOffsetBox.value = totalBytes
                            } else if let rangeHdr = outcome.headers["range"],
                                      let parsedEnd = Self.parseReceivedRangeEnd(rangeHdr) {
                                nextOffsetBox.value = parsedEnd + 1
                            } else {
                                nextOffsetBox.value = endExclusive
                            }
                        }
                        if fallbackBox.value {
                            useHTTPByteRoute = false
                            continue
                        }
                        offset = nextOffsetBox.value
                    } else {
                        let currentPartIndex = partIndex
                        try await gate.runInterruptibleSlice {
                            _ = try await client.op(
                                method: "storage.putPart",
                                params: [
                                    "uploadId": .string(uploadId),
                                    "partIndex": .int(Int64(currentPartIndex)),
                                    "dataB64": .string(chunkData.base64EncodedString())
                                ],
                                actAs: actAs,
                                timeout: timeout
                            )
                        }
                        offset += Int64(chunkData.count)
                        partIndex += 1
                    }
                    emitProgress(completedBytes: offset, totalBytes: totalBytes)
                } catch {
                    if gate.isCancelled {
                        return
                    }
                    if gate.isPaused || error is CancellationError || StorageErrorCode.from(error).code == .cancelled {
                        if gate.isPaused {
                            continue
                        }
                    }
                    throw error
                }
            }

            guard await gate.waitUntilRunnable() else {
                return
            }

            let commitTask = Task<CommittedOutcome, Error> {
                let finishRes = try await client.op(
                    method: "storage.finishUpload",
                    params: [
                        "uploadId": .string(uploadId),
                        "rollback": .bool(true)
                    ],
                    actAs: actAs,
                    timeout: timeout
                )
                let token = finishRes.dictionaryValue?["rollbackToken"]?.stringValue
                let meta = try StorageMetadata.fromWire(finishRes, fallbackBucket: self.reference.bucket)
                return CommittedOutcome(metadata: meta, rollbackToken: token)
            }
            stateLock.withLock {
                inFlightCommitTask = commitTask
                stagedUploadId = nil
            }

            let committed = try await commitTask.value
            deliverOrHoldCommitOutcome(.success(committed))
        } catch {
            if !gate.isCancelled {
                _ = try? await client.op(
                    method: "storage.abortUpload",
                    params: ["uploadId": .string(uploadId)],
                    actAs: actAs,
                    timeout: 5.0
                )
                deliverOrHoldCommitOutcome(.failure(error))
            }
        }
    }

    private func validateAndMeasureSource() throws -> (totalBytes: Int64, inferredContentType: String?) {
        switch source {
        case .data(let bytes):
            return (Int64(bytes.count), nil)
        case .file(let fileURL):
            guard fileURL.isFileURL else {
                throw StorageErrorCode(
                    code: .invalidArgument,
                    message: "putFile(from:) requires a local file:// URL: \(fileURL.absoluteString)"
                )
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory),
                  !isDirectory.boolValue else {
                throw StorageErrorCode(
                    code: .invalidArgument,
                    message: "File at URL \(fileURL.path) is not reachable or is a directory."
                )
            }
            let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
            return (max(0, size), StorageMimeTypeResolver.inferContentType(for: fileURL))
        }
    }

    private func readSourceSlice(offset: Int64, length: Int) throws -> Data {
        guard length > 0 else { return Data() }
        switch source {
        case .data(let bytes):
            let start = Int(offset)
            let end = min(start + length, bytes.count)
            guard start < end else { return Data() }
            return bytes.subdata(in: start..<end)
        case .file(let fileURL):
            let handle = try FileHandle(forReadingFrom: fileURL)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            return try handle.read(upToCount: length) ?? Data()
        }
    }

    private func queryByteRouteOffset(
        targetURL: URL,
        headers: [String: String],
        totalBytes: Int64,
        timeout: TimeInterval
    ) async throws -> Int64 {
        var reqHeaders = headers
        reqHeaders["Content-Range"] = "bytes */\(totalBytes)"
        reqHeaders["Content-Length"] = "0"
        let outcome = try await BridgeStorageTransport.performHTTPRequest(
            url: targetURL,
            method: "PUT",
            headers: reqHeaders,
            body: Data(),
            timeout: timeout
        )
        if outcome.statusCode == 200 {
            return totalBytes
        }
        if outcome.statusCode == 308 {
            if let rangeHdr = outcome.headers["range"],
               let end = Self.parseReceivedRangeEnd(rangeHdr) {
                return end + 1
            }
            return 0
        }
        throw BridgeStorageTransport.mapHTTPFailure(
            statusCode: outcome.statusCode,
            path: targetURL.path,
            body: outcome.body
        )
    }

    private static func parseReceivedRangeEnd(_ header: String) -> Int64? {
        let trimmed = header.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("bytes=0-") else {
            return nil
        }
        return Int64(trimmed.dropFirst("bytes=0-".count))
    }
}

private final class LockedInt64Box: @unchecked Sendable {
    private let lock = NSLock()
    private var raw: Int64
    init(_ initial: Int64) { self.raw = initial }
    var value: Int64 {
        get { lock.lock(); defer { lock.unlock() }; return raw }
        set { lock.lock(); raw = newValue; lock.unlock() }
    }
}

private final class LockedBoolBox: @unchecked Sendable {
    private let lock = NSLock()
    private var raw: Bool
    init(_ initial: Bool) { self.raw = initial }
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return raw }
        set { lock.lock(); raw = newValue; lock.unlock() }
    }
}
