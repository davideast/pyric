import Foundation
import PyricAppCheck
import PyricFirestore

extension Crashlytics {
    // MARK: - Previous Crash & Data Collection Controls

    /// Returns whether the application crashed during the previous execution.
    public func didCrashDuringPreviousExecution() -> Bool {
        stateLock.withLock { _didPreviouslyCrash }
    }

    package func simulatePreviousCrashForTesting(_ didCrash: Bool = true) {
        stateLock.withLock { _didPreviouslyCrash = didCrash }
    }

    /// Enables or disables automatic Crashlytics report collection.
    public func setCrashlyticsCollectionEnabled(_ enabled: Bool) {
        applyCollectionEnabled(enabled)
    }

    /// Enables, disables, or resets (`nil`) the Crashlytics collection override.
    public func setCrashlyticsCollectionEnabled(_ enabled: Bool?) {
        applyCollectionEnabled(enabled)
    }

    /// Indicates whether automatic Crashlytics data collection is currently enabled.
    public func isCrashlyticsCollectionEnabled() -> Bool {
        stateLock.withLock { resolveCollectionEnabledLocked() }
    }

    // MARK: - Unsent Reports & Synchronization

    /// Checks whether unsent crash or non-fatal reports are queued on the Crashlytics broker.
    public func checkForUnsentReports() async -> Bool {
        let params = baseParams()
        do {
            return try await serialQueue.enqueue { [weak self] in
                guard let self else { return false }
                let res = try await self.dispatchOp(method: "crashlytics.checkForUnsentReports", params: params)
                return res.dictionaryValue?["hasUnsentReports"]?.boolValue ?? false
            }
        } catch {
            return false
        }
    }

    /// Completion-handler overload of `checkForUnsentReports()`.
    public func checkForUnsentReports(completion: @escaping @Sendable (Bool) -> Void) {
        Task {
            let hasUnsent = await self.checkForUnsentReports()
            completion(hasUnsent)
        }
    }

    /// Checks for unsent reports and returns the newest unsent `CrashlyticsReport` for annotation, or `nil` if none exist.
    public func checkAndUpdateUnsentReports() async -> CrashlyticsReport? {
        let params = baseParams()
        do {
            return try await serialQueue.enqueue { [weak self] in
                guard let self else { return nil }
                let checkRes = try await self.dispatchOp(method: "crashlytics.checkForUnsentReports", params: params)
                guard checkRes.dictionaryValue?["hasUnsentReports"]?.boolValue == true else {
                    return nil
                }
                let stateRaw = try await self.dispatchOp(method: "crashlytics.getState", params: params)
                let snapshot = try CrashlyticsStateSnapshot.fromWire(stateRaw)
                self.syncDidCrashFlag(snapshot.didCrashOnPreviousExecution)
                guard let newest = snapshot.unsentReports.last else {
                    return nil
                }
                let createdDate = Date(timeIntervalSince1970: Double(newest.timestampMs) / 1000.0)
                return CrashlyticsReport(
                    reportID: newest.reportID,
                    dateCreated: createdDate,
                    hasCrash: newest.fatal,
                    owner: self
                )
            }
        } catch {
            return nil
        }
    }

    /// Completion-handler overload of `checkAndUpdateUnsentReports()`.
    public func checkAndUpdateUnsentReports(completion: @escaping @Sendable (CrashlyticsReport?) -> Void) {
        Task {
            let report = await self.checkAndUpdateUnsentReports()
            completion(report)
        }
    }

    /// Enqueues any unsent reports to be promoted and flushed on the Crashlytics broker.
    public func sendUnsentReports() {
        enqueueFireAndForgetOp(method: "crashlytics.sendUnsentReports", params: baseParams())
    }

    /// Deletes any unsent reports queued on the Crashlytics broker.
    public func deleteUnsentReports() {
        enqueueFireAndForgetOp(method: "crashlytics.deleteUnsentReports", params: baseParams())
    }

    /// Drains all enqueued Crashlytics operations and flushes pending reports on the broker.
    public func flush() async throws {
        let params = baseParams()
        do {
            _ = try await serialQueue.enqueue { [weak self] in
                guard let self else {
                    throw CrashlyticsError(code: .cancelled, message: "Crashlytics instance deallocated.")
                }
                return try await self.dispatchOp(method: "crashlytics.flush", params: params)
            }
        } catch {
            throw CrashlyticsError.from(error)
        }
    }

    /// Completion-handler overload of `flush()`.
    public func flush(completion: @escaping @Sendable ((any Error)?) -> Void) {
        Task {
            do {
                try await self.flush()
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    /// Reads the authoritative per-app Crashlytics sandbox state after draining prior FIFO operations.
    public func getState() async throws -> CrashlyticsStateSnapshot {
        let params = baseParams()
        do {
            return try await serialQueue.enqueue { [weak self] in
                guard let self else {
                    throw CrashlyticsError(code: .cancelled, message: "Crashlytics instance deallocated.")
                }
                let raw = try await self.dispatchOp(method: "crashlytics.getState", params: params)
                let decoded = try CrashlyticsStateSnapshot.fromWire(raw)
                self.syncDidCrashFlag(decoded.didCrashOnPreviousExecution)
                return decoded
            }
        } catch {
            throw CrashlyticsError.from(error)
        }
    }

    // MARK: - Package Plumbing

    package var isDisposedState: Bool {
        stateLock.withLock { _isDisposed }
    }

    package func applyCollectionEnabled(_ enabled: Bool?) {
        stateLock.withLock {
            _collectionOverride = enabled
        }
        var params = baseParams()
        if let enabled {
            params["enabled"] = .bool(enabled)
        } else {
            params["enabled"] = .null
        }
        enqueueFireAndForgetOp(method: "crashlytics.setCollectionEnabled", params: params)
    }

    package func resolveCollectionEnabledLocked() -> Bool {
        if let explicit = _collectionOverride {
            return explicit
        }
        if let plistFlag = Bundle.main.object(forInfoDictionaryKey: "FirebaseCrashlyticsCollectionEnabled") as? Bool {
            return plistFlag
        }
        return true
    }

    package func snapshotBreadcrumbsAndDeferredFlag() -> ([CrashlyticsBreadcrumbEntry], Bool) {
        stateLock.withLock {
            (_breadcrumbs, !resolveCollectionEnabledLocked())
        }
    }

    package func syncDidCrashFlag(_ remoteDidCrash: Bool) {
        if remoteDidCrash {
            stateLock.withLock { _didPreviouslyCrash = true }
        }
    }

    package func baseParams() -> [String: AnySendable] {
        var params: [String: AnySendable] = [:]
        if let wireAppID {
            params["appId"] = .string(wireAppID)
        }
        return params
    }

    package func enqueueFireAndForgetOp(method: String, params: [String: AnySendable]) {
        serialQueue.enqueueFireAndForget { [weak self] in
            guard let self else { return }
            _ = try? await self.dispatchOp(method: method, params: params)
        }
    }

    package func dispatchOp(method: String, params: [String: AnySendable]) async throws -> AnySendable {
        let client = stateLock.withLock { _bridgeClient }
        return try await client.opWithAppCheck(
            app: app,
            method: method,
            params: params
        )
    }
}
