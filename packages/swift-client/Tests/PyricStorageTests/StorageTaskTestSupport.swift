import Foundation
import Testing
@testable import PyricStorage
import PyricFirestore

/// Creates an isolated, ownership-marked scratch directory under `~/.cache/pyric-swift-storage-tests/`
/// (avoiding `/tmp` / `NSTemporaryDirectory()` on both Linux and macOS).
enum StorageTestScratchDir {
    private static let markerName = ".pyric-swift-storage-test-owned"

    static func withDirectory<T>(
        _ body: (URL) async throws -> T
    ) async throws -> T {
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL
        let cacheRoot = home
            .appendingPathComponent(".cache", isDirectory: true)
            .appendingPathComponent("pyric-swift-storage-tests", isDirectory: true)
        let dir = cacheRoot.appendingPathComponent("run-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let marker = dir.appendingPathComponent(markerName, isDirectory: false)
        try Data("owned".utf8).write(to: marker)

        defer {
            cleanupOwnedDirectory(dir, expectedParent: cacheRoot)
        }
        return try await body(dir)
    }

    private static func cleanupOwnedDirectory(_ dir: URL, expectedParent: URL) {
        let fm = FileManager.default
        let resolvedDir = dir.resolvingSymlinksInPath().standardizedFileURL
        let resolvedParent = expectedParent.resolvingSymlinksInPath().standardizedFileURL
        guard resolvedDir.path.hasPrefix(resolvedParent.path + "/") else {
            return
        }
        let marker = resolvedDir.appendingPathComponent(markerName)
        guard fm.fileExists(atPath: marker.path) else {
            return
        }
        guard let contents = try? fm.contentsOfDirectory(
            at: resolvedDir,
            includingPropertiesForKeys: nil
        ) else {
            return
        }
        for item in contents where item.lastPathComponent != markerName {
            try? fm.removeItem(at: item)
        }
        try? fm.removeItem(at: marker)
        try? fm.removeItem(at: resolvedDir)
    }
}

/// Thread-safe event recorder for testing `StorageObservableTask` observer callbacks.
final class TaskEventRecorder<Element: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []

    func append(_ value: Element) {
        lock.lock()
        items.append(value)
        lock.unlock()
    }

    var values: [Element] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }
}

/// Chunked staging harness extending `MockObjectStore` for `beginUpload` / `putPart` / `finishUpload` / `abortUpload` / `rollbackUpload`.
final class MockChunkedUploadHarness: @unchecked Sendable {
    struct Staged {
        let bucket: String
        let path: String
        let size: Int
        let contentType: String?
        let metadata: [String: AnySendable]?
        var parts: [Int: Data] = [:]
    }

    private let lock = NSLock()
    private let store: MockObjectStore
    private var stagedById: [String: Staged] = [:]
    private var rollbackPaths: [String: (bucket: String, path: String)] = [:]
    private var seq = 0
    private(set) var abortedUploadIds: [String] = []
    private(set) var rolledBackTokens: [String] = []
    private(set) var putPartSizes: [Int] = []

    init(store: MockObjectStore) {
        self.store = store
    }

    func handleStorageOp(
        id: String,
        op: [String: AnySendable],
        channel: MockStorageBridgeChannel,
        defaultBucket: String = "test.appspot.com"
    ) -> Bool {
        guard let method = op["method"]?.stringValue else { return false }
        let bucket = op["bucket"]?.stringValue ?? op["defaultBucket"]?.stringValue ?? defaultBucket

        switch method {
        case "storage.beginUpload":
            let path = op["path"]?.stringValue ?? ""
            let size = Int(op["size"]?.intValue ?? 0)
            let ct = op["contentType"]?.stringValue
            let meta = op["metadata"]?.dictionaryValue
            let uploadId: String = {
                lock.lock()
                defer { lock.unlock() }
                seq += 1
                let uid = "up-\(seq)"
                stagedById[uid] = Staged(
                    bucket: bucket,
                    path: path,
                    size: size,
                    contentType: ct,
                    metadata: meta
                )
                return uid
            }()
            channel.sendFromServer([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": [
                    "uploadId": uploadId,
                    "uploadUrl": "/__pyric/storage/v0/b/\(bucket)/o?name=\(path)&upload_id=\(uploadId)&upload_token=tok"
                ]
            ])
            return true

        case "storage.putPart":
            let uploadId = op["uploadId"]?.stringValue ?? ""
            let partIndex = Int(op["partIndex"]?.intValue ?? 0)
            let b64 = op["dataB64"]?.stringValue ?? ""
            let chunk = Data(base64Encoded: b64) ?? Data()
            let found: Bool = {
                lock.lock()
                defer { lock.unlock() }
                guard var staged = stagedById[uploadId] else { return false }
                staged.parts[partIndex] = chunk
                stagedById[uploadId] = staged
                putPartSizes.append(chunk.count)
                return true
            }()
            if found {
                channel.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": ["bytesTransferred": chunk.count]
                ])
            } else {
                channel.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": ["code": "storage/object-not-found", "message": "Unknown uploadId"]
                ])
            }
            return true

        case "storage.finishUpload":
            let uploadId = op["uploadId"]?.stringValue ?? ""
            let wantsRollback = op["rollback"]?.boolValue == true
            let staged: Staged? = {
                lock.lock()
                defer { lock.unlock() }
                return stagedById.removeValue(forKey: uploadId)
            }()
            guard let staged else {
                channel.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": ["code": "storage/object-not-found", "message": "Missing staged upload"]
                ])
                return true
            }
            var merged = Data()
            for idx in staged.parts.keys.sorted() {
                if let part = staged.parts[idx] {
                    merged.append(part)
                }
            }
            var stored = store.put(
                bucket: staged.bucket,
                path: staged.path,
                bytes: merged,
                contentType: staged.contentType,
                metadata: staged.metadata
            )
            if wantsRollback {
                let token = "rb-\(uploadId)"
                lock.lock()
                rollbackPaths[token] = (staged.bucket, staged.path)
                lock.unlock()
                stored["rollbackToken"] = token
            }
            channel.sendFromServer([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": stored
            ])
            return true

        case "storage.abortUpload":
            let uploadId = op["uploadId"]?.stringValue ?? ""
            lock.lock()
            stagedById.removeValue(forKey: uploadId)
            abortedUploadIds.append(uploadId)
            lock.unlock()
            channel.sendFromServer([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": NSNull()
            ])
            return true

        case "storage.rollbackUpload":
            let token = op["rollbackToken"]?.stringValue ?? ""
            let target: (bucket: String, path: String)? = {
                lock.lock()
                defer { lock.unlock() }
                rolledBackTokens.append(token)
                return rollbackPaths.removeValue(forKey: token)
            }()
            if let target {
                _ = store.delete(bucket: target.bucket, path: target.path)
            }
            channel.sendFromServer([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": ["deleted": target != nil, "restored": false]
            ])
            return true

        default:
            return false
        }
    }
}
