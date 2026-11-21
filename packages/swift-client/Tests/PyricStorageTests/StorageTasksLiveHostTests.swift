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

@Suite("PyricStorage Tasks & File I/O Live-Host Suite", .serialized)
struct StorageTasksLiveHostTests {
    private static let projectId = "demo-swift-storage"
    private static let defaultBucket = "demo-swift-storage.appspot.com"
    private static let iosAppId = "1:424242424242:ios:swiftstorageapp"

    private func withAuthenticatedLiveStorage(
        _ body: (Storage, String) async throws -> Void
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

            let appName = "live-storage-tasks-\(UUID().uuidString.prefix(8))"
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
            storage.callbackQueue = DispatchQueue(label: "live.swift.storage.tasks.\(appName)")

            let auth = Auth.auth(app: app)
            let authRes = try await auth.createUser(
                withEmail: "tasks-\(UUID().uuidString.prefix(8))@example.com",
                password: "SwiftStorageTasks!123"
            )
            try await body(storage, authRes.user.uid)
            await app.delete()
        }
    }

    @Test("Streams multi-chunk (> 256 KB) putFileAsync and writeAsync(toFile:onProgress:) over HostedRuntime HTTP byte route")
    func multiChunkPutFileAndWriteAsyncOverHostedRuntime() async throws {
        try await withAuthenticatedLiveStorage { storage, uid in
            try await StorageTestScratchDir.withDirectory { scratchDir in
                let chunkedSource = scratchDir.appendingPathComponent("recording.wav")
                let totalSize = 600 * 1024
                var rawAudio = Data(count: totalSize)
                for idx in 0..<totalSize {
                    rawAudio[idx] = UInt8((idx * 13 + 5) % 251)
                }
                try rawAudio.write(to: chunkedSource)

                let uploadSteps = TaskEventRecorder<Int64>()
                let audioRef = storage.reference(withPath: "users/\(uid)/media/recording.wav")
                let uploadedMeta = try await audioRef.putFileAsync(from: chunkedSource) { progress in
                    if let completed = progress?.completedUnitCount {
                        uploadSteps.append(completed)
                    }
                }
                #expect(uploadedMeta.size == Int64(totalSize))
                #expect(uploadedMeta.contentType == "audio/wav")
                #expect(uploadSteps.values.contains(262_144))
                #expect(uploadSteps.values.contains(524_288))
                #expect(uploadSteps.values.last == Int64(totalSize))

                let downloadDest = scratchDir.appendingPathComponent("downloaded-recording.wav")
                let downloadSteps = TaskEventRecorder<Int64>()
                let savedURL = try await audioRef.writeAsync(toFile: downloadDest) { progress in
                    if let completed = progress?.completedUnitCount {
                        downloadSteps.append(completed)
                    }
                }
                #expect(savedURL == downloadDest)
                #expect(try Data(contentsOf: downloadDest) == rawAudio)
                #expect(downloadSteps.values.contains(262_144))
                #expect(downloadSteps.values.last == Int64(totalSize))
            }
        }
    }

    @Test("Governs observable StorageUploadTask pause, resume, and cancel over HostedRuntime")
    func observableUploadTaskPauseResumeAndCancelOverHostedRuntime() async throws {
        try await withAuthenticatedLiveStorage { storage, uid in
            let payload = Data(repeating: 0x6D, count: 550 * 1024)

            let pauseResumeRef = storage.reference(withPath: "users/\(uid)/media/paused-upload.bin")
            let observedStatuses = TaskEventRecorder<StorageTaskStatus>()
            let pausedMeta = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
                let task = pauseResumeRef.putData(payload, metadata: nil) { meta, err in
                    if let err { cont.resume(throwing: err) }
                    else if let meta { cont.resume(returning: meta) }
                }
                task.observe(.pause) { snap in observedStatuses.append(snap.status) }
                task.observe(.resume) { snap in observedStatuses.append(snap.status) }
                task.pause()
                task.resume()
            }
            #expect(pausedMeta.size == Int64(payload.count))
            #expect(observedStatuses.values.contains(.pause))
            #expect(observedStatuses.values.contains(.resume))

            let cancelledRef = storage.reference(withPath: "users/\(uid)/media/cancelled.bin")
            let cancelDone = AsyncStream<Error?>.makeStream()
            let cancelTask = cancelledRef.putData(payload, metadata: nil) { _, err in
                cancelDone.continuation.yield(err)
            }
            cancelTask.pause()
            cancelTask.cancel()
            var cancelIter = cancelDone.stream.makeAsyncIterator()
            let cancelErr = try #require(await cancelIter.next() ?? nil)
            #expect(StorageErrorCode.from(cancelErr).code == .cancelled)

            var cancelledNotFound = false
            do {
                _ = try await cancelledRef.getMetadata()
            } catch StorageErrorCode.objectNotFound {
                cancelledNotFound = true
            }
            #expect(cancelledNotFound == true)
        }
    }

    @Test("Round-trips 0-byte files and cursor-stable pagination across deletions over HostedRuntime")
    func zeroByteFilesAndCursorPaginationOverHostedRuntime() async throws {
        try await withAuthenticatedLiveStorage { storage, uid in
            try await StorageTestScratchDir.withDirectory { scratchDir in
                let zeroSource = scratchDir.appendingPathComponent("empty.txt")
                try Data().write(to: zeroSource)
                let zeroRef = storage.reference(withPath: "users/\(uid)/pages/a-zero.txt")
                let zeroMeta = try await zeroRef.putFileAsync(from: zeroSource)
                #expect(zeroMeta.size == 0)

                let zeroDest = scratchDir.appendingPathComponent("empty-downloaded.txt")
                _ = try await zeroRef.writeAsync(toFile: zeroDest)
                #expect(try Data(contentsOf: zeroDest).isEmpty)

                let itemB = storage.reference(withPath: "users/\(uid)/pages/b-item.txt")
                let itemC = storage.reference(withPath: "users/\(uid)/pages/c-item.txt")
                _ = try await itemB.putDataAsync(Data("b".utf8))
                _ = try await itemC.putDataAsync(Data("c".utf8))

                let pagesRoot = storage.reference(withPath: "users/\(uid)/pages")
                let firstPage = try await pagesRoot.list(maxResults: 2)
                #expect(firstPage.items.map(\.name) == ["a-zero.txt", "b-item.txt"])
                let pageCursor = try #require(firstPage.pageToken)

                try await zeroRef.delete()
                let secondPage = try await pagesRoot.list(maxResults: 2, pageToken: pageCursor)
                #expect(secondPage.items.map(\.name) == ["c-item.txt"])
                #expect(secondPage.pageToken == nil)
            }
        }
    }
}
