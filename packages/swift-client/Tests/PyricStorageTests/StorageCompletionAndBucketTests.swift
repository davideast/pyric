import Foundation
import Testing
@testable import PyricStorage
import PyricFirestore
import FirebaseAuth

@Suite("PyricStorage Completion & Bucket Isolation Suite", .serialized)
struct StorageCompletionAndBucketTests {

    private func makeMockClientAndStore(defaultBucket: String = "primary.appspot.com") -> (PyricBridgeClient, MockStorageBridgeChannel, MockObjectStore) {
        let store = MockObjectStore()
        let channel = MockStorageBridgeChannel { frame, transport in
            let type = frame["type"]?.stringValue
            if type == "attach" {
                transport.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "clientSessionId": "swift-storage-completion-mock"
                ])
                return
            }
            guard type == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue,
                  let method = op["method"]?.stringValue else {
                return
            }
            let bucket = op["bucket"]?.stringValue ?? op["defaultBucket"]?.stringValue ?? defaultBucket
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
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Missing"]])
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
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Missing"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": store.serialize(entry)])
            case "storage.setMetadata", "storage.updateMetadata":
                let patch = op["patch"]?.dictionaryValue ?? [:]
                guard let updated = store.patch(bucket: bucket, path: path, patch: patch) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Missing"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": updated])
            case "storage.getDownloadURL":
                guard let urlPath = store.mintDownloadPath(bucket: bucket, path: path) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Missing"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": ["path": urlPath]])
            case "storage.listAll":
                let listed = store.list(bucket: bucket, prefix: path)
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": ["prefixes": listed.prefixes, "items": listed.items]])
            case "storage.deleteObject":
                guard store.delete(bucket: bucket, path: path) else {
                    transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/object-not-found", "message": "Missing"]])
                    return
                }
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": NSNull()])
            default:
                transport.sendFromServer(["type": "worker-res", "id": id, "ok": false, "error": ["code": "storage/unknown", "message": "Unknown"]])
            }
        }
        let client = PyricBridgeClient(channel: channel, endpoint: URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!)
        return (client, channel, store)
    }

    @Test("Completion-handler and Result overloads deliver values and NSError codes on callbackQueue")
    func completionAndResultOverloadsDeliverValuesAndErrors() async throws {
        let (bridge, _, _) = makeMockClientAndStore()
        let app = FirebaseApp(name: "completion-app", options: FirebaseOptions(projectID: "comp-proj", storageBucket: "primary.appspot.com"))
        let storage = Storage(app: app, storageBucket: "primary.appspot.com", isNamedBucket: false, configuredDefaultBucket: "primary.appspot.com", bridgeClient: bridge)
        storage.callbackQueue = DispatchQueue(label: "test.completion.queue")

        let fileRef = storage.reference(withPath: "items/alpha.txt")
        let putMeta = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
            fileRef.putData(Data("alpha-bytes".utf8), metadata: nil) { meta, err in
                if let err { cont.resume(throwing: err) }
                else if let meta { cont.resume(returning: meta) }
            }
        }
        #expect(putMeta.size == 11)

        let getDataBytes = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            fileRef.getData(maxSize: 1024) { result in
                cont.resume(with: result)
            }
        }
        #expect(String(data: getDataBytes, encoding: .utf8) == "alpha-bytes")

        let dataBytes = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            fileRef.data(maxSize: 1024) { data, err in
                if let err { cont.resume(throwing: err) }
                else if let data { cont.resume(returning: data) }
            }
        }
        #expect(dataBytes == getDataBytes)

        let urlResult = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            fileRef.downloadURL { result in
                cont.resume(with: result)
            }
        }
        #expect(urlResult.absoluteString.contains("token="))

        let metaResult = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
            fileRef.getMetadata { result in
                cont.resume(with: result)
            }
        }
        #expect(metaResult.name == "alpha.txt")

        let patch = StorageMetadata()
        patch.contentLanguage = "fr"
        let updatedResult = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
            fileRef.updateMetadata(patch) { result in
                cont.resume(with: result)
            }
        }
        #expect(updatedResult.contentLanguage == "fr")

        let listedAll = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageListResult, Error>) in
            storage.reference(withPath: "items").listAll { result in
                cont.resume(with: result)
            }
        }
        #expect(listedAll.items.map(\.name) == ["alpha.txt"])

        let listedPage = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageListResult, Error>) in
            storage.reference(withPath: "items").list(maxResults: 10) { result in
                cont.resume(with: result)
            }
        }
        #expect(listedPage.items.count == 1)

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            fileRef.delete { err in
                if let err { cont.resume(throwing: err) }
                else { cont.resume() }
            }
        }

        // Missing object over completion callback surfaces NSError in StorageErrorDomain with .objectNotFound.
        let missingError = await withCheckedContinuation { (cont: CheckedContinuation<NSError?, Never>) in
            fileRef.getMetadata { _, err in
                cont.resume(returning: err as NSError?)
            }
        }
        let resolvedError = try #require(missingError)
        #expect(resolvedError.domain == StorageErrorDomain)
        #expect(resolvedError.code == StorageErrorCode.objectNotFound.rawValue)

        await bridge.disconnect()
    }

    @Test("Named gs:// bucket sends explicit bucket wire field while default bucket sends defaultBucket")
    func namedBucketWireIsolation() async throws {
        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            Storage.reset()
            defer { Storage.reset() }

            let (bridge, channel, _) = makeMockClientAndStore(defaultBucket: "app-default.appspot.com")
            let app = FirebaseApp(
                name: "multi-bucket-app",
                options: FirebaseOptions(projectID: "multi-proj", storageBucket: "app-default.appspot.com")
            )
            let defaultStorage = Storage.storage(app: app, bridgeClient: bridge)
            let archiveStorage = Storage.storage(app: app, url: "gs://archive-vault", bridgeClient: bridge)

            _ = try await defaultStorage.reference(withPath: "shared/item.txt").putDataAsync(Data("from-default".utf8))
            _ = try await archiveStorage.reference(withPath: "shared/item.txt").putDataAsync(Data("from-archive".utf8))

            let defaultBytes = try await defaultStorage.reference(withPath: "shared/item.txt").data(maxSize: 256)
            let archiveBytes = try await archiveStorage.reference(withPath: "shared/item.txt").data(maxSize: 256)
            #expect(String(data: defaultBytes, encoding: .utf8) == "from-default")
            #expect(String(data: archiveBytes, encoding: .utf8) == "from-archive")

            let ops = channel.recordedOps
            #expect(ops.count >= 4)
            #expect(ops[0]["bucket"] == nil)
            #expect(ops[0]["defaultBucket"]?.stringValue == "app-default.appspot.com")
            #expect(ops[1]["bucket"]?.stringValue == "archive-vault")
            #expect(ops[1]["defaultBucket"]?.stringValue == "app-default.appspot.com")

            await bridge.disconnect()
        }
    }

    @Test("Metadata clearing sets null on removed customMetadata keys and cleared settable fields")
    func metadataPatchClearsRemovedKeysAndFields() {
        let existing = StorageMetadata(dictionary: [
            "bucket": "b",
            "name": "doc.txt",
            "cacheControl": "public, max-age=60",
            "contentLanguage": "en",
            "metadata": ["keep": "1", "removeMe": "old"]
        ])
        existing.cacheControl = nil
        existing.customMetadata = ["keep": "2", "added": "3"]

        let patch = existing.toAdminPatchWire(existingCustomKeys: ["keep", "removeMe"])
        let settable = patch["settable"]?.dictionaryValue
        #expect(settable?["cacheControl"] == .null)
        #expect(settable?["contentLanguage"] == nil)

        let custom = patch["customMetadata"]?.dictionaryValue
        #expect(custom?["keep"]?.stringValue == "2")
        #expect(custom?["added"]?.stringValue == "3")
        #expect(custom?["removeMe"] == .null)
    }

    @Test("Live-host missing-object operations surface StorageErrorCode.objectNotFound and unauthenticated writes surface unauthorized")
    func liveHostMissingObjectAndUnauthenticatedMatrix() async throws {
        guard let rawBridgeUrl = ProcessInfo.processInfo.environment["PYRIC_LIVE_STORAGE_BRIDGE_URL"],
              !rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let parsedUrl = try #require(URL(string: rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines)))
        let host = try #require(parsedUrl.host)
        let port = try #require(parsedUrl.port)

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            Storage.reset()
            Auth.reset()
            FirebaseApp.resetAppsForTesting()
            defer {
                Storage.reset()
                Auth.reset()
                FirebaseApp.resetAppsForTesting()
            }

            let options = FirebaseOptions(
                projectID: "demo-swift-storage",
                apiKey: "sandbox-storage-key",
                googleAppID: "1:424242424242:ios:swiftstorageapp",
                storageBucket: "demo-swift-storage.appspot.com"
            )
            FirebaseApp.configure(name: "live-matrix-app", options: options)
            let app = try #require(FirebaseApp.app(name: "live-matrix-app"))
            let storage = Storage.storage(app: app)
            storage.useEmulator(withHost: host, port: port)
            let auth = Auth.auth(app: app)

            // Unauthenticated write/update/delete to /public/ is denied by Storage Rules (`allow read: if true; allow write: if request.auth != null`).
            let publicRef = storage.reference(withPath: "public/readme.txt")
            var unauthedUpdateDenied = false
            do {
                let m = StorageMetadata()
                m.cacheControl = "no-store"
                _ = try await publicRef.updateMetadata(m)
            } catch StorageErrorCode.unauthorized {
                unauthedUpdateDenied = true
            }
            #expect(unauthedUpdateDenied == true)

            // Sign in and verify missing-object operations return StorageErrorCode.objectNotFound.
            let signedIn = try await auth.createUser(
                withEmail: "matrix-user@example.com",
                password: "MatrixPassword!123"
            )
            let missingRef = storage.reference(withPath: "users/\(signedIn.user.uid)/does-not-exist.bin")

            var getDataMissing = false
            do {
                _ = try await missingRef.data(maxSize: 1024)
            } catch StorageErrorCode.objectNotFound {
                getDataMissing = true
            }
            #expect(getDataMissing == true)

            var downloadUrlMissing = false
            do {
                _ = try await missingRef.downloadURL()
            } catch StorageErrorCode.objectNotFound {
                downloadUrlMissing = true
            }
            #expect(downloadUrlMissing == true)

            var updateMissing = false
            do {
                let m = StorageMetadata()
                m.contentType = "application/octet-stream"
                _ = try await missingRef.updateMetadata(m)
            } catch StorageErrorCode.objectNotFound {
                updateMissing = true
            }
            #expect(updateMissing == true)

            // Upload 0-byte empty file and verify round-trip metadata + data(maxSize:).
            let emptyRef = storage.reference(withPath: "users/\(signedIn.user.uid)/empty.bin")
            let emptyMeta = try await emptyRef.putDataAsync(Data())
            #expect(emptyMeta.size == 0)
            let emptyBytes = try await emptyRef.data(maxSize: 16)
            #expect(emptyBytes.isEmpty)
            try await emptyRef.delete()

            await app.delete()
        }
    }
}
