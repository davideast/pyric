import Foundation
import PyricFirestore

package struct RecordedCrashlyticsOp: Sendable {
    package let id: String
    package let method: String
    package let payload: [String: AnySendable]
}

/// Deterministic in-memory `WebSocketTransport` emulating the Pyric `CrashlyticsBroker`
/// and `appCheck.getToken` wire protocol for unit tests without opening sockets.
package final class MockCrashlyticsBridgeChannel: WebSocketTransport, @unchecked Sendable {
    private struct AppBucket {
        var collectionEnabled: Bool = true
        var userId: String?
        var customKeys: [String: AnySendable] = [:]
        var didCrashOnPreviousExecution: Bool = false
        var logs: [AnySendable] = []
        var reports: [[String: AnySendable]] = []
        var unsentReports: [[String: AnySendable]] = []
    }

    private let lock = NSLock()
    private var inboundQueue: [String] = []
    private var waiters: [CheckedContinuation<String, any Error>] = []
    private var closed = false
    private var nextReportSeq = 1
    private var apps: [String: AppBucket] = [:]
    private var recordedOps: [RecordedCrashlyticsOp] = []
    private var forcedFailureMethod: String?

    package init() {}

    package func failNextOp(forMethod method: String?) {
        lock.withLock {
            forcedFailureMethod = method
        }
    }

    package func snapshotOps() -> [RecordedCrashlyticsOp] {
        lock.withLock { recordedOps }
    }

    public func send(_ text: String) async throws {
        guard let data = text.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = frame["type"]?.stringValue else {
            return
        }

        switch type {
        case "attach":
            let ack: [String: AnySendable] = [
                "type": .string("attach-ack"),
                "protocol": .int(1),
                "peerConnected": .bool(true),
                "clientSessionId": .string("mock-crashlytics-session"),
            ]
            enqueueEncoded(ack)

        case "ping":
            if let id = frame["id"]?.stringValue {
                enqueueEncoded(["type": .string("pong"), "id": .string(id)])
            }

        case "worker-op":
            guard let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue,
                  let method = op["method"]?.stringValue else {
                return
            }
            let reply = lock.withLock { () -> [String: AnySendable] in
                recordedOps.append(RecordedCrashlyticsOp(id: id, method: method, payload: op))
                if forcedFailureMethod == method {
                    forcedFailureMethod = nil
                    return [
                        "type": .string("worker-res"),
                        "id": .string(id),
                        "ok": .bool(false),
                        "error": .dictionary([
                            "code": .string("unavailable"),
                            "message": .string("Injected failure for \(method)"),
                        ]),
                    ]
                }
                let result = handleOperationLocked(method: method, op: op)
                return [
                    "type": .string("worker-res"),
                    "id": .string(id),
                    "ok": .bool(true),
                    "value": result,
                ]
            }
            enqueueEncoded(reply)

        default:
            break
        }
    }

    public func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let immediate: Result<String, any Error>? = lock.withLock {
                if closed {
                    return .failure(CancellationError())
                }
                if !inboundQueue.isEmpty {
                    return .success(inboundQueue.removeFirst())
                }
                waiters.append(continuation)
                return nil
            }
            if let immediate {
                continuation.resume(with: immediate)
            }
        }
    }

    public func close(closeCode: Int, reason: String?) async {
        _ = closeCode
        _ = reason
        let pending: [CheckedContinuation<String, any Error>] = lock.withLock {
            closed = true
            let current = waiters
            waiters.removeAll()
            return current
        }
        for waiter in pending {
            waiter.resume(throwing: CancellationError())
        }
    }

    private func handleOperationLocked(method: String, op: [String: AnySendable]) -> AnySendable {
        if method == "appCheck.getToken" {
            let nowMs = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
            return .dictionary([
                "token": .string("mock-crashlytics-appcheck-jwt"),
                "expireTimeMillis": .int(nowMs + 3_600_000),
            ])
        }

        let rawAppId = op["appId"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let appKey = (rawAppId?.isEmpty == false) ? rawAppId! : "default"
        var bucket = apps[appKey] ?? AppBucket()

        let result: AnySendable
        switch method {
        case "crashlytics.log":
            let message = op["message"]?.stringValue ?? ""
            let ts = op["timestampMs"]?.intValue ?? 0
            var entry: [String: AnySendable] = [
                "message": .string(message),
                "timestampMs": .int(ts),
            ]
            if let attrs = op["attributes"] {
                entry["attributes"] = attrs
            }
            bucket.logs.append(.dictionary(entry))
            if bucket.logs.count > 256 {
                bucket.logs.removeFirst()
            }
            result = .dictionary([
                "logged": .bool(true),
                "logCount": .int(Int64(bucket.logs.count)),
            ])

        case "crashlytics.setUserId":
            bucket.userId = op["userId"]?.stringValue ?? ""
            result = .null

        case "crashlytics.setCustomKeys":
            if let keys = op["keys"]?.dictionaryValue {
                for (k, v) in keys {
                    if v.isNull {
                        bucket.customKeys.removeValue(forKey: k)
                    } else {
                        bucket.customKeys[k] = v
                    }
                }
            }
            result = .null

        case "crashlytics.setCollectionEnabled":
            if let enabled = op["enabled"]?.boolValue {
                bucket.collectionEnabled = enabled
            } else {
                bucket.collectionEnabled = true
            }
            result = .dictionary(["enabled": .bool(bucket.collectionEnabled)])

        case "crashlytics.recordError":
            let reportId = "crash-\(nextReportSeq)"
            nextReportSeq += 1
            let isFatal = op["fatal"]?.boolValue ?? false
            if isFatal {
                bucket.didCrashOnPreviousExecution = true
            }
            let crumbs = op["breadcrumbs"] ?? .array(bucket.logs)
            let report: [String: AnySendable] = [
                "reportId": .string(reportId),
                "appId": .string(appKey),
                "name": op["name"] ?? .string("Error"),
                "message": op["message"] ?? .string(""),
                "stack": op["stack"] ?? .null,
                "code": op["code"] ?? .null,
                "cause": op["cause"] ?? .null,
                "fatal": .bool(isFatal),
                "attributes": op["attributes"] ?? .dictionary([:]),
                "customKeys": .dictionary(bucket.customKeys),
                "userId": bucket.userId.map(AnySendable.string) ?? .null,
                "breadcrumbs": crumbs,
                "timestampMs": op["timestampMs"] ?? .int(0),
                "appVersion": op["appVersion"] ?? .null,
                "region": op["region"] ?? .null,
                "sdkPlatform": op["sdkPlatform"] ?? .string("ios"),
                "flushed": .bool(false),
            ]
            let deferred = op["deferred"]?.boolValue ?? false
            if !bucket.collectionEnabled || deferred {
                bucket.unsentReports.append(report)
            } else {
                bucket.reports.append(report)
            }
            result = .dictionary([
                "reportId": .string(reportId),
                "queued": .bool(true),
                "flushed": .bool(false),
            ])

        case "crashlytics.flush":
            var flushedCount: Int64 = 0
            for idx in bucket.reports.indices {
                if bucket.reports[idx]["flushed"]?.boolValue != true {
                    bucket.reports[idx]["flushed"] = .bool(true)
                    flushedCount += 1
                }
            }
            result = .dictionary(["flushedCount": .int(flushedCount)])

        case "crashlytics.checkForUnsentReports":
            let count = bucket.unsentReports.count
            result = .dictionary([
                "hasUnsentReports": .bool(count > 0),
                "count": .int(Int64(count)),
            ])

        case "crashlytics.sendUnsentReports":
            let pending = bucket.unsentReports
            bucket.unsentReports.removeAll()
            for var report in pending {
                report["flushed"] = .bool(true)
                bucket.reports.append(report)
            }
            result = .dictionary(["sentCount": .int(Int64(pending.count))])

        case "crashlytics.deleteUnsentReports":
            let deletedCount = bucket.unsentReports.count
            bucket.unsentReports.removeAll()
            result = .dictionary(["deletedCount": .int(Int64(deletedCount))])

        case "crashlytics.getState":
            result = .dictionary([
                "collectionEnabled": .bool(bucket.collectionEnabled),
                "userId": bucket.userId.map(AnySendable.string) ?? .null,
                "customKeys": .dictionary(bucket.customKeys),
                "appVersion": .null,
                "region": .null,
                "didCrashOnPreviousExecution": .bool(bucket.didCrashOnPreviousExecution),
                "logs": .array(bucket.logs),
                "reports": .array(bucket.reports.map(AnySendable.dictionary)),
                "unsentReports": .array(bucket.unsentReports.map(AnySendable.dictionary)),
            ])

        default:
            result = .null
        }

        apps[appKey] = bucket
        return result
    }

    private func enqueueEncoded(_ dict: [String: AnySendable]) {
        guard let data = try? JSONEncoder().encode(AnySendable.dictionary(dict)),
              let raw = String(data: data, encoding: .utf8) else {
            return
        }
        let waiter: CheckedContinuation<String, any Error>? = lock.withLock {
            if !waiters.isEmpty {
                return waiters.removeFirst()
            }
            inboundQueue.append(raw)
            return nil
        }
        waiter?.resume(returning: raw)
    }
}
