import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

/// Notification Service Extension helper matching `FIRMessagingExtensionHelper` (`MessagingExtensionHelper`)
/// and `Messaging.serviceExtension()` in `FirebaseMessaging 13.2.0`.
///
/// Never performs external network fetches in sandbox mode; records BigQuery delivery metrics
/// deterministically in memory for inspection and completes notification content modification locally.
public final class MessagingExtensionHelper: NSObject, @unchecked Sendable {
    private let lock = NSLock()
    private var _exportedMetrics: [[String: String]] = []

    public override init() {
        super.init()
    }

    /// Snapshot of delivery metric payloads exported via `exportDeliveryMetricsToBigQuery(withMessageInfo:)`.
    public var exportedMetrics: [[String: String]] {
        lock.lock()
        defer { lock.unlock() }
        return _exportedMetrics
    }

    /// Clears recorded delivery metric exports on this helper instance.
    public func resetExportedMetrics() {
        lock.lock()
        _exportedMetrics.removeAll()
        lock.unlock()
    }

    /// Records delivery metrics for BigQuery export, matching `FIRMessagingExtensionHelper.exportDeliveryMetricsToBigQuery(withMessageInfo:)`.
    public func exportDeliveryMetricsToBigQuery(withMessageInfo info: [AnyHashable: Any]) {
        guard !info.isEmpty else { return }
        var normalized: [String: String] = [:]
        for (rawKey, rawValue) in info {
            guard let key = rawKey as? String else { continue }
            if let str = rawValue as? String {
                normalized[key] = str
            } else if let num = rawValue as? NSNumber {
                normalized[key] = num.stringValue
            }
        }
        lock.lock()
        _exportedMetrics.append(normalized)
        lock.unlock()
    }

    #if canImport(UserNotifications)
    /// Completes notification content modification locally without external network fetches,
    /// matching `FIRMessagingExtensionHelper.populateNotificationContent(_:withContentHandler:)`.
    public func populateNotificationContent(
        _ content: UNMutableNotificationContent,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        exportDeliveryMetricsToBigQuery(withMessageInfo: content.userInfo)
        contentHandler(content)
    }
    #endif
}
