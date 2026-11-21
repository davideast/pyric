import Foundation
import Testing
@testable import PyricStorage
import PyricFirestore

@Suite("PyricStorage Edge-Case Hardening & Parity Suite", .serialized)
struct StorageEdgeCaseHardeningTests {
    private func makeIsolatedStorage(
        channel: MockStorageBridgeChannel,
        appName: String = "edge-case-\(UUID().uuidString)",
        defaultBucket: String = "edge-default.appspot.com"
    ) -> (FirebaseApp, Storage) {
        let options = FirebaseOptions(
            projectID: "demo-edge-storage",
            apiKey: "edge-api-key",
            googleAppID: "1:999:ios:edgeapp",
            storageBucket: defaultBucket
        )
        let app = FirebaseApp(name: appName, options: options)
        let client = PyricBridgeClient(channel: channel)
        let storage = Storage.storage(app: app, bridgeClient: client)
        storage.callbackQueue = DispatchQueue(label: "test.storage.edge.\(appName)")
        return (app, storage)
    }

    private func makeMockChannel(
        store: MockObjectStore,
        chunkHarness: MockChunkedUploadHarness,
        defaultBucket: String = "edge-default.appspot.com"
    ) -> MockStorageBridgeChannel {
        MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-edge-\(UUID().uuidString)"
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }

            if chunkHarness.handleStorageOp(id: id, op: op, channel: chan, defaultBucket: defaultBucket) {
                return
            }

            let bucket = op["bucket"]?.stringValue ?? op["defaultBucket"]?.stringValue ?? defaultBucket
            let path = op["path"]?.stringValue ?? ""

            switch op["method"]?.stringValue {
            case "storage.putBytes":
                let b64 = op["dataB64"]?.stringValue ?? ""
                let bytes = Data(base64Encoded: b64) ?? Data()
                let ct = op["contentType"]?.stringValue
                let meta = op["metadata"]?.dictionaryValue
                let stored = store.put(bucket: bucket, path: path, bytes: bytes, contentType: ct, metadata: meta)
                chan.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": stored])

            case "storage.getBytes":
                guard let entry = store.get(bucket: bucket, path: path) else {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "storage/object-not-found", "message": "Not found"]
                    ])
                    return
                }
                let offset = Int(op["offset"]?.intValue ?? 0)
                let slice: Data
                if let lengthVal = op["length"]?.intValue {
                    let end = min(offset + Int(lengthVal), entry.bytes.count)
                    slice = (offset < end) ? entry.bytes.subdata(in: offset..<end) : Data()
                } else {
                    slice = entry.bytes
                }
                chan.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": [
                        "dataB64": slice.base64EncodedString(),
                        "contentType": entry.contentType,
                        "size": entry.bytes.count,
                        "generation": "\(entry.generation)"
                    ]
                ])

            case "storage.getMetadata":
                if let entry = store.get(bucket: bucket, path: path) {
                    chan.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": store.serialize(entry)])
                } else {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "storage/object-not-found", "message": "Not found"]
                    ])
                }

            case "storage.listAll":
                let listed = store.list(bucket: bucket, prefix: path)
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

    @Test("0-byte putData / getData(maxSize: 0) succeeds while 1-byte object at maxSize 0 rejects with downloadSizeExceeded")
    func zeroBytePutDataAndZeroMaxSizeBoundary() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeMockChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        let emptyRef = storage.reference(withPath: "edge/zero.bin")
        let emptyMeta = try await emptyRef.putDataAsync(Data())
        #expect(emptyMeta.size == 0)

        let readZeroAsync = try await emptyRef.data(maxSize: 0)
        #expect(readZeroAsync.isEmpty)

        let readZeroCompletion = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            emptyRef.getData(maxSize: 0) { result in
                cont.resume(with: result)
            }
        }
        #expect(readZeroCompletion.isEmpty)

        let oneByteRef = storage.reference(withPath: "edge/one.bin")
        _ = try await oneByteRef.putDataAsync(Data([0x7F]))
        var rejectedAtZeroMax = false
        do {
            _ = try await oneByteRef.data(maxSize: 0)
        } catch StorageErrorCode.downloadSizeExceeded {
            rejectedAtZeroMax = true
        }
        #expect(rejectedAtZeroMax == true)
    }

    @Test("putDataAsync streams multi-chunk (> 256 KB) in-memory Data when uploadChunkSizeBytes is configured")
    func multiChunkPutDataAsyncWithCustomUploadChunkSize() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeMockChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)
        storage.uploadChunkSizeBytes = 262_144

        let totalBytes = 614_400 // 600 KiB = 262_144 + 262_144 + 90_112
        var payload = Data(count: totalBytes)
        for idx in 0..<totalBytes {
            payload[idx] = UInt8((idx * 17 + 11) % 256)
        }

        let progressRecorder = TaskEventRecorder<Int64>()
        let blobRef = storage.reference(withPath: "edge/multi-chunk-memory.bin")
        let meta = try await blobRef.putDataAsync(payload) { progress in
            if let completed = progress?.completedUnitCount {
                progressRecorder.append(completed)
            }
        }
        #expect(meta.size == Int64(totalBytes))
        #expect(harness.putPartSizes == [262_144, 262_144, 90_112])
        #expect(progressRecorder.values.contains(262_144))
        #expect(progressRecorder.values.contains(524_288))
        #expect(progressRecorder.values.last == Int64(totalBytes))

        let downloaded = try await blobRef.data(maxSize: 1_048_576)
        #expect(downloaded == payload)
    }

    @Test("Unicode, percent-reserved characters, and redundant slashes normalize and round-trip across gs:// and HTTP URLs")
    func unicodePercentReservedAndSlashNormalizedPaths() throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeMockChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        let unicodeDir = "caf\u{00E9}-\u{65E5}\u{672C}\u{8A9E}"
        let unicodeLeaf = "r\u{00E9}sum\u{00E9} #1 + 100% \u{1F680}.txt"
        let messyInput = "///\(unicodeDir)///nested//\(unicodeLeaf)///"
        let expectedNormalized = "\(unicodeDir)/nested/\(unicodeLeaf)"

        let ref = storage.reference(withPath: messyInput)
        #expect(ref.fullPath == expectedNormalized)
        #expect(ref.name == unicodeLeaf)
        #expect(ref.parent()?.fullPath == "\(unicodeDir)/nested")
        #expect(ref.parent()?.parent()?.fullPath == unicodeDir)
        #expect(ref.parent()?.parent()?.parent()?.fullPath == "")
        #expect(ref.parent()?.parent()?.parent()?.parent() == nil)

        let gsRef = storage.reference(forURL: "gs://edge-default.appspot.com///\(expectedNormalized)//")
        #expect(gsRef == ref)

        let endpoint = try #require(URL(string: "ws://127.0.0.1:9199/__pyric/sandbox"))
        let byteRouteURL = try #require(
            BridgeStorageTransport.buildObjectByteRouteURL(
                endpoint: endpoint,
                bucket: "edge-default.appspot.com",
                fullPath: expectedNormalized,
                generation: "42"
            )
        )
        let roundTrippedFromPyricHTTP = try storage.reference(for: byteRouteURL)
        #expect(roundTrippedFromPyricHTTP.fullPath == expectedNormalized)
        #expect(roundTrippedFromPyricHTTP.name == unicodeLeaf)

        let allowed = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        )
        let encodedObj = try #require(expectedNormalized.addingPercentEncoding(withAllowedCharacters: allowed))
        let firebaseCloudURL = try #require(
            URL(string: "https://firebasestorage.googleapis.com/v0/b/edge-default.appspot.com/o/\(encodedObj)?alt=media&token=abc")
        )
        let roundTrippedFromFirebaseHTTP = try storage.reference(for: firebaseCloudURL)
        #expect(roundTrippedFromFirebaseHTTP.fullPath == expectedNormalized)
    }

    @Test("downloadSizeExceeded and negative maxSize surface across getData completion, Result, async, and observer snapshots")
    func downloadSizeExceededAndNegativeMaxSizeSurfaceConsistently() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeMockChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        _ = store.put(
            bucket: "edge-default.appspot.com",
            path: "edge/oversized.bin",
            bytes: Data(repeating: 0x33, count: 2048),
            contentType: "application/octet-stream",
            metadata: nil
        )
        let ref = storage.reference(withPath: "edge/oversized.bin")

        let failureSnapshots = TaskEventRecorder<NSError>()
        let resultOutcome: Result<Data, Error> = await withCheckedContinuation { cont in
            let task = ref.getData(maxSize: 512) { result in
                cont.resume(returning: result)
            }
            task.observe(.failure) { snap in
                if let err = snap.error as NSError? {
                    failureSnapshots.append(err)
                }
            }
        }
        switch resultOutcome {
        case .success:
            Issue.record("Expected downloadSizeExceeded failure")
        case .failure(let err):
            let nsErr = err as NSError
            #expect(nsErr.domain == StorageErrorDomain)
            #expect(nsErr.code == StorageErrorCode.downloadSizeExceeded.rawValue)
            #expect(nsErr.userInfo["totalSize"] as? Int64 == 2048)
            #expect(nsErr.userInfo["maxAllowedSize"] as? Int64 == 512)
        }
        #expect(failureSnapshots.values.first?.code == StorageErrorCode.downloadSizeExceeded.rawValue)

        var negativeRejected = false
        do {
            _ = try await ref.data(maxSize: -1)
        } catch StorageErrorCode.invalidArgument {
            negativeRejected = true
        }
        #expect(negativeRejected == true)
    }

    @Test("updateMetadataWithRulesGate merges existing size, contentType, and customMetadata before probing Storage Rules")
    func updateMetadataRulesGateMergesExistingResourceFields() async throws {
        let store = MockObjectStore()
        _ = store.put(
            bucket: "edge-default.appspot.com",
            path: "validated/u1/config.json",
            bytes: Data(repeating: 0x41, count: 1536),
            contentType: "application/json",
            metadata: [
                "cacheControl": .string("private, max-age=30"),
                "customMetadata": .dictionary(["owner": .string("u1"), "env": .string("staging")])
            ]
        )

        let capturedBeginOps = TaskEventRecorder<[String: AnySendable]>()
        let denyWriteProbe = EdgeLockedFlag(false)

        let channel = MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-rules-gate"
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }

            let bucket = op["bucket"]?.stringValue ?? op["defaultBucket"]?.stringValue ?? "edge-default.appspot.com"
            let path = op["path"]?.stringValue ?? ""
            let isAdmin = op["actAs"]?.dictionaryValue?["mode"]?.stringValue == "admin"

            switch op["method"]?.stringValue {
            case "storage.setMetadata":
                if !isAdmin {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "storage/unauthorized", "message": "storage.setMetadata is the admin plane"]
                    ])
                    return
                }
                let patch = op["patch"]?.dictionaryValue ?? [:]
                if let updated = store.patch(bucket: bucket, path: path, patch: patch) {
                    chan.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": updated])
                } else {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "storage/object-not-found", "message": "Not found"]
                    ])
                }

            case "storage.getMetadata":
                if let entry = store.get(bucket: bucket, path: path) {
                    chan.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": store.serialize(entry)])
                } else {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "storage/object-not-found", "message": "Not found"]
                    ])
                }

            case "storage.beginUpload":
                capturedBeginOps.append(op)
                if denyWriteProbe.value {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "storage/unauthorized", "message": "Denied by Storage Rules"]
                    ])
                } else {
                    chan.sendFromServer([
                        "type": "worker-res",
                        "id": id,
                        "ok": true,
                        "value": ["uploadId": "probe-1", "uploadUrl": "/__pyric/storage/v0/b/\(bucket)/o"]
                    ])
                }

            case "storage.abortUpload":
                chan.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": NSNull()])

            default:
                break
            }
        }

        let (_, storage) = makeIsolatedStorage(channel: channel)
        let configRef = storage.reference(withPath: "validated/u1/config.json")

        // Partial patch setting ONLY cacheControl must probe beginUpload with existing size + contentType + customMetadata
        let partialPatch = StorageMetadata()
        partialPatch.cacheControl = "public, max-age=900"
        let updated = try await configRef.updateMetadata(partialPatch)
        #expect(updated.cacheControl == "public, max-age=900")
        #expect(updated.contentType == "application/json")
        #expect(updated.customMetadata == ["owner": "u1", "env": "staging"])

        let probeOp = try #require(capturedBeginOps.values.first)
        #expect(probeOp["size"]?.intValue == 1536)
        #expect(probeOp["contentType"]?.stringValue == "application/json")
        let probeMeta = probeOp["metadata"]?.dictionaryValue
        #expect(probeMeta?["cacheControl"]?.stringValue == "public, max-age=900")
        #expect(probeMeta?["customMetadata"]?.dictionaryValue?["owner"]?.stringValue == "u1")

        // Denied write on missing object must surface StorageErrorCode.unauthorized (never leaking objectNotFound)
        denyWriteProbe.value = true
        var unauthorizedOnMissing = false
        do {
            _ = try await storage.reference(withPath: "validated/other/missing.json").updateMetadata(partialPatch)
        } catch StorageErrorCode.unauthorized {
            unauthorizedOnMissing = true
        }
        #expect(unauthorizedOnMissing == true)

        // Authorized write on missing object surfaces StorageErrorCode.objectNotFound
        denyWriteProbe.value = false
        var notFoundWhenAuthorized = false
        do {
            _ = try await storage.reference(withPath: "validated/u1/missing.json").updateMetadata(partialPatch)
        } catch StorageErrorCode.objectNotFound {
            notFoundWhenAuthorized = true
        }
        #expect(notFoundWhenAuthorized == true)
    }

    @Test("Concurrent uploads and downloads isolate mid-flight and immediate task cancellations without stalling FIFO turns")
    func concurrentUploadsDownloadsAndCancellationIsolation() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeMockChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)
        storage.uploadChunkSizeBytes = 262_144

        let seedPayload = Data(repeating: 0x5A, count: 300 * 1024)
        _ = store.put(
            bucket: "edge-default.appspot.com",
            path: "concurrent/seed.bin",
            bytes: seedPayload,
            contentType: "application/octet-stream",
            metadata: nil
        )

        // Immediately cancel a download right after enqueue() to exercise FIFO turn pass-through
        let immediateCancelTask = storage.reference(withPath: "concurrent/seed.bin").getData(maxSize: 1_000_000) { _, _ in }
        immediateCancelTask.cancel()

        // Launch 3 concurrent multi-chunk uploads + 1 paused-then-cancelled upload + 2 concurrent downloads
        let cancelledUpload = storage.reference(withPath: "concurrent/aborted.bin").putData(seedPayload)
        cancelledUpload.pause()
        cancelledUpload.cancel()

        try await withThrowingTaskGroup(of: Void.self) { group in
            for idx in 0..<3 {
                group.addTask {
                    let expected = Data(repeating: UInt8(0x10 + idx), count: 320 * 1024)
                    let ref = storage.reference(withPath: "concurrent/item-\(idx).bin")
                    let meta = try await ref.putDataAsync(expected)
                    #expect(meta.size == Int64(expected.count))
                    let roundTrip = try await ref.data(maxSize: 1_000_000)
                    #expect(roundTrip == expected)
                }
            }
            for _ in 0..<2 {
                group.addTask {
                    let downloaded = try await storage.reference(withPath: "concurrent/seed.bin").data(maxSize: 1_000_000)
                    #expect(downloaded == seedPayload)
                }
            }
            try await group.waitForAll()
        }

        #expect(store.get(bucket: "edge-default.appspot.com", path: "concurrent/aborted.bin") == nil)
    }

    @Test("Custom gs:// bucket URLs isolate wire buckets and reject mismatched or malformed URLs")
    func customGsBucketUrlVariantsAndMismatchErrors() throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeMockChannel(store: store, chunkHarness: harness)
        let (app, defaultStorage) = makeIsolatedStorage(channel: channel)
        let customA = Storage.storage(app: app, url: "gs://custom-archive", bridgeClient: defaultStorage.bridgeClient)
        let customATrailing = Storage.storage(app: app, url: "gs://custom-archive/", bridgeClient: defaultStorage.bridgeClient)
        #expect(customA === customATrailing)
        #expect(customA !== defaultStorage)
        #expect(customA.reference(withPath: "a/b.txt").bucket == "custom-archive")
        #expect(customA.reference(withPath: "a/b.txt").bucketWireParams["bucket"]?.stringValue == "custom-archive")

        var sawBucketMismatch = false
        do {
            _ = try customA.validatedReference(forURL: "gs://other-bucket/a/b.txt")
        } catch StorageErrorCode.bucketMismatch {
            sawBucketMismatch = true
        }
        #expect(sawBucketMismatch == true)

        var sawPathError = false
        do {
            _ = try customA.validatedReference(forURL: "ftp://custom-archive/a/b.txt")
        } catch StorageErrorCode.pathError {
            sawPathError = true
        }
        #expect(sawPathError == true)

        var sawNonRootBucketError = false
        do {
            _ = try Storage.validatedStorage(app: app, url: "gs://custom-archive/subpath")
        } catch StorageErrorCode.invalidArgument {
            sawNonRootBucketError = true
        }
        #expect(sawNonRootBucketError == true)
    }

    @Test("Swift 6 strict Sendable types tolerate concurrent reads and mutations across TaskGroup child tasks")
    func swift6SendableConcurrentAccessSafety() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeMockChannel(store: store, chunkHarness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)
        let sharedMeta = StorageMetadata()
        sharedMeta.contentType = "text/plain"
        let rootRef = storage.reference(withPath: "sendable")
        let listResult = StorageListResult(
            prefixes: [rootRef.child("sub")],
            items: [rootRef.child("doc.txt")],
            pageToken: "tok-1"
        )

        try await withThrowingTaskGroup(of: String.self) { group in
            for idx in 0..<16 {
                group.addTask {
                    storage.maxOperationRetryTime = TimeInterval(60 + idx)
                    sharedMeta.cacheControl = "max-age=\(idx)"
                    sharedMeta.customMetadata = ["worker": "\(idx)"]
                    let dict = sharedMeta.dictionaryRepresentation()
                    let childRef = listResult.items[0].child("leaf-\(idx)")
                    _ = dict["cacheControl"]
                    return childRef.fullPath
                }
            }
            var collected: [String] = []
            for try await path in group {
                collected.append(path)
            }
            #expect(collected.count == 16)
        }
    }
}

private final class EdgeLockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var raw: Bool
    init(_ initial: Bool) { self.raw = initial }
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return raw }
        set { lock.lock(); raw = newValue; lock.unlock() }
    }
}
