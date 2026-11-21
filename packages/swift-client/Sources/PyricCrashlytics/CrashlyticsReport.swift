import Foundation

/// Represents an unsent Crashlytics report yielded by `Crashlytics.checkAndUpdateUnsentReports()`,
/// mirroring `FirebaseCrashlytics.CrashlyticsReport` (`FIRCrashlyticsReport` in `firebase-ios-sdk:13.2.0`).
public final class CrashlyticsReport: NSObject, @unchecked Sendable {
    public let reportID: String
    public let dateCreated: Date
    public let hasCrash: Bool

    private weak var owner: Crashlytics?
    private let stateLock = NSLock()
    private var _loggedMessages: [String] = []
    private var _customValues: [String: CrashlyticsCustomValue] = [:]
    private var _userID: String?

    @available(*, unavailable, message: "CrashlyticsReport instances are provided by checkAndUpdateUnsentReports.")
    override public init() {
        fatalError("CrashlyticsReport cannot be initialized directly with init().")
    }

    package init(
        reportID: String,
        dateCreated: Date,
        hasCrash: Bool,
        owner: Crashlytics?
    ) {
        self.reportID = reportID
        self.dateCreated = dateCreated
        self.hasCrash = hasCrash
        self.owner = owner
        super.init()
    }

    /// Appends a log message to the report and underlying Crashlytics session.
    public func log(_ msg: String) {
        stateLock.withLock {
            _loggedMessages.append(msg)
        }
        owner?.log(msg)
    }

    /// Appends a formatted log message using variadic `CVarArg` arguments.
    public func log(format: String, _ args: any CVarArg...) {
        let formatted = withVaList(args) { ptr in
            NSString(format: format, arguments: ptr) as String
        }
        log(formatted)
    }

    /// Appends a formatted log message using a `CVaListPointer`.
    public func log(format: String, arguments args: CVaListPointer) {
        let formatted = NSString(format: format, arguments: args) as String
        log(formatted)
    }

    /// Sets or removes (`nil`) a custom key-value annotation on the report and Crashlytics session.
    public func setCustomValue(_ value: Any?, forKey key: String) {
        let wireScalar = CrashlyticsValueNormalizer.normalizeCustomValue(value)
        stateLock.withLock {
            if let mapped = CrashlyticsCustomValue.fromWire(wireScalar) {
                _customValues[key] = mapped
            } else {
                _customValues.removeValue(forKey: key)
            }
        }
        owner?.setCustomValue(value, forKey: key)
    }

    /// Sets or removes multiple custom key-value annotations on the report and Crashlytics session.
    public func setCustomKeysAndValues(_ keysAndValues: [AnyHashable: Any]) {
        stateLock.withLock {
            for (rawKey, rawValue) in keysAndValues {
                let key = (rawKey as? String) ?? String(describing: rawKey)
                let wireScalar = CrashlyticsValueNormalizer.normalizeCustomValue(rawValue)
                if let mapped = CrashlyticsCustomValue.fromWire(wireScalar) {
                    _customValues[key] = mapped
                } else {
                    _customValues.removeValue(forKey: key)
                }
            }
        }
        owner?.setCustomKeysAndValues(keysAndValues)
    }

    /// Associates a user identifier with the report and Crashlytics session.
    public func setUserID(_ userID: String?) {
        stateLock.withLock {
            _userID = userID
        }
        owner?.setUserID(userID)
    }

    package var loggedMessagesSnapshot: [String] {
        stateLock.withLock { _loggedMessages }
    }

    package var customValuesSnapshot: [String: CrashlyticsCustomValue] {
        stateLock.withLock { _customValues }
    }

    package var userIDSnapshot: String? {
        stateLock.withLock { _userID }
    }
}
