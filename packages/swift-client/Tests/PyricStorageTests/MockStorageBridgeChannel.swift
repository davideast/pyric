import Foundation
@testable import PyricStorage
import PyricFirestore

final class MockStorageBridgeChannel: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []
    private var sentOps: [[String: AnySendable]] = []
    private var serverHandler: (@Sendable ([String: AnySendable], MockStorageBridgeChannel) -> Void)?
    private(set) var isClosed = false

    init(onClientMessage: (@Sendable ([String: AnySendable], MockStorageBridgeChannel) -> Void)? = nil) {
        self.serverHandler = onClientMessage
    }

    var recordedOps: [[String: AnySendable]] {
        lock.lock()
        defer { lock.unlock() }
        return sentOps
    }

    func send(_ text: String) async throws {
        let parsed: ([String: AnySendable], (@Sendable ([String: AnySendable], MockStorageBridgeChannel) -> Void)?)? = try {
            lock.lock()
            defer { lock.unlock() }
            if isClosed {
                throw PyricBridgeError.unavailable("Mock WebSocket channel is closed.")
            }
            guard let data = text.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(AnySendable.self, from: data),
                  let dict = decoded.dictionaryValue else {
                return nil
            }
            if dict["type"]?.stringValue == "ping" {
                return nil
            }
            if dict["type"]?.stringValue == "worker-op",
               let opPayload = dict["op"]?.dictionaryValue {
                sentOps.append(opPayload)
            }
            return (dict, serverHandler)
        }()

        if let (frame, handler) = parsed {
            handler?(frame, self)
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let buffered: String? = {
                lock.lock()
                defer { lock.unlock() }
                if isClosed {
                    continuation.resume(throwing: PyricBridgeError.unavailable("Mock WebSocket closed."))
                    return nil
                }
                if !incomingQueue.isEmpty {
                    return incomingQueue.removeFirst()
                }
                receiveContinuations.append(continuation)
                return nil
            }()
            if let buffered {
                continuation.resume(returning: buffered)
            }
        }
    }

    func close(closeCode: Int = 1000, reason: String? = nil) async {
        let waiters: [CheckedContinuation<String, Error>] = {
            lock.lock()
            defer { lock.unlock() }
            isClosed = true
            let current = receiveContinuations
            receiveContinuations.removeAll()
            return current
        }()
        for waiter in waiters {
            waiter.resume(throwing: PyricBridgeError.unavailable("Mock WebSocket closed."))
        }
    }

    func sendFromServer(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        let waiter: CheckedContinuation<String, Error>? = {
            lock.lock()
            defer { lock.unlock() }
            if !receiveContinuations.isEmpty {
                return receiveContinuations.removeFirst()
            }
            incomingQueue.append(json)
            return nil
        }()
        waiter?.resume(returning: json)
    }
}

final class MockObjectStore: @unchecked Sendable {
    struct Entry {
        var bytes: Data
        var bucket: String
        var fullPath: String
        var generation: Int64
        var metageneration: Int64
        var contentType: String
        var cacheControl: String?
        var contentDisposition: String?
        var contentEncoding: String?
        var contentLanguage: String?
        var customMetadata: [String: String]?
        var downloadToken: String?
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var genSeq: Int64 = 0

    private func key(bucket: String, path: String) -> String {
        "\(bucket)|\(path)"
    }

    func put(
        bucket: String,
        path: String,
        bytes: Data,
        contentType: String?,
        metadata: [String: AnySendable]?
    ) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        genSeq += 1
        var custom: [String: String]?
        if let customDict = (metadata?["customMetadata"] ?? metadata?["metadata"])?.dictionaryValue {
            var out: [String: String] = [:]
            for (k, v) in customDict {
                if let str = v.stringValue { out[k] = str }
            }
            custom = out
        }
        let resolvedType = contentType ?? metadata?["contentType"]?.stringValue ?? "application/octet-stream"
        let entry = Entry(
            bytes: bytes,
            bucket: bucket,
            fullPath: path,
            generation: genSeq,
            metageneration: 1,
            contentType: resolvedType,
            cacheControl: metadata?["cacheControl"]?.stringValue,
            contentDisposition: metadata?["contentDisposition"]?.stringValue,
            contentEncoding: metadata?["contentEncoding"]?.stringValue,
            contentLanguage: metadata?["contentLanguage"]?.stringValue,
            customMetadata: custom,
            downloadToken: nil
        )
        entries[key(bucket: bucket, path: path)] = entry
        return serialize(entry)
    }

    func get(bucket: String, path: String) -> Entry? {
        lock.lock()
        defer { lock.unlock() }
        return entries[key(bucket: bucket, path: path)]
    }

    func patch(bucket: String, path: String, patch: [String: AnySendable]) -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        let k = key(bucket: bucket, path: path)
        guard var entry = entries[k] else { return nil }
        entry.metageneration += 1
        if let settable = patch["settable"]?.dictionaryValue {
            if let v = settable["contentType"] {
                entry.contentType = v.stringValue ?? "application/octet-stream"
            }
            if let v = settable["cacheControl"] {
                entry.cacheControl = v.isNull ? nil : v.stringValue
            }
            if let v = settable["contentDisposition"] {
                entry.contentDisposition = v.isNull ? nil : v.stringValue
            }
            if let v = settable["contentEncoding"] {
                entry.contentEncoding = v.isNull ? nil : v.stringValue
            }
            if let v = settable["contentLanguage"] {
                entry.contentLanguage = v.isNull ? nil : v.stringValue
            }
        }
        if let customPatch = patch["customMetadata"]?.dictionaryValue {
            var nextCustom = entry.customMetadata ?? [:]
            for (ck, cv) in customPatch {
                if cv.isNull {
                    nextCustom.removeValue(forKey: ck)
                } else if let str = cv.stringValue {
                    nextCustom[ck] = str
                }
            }
            entry.customMetadata = nextCustom.isEmpty ? nil : nextCustom
        }
        entries[k] = entry
        return serialize(entry)
    }

    func mintDownloadPath(bucket: String, path: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        let k = key(bucket: bucket, path: path)
        guard var entry = entries[k] else { return nil }
        let token = entry.downloadToken ?? "tok-\(entry.generation)"
        entry.downloadToken = token
        entries[k] = entry
        let encodedPath = path.replacingOccurrences(of: "/", with: "%2F")
        return "/__pyric/storage/v0/b/\(bucket)/o/\(encodedPath)?alt=media&token=\(token)"
    }

    func delete(bucket: String, path: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return entries.removeValue(forKey: key(bucket: bucket, path: path)) != nil
    }

    func list(bucket: String, prefix: String) -> (prefixes: [[String: String]], items: [[String: String]]) {
        lock.lock()
        let matching = entries.values.filter { $0.bucket == bucket }
        lock.unlock()

        let normalizedPrefix = prefix.isEmpty ? "" : "\(prefix)/"
        var folderSet = Set<String>()
        var fileList: [String] = []

        for entry in matching {
            guard entry.fullPath.hasPrefix(normalizedPrefix) else { continue }
            let remainder = String(entry.fullPath.dropFirst(normalizedPrefix.count))
            guard !remainder.isEmpty else { continue }
            if let slashIdx = remainder.firstIndex(of: "/") {
                let childFolder = String(remainder[..<slashIdx])
                let fullFolder = normalizedPrefix.isEmpty ? childFolder : "\(prefix)/\(childFolder)"
                folderSet.insert(fullFolder)
            } else {
                fileList.append(entry.fullPath)
            }
        }

        let sortedPrefixes = folderSet.sorted().map { folderPath in
            ["fullPath": folderPath, "name": ParsedStorageLocation.lastComponent(of: folderPath)]
        }
        let sortedItems = fileList.sorted().map { itemPath in
            ["fullPath": itemPath, "name": ParsedStorageLocation.lastComponent(of: itemPath)]
        }
        return (sortedPrefixes, sortedItems)
    }

    func serialize(_ entry: Entry) -> [String: Any] {
        var out: [String: Any] = [
            "bucket": entry.bucket,
            "fullPath": entry.fullPath,
            "name": ParsedStorageLocation.lastComponent(of: entry.fullPath),
            "size": entry.bytes.count,
            "generation": "\(entry.generation)",
            "metageneration": "\(entry.metageneration)",
            "timeCreated": "2026-01-15T12:00:00.000Z",
            "updated": "2026-01-15T12:05:00.000Z",
            "md5Hash": "dGVzdG1kNQ==",
            "contentType": entry.contentType
        ]
        if let cc = entry.cacheControl { out["cacheControl"] = cc }
        if let cd = entry.contentDisposition { out["contentDisposition"] = cd }
        if let ce = entry.contentEncoding { out["contentEncoding"] = ce }
        if let cl = entry.contentLanguage { out["contentLanguage"] = cl }
        if let custom = entry.customMetadata { out["customMetadata"] = custom }
        return out
    }
}
