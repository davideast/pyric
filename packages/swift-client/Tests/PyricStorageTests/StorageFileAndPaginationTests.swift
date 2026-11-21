import Foundation
import Testing
@testable import PyricStorage
import PyricFirestore

@Suite("PyricStorage File I/O, Download Tasks & Cursor Pagination", .serialized)
struct StorageFileAndPaginationTests {
    private func makeIsolatedStorage(
        channel: MockStorageBridgeChannel,
        appName: String = "file-page-test-\(UUID().uuidString)"
    ) -> (FirebaseApp, Storage) {
        let options = FirebaseOptions(
            projectID: "demo-file-page",
            apiKey: "file-key",
            googleAppID: "1:111:ios:file",
            storageBucket: "test.appspot.com"
        )
        let app = FirebaseApp(name: appName, options: options)
        let client = PyricBridgeClient(channel: channel)
        let storage = Storage.storage(app: app, bridgeClient: client)
        storage.callbackQueue = DispatchQueue(label: "test.storage.file.\(appName)")
        return (app, storage)
    }

    private func makeFileAndListChannel(
        store: MockObjectStore,
        chunkHarness: MockChunkedUploadHarness
    ) -> MockStorageBridgeChannel {
        MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-file-\(UUID().uuidString)"
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }

            if chunkHarness.handleStorageOp(id: id, op: op, channel: chan) {
                return
            }
            switch op["method"]?.stringValue {
            case "storage.getBytes":
                let path = op["path"]?.stringValue ?? ""
                if let entry = store.get(bucket: "test.appspot.com", path: path) {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": true,
                        "value": [
                            "dataB64": entry.bytes.base64EncodedString(),
                            "contentType": entry.contentType,
                            "size": entry.bytes.count,
                            "generation": "\(entry.generation)"
                        ]
                    ])
                } else {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "storage/object-not-found", "message": "Not found"]
                    ])
                }
            case "storage.listAll":
                let prefix = op["path"]?.stringValue ?? ""
                let listed = store.list(bucket: "test.appspot.com", prefix: prefix)
                chan.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": ["prefixes": listed.prefixes, "items": listed.items]
                ])
            default:
                break
            }
        }
    }

    @Test("putFile / putFileAsync streams multi-chunk local files with MIME inference and Progress snapshots")
    func putFileStreamsMultiChunkWithMimeInferenceAndProgress() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeFileAndListChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        try await StorageTestScratchDir.withDirectory { dir in
            let sourceFile = dir.appendingPathComponent("dataset.json")
            let size = 540 * 1024
            var expectedBytes = Data(count: size)
            for idx in 0..<size { expectedBytes[idx] = UInt8((idx * 7 + 3) % 256) }
            try expectedBytes.write(to: sourceFile)

            let uploadProgress = TaskEventRecorder<Int64>()
            let objectRef = storage.reference(withPath: "datasets/dataset.json")
            let uploadedMeta = try await objectRef.putFileAsync(from: sourceFile) { progress in
                if let completed = progress?.completedUnitCount {
                    uploadProgress.append(completed)
                }
            }
            #expect(uploadedMeta.size == Int64(size))
            #expect(uploadedMeta.contentType == "application/json")
            #expect(harness.putPartSizes == [262_144, 262_144, 28_672])
            #expect(uploadProgress.values.contains(262_144))
            #expect(uploadProgress.values.contains(524_288))
            #expect(uploadProgress.values.last == Int64(size))

            // Explicit metadata.contentType overrides extension inference
            let pngFile = dir.appendingPathComponent("raw.png")
            try Data([0x89, 0x50, 0x4E, 0x47]).write(to: pngFile)
            let customMeta = StorageMetadata()
            customMeta.contentType = "application/x-custom-png"
            let overridden = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
                storage.reference(withPath: "datasets/raw.png").putFile(from: pngFile, metadata: customMeta) { res in
                    cont.resume(with: res)
                }
            }
            #expect(overridden.contentType == "application/x-custom-png")
        }
    }

    @Test("putFile and write(toFile:) round-trip 0-byte empty files without sending empty parts")
    func zeroBytePutFileAndWriteToFileRoundTrip() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeFileAndListChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        try await StorageTestScratchDir.withDirectory { dir in
            let emptySource = dir.appendingPathComponent("empty.txt")
            try Data().write(to: emptySource)
            let emptyRef = storage.reference(withPath: "datasets/empty.txt")
            let emptyMeta = try await emptyRef.putFileAsync(from: emptySource)
            #expect(emptyMeta.size == 0)
            #expect(emptyMeta.contentType == "text/plain")
            #expect(harness.putPartSizes.isEmpty)

            let emptyDest = dir.appendingPathComponent("empty-out.txt")
            let savedEmptyURL = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
                emptyRef.write(toFile: emptyDest) { result in
                    cont.resume(with: result)
                }
            }
            #expect(savedEmptyURL == emptyDest)
            #expect(try Data(contentsOf: emptyDest).isEmpty)
        }
    }

    @Test("putFile and write(toFile:) reject missing files, directories, non-file URLs, and root references")
    func fileIOValidatesInvalidFileURLsAndRootReference() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeFileAndListChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        try await StorageTestScratchDir.withDirectory { dir in
            let missingFile = dir.appendingPathComponent("does-not-exist.bin")
            var rejectedMissing = false
            do {
                _ = try await storage.reference(withPath: "bad/missing.bin").putFileAsync(from: missingFile)
            } catch StorageErrorCode.invalidArgument {
                rejectedMissing = true
            }
            #expect(rejectedMissing == true)

            var rejectedDirectory = false
            do {
                _ = try await storage.reference(withPath: "bad/dir.bin").putFileAsync(from: dir)
            } catch StorageErrorCode.invalidArgument {
                rejectedDirectory = true
            }
            #expect(rejectedDirectory == true)

            let remoteURL = try #require(URL(string: "https://example.com/file.bin"))
            var rejectedNonFileWrite = false
            do {
                _ = try await storage.reference(withPath: "bad/out.bin").writeAsync(toFile: remoteURL)
            } catch StorageErrorCode.invalidArgument {
                rejectedNonFileWrite = true
            }
            #expect(rejectedNonFileWrite == true)

            let validOut = dir.appendingPathComponent("root-out.bin")
            var rejectedRootWrite = false
            do {
                _ = try await storage.reference().writeAsync(toFile: validOut)
            } catch StorageErrorCode.invalidArgument {
                rejectedRootWrite = true
            }
            #expect(rejectedRootWrite == true)
        }
    }

    @Test("StorageDownloadTask streams writeAsync(toFile:onProgress:), enforces maxSize, and cancels without leaving partial files")
    func downloadTaskWriteProgressMaxSizeAndCancelCleanup() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let holdGetBytes = LockedBoolBox(false)
        let getBytesReached = AsyncStream<Void>.makeStream()

        let channel = MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-dl"
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }

            if op["method"]?.stringValue == "storage.getBytes" {
                if holdGetBytes.value {
                    getBytesReached.continuation.yield()
                    return
                }
                let path = op["path"]?.stringValue ?? ""
                if let entry = store.get(bucket: "test.appspot.com", path: path) {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": true,
                        "value": [
                            "dataB64": entry.bytes.base64EncodedString(),
                            "contentType": entry.contentType,
                            "size": entry.bytes.count,
                            "generation": "\(entry.generation)"
                        ]
                    ])
                }
                return
            }
            _ = harness.handleStorageOp(id: id, op: op, channel: chan)
        }

        let (_, storage) = makeIsolatedStorage(channel: channel)
        let bigData = Data(repeating: 0xAB, count: 550 * 1024)
        _ = store.put(bucket: "test.appspot.com", path: "dl/archive.tar", bytes: bigData, contentType: "application/x-tar", metadata: nil)
        let archiveRef = storage.reference(withPath: "dl/archive.tar")

        // 1. getData(maxSize:) returns observable StorageDownloadTask and rejects exceeded maxSize
        var exceeded = false
        do {
            _ = try await archiveRef.data(maxSize: 1024)
        } catch StorageErrorCode.downloadSizeExceeded {
            exceeded = true
        }
        #expect(exceeded == true)

        try await StorageTestScratchDir.withDirectory { dir in
            // 2. writeAsync creates nested directories and overwrites existing file atomically
            let destFile = dir.appendingPathComponent("nested/sub/archive.tar")
            let dlProgress = TaskEventRecorder<Int64>()
            let saved = try await archiveRef.writeAsync(toFile: destFile) { progress in
                if let completed = progress?.completedUnitCount {
                    dlProgress.append(completed)
                }
            }
            #expect(saved == destFile)
            #expect(try Data(contentsOf: destFile) == bigData)
            #expect(dlProgress.values.contains(262_144))
            #expect(dlProgress.values.last == Int64(bigData.count))

            // 3. Cancelled write(toFile:) leaves no file at destination
            holdGetBytes.value = true
            let cancelledFile = dir.appendingPathComponent("cancelled-archive.tar")
            let cancelOutcome = AsyncStream<Error?>.makeStream()
            let dlTask = archiveRef.write(toFile: cancelledFile) { _, err in
                cancelOutcome.continuation.yield(err)
            }
            var reachIter = getBytesReached.stream.makeAsyncIterator()
            _ = await reachIter.next()
            dlTask.pause()
            #expect(dlTask.snapshot.status == .pause)
            dlTask.resume()
            dlTask.cancel()

            var errIter = cancelOutcome.stream.makeAsyncIterator()
            let err = try #require(await errIter.next() ?? nil)
            #expect(StorageErrorCode.from(err).code == .cancelled)
            #expect(FileManager.default.fileExists(atPath: cancelledFile.path) == false)
        }
    }

    @Test("Cursor-based list(maxResults:pageToken:) paginates prefixes + items without skipping across mid-walk deletions")
    func cursorPaginationHandlesMixedEntriesAndMidWalkMutations() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeFileAndListChannel(store: store, chunkHarness: harness)

        _ = store.put(bucket: "test.appspot.com", path: "gallery/dir-b/nested.png", bytes: Data([1]), contentType: "image/png", metadata: nil)
        _ = store.put(bucket: "test.appspot.com", path: "gallery/dir-a/nested.png", bytes: Data([2]), contentType: "image/png", metadata: nil)
        _ = store.put(bucket: "test.appspot.com", path: "gallery/file-3.txt", bytes: Data([3]), contentType: "text/plain", metadata: nil)
        _ = store.put(bucket: "test.appspot.com", path: "gallery/file-1.txt", bytes: Data([4]), contentType: "text/plain", metadata: nil)
        _ = store.put(bucket: "test.appspot.com", path: "gallery/file-2.txt", bytes: Data([5]), contentType: "text/plain", metadata: nil)

        let (_, storage) = makeIsolatedStorage(channel: channel)
        let galleryRef = storage.reference(withPath: "gallery")

        let page1 = try await galleryRef.list(maxResults: 2)
        #expect(page1.prefixes.map(\.name) == ["dir-a", "dir-b"])
        #expect(page1.items.isEmpty)
        let token1 = try #require(page1.pageToken)

        // Delete dir-a BEFORE fetching page 2: cursor pagination must NOT skip file-1.txt
        _ = store.delete(bucket: "test.appspot.com", path: "gallery/dir-a/nested.png")

        let page2 = try await galleryRef.list(maxResults: 2, pageToken: token1)
        #expect(page2.prefixes.isEmpty)
        #expect(page2.items.map(\.name) == ["file-1.txt", "file-2.txt"])
        let token2 = try #require(page2.pageToken)

        let page3 = try await galleryRef.list(maxResults: 2, pageToken: token2)
        #expect(page3.prefixes.isEmpty)
        #expect(page3.items.map(\.name) == ["file-3.txt"])
        #expect(page3.pageToken == nil)
    }

    @Test("list(maxResults:pageToken:) rejects out-of-range maxResults and empty or malformed pageTokens")
    func listPaginationValidatesArguments() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeFileAndListChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)
        let ref = storage.reference(withPath: "gallery")

        for badMax: Int64 in [-5, 0, 1001] {
            var rejected = false
            do {
                _ = try await ref.list(maxResults: badMax)
            } catch StorageErrorCode.invalidArgument {
                rejected = true
            }
            #expect(rejected == true)
        }

        for badToken in ["", "   ", "not-a-valid-cursor!!!"] {
            var rejected = false
            do {
                _ = try await ref.list(maxResults: 2, pageToken: badToken)
            } catch StorageErrorCode.invalidArgument {
                rejected = true
            }
            #expect(rejected == true)
        }
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
