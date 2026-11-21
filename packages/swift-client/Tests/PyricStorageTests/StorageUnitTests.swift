import Foundation
import Testing
@testable import PyricStorage
import PyricFirestore
import FirebaseAuth

@Suite("PyricStorage Unit Suite", .serialized)
struct StorageUnitTests {

    private func resetGlobalState() {
        Storage.reset()
        Auth.reset()
        FirebaseApp.resetAppsForTesting()
    }

    @Test("Instance caching scopes Storage per FirebaseApp and per gs:// bucket URL, and reset() evicts")
    func instanceCachingPerAppAndPerBucket() async throws {
        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            resetGlobalState()
            defer { resetGlobalState() }

            FirebaseApp.configure(
                options: FirebaseOptions(
                    projectID: "demo-storage-unit",
                    googleAppID: "1:111111111111:ios:storageunit",
                    storageBucket: "demo-storage-unit.appspot.com"
                )
            )
            let defaultStorageA = Storage.storage()
            let defaultStorageB = Storage.storage(app: FirebaseApp.app())
            let explicitDefaultBucket = Storage.storage(url: "gs://demo-storage-unit.appspot.com")
            #expect(defaultStorageA === defaultStorageB)
            #expect(defaultStorageA === explicitDefaultBucket)
            #expect(defaultStorageA.reference().bucket == "demo-storage-unit.appspot.com")

            let customBucketStorage = Storage.storage(url: "gs://secondary-assets-bucket/")
            #expect(customBucketStorage !== defaultStorageA)
            #expect(customBucketStorage.reference().bucket == "secondary-assets-bucket")

            FirebaseApp.configure(
                name: "other-app",
                options: FirebaseOptions(
                    projectID: "demo-storage-unit",
                    googleAppID: "1:111111111111:ios:otherapp",
                    storageBucket: "demo-storage-unit.appspot.com"
                )
            )
            let otherApp = try #require(FirebaseApp.app(name: "other-app"))
            let otherAppStorage = Storage.storage(app: otherApp)
            #expect(otherAppStorage !== defaultStorageA)
            #expect(otherAppStorage.app === otherApp)

            #expect(defaultStorageA.maxUploadRetryTime == 600.0)
            #expect(defaultStorageA.maxDownloadRetryTime == 600.0)
            #expect(defaultStorageA.maxOperationRetryTime == 120.0)
            #expect(defaultStorageA.uploadChunkSizeBytes == .max)

            defaultStorageA.maxUploadRetryTime = 45.0
            defaultStorageA.maxDownloadRetryTime = 90.0
            defaultStorageA.maxOperationRetryTime = 30.0
            defaultStorageA.uploadChunkSizeBytes = 100_000
            #expect(defaultStorageA.maxUploadRetryTime == 45.0)
            #expect(defaultStorageA.maxDownloadRetryTime == 90.0)
            #expect(defaultStorageA.maxOperationRetryTime == 30.0)
            #expect(defaultStorageA.uploadChunkSizeBytes == 262_144)

            defaultStorageA.uploadChunkSizeBytes = 600_000
            #expect(defaultStorageA.uploadChunkSizeBytes == 524_288)

            defaultStorageA.useEmulator(withHost: "127.0.0.1", port: 9199)
            #expect(defaultStorageA.emulatorConfiguration?.host == "127.0.0.1")
            #expect(defaultStorageA.emulatorConfiguration?.port == 9199)

            #expect(throws: StorageErrorCode.invalidArgument) {
                _ = try Storage.validatedStorage(app: otherApp, url: "https://not-gs.example.com")
            }
            #expect(throws: StorageErrorCode.invalidArgument) {
                _ = try Storage.validatedStorage(app: otherApp, url: "gs://bucket-with-path/folder/file.txt")
            }

            Storage.reset()
            let freshDefault = Storage.storage()
            #expect(freshDefault !== defaultStorageA)
        }
    }

    @Test("StorageReference navigation, slash normalization, and URL parsing match FirebaseStorage")
    func referenceHierarchyAndURLParsing() throws {
        let app = FirebaseApp(
            name: "ref-nav-app",
            options: FirebaseOptions(projectID: "demo-ref", storageBucket: "demo-ref.appspot.com")
        )
        let storage = Storage(
            app: app,
            storageBucket: "demo-ref.appspot.com",
            isNamedBucket: false,
            configuredDefaultBucket: "demo-ref.appspot.com"
        )

        let root = storage.reference()
        #expect(root.fullPath == "")
        #expect(root.name == "")
        #expect(root.parent() == nil)
        #expect(root.description == "gs://demo-ref.appspot.com/")

        let nested = storage.reference(withPath: "//users///uid-1/avatars/photo.png/")
        #expect(nested.fullPath == "users/uid-1/avatars/photo.png")
        #expect(nested.name == "photo.png")
        #expect(nested.bucket == "demo-ref.appspot.com")
        #expect(nested.description == "gs://demo-ref.appspot.com/users/uid-1/avatars/photo.png")

        let avatarsFolder = try #require(nested.parent())
        #expect(avatarsFolder.fullPath == "users/uid-1/avatars")
        #expect(avatarsFolder.name == "avatars")
        #expect(avatarsFolder.root() == root)

        let fromGs = storage.reference(forURL: "gs://demo-ref.appspot.com/users/uid-1/avatars/photo.png")
        #expect(fromGs == nested)

        let fromProdHttp = try storage.reference(
            for: try #require(
                URL(string: "https://firebasestorage.googleapis.com/v0/b/demo-ref.appspot.com/o/users%2Fuid-1%2Favatars%2Fphoto.png?alt=media&token=abc")
            )
        )
        #expect(fromProdHttp == nested)

        let fromPyricRoute = try storage.reference(
            for: try #require(
                URL(string: "http://127.0.0.1:5174/__pyric/storage/v0/b/demo-ref.appspot.com/o/users%2Fuid-1%2Favatars%2Fphoto.png?alt=media&token=xyz")
            )
        )
        #expect(fromPyricRoute == nested)

        var caughtBucketMismatch = false
        do {
            _ = try storage.reference(for: try #require(URL(string: "gs://wrong-bucket/users/file.txt")))
        } catch StorageErrorCode.bucketMismatch {
            caughtBucketMismatch = true
        }
        #expect(caughtBucketMismatch == true)

        var caughtPathError = false
        do {
            _ = try storage.validatedReference(forURL: "ftp://demo-ref.appspot.com/file.txt")
        } catch StorageErrorCode.pathError {
            caughtPathError = true
        }
        #expect(caughtPathError == true)
    }

    @Test("StorageMetadata fields, customMetadata, and dictionaryRepresentation round-trip cleanly")
    func metadataFieldsAndDictionaryRepresentation() throws {
        let dict: [String: AnyHashable] = [
            "bucket": "meta-bucket.appspot.com",
            "name": "docs/report.pdf",
            "size": Int64(2048),
            "generation": "7",
            "metageneration": "3",
            "timeCreated": "2026-02-01T10:00:00.000Z",
            "updated": "2026-02-01T10:30:00.000Z",
            "md5Hash": "rL0Y20zC+Fzt72VPzMSk2A==",
            "cacheControl": "public, max-age=3600",
            "contentDisposition": "inline; filename=\"report.pdf\"",
            "contentEncoding": "identity",
            "contentLanguage": "en-US",
            "contentType": "application/pdf",
            "metadata": ["author": "ada", "version": "v1"]
        ]
        let meta = StorageMetadata(dictionary: dict)
        #expect(meta.bucket == "meta-bucket.appspot.com")
        #expect(meta.path == "docs/report.pdf")
        #expect(meta.name == "report.pdf")
        #expect(meta.size == 2048)
        #expect(meta.generation == 7)
        #expect(meta.metageneration == 3)
        #expect(meta.timeCreated != nil)
        #expect(meta.updated != nil)
        #expect(meta.md5Hash == "rL0Y20zC+Fzt72VPzMSk2A==")
        #expect(meta.cacheControl == "public, max-age=3600")
        #expect(meta.contentDisposition == "inline; filename=\"report.pdf\"")
        #expect(meta.contentEncoding == "identity")
        #expect(meta.contentLanguage == "en-US")
        #expect(meta.contentType == "application/pdf")
        #expect(meta.customMetadata == ["author": "ada", "version": "v1"])
        #expect(meta.isFile == true)
        #expect(meta.isFolder == false)

        let exported = meta.dictionaryRepresentation()
        #expect(exported["bucket"] as? String == "meta-bucket.appspot.com")
        #expect(exported["name"] as? String == "docs/report.pdf")
        #expect(exported["size"] as? Int64 == 2048)
        #expect(exported["generation"] as? String == "7")
        #expect(exported["metageneration"] as? String == "3")
        #expect(exported["contentType"] as? String == "application/pdf")
        #expect(exported["metadata"] as? [String: String] == ["author": "ada", "version": "v1"])
    }

    @Test("StorageErrorDomain, raw values, wire mappings, NSError bridging, and ~= pattern matching")
    func errorCodesAndPatternMatching() {
        #expect(StorageErrorDomain == "FIRStorageErrorDomain")
        #expect(StorageErrorCode.unknown.rawValue == -13000)
        #expect(StorageErrorCode.objectNotFound.rawValue == -13010)
        #expect(StorageErrorCode.bucketNotFound.rawValue == -13011)
        #expect(StorageErrorCode.projectNotFound.rawValue == -13012)
        #expect(StorageErrorCode.quotaExceeded.rawValue == -13013)
        #expect(StorageErrorCode.unauthenticated.rawValue == -13020)
        #expect(StorageErrorCode.unauthorized.rawValue == -13021)
        #expect(StorageErrorCode.retryLimitExceeded.rawValue == -13030)
        #expect(StorageErrorCode.nonMatchingChecksum.rawValue == -13031)
        #expect(StorageErrorCode.downloadSizeExceeded.rawValue == -13032)
        #expect(StorageErrorCode.cancelled.rawValue == -13040)
        #expect(StorageErrorCode.invalidArgument.rawValue == -13050)
        #expect(StorageErrorCode.bucketMismatch.rawValue == -13051)
        #expect(StorageErrorCode.internalError.rawValue == -13052)

        let wireMappings: [(String, StorageErrorCode)] = [
            ("storage/unknown", .unknown),
            ("storage/object-not-found", .objectNotFound),
            ("storage/bucket-not-found", .bucketNotFound),
            ("storage/project-not-found", .projectNotFound),
            ("storage/quota-exceeded", .quotaExceeded),
            ("payload-too-large", .quotaExceeded),
            ("storage/unauthenticated", .unauthenticated),
            ("storage/unauthorized", .unauthorized),
            ("storage/retry-limit-exceeded", .retryLimitExceeded),
            ("storage/non-matching-checksum", .nonMatchingChecksum),
            ("storage/download-size-exceeded", .downloadSizeExceeded),
            ("storage/canceled", .cancelled),
            ("storage/invalid-argument", .invalidArgument),
            ("storage/invalid-root-operation", .invalidArgument),
            ("storage/bucket-mismatch", .bucketMismatch),
            ("storage/internal-error", .internalError)
        ]

        for (wireCode, expected) in wireMappings {
            let bridgeErr = PyricBridgeError.fromCode(code: wireCode, message: "test \(wireCode)")
            let mapped: Error = StorageErrorCode.from(bridgeErr)
            let nsErr = mapped as NSError
            #expect(nsErr.domain == StorageErrorDomain)
            #expect(nsErr.code == expected.rawValue)
            #expect(expected ~= mapped)
            #expect(expected ~= nsErr)
        }
    }

    @Test("Async, completion, and Result CRUD operations work end-to-end over MockStorageBridgeChannel")
    func mockBridgeAsyncAndCompletionCRUD() async throws {
        let store = MockObjectStore()
        let channel = MockStorageBridgeChannel { frame, transport in
            let type = frame["type"]?.stringValue
            if type == "attach" {
                transport.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "clientSessionId": "swift-storage-mock"
                ])
                return
            }
            guard type == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue,
                  let method = op["method"]?.stringValue else {
                return
            }
            let bucket = op["bucket"]?.stringValue ?? op["defaultBucket"]?.stringValue ?? "mock-bucket.appspot.com"
            let path = op["path"]?.stringValue ?? ""

            switch method {
            case "storage.putBytes":
                let bytes = Data(base64Encoded: op["dataB64"]?.stringValue ?? "") ?? Data()
                let meta = store.put(
                    bucket: bucket,
                    path: path,
                    bytes: bytes,
                    contentType: op["contentType"]?.stringValue,
                    metadata: op["metadata"]?.dictionaryValue
                )
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": meta])
            case "storage.getBytes":
                guard let entry = store.get(bucket: bucket, path: path) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Not found"]])
                    return
                }
                transport.sendFromServer([
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
            case "storage.getMetadata":
                guard let entry = store.get(bucket: bucket, path: path) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Not found"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": store.serialize(entry)])
            case "storage.setMetadata":
                let patch = op["patch"]?.dictionaryValue ?? [:]
                guard let updated = store.patch(bucket: bucket, path: path, patch: patch) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Not found"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": updated])
            case "storage.getDownloadURL":
                guard let urlPath = store.mintDownloadPath(bucket: bucket, path: path) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Not found"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": ["path": urlPath]])
            case "storage.listAll":
                let listed = store.list(bucket: bucket, prefix: path)
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": ["prefixes": listed.prefixes, "items": listed.items]])
            case "storage.deleteObject":
                guard store.delete(bucket: bucket, path: path) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Not found"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": NSNull()])
            default:
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/unknown", "message": "Unhandled \(method)"]])
            }
        }

        let bridge = PyricBridgeClient(channel: channel, endpoint: URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!)
        let app = FirebaseApp(name: "mock-crud-app", options: FirebaseOptions(projectID: "mock-proj", storageBucket: "mock-bucket.appspot.com"))
        let storage = Storage(app: app, storageBucket: "mock-bucket.appspot.com", isNamedBucket: false, configuredDefaultBucket: "mock-bucket.appspot.com", bridgeClient: bridge)
        storage.callbackQueue = DispatchQueue(label: "test.storage.callbacks")

        var rootPutRejected = false
        do {
            _ = try await storage.reference().putDataAsync(Data("x".utf8))
        } catch StorageErrorCode.invalidArgument {
            rootPutRejected = true
        }
        #expect(rootPutRejected == true)

        let noteRef = storage.reference(withPath: "docs/notes/hello.txt")
        let initialMeta = StorageMetadata()
        initialMeta.contentType = "text/plain"
        initialMeta.cacheControl = "public, max-age=60"
        initialMeta.customMetadata = ["env": "unit", "owner": "swift"]

        let uploadedMeta = try await noteRef.putDataAsync(Data("hello swift storage".utf8), metadata: initialMeta)
        #expect(uploadedMeta.size == 19)
        #expect(uploadedMeta.contentType == "text/plain")
        #expect(uploadedMeta.customMetadata == ["env": "unit", "owner": "swift"])

        let siblingRef = storage.reference(withPath: "docs/sub/second.txt")
        let siblingMeta = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
            siblingRef.putData(Data("second".utf8), metadata: nil) { result in
                cont.resume(with: result)
            }
        }
        #expect(siblingMeta.size == 6)

        let downloaded = try await noteRef.data(maxSize: 1024)
        #expect(String(data: downloaded, encoding: .utf8) == "hello swift storage")

        var caughtSizeOverflow = false
        do {
            _ = try await noteRef.data(maxSize: 5)
        } catch StorageErrorCode.downloadSizeExceeded {
            caughtSizeOverflow = true
        }
        #expect(caughtSizeOverflow == true)

        let dlURL = try await noteRef.downloadURL()
        #expect(dlURL.absoluteString.contains("/__pyric/storage/v0/b/mock-bucket.appspot.com/o/docs%2Fnotes%2Fhello.txt"))
        #expect(dlURL.absoluteString.contains("token="))

        let fetchedMeta = try await noteRef.metadata()
        #expect(fetchedMeta.metageneration == 1)

        let patchMeta = StorageMetadata()
        patchMeta.cacheControl = "no-cache"
        patchMeta.customMetadata = ["env": "prod"]
        let updatedMeta = try await noteRef.updateMetadata(patchMeta)
        #expect(updatedMeta.metageneration == 2)
        #expect(updatedMeta.cacheControl == "no-cache")
        #expect(updatedMeta.customMetadata?["env"] == "prod")

        let docsRef = storage.reference(withPath: "docs")
        _ = try await storage.reference(withPath: "docs/readme.md").putDataAsync(Data("# docs".utf8))
        let listedAll = try await docsRef.listAll()
        #expect(listedAll.prefixes.map(\.fullPath) == ["docs/notes", "docs/sub"])
        #expect(listedAll.items.map(\.fullPath) == ["docs/readme.md"])
        #expect(listedAll.pageToken == nil)

        let page1 = try await docsRef.list(maxResults: 2)
        #expect(page1.prefixes.count == 2)
        #expect(page1.items.isEmpty)
        let token = try #require(page1.pageToken)
        let page2 = try await docsRef.list(maxResults: 2, pageToken: token)
        #expect(page2.prefixes.isEmpty)
        #expect(page2.items.map(\.fullPath) == ["docs/readme.md"])
        #expect(page2.pageToken == nil)

        var badMaxResults = false
        do {
            _ = try await docsRef.list(maxResults: 0)
        } catch StorageErrorCode.invalidArgument {
            badMaxResults = true
        }
        #expect(badMaxResults == true)

        try await noteRef.delete()
        var missingAfterDelete = false
        do {
            _ = try await noteRef.getMetadata()
        } catch StorageErrorCode.objectNotFound {
            missingAfterDelete = true
        }
        #expect(missingAfterDelete == true)

        await bridge.disconnect()
    }
}
