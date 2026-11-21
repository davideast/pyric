import Foundation
import Testing
@testable import PyricStorage
import PyricFirestore

@Suite("PyricStorage Observable Tasks & Resumable Controls", .serialized)
struct StorageObservableTaskTests {
    private func makeIsolatedStorage(
        channel: MockStorageBridgeChannel,
        appName: String = "task-test-\(UUID().uuidString)"
    ) -> (FirebaseApp, Storage) {
        let options = FirebaseOptions(
            projectID: "demo-task-test",
            apiKey: "task-key",
            googleAppID: "1:111:ios:task",
            storageBucket: "test.appspot.com"
        )
        let app = FirebaseApp(name: appName, options: options)
        let client = PyricBridgeClient(channel: channel)
        let storage = Storage.storage(app: app, bridgeClient: client)
        storage.callbackQueue = DispatchQueue(label: "test.storage.callbacks.\(appName)")
        return (app, storage)
    }

    private func makeChunkedChannel(
        store: MockObjectStore,
        harness: MockChunkedUploadHarness
    ) -> MockStorageBridgeChannel {
        MockStorageBridgeChannel { frame, chan in
            let type = frame["type"]?.stringValue
            if type == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-\(UUID().uuidString)"
                ])
                return
            }
            guard type == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }
            if op["method"]?.stringValue == "storage.putBytes" {
                let path = op["path"]?.stringValue ?? ""
                let bytes = Data(base64Encoded: op["dataB64"]?.stringValue ?? "") ?? Data()
                let stored = store.put(
                    bucket: "test.appspot.com",
                    path: path,
                    bytes: bytes,
                    contentType: op["contentType"]?.stringValue,
                    metadata: op["metadata"]?.dictionaryValue
                )
                chan.sendFromServer(["type": "worker-res", "id": id, "ok": true, "value": stored])
                return
            }
            _ = harness.handleStorageOp(id: id, op: op, channel: chan)
        }
    }

    @Test("StorageTaskStatus raw values and StorageTaskSnapshot descriptions match FirebaseStorage 13.2.0")
    func statusRawValuesAndSnapshotDescriptions() {
        #expect(StorageTaskStatus.unknown.rawValue == 0)
        #expect(StorageTaskStatus.resume.rawValue == 1)
        #expect(StorageTaskStatus.progress.rawValue == 2)
        #expect(StorageTaskStatus.pause.rawValue == 3)
        #expect(StorageTaskStatus.success.rawValue == 4)
        #expect(StorageTaskStatus.failure.rawValue == 5)

        let channel = MockStorageBridgeChannel()
        let (_, storage) = makeIsolatedStorage(channel: channel)
        let ref = storage.reference(withPath: "docs/readme.txt")
        let baseTask = StorageTask(reference: ref, callbackQueue: storage.callbackQueue, totalBytes: 128)
        let initialSnap = baseTask.snapshot
        #expect(initialSnap.task === baseTask)
        #expect(initialSnap.reference == ref)
        #expect(initialSnap.status == .resume)
        #expect(initialSnap.progress?.totalUnitCount == 128)
        #expect(initialSnap.progress?.completedUnitCount == 0)
        #expect(initialSnap.description == "<State: Resume>")

        let pausedSnap = StorageTaskSnapshot(
            task: baseTask, state: .paused, status: .pause,
            reference: ref, metadata: nil, progress: nil, error: nil
        )
        #expect(pausedSnap.description == "<State: Paused>")

        let successSnap = StorageTaskSnapshot(
            task: baseTask, state: .success, status: .success,
            reference: ref, metadata: nil, progress: nil, error: nil
        )
        #expect(successSnap.description == "<State: Success>")

        let failedSnap = StorageTaskSnapshot(
            task: baseTask, state: .failed, status: .failure,
            reference: ref, metadata: nil, progress: nil, error: StorageErrorCode.cancelled
        )
        #expect(failedSnap.description.hasPrefix("<State: Failed, Error:"))
    }

    @Test("Multi-chunk (> 256 KB) upload streams over beginUpload/putPart/finishUpload with monotonic Progress")
    func multiChunkUploadStreamsPartsAndNotifiesObservers() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeChunkedChannel(store: store, harness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)
        let ref = storage.reference(withPath: "uploads/multi-chunk.bin")

        let totalSize = 600 * 1024
        var payload = Data(count: totalSize)
        for idx in 0..<totalSize { payload[idx] = UInt8(idx % 251) }

        let progressCounts = TaskEventRecorder<Int64>()
        let statusesSeen = TaskEventRecorder<StorageTaskStatus>()
        let meta = StorageMetadata()
        meta.contentType = "application/octet-stream"
        meta.customMetadata = ["mode": "chunked"]

        let storedMeta = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
            let task = ref.putData(payload, metadata: meta) { resultMeta, err in
                if let err { cont.resume(throwing: err) }
                else if let resultMeta { cont.resume(returning: resultMeta) }
            }
            task.observe(.resume) { snap in statusesSeen.append(snap.status) }
            task.observe(.progress) { snap in
                statusesSeen.append(snap.status)
                if let completed = snap.progress?.completedUnitCount { progressCounts.append(completed) }
            }
            task.observe(.success) { snap in statusesSeen.append(snap.status) }
        }

        #expect(storedMeta.size == Int64(totalSize))
        #expect(storedMeta.customMetadata == ["mode": "chunked"])
        #expect(harness.putPartSizes == [262_144, 262_144, 90_112])

        let recordedProgress = progressCounts.values
        #expect(recordedProgress.contains(262_144))
        #expect(recordedProgress.contains(524_288))
        #expect(recordedProgress.last == Int64(totalSize))
        for idx in 1..<recordedProgress.count {
            #expect(recordedProgress[idx] >= recordedProgress[idx - 1])
        }
        #expect(statusesSeen.values.contains(.success))
        #expect(store.get(bucket: "test.appspot.com", path: "uploads/multi-chunk.bin")?.bytes == payload)
    }

    @Test("Explicit uploadChunkSizeBytes normalizes to 256 KiB multiples and governs part sizes")
    func explicitUploadChunkSizeBytesGovernsPartSizes() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeChunkedChannel(store: store, harness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        storage.uploadChunkSizeBytes = 100_000
        #expect(storage.uploadChunkSizeBytes == 262_144)

        storage.uploadChunkSizeBytes = 600_000
        #expect(storage.uploadChunkSizeBytes == 524_288)

        let payload = Data(repeating: 0x5B, count: 600 * 1024)
        let ref = storage.reference(withPath: "uploads/custom-512k.bin")
        let stored = try await ref.putDataAsync(payload)
        #expect(stored.size == Int64(payload.count))
        #expect(harness.putPartSizes == [524_288, 90_112])
    }

    @Test("removeObserver(withHandle:), removeAllObservers(for:), and removeAllObservers() isolate callbacks")
    func observerRemovalMethodsIsolateCallbacks() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeChunkedChannel(store: store, harness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)
        storage.uploadChunkSizeBytes = 256 * 1024
        let ref = storage.reference(withPath: "uploads/observers.bin")

        let removedHits = TaskEventRecorder<Int>()
        let keptProgressHits = TaskEventRecorder<Int>()
        let keptSuccessHits = TaskEventRecorder<Int>()

        let finishedTask: StorageUploadTask = try await withCheckedThrowingContinuation { cont in
            let task = ref.putData(Data(repeating: 0x42, count: 300 * 1024), metadata: nil) { _, err in
                if let err { cont.resume(throwing: err) }
            }
            task.pause()
            let hRemoved = task.observe(.progress) { _ in removedHits.append(1) }
            _ = task.observe(.progress) { _ in keptProgressHits.append(1) }
            task.removeObserver(withHandle: hRemoved)

            let hPauseRemoved = task.observe(.resume) { _ in removedHits.append(2) }
            _ = hPauseRemoved
            task.removeAllObservers(for: .resume)

            _ = task.observe(.success) { snap in
                keptSuccessHits.append(1)
                if let t = snap.task as? StorageUploadTask { cont.resume(returning: t) }
            }
            task.resume()
        }

        #expect(removedHits.count == 0)
        #expect(keptProgressHits.count >= 2)
        #expect(keptSuccessHits.count == 1)
        finishedTask.removeAllObservers()
    }

    @Test("Late observers registered after terminal success or failure replay once and are not retained")
    func lateTerminalSuccessAndFailureObserversReplayOnce() async throws {
        let store = MockObjectStore()
        let harness = MockChunkedUploadHarness(store: store)
        let channel = makeChunkedChannel(store: store, harness: harness)
        let (_, storage) = makeIsolatedStorage(channel: channel)

        let okRef = storage.reference(withPath: "uploads/late-ok.bin")
        let okDone = AsyncStream<StorageUploadTask>.makeStream()
        let okTask = okRef.putData(Data([1, 2, 3]), metadata: nil) { _, _ in }
        okTask.observe(.success) { snap in
            if let t = snap.task as? StorageUploadTask { okDone.continuation.yield(t) }
        }
        var okIter = okDone.stream.makeAsyncIterator()
        let settledOk = try #require(await okIter.next())

        let replayedOk: StorageTaskSnapshot = await withCheckedContinuation { cont in
            settledOk.observe(.success) { snap in cont.resume(returning: snap) }
        }
        #expect(replayedOk.status == .success)

        // Root upload fails -> late .failure observer replays once with error
        let rootRef = storage.reference()
        let failDone = AsyncStream<StorageUploadTask>.makeStream()
        let failTask = rootRef.putData(Data([1]), metadata: nil) { _, _ in }
        failTask.observe(.failure) { snap in
            if let t = snap.task as? StorageUploadTask { failDone.continuation.yield(t) }
        }
        var failIter = failDone.stream.makeAsyncIterator()
        let settledFail = try #require(await failIter.next())

        let replayedFail: StorageTaskSnapshot = await withCheckedContinuation { cont in
            settledFail.observe(.failure) { snap in cont.resume(returning: snap) }
        }
        #expect(replayedFail.status == .failure)
        #expect(replayedFail.error != nil)
    }

    @Test("Pause, resume, and cancel controls govern in-flight StorageUploadTask and abort staged server bytes")
    func pauseResumeAndCancelUploadTask() async throws {
        let store = MockObjectStore()
        let chunkHarness = MockChunkedUploadHarness(store: store)

        final class PartGate: @unchecked Sendable {
            private let lock = NSLock()
            private var heldReply: (@Sendable () -> Void)?
            private var onPartZeroArrived: (@Sendable () -> Void)?

            func onFirstPart(_ cb: @escaping @Sendable () -> Void) {
                lock.withLock { onPartZeroArrived = cb }
            }

            func interceptOrPass(partIndex: Int, sendReply: @escaping @Sendable () -> Void) {
                let notify: (@Sendable () -> Void)? = lock.withLock {
                    if partIndex == 0, let cb = onPartZeroArrived {
                        onPartZeroArrived = nil
                        heldReply = sendReply
                        return cb
                    }
                    return nil
                }
                if let notify { notify() } else { sendReply() }
            }

            func releaseHeld() {
                let reply: (@Sendable () -> Void)? = lock.withLock {
                    let current = heldReply
                    heldReply = nil
                    return current
                }
                reply?()
            }
        }

        let partGate = PartGate()
        let channel = MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-ctrl"
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }

            if op["method"]?.stringValue == "storage.putPart" {
                let partIdx = Int(op["partIndex"]?.intValue ?? 0)
                partGate.interceptOrPass(partIndex: partIdx) {
                    _ = chunkHarness.handleStorageOp(id: id, op: op, channel: chan)
                }
                return
            }
            _ = chunkHarness.handleStorageOp(id: id, op: op, channel: chan)
        }

        let (_, storage) = makeIsolatedStorage(channel: channel)
        let payload = Data(repeating: 0x7A, count: 320 * 1024)

        let pauseRef = storage.reference(withPath: "uploads/pausable.bin")
        let pauseStates = TaskEventRecorder<StorageTaskStatus>()
        let partZeroReached = AsyncStream<Void>.makeStream()
        partGate.onFirstPart { partZeroReached.continuation.yield() }

        let finishedStream = AsyncStream<Void>.makeStream()
        let uploadTask = pauseRef.putData(payload, metadata: nil) { _ in
            finishedStream.continuation.yield()
        }
        uploadTask.observe(.pause) { snap in pauseStates.append(snap.status) }
        uploadTask.observe(.resume) { snap in pauseStates.append(snap.status) }

        var iterator = partZeroReached.stream.makeAsyncIterator()
        _ = await iterator.next()

        uploadTask.pause()
        #expect(uploadTask.snapshot.status == .pause)
        partGate.releaseHeld()

        uploadTask.resume()
        var doneIter = finishedStream.stream.makeAsyncIterator()
        _ = await doneIter.next()

        #expect(uploadTask.snapshot.status == .success)
        #expect(pauseStates.values.contains(.pause))
        #expect(pauseStates.values.contains(.resume))
        #expect(store.get(bucket: "test.appspot.com", path: "uploads/pausable.bin")?.bytes.count == payload.count)

        let cancelRef = storage.reference(withPath: "uploads/cancellable.bin")
        let cancelPartReached = AsyncStream<Void>.makeStream()
        partGate.onFirstPart { cancelPartReached.continuation.yield() }

        let cancelOutcomeStream = AsyncStream<Error?>.makeStream()
        let cancelTask = cancelRef.putData(payload, metadata: nil) { _, err in
            cancelOutcomeStream.continuation.yield(err)
        }
        var cancelIter = cancelPartReached.stream.makeAsyncIterator()
        _ = await cancelIter.next()

        cancelTask.cancel()
        partGate.releaseHeld()

        var errIter = cancelOutcomeStream.stream.makeAsyncIterator()
        let cancelErr = try #require(await errIter.next() ?? nil)
        #expect(StorageErrorCode.from(cancelErr).code == .cancelled)
        #expect(!chunkHarness.abortedUploadIds.isEmpty)
        #expect(store.get(bucket: "test.appspot.com", path: "uploads/cancellable.bin") == nil)
    }

    @Test("Cancel racing finishUpload redeems rollbackToken via storage.rollbackUpload and removes stored object")
    func cancelRacingFinishUploadRollsBackCommittedObject() async throws {
        let store = MockObjectStore()
        let chunkHarness = MockChunkedUploadHarness(store: store)
        let finishArrived = AsyncStream<(@Sendable () -> Void)>.makeStream()

        let channel = MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-rollback"
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }

            if op["method"]?.stringValue == "storage.finishUpload" {
                finishArrived.continuation.yield {
                    _ = chunkHarness.handleStorageOp(id: id, op: op, channel: chan)
                }
                return
            }
            _ = chunkHarness.handleStorageOp(id: id, op: op, channel: chan)
        }

        let (_, storage) = makeIsolatedStorage(channel: channel)
        storage.uploadChunkSizeBytes = 256 * 1024
        let ref = storage.reference(withPath: "uploads/racing-finish.bin")
        let doneStream = AsyncStream<Error?>.makeStream()

        let task = ref.putData(Data(repeating: 0x19, count: 300 * 1024), metadata: nil) { _, err in
            doneStream.continuation.yield(err)
        }

        var finishIter = finishArrived.stream.makeAsyncIterator()
        let releaseFinish = try #require(await finishIter.next())
        task.cancel()
        releaseFinish()

        var doneIter = doneStream.stream.makeAsyncIterator()
        let err = try #require(await doneIter.next() ?? nil)
        #expect(StorageErrorCode.from(err).code == .cancelled)
        #expect(!chunkHarness.rolledBackTokens.isEmpty)
        #expect(store.get(bucket: "test.appspot.com", path: "uploads/racing-finish.bin") == nil)
    }

    @Test("Structured Swift Task cancellation cancels putDataAsync via StorageTaskCanceller")
    func swiftTaskCancellationCancelsPutDataAsync() async throws {
        let store = MockObjectStore()
        let chunkHarness = MockChunkedUploadHarness(store: store)
        let startedPart = AsyncStream<Void>.makeStream()

        let channel = MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-swift-cancel"
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }
            if op["method"]?.stringValue == "storage.putPart" {
                startedPart.continuation.yield()
                return
            }
            _ = chunkHarness.handleStorageOp(id: id, op: op, channel: chan)
        }

        let (_, storage) = makeIsolatedStorage(channel: channel)
        let ref = storage.reference(withPath: "uploads/structured-cancel.bin")
        let bigPayload = Data(repeating: 0x33, count: 300 * 1024)

        let asyncUpload = Task {
            try await ref.putDataAsync(bigPayload)
        }

        var iter = startedPart.stream.makeAsyncIterator()
        _ = await iter.next()
        asyncUpload.cancel()

        var caughtCancelled = false
        do {
            _ = try await asyncUpload.value
        } catch StorageErrorCode.cancelled {
            caughtCancelled = true
        }
        #expect(caughtCancelled == true)
    }
}
