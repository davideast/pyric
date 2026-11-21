import Foundation

/// Thread-safe async gate coordinating `pause()`, `resume()`, and `cancel()` across chunked transfers.
package final class StorageTransferGate: @unchecked Sendable {
    private let lock = NSLock()
    private var paused = false
    private var cancelled = false
    private var resyncNeeded = false
    private var pauseWaiters: [CheckedContinuation<Bool, Never>] = []
    private var activeSliceTask: Task<Void, Error>?

    package init() {}

    package var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    package var isPaused: Bool {
        lock.lock()
        defer { lock.unlock() }
        return paused
    }

    package func consumeResyncFlag() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let current = resyncNeeded
        resyncNeeded = false
        return current
    }

    package func markPaused() {
        let sliceToCancel: Task<Void, Error>? = {
            lock.lock()
            defer { lock.unlock() }
            guard !cancelled else { return nil }
            paused = true
            resyncNeeded = true
            return activeSliceTask
        }()
        sliceToCancel?.cancel()
    }

    package func markResumed() {
        let waiters: [CheckedContinuation<Bool, Never>] = {
            lock.lock()
            defer { lock.unlock() }
            guard !cancelled else { return [] }
            paused = false
            let current = pauseWaiters
            pauseWaiters.removeAll()
            return current
        }()
        for waiter in waiters {
            waiter.resume(returning: true)
        }
    }

    package func markCancelled() {
        let (waiters, sliceToCancel): ([CheckedContinuation<Bool, Never>], Task<Void, Error>?) = {
            lock.lock()
            defer { lock.unlock() }
            cancelled = true
            paused = false
            let current = pauseWaiters
            pauseWaiters.removeAll()
            return (current, activeSliceTask)
        }()
        sliceToCancel?.cancel()
        for waiter in waiters {
            waiter.resume(returning: false)
        }
    }

    /// Suspends while paused and returns `false` if cancelled, or `true` when ready to transfer.
    package func waitUntilRunnable() async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            if cancelled {
                lock.unlock()
                continuation.resume(returning: false)
                return
            }
            if !paused {
                lock.unlock()
                continuation.resume(returning: true)
                return
            }
            pauseWaiters.append(continuation)
            lock.unlock()
        }
    }

    /// Runs a cancellable slice operation that `pause()` or `cancel()` can interrupt immediately.
    package func runInterruptibleSlice(_ operation: @escaping @Sendable () async throws -> Void) async throws {
        let sliceTask = Task {
            try await operation()
        }
        let immediateCancel: Bool = lock.withLock {
            activeSliceTask = sliceTask
            return paused || cancelled
        }
        if immediateCancel {
            sliceTask.cancel()
        }
        defer {
            clearActiveSliceTask(sliceTask)
        }
        try await sliceTask.value
    }

    private func clearActiveSliceTask(_ sliceTask: Task<Void, Error>) {
        lock.withLock {
            if activeSliceTask == sliceTask {
                activeSliceTask = nil
            }
        }
    }
}

/// Infers standard MIME content types from file extensions without Apple-only frameworks.
package enum StorageMimeTypeResolver {
    private static let table: [String: String] = [
        "txt": "text/plain",
        "text": "text/plain",
        "log": "text/plain",
        "csv": "text/csv",
        "md": "text/markdown",
        "html": "text/html",
        "htm": "text/html",
        "css": "text/css",
        "js": "application/javascript",
        "mjs": "application/javascript",
        "json": "application/json",
        "xml": "application/xml",
        "pdf": "application/pdf",
        "zip": "application/zip",
        "gz": "application/gzip",
        "tar": "application/x-tar",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "ico": "image/x-icon",
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "ogg": "audio/ogg",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mov": "video/quicktime",
        "wasm": "application/wasm"
    ]

    package static func inferContentType(for fileURL: URL) -> String {
        let ext = fileURL.pathExtension.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !ext.isEmpty else {
            return "application/octet-stream"
        }
        return table[ext] ?? "application/octet-stream"
    }
}
