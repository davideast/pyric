import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import PyricStorage
import PyricFirestore
import FirebaseAuth
import PyricDatabase
import PyricAppCheck

@Suite("PyricStorage Edge-Case & Parity Live-Host Suite", .serialized)
struct StorageEdgeCaseLiveHostTests {
    private static let projectId = "demo-swift-storage"
    private static let defaultBucket = "demo-swift-storage.appspot.com"
    private static let iosAppId = "1:424242424242:ios:swiftstorageapp"

    private func fetchRawHTTP(url: URL) async throws -> (status: Int, body: Data) {
        try await withCheckedThrowingContinuation { continuation in
            let task = URLSession.shared.dataTask(with: url) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                continuation.resume(returning: (status: status, body: data ?? Data()))
            }
            task.resume()
        }
    }

    private func withLiveStorageApp(
        _ body: (FirebaseApp, Storage, String, Int, String) async throws -> Void
    ) async throws {
        guard let rawBridgeUrl = ProcessInfo.processInfo.environment["PYRIC_LIVE_STORAGE_BRIDGE_URL"],
              !rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let parsedUrl = try #require(URL(string: rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines)))
        let host = try #require(parsedUrl.host)
        let port = try #require(parsedUrl.port)

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            Storage.reset()
            AppCheck.reset()
            Auth.reset()
            Database.reset()
            Firestore.reset()
            FirebaseApp.resetAppsForTesting()
            defer {
                Storage.reset()
                AppCheck.reset()
                Auth.reset()
                Database.reset()
                Firestore.reset()
                FirebaseApp.resetAppsForTesting()
            }

            let appName = "live-storage-edge-\(UUID().uuidString.prefix(8))"
            let options = FirebaseOptions(
                projectID: Self.projectId,
                apiKey: "sandbox-storage-key",
                googleAppID: Self.iosAppId,
                storageBucket: Self.defaultBucket
            )
            FirebaseApp.configure(name: appName, options: options)
            let app = try #require(FirebaseApp.app(name: appName))

            let storage = Storage.storage(app: app)
            storage.useEmulator(withHost: host, port: port)

            let auth = Auth.auth(app: app)
            let authRes = try await auth.createUser(
                withEmail: "edge-\(UUID().uuidString.prefix(8))@example.com",
                password: "SwiftStorageEdge!123"
            )
            try await body(app, storage, host, port, authRes.user.uid)
            await app.delete()
        }
    }

    @Test("Unicode, spaces, percent-reserved symbols, and slash-normalized paths round-trip over HostedRuntime")
    func unicodeAndSlashNormalizedPathsOverHostedRuntime() async throws {
        try await withLiveStorageApp { _, storage, _, _, uid in
            let dirSegment = "caf\u{00E9} \u{65E5}\u{672C}\u{8A9E}"
            let fileSegment = "r\u{00E9}sum\u{00E9} + 100% \u{1F680}.txt"
            let unnormalizedPath = "///users///\(uid)//\(dirSegment)///\(fileSegment)///"
            let expectedPath = "users/\(uid)/\(dirSegment)/\(fileSegment)"

            let ref = storage.reference(withPath: unnormalizedPath)
            #expect(ref.fullPath == expectedPath)
            #expect(ref.name == fileSegment)

            let expectedBytes = Data("Unicode payload \u{00E9} \u{65E5}\u{672C}\u{8A9E} \u{1F680}".utf8)
            let meta = StorageMetadata()
            meta.contentType = "text/plain; charset=utf-8"
            meta.customMetadata = ["label": "caf\u{00E9}-\u{1F680}"]

            let uploaded = try await ref.putDataAsync(expectedBytes, metadata: meta)
            #expect(uploaded.path == expectedPath)
            #expect(uploaded.name == fileSegment)
            #expect(uploaded.customMetadata == ["label": "caf\u{00E9}-\u{1F680}"])

            let downloaded = try await ref.data(maxSize: 4096)
            #expect(downloaded == expectedBytes)

            let tokenURL = try await ref.downloadURL()
            let roundTrippedRef = try storage.reference(for: tokenURL)
            #expect(roundTrippedRef.fullPath == expectedPath)
            #expect(roundTrippedRef.name == fileSegment)

            let httpFetched = try await fetchRawHTTP(url: tokenURL)
            #expect(httpFetched.status == 200)
            #expect(httpFetched.body == expectedBytes)

            let parentListing = try await storage.reference(withPath: "users/\(uid)/\(dirSegment)").listAll()
            #expect(parentListing.items.map(\.fullPath) == [expectedPath])
            #expect(parentListing.items.map(\.name) == [fileSegment])

            try await roundTrippedRef.delete()
        }
    }

    @Test("0-byte Data, multi-chunk (> 256 KB) Data, and downloadSizeExceeded boundaries over HostedRuntime")
    func zeroByteMultiChunkDataAndMaxSizeBoundariesOverHostedRuntime() async throws {
        try await withLiveStorageApp { _, storage, _, _, uid in
            // 1. 0-byte Data upload + data(maxSize: 0) success
            let emptyRef = storage.reference(withPath: "users/\(uid)/edge/zero.dat")
            let emptyMeta = try await emptyRef.putDataAsync(Data())
            #expect(emptyMeta.size == 0)
            let emptyData = try await emptyRef.data(maxSize: 0)
            #expect(emptyData.isEmpty)

            // 2. Multi-chunk (> 256 KB) in-memory putDataAsync + exact maxSize vs maxSize - 1 downloadSizeExceeded
            storage.uploadChunkSizeBytes = 262_144
            let totalSize = 620 * 1024
            var largePayload = Data(count: totalSize)
            for idx in 0..<totalSize {
                largePayload[idx] = UInt8((idx * 19 + 7) % 251)
            }

            let progressSteps = TaskEventRecorder<Int64>()
            let largeRef = storage.reference(withPath: "users/\(uid)/edge/multi-chunk.bin")
            let uploaded = try await largeRef.putDataAsync(largePayload) { progress in
                if let completed = progress?.completedUnitCount {
                    progressSteps.append(completed)
                }
            }
            #expect(uploaded.size == Int64(totalSize))
            #expect(progressSteps.values.contains(262_144))
            #expect(progressSteps.values.contains(524_288))
            #expect(progressSteps.values.last == Int64(totalSize))

            var rejectedJustUnderSize = false
            do {
                _ = try await largeRef.data(maxSize: Int64(totalSize - 1))
            } catch StorageErrorCode.downloadSizeExceeded {
                rejectedJustUnderSize = true
            }
            #expect(rejectedJustUnderSize == true)

            let exactFitBytes = try await largeRef.data(maxSize: Int64(totalSize))
            #expect(exactFitBytes == largePayload)
        }
    }

    @Test("Partial updateMetadata preserves existing size and contentType when Storage Rules inspect request.resource")
    func partialUpdateMetadataPreservesResourceContextInStorageRules() async throws {
        try await withLiveStorageApp { _, storage, _, _, uid in
            let configRef = storage.reference(withPath: "validated/\(uid)/settings.json")
            let jsonBytes = Data(repeating: 0x7B, count: 512)
            let initialMeta = StorageMetadata()
            initialMeta.contentType = "application/json"
            initialMeta.customMetadata = ["env": "prod"]

            let created = try await configRef.putDataAsync(jsonBytes, metadata: initialMeta)
            #expect(created.contentType == "application/json")
            #expect(created.size == 512)

            // Partial patch modifying ONLY cacheControl must keep existing size (512 <= 4096) & contentType (application/json)
            let cacheOnlyPatch = StorageMetadata()
            cacheOnlyPatch.cacheControl = "public, max-age=1800"
            let patched = try await configRef.updateMetadata(cacheOnlyPatch)
            #expect(patched.cacheControl == "public, max-age=1800")
            #expect(patched.contentType == "application/json")
            #expect(patched.customMetadata == ["env": "prod"])

            // Patching contentType to disallowed text/html must be rejected by Storage Rules with .unauthorized
            let disallowedPatch = StorageMetadata()
            disallowedPatch.contentType = "text/html"
            var rejectedDisallowedType = false
            do {
                _ = try await configRef.updateMetadata(disallowedPatch)
            } catch StorageErrorCode.unauthorized {
                rejectedDisallowedType = true
            }
            #expect(rejectedDisallowedType == true)

            // Uploading > 4096 bytes to /validated/<uid>/... must also be rejected by Storage Rules
            var rejectedOversized = false
            do {
                _ = try await storage.reference(withPath: "validated/\(uid)/huge.json")
                    .putDataAsync(Data(repeating: 0x20, count: 5000), metadata: initialMeta)
            } catch StorageErrorCode.unauthorized {
                rejectedOversized = true
            }
            #expect(rejectedOversized == true)
        }
    }

    @Test("Concurrent uploads, downloads, and cancellations stay isolated over HostedRuntime")
    func concurrentTransfersAndCancellationIsolationOverHostedRuntime() async throws {
        try await withLiveStorageApp { _, storage, _, _, uid in
            storage.uploadChunkSizeBytes = 262_144
            let seedBytes = Data(repeating: 0x4C, count: 300 * 1024)
            let seedRef = storage.reference(withPath: "users/\(uid)/concurrent/seed.bin")
            _ = try await seedRef.putDataAsync(seedBytes)

            // Cancel a download immediately after enqueue() and cancel a paused multi-chunk upload concurrently
            let cancelledDlDone = AsyncStream<Error?>.makeStream()
            let cancelledDl = seedRef.getData(maxSize: 1_000_000) { _, err in
                cancelledDlDone.continuation.yield(err)
            }
            cancelledDl.cancel()

            let abortedRef = storage.reference(withPath: "users/\(uid)/concurrent/aborted-upload.bin")
            let cancelledUpDone = AsyncStream<Error?>.makeStream()
            let cancelledUp = abortedRef.putData(Data(repeating: 0x99, count: 550 * 1024), metadata: nil) { _, err in
                cancelledUpDone.continuation.yield(err)
            }
            cancelledUp.pause()
            cancelledUp.cancel()

            try await withThrowingTaskGroup(of: Void.self) { group in
                for idx in 0..<3 {
                    group.addTask {
                        let body = Data(repeating: UInt8(0x21 + idx), count: 300 * 1024)
                        let itemRef = storage.reference(withPath: "users/\(uid)/concurrent/sibling-\(idx).bin")
                        let meta = try await itemRef.putDataAsync(body)
                        #expect(meta.size == Int64(body.count))
                        let readBack = try await itemRef.data(maxSize: 1_000_000)
                        #expect(readBack == body)
                    }
                }
                group.addTask {
                    let seedRead = try await seedRef.data(maxSize: 1_000_000)
                    #expect(seedRead == seedBytes)
                }
                try await group.waitForAll()
            }

            var dlIter = cancelledDlDone.stream.makeAsyncIterator()
            let dlErr = try #require(await dlIter.next() ?? nil)
            #expect(StorageErrorCode.from(dlErr).code == .cancelled)

            var upIter = cancelledUpDone.stream.makeAsyncIterator()
            let upErr = try #require(await upIter.next() ?? nil)
            #expect(StorageErrorCode.from(upErr).code == .cancelled)

            var abortedMissing = false
            do {
                _ = try await abortedRef.getMetadata()
            } catch StorageErrorCode.objectNotFound {
                abortedMissing = true
            }
            #expect(abortedMissing == true)
        }
    }

    @Test("Custom gs:// bucket Storage.storage(app:url:) isolates objects, listings, downloadURL, and deletion over HostedRuntime")
    func customGsBucketIsolationOverHostedRuntime() async throws {
        try await withLiveStorageApp { app, defaultStorage, _, _, uid in
            // 1. Undeployed named bucket denies client operations with StorageErrorCode.unauthorized
            let undeployedStorage = Storage.storage(app: app, url: "gs://undeployed-vault")
            var undeployedDenied = false
            do {
                _ = try await undeployedStorage.reference(withPath: "users/\(uid)/denied.txt")
                    .putDataAsync(Data("no-rules".utf8))
            } catch StorageErrorCode.unauthorized {
                undeployedDenied = true
            }
            #expect(undeployedDenied == true)

            // 2. Deployed custom gs://archive-vault bucket isolates objects, listings, downloadURL, and deletion
            let customBucketName = "archive-vault"
            let archiveStorage = Storage.storage(app: app, url: "gs://\(customBucketName)")
            #expect(archiveStorage !== defaultStorage)

            let relativePath = "users/\(uid)/vault/shared-key.txt"
            let defaultRef = defaultStorage.reference(withPath: relativePath)
            let archiveRef = archiveStorage.reference(forURL: "gs://\(customBucketName)/\(relativePath)")

            let defaultPayload = Data("default-bucket-payload".utf8)
            let archivePayload = Data("custom-archive-bucket-payload".utf8)

            let defaultMeta = try await defaultRef.putDataAsync(defaultPayload)
            let archiveMeta = try await archiveRef.putDataAsync(archivePayload)
            #expect(defaultMeta.bucket == Self.defaultBucket)
            #expect(archiveMeta.bucket == customBucketName)

            #expect(try await defaultRef.data(maxSize: 1024) == defaultPayload)
            #expect(try await archiveRef.data(maxSize: 1024) == archivePayload)

            let archiveURL = try await archiveRef.downloadURL()
            #expect(archiveURL.absoluteString.contains(customBucketName))
            let resolvedArchiveRef = try archiveStorage.reference(for: archiveURL)
            #expect(resolvedArchiveRef == archiveRef)
            let archiveHTTP = try await fetchRawHTTP(url: archiveURL)
            #expect(archiveHTTP.status == 200)
            #expect(archiveHTTP.body == archivePayload)

            // Deleting from custom bucket must NOT delete same-named object in default bucket
            try await archiveRef.delete()
            #expect(try await defaultRef.data(maxSize: 1024) == defaultPayload)

            let archiveListing = try await archiveStorage.reference(withPath: "users/\(uid)/vault").listAll()
            #expect(archiveListing.items.isEmpty)
        }
    }
}
