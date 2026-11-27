import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

extension StorageDownloadTask {
    package func runDownload(
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            completeWithFailure(
                StorageErrorCode(
                    code: .invalidArgument,
                    message: "storage/invalid-root-operation: download cannot operate on the root reference."
                )
            )
            return
        }

        switch target {
        case .memory(let maxSize, _):
            if maxSize < 0 {
                await client.pass(turn: turn)
                completeWithFailure(
                    StorageErrorCode(
                        code: .invalidArgument,
                        message: "maxSize must be greater than or equal to zero."
                    )
                )
                return
            }
        case .file(let fileURL, _):
            if !fileURL.isFileURL {
                await client.pass(turn: turn)
                completeWithFailure(
                    StorageErrorCode(
                        code: .invalidArgument,
                        message: "write(toFile:) requires a local file:// URL: \(fileURL.absoluteString)"
                    )
                )
                return
            }
        }

        guard await gate.waitUntilRunnable() else {
            await client.pass(turn: turn)
            return
        }

        if client.hasInjectedChannel {
            await runInjectedChannelDownload(
                client: client,
                turn: turn,
                actAs: actAs,
                timeout: timeout
            )
            return
        }

        await runHostedByteRouteDownload(
            client: client,
            turn: turn,
            actAs: actAs,
            timeout: timeout
        )
    }

    private func runInjectedChannelDownload(
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async {
        let maxAllowed: Int64? = {
            if case .memory(let maxSize, _) = target { return maxSize }
            return nil
        }()

        do {
            var getParams = reference.bucketWireParams
            getParams["path"] = .string(reference.fullPath)
            let bytes: Data
            do {
                let res = try await client.op(
                    turn: turn,
                    method: "storage.getBytes",
                    params: getParams,
                    actAs: actAs,
                    timeout: timeout
                )
                guard let dict = res.dictionaryValue,
                      let b64 = dict["dataB64"]?.stringValue,
                      let decoded = Data(base64Encoded: b64) else {
                    throw StorageErrorCode(
                        code: .internalError,
                        message: "storage.getBytes response lacked valid base64 payload."
                    )
                }
                if let maxAllowed, Int64(decoded.count) > maxAllowed {
                    throw StorageErrorCode.downloadSizeExceeded(
                        total: Int64(decoded.count),
                        maxSize: maxAllowed
                    )
                }
                bytes = decoded
            } catch let bridgeErr as PyricBridgeError where bridgeErr.rawCode == "payload-too-large" {
                let rawMeta = try await client.op(
                    method: "storage.getMetadata",
                    params: getParams,
                    actAs: actAs,
                    timeout: timeout
                )
                let meta = try StorageMetadata.fromWire(rawMeta, fallbackBucket: reference.bucket)
                if let maxAllowed, meta.size > maxAllowed {
                    throw StorageErrorCode.downloadSizeExceeded(total: meta.size, maxSize: maxAllowed)
                }
                stateLock.withLock {
                    _metadata = meta
                    _totalBytes = meta.size
                }
                let gen = rawMeta.dictionaryValue?["generation"]?.stringValue ?? "\(meta.generation)"
                bytes = try await streamFrameRanges(
                    client: client,
                    actAs: actAs,
                    totalBytes: meta.size,
                    generation: gen,
                    maxAllowed: maxAllowed,
                    timeout: timeout
                )
            }

            guard await gate.waitUntilRunnable() else { return }
            let total = Int64(bytes.count)
            emitProgress(completedBytes: 0, totalBytes: total)
            if total > 0 {
                var offset = 0
                let step = Self.defaultDownloadSliceBytes
                while offset < bytes.count {
                    guard await gate.waitUntilRunnable() else { return }
                    offset = min(offset + step, bytes.count)
                    emitProgress(completedBytes: Int64(offset), totalBytes: total)
                }
            }

            try finalizeDownloadedBytes(bytes)
        } catch {
            if !gate.isCancelled {
                completeWithFailure(error)
            }
        }
    }

    private func streamFrameRanges(
        client: PyricBridgeClient,
        actAs: AuthLens?,
        totalBytes: Int64,
        generation: String,
        maxAllowed: Int64?,
        timeout: TimeInterval
    ) async throws -> Data {
        if totalBytes == 0 {
            return Data()
        }
        var assembled = Data()
        assembled.reserveCapacity(Int(totalBytes))
        var offset: Int64 = 0
        let sliceLimit = Int64(Self.defaultDownloadSliceBytes)
        emitProgress(completedBytes: 0, totalBytes: totalBytes)

        while offset < totalBytes {
            guard await gate.waitUntilRunnable() else {
                throw StorageErrorCode.cancelled
            }
            let length = min(sliceLimit, totalBytes - offset)
            var chunkParams = reference.bucketWireParams
            chunkParams["path"] = .string(reference.fullPath)
            chunkParams["offset"] = .int(offset)
            chunkParams["length"] = .int(length)
            chunkParams["expectedGeneration"] = .string(generation)

            let frozenParams = chunkParams
            let chunkBox = LockedDataBox()
            try await gate.runInterruptibleSlice {
                let res = try await client.op(
                    method: "storage.getBytes",
                    params: frozenParams,
                    actAs: actAs,
                    timeout: timeout
                )
                guard let b64 = res.dictionaryValue?["dataB64"]?.stringValue,
                      let decoded = Data(base64Encoded: b64) else {
                    throw StorageErrorCode(
                        code: .internalError,
                        message: "storage.getBytes range response lacked base64 payload."
                    )
                }
                chunkBox.value = decoded
            }
            if gate.isPaused {
                continue
            }
            let chunk = chunkBox.value
            assembled.append(chunk)
            if let maxAllowed, Int64(assembled.count) > maxAllowed {
                throw StorageErrorCode.downloadSizeExceeded(
                    total: Int64(assembled.count),
                    maxSize: maxAllowed
                )
            }
            offset += Int64(chunk.count)
            emitProgress(completedBytes: offset, totalBytes: totalBytes)
            if chunk.isEmpty {
                break
            }
        }
        return assembled
    }

    private func runHostedByteRouteDownload(
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async {
        let maxAllowed: Int64? = {
            if case .memory(let maxSize, _) = target { return maxSize }
            return nil
        }()

        for attempt in 0..<2 {
            guard await gate.waitUntilRunnable() else {
                if attempt == 0 {
                    await client.pass(turn: turn)
                }
                return
            }

            var stagingURL: URL?
            var stagingHandle: FileHandle?
            defer {
                try? stagingHandle?.close()
                if let stagingURL {
                    try? FileManager.default.removeItem(at: stagingURL)
                }
            }

            do {
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
                if let maxAllowed, meta.size > maxAllowed {
                    throw StorageErrorCode.downloadSizeExceeded(total: meta.size, maxSize: maxAllowed)
                }

                stateLock.withLock {
                    _metadata = meta
                    _totalBytes = meta.size
                }

                emitProgress(completedBytes: 0, totalBytes: meta.size)

                var memoryBuffer = Data()
                if case .file(let destURL, _) = target {
                    let parentDir = destURL.deletingLastPathComponent()
                    try FileManager.default.createDirectory(
                        at: parentDir,
                        withIntermediateDirectories: true
                    )
                    let tempURL = parentDir.appendingPathComponent(
                        ".\(destURL.lastPathComponent).pyric-dl-\(UUID().uuidString).part"
                    )
                    _ = FileManager.default.createFile(atPath: tempURL.path, contents: nil)
                    stagingURL = tempURL
                    stagingHandle = try FileHandle(forWritingTo: tempURL)
                } else if meta.size > 0 {
                    memoryBuffer.reserveCapacity(Int(min(meta.size, Int64(BridgeStorageTransport.maxStorageOpBytes))))
                }

                if meta.size > 0 {
                    let generationStr = rawMeta.dictionaryValue?["generation"]?.stringValue ?? "\(meta.generation)"
                    let objectBucket = meta.bucket.isEmpty ? reference.bucket : meta.bucket
                    let clientEndpoint = await client.endpoint
                    let clientBaseHeaders = await client.headers
                    guard let routeURL = BridgeStorageTransport.buildObjectByteRouteURL(
                        endpoint: clientEndpoint,
                        bucket: objectBucket,
                        fullPath: reference.fullPath,
                        generation: generationStr
                    ) else {
                        let fallbackBytes = try await streamFrameRanges(
                            client: client,
                            actAs: actAs,
                            totalBytes: meta.size,
                            generation: generationStr,
                            maxAllowed: maxAllowed,
                            timeout: timeout
                        )
                        try finalizeDownloadedBytes(fallbackBytes)
                        return
                    }

                    var offset: Int64 = 0
                    let sliceSize = Int64(Self.defaultDownloadSliceBytes)
                    var sawPreconditionChanged = false

                    while offset < meta.size {
                        guard await gate.waitUntilRunnable() else { return }

                        let sliceOffset = offset
                        let endInclusive = min(sliceOffset + sliceSize - 1, meta.size - 1)
                        let outcomeBox = LockedHTTPOutcomeBox()

                        do {
                            try await gate.runInterruptibleSlice {
                                var headers = clientBaseHeaders
                                headers["x-pyric-byte-route"] = "1"
                                headers["Range"] = "bytes=\(sliceOffset)-\(endInclusive)"
                                if let sessionToken = ProcessInfo.processInfo.environment["PYRIC_SESSION_TOKEN"],
                                   !sessionToken.isEmpty {
                                    headers["x-pyric-session-token"] = sessionToken
                                }
                                headers = await BridgeAppCheckAttachment.attachHeader(
                                    to: headers,
                                    tokenProvider: client.appCheckTokenProvider
                                )
                                outcomeBox.value = try await BridgeStorageTransport.performHTTPRequest(
                                    url: routeURL,
                                    method: "GET",
                                    headers: headers,
                                    body: nil,
                                    timeout: timeout
                                )
                            }
                        } catch {
                            if gate.isCancelled { return }
                            if gate.isPaused { continue }
                            throw error
                        }

                        if gate.isCancelled { return }
                        if gate.isPaused { continue }

                        guard let outcome = outcomeBox.value else { continue }
                        if outcome.statusCode == 412 && attempt == 0 {
                            sawPreconditionChanged = true
                            break
                        }
                        if outcome.statusCode == 404,
                           let text = String(data: outcome.body, encoding: .utf8),
                           text.contains("Not a byte route path") {
                            let fallbackBytes = try await streamFrameRanges(
                                client: client,
                                actAs: actAs,
                                totalBytes: meta.size,
                                generation: generationStr,
                                maxAllowed: maxAllowed,
                                timeout: timeout
                            )
                            try finalizeDownloadedBytes(fallbackBytes)
                            return
                        }
                        guard outcome.statusCode == 200 || outcome.statusCode == 206 else {
                            throw BridgeStorageTransport.mapHTTPFailure(
                                statusCode: outcome.statusCode,
                                path: reference.fullPath,
                                body: outcome.body
                            )
                        }

                        let chunk = outcome.body
                        if let stagingHandle {
                            try stagingHandle.write(contentsOf: chunk)
                        } else {
                            memoryBuffer.append(chunk)
                            if let maxAllowed, Int64(memoryBuffer.count) > maxAllowed {
                                throw StorageErrorCode.downloadSizeExceeded(
                                    total: Int64(memoryBuffer.count),
                                    maxSize: maxAllowed
                                )
                            }
                        }
                        offset += Int64(chunk.count)
                        emitProgress(completedBytes: offset, totalBytes: meta.size)
                        if chunk.isEmpty {
                            break
                        }
                    }

                    if sawPreconditionChanged {
                        continue
                    }
                }

                guard await gate.waitUntilRunnable() else { return }

                if case .file(let destURL, _) = target, let readyStagingURL = stagingURL {
                    try stagingHandle?.close()
                    stagingHandle = nil
                    if FileManager.default.fileExists(atPath: destURL.path) {
                        try FileManager.default.removeItem(at: destURL)
                    }
                    try FileManager.default.moveItem(at: readyStagingURL, to: destURL)
                    stagingURL = nil
                    completeWithSuccessFile(destURL)
                } else {
                    completeWithSuccessData(memoryBuffer)
                }
                return
            } catch {
                if !gate.isCancelled {
                    completeWithFailure(error)
                }
                return
            }
        }

        if !gate.isCancelled {
            completeWithFailure(StorageErrorCode.retryLimitExceeded)
        }
    }
}

private final class LockedDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var raw = Data()
    var value: Data {
        get { lock.lock(); defer { lock.unlock() }; return raw }
        set { lock.lock(); raw = newValue; lock.unlock() }
    }
}

private final class LockedHTTPOutcomeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var raw: BridgeStorageTransport.HTTPOutcome?
    var value: BridgeStorageTransport.HTTPOutcome? {
        get { lock.lock(); defer { lock.unlock() }; return raw }
        set { lock.lock(); raw = newValue; lock.unlock() }
    }
}
