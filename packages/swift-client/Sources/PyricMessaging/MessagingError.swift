import Foundation
import PyricFirestore

/// Error domain matching `FIRMessagingErrorDomain` (`MessagingErrorDomain`) in `FirebaseMessaging 13.2.0`.
public let MessagingErrorDomain: String = "com.google.fcm"

/// Notification posted when the FCM registration token is minted or refreshed,
/// matching `FIRMessagingRegistrationTokenRefreshedNotification`.
public let MessagingRegistrationTokenRefreshedNotification = Notification.Name(
    "com.firebase.messaging.notif.fcm-token-refreshed"
)

/// Notification posted when the FCM installation registration is unregistered,
/// matching `FIRMessagingInstallationIdUnregisteredNotification`.
public let MessagingInstallationIdUnregisteredNotification = Notification.Name(
    "com.firebase.messaging.notif.installation-id-unregistered"
)

public extension Notification.Name {
    /// Posted when the FCM registration token is minted or refreshed,
    /// matching `NSNotification.Name.MessagingRegistrationTokenRefreshed` in `FirebaseMessaging 13.2.0`.
    static let MessagingRegistrationTokenRefreshed = MessagingRegistrationTokenRefreshedNotification

    /// Posted when the FCM installation ID is unregistered from FCM,
    /// matching `NSNotification.Name.messagingInstallationIdUnregistered` in `FirebaseMessaging 13.2.0`.
    static let messagingInstallationIdUnregistered = MessagingInstallationIdUnregisteredNotification
}

/// Error type matching `NS_ERROR_ENUM(FIRMessagingErrorDomain, FIRMessagingError)` (`MessagingError`)
/// in `FirebaseMessaging 13.2.0`, extended with `.disabled` for hosts built without Messaging enabled.
///
/// Mirrors Swift's `NS_ERROR_ENUM` import shape so callers can match `catch MessagingError.invalidTopicName`,
/// `catch let err as MessagingError`, construct `MessagingError(rawValue:)`, and inspect `NSError`
/// `domain` (`MessagingErrorDomain`) and `code` identically across Apple platforms and Linux.
public struct MessagingError: Error, LocalizedError, CustomNSError, CustomStringConvertible, Sendable, Hashable {
    public enum Code: Int, Sendable, Equatable, Hashable, CaseIterable {
        /// Unknown error (`FIRMessagingErrorUnknown = 0`).
        case unknown = 0
        /// Could not validate request from this client (`FIRMessagingErrorAuthentication = 1`).
        case authentication = 1
        /// Messaging / InstanceID service cannot be accessed (`FIRMessagingErrorNoAccess = 2`).
        case noAccess = 2
        /// Request to Messaging backend timed out (`FIRMessagingErrorTimeout = 3`).
        case timeout = 3
        /// No network available to reach the servers (`FIRMessagingErrorNetwork = 4`).
        case network = 4
        /// Another similar operation is in progress (`FIRMessagingErrorOperationInProgress = 5`).
        case operationInProgress = 5
        /// Parameters of the request were invalid (`FIRMessagingErrorInvalidRequest = 7`).
        case invalidRequest = 7
        /// Topic name is invalid for subscription or unsubscription (`FIRMessagingErrorInvalidTopicName = 8`).
        case invalidTopicName = 8
        /// Sandbox host was constructed without Messaging enabled (`messaging/disabled`).
        case disabled = 9
    }

    public static let unknown = MessagingError(code: .unknown, message: "Unknown Firebase Messaging error.")
    public static let authentication = MessagingError(
        code: .authentication,
        message: "Firebase Messaging could not validate the request."
    )
    public static let noAccess = MessagingError(
        code: .noAccess,
        message: "Firebase Messaging service access was denied."
    )
    public static let timeout = MessagingError(
        code: .timeout,
        message: "Firebase Messaging request timed out."
    )
    public static let network = MessagingError(
        code: .network,
        message: "No network connection available to reach Firebase Messaging."
    )
    public static let operationInProgress = MessagingError(
        code: .operationInProgress,
        message: "Another conflicting Firebase Messaging operation is already in progress."
    )
    public static let invalidRequest = MessagingError(
        code: .invalidRequest,
        message: "Invalid parameters provided to Firebase Messaging."
    )
    public static let invalidTopicName = MessagingError(
        code: .invalidTopicName,
        message: "Invalid topic name for Firebase Messaging subscription."
    )
    public static let disabled = MessagingError(
        code: .disabled,
        message: "Firebase Messaging is disabled on the connected Pyric sandbox host."
    )

    public let code: Code
    public let message: String
    /// Raw status code reported by the Pyric broker (e.g. `"NOT_FOUND"`, `"INVALID_ARGUMENT"`), if any.
    public let brokerStatus: String?
    /// Captured `google.rpc` error envelope returned by `messaging.send` or topic ops, if any.
    public let envelope: AnySendable?

    public var rawValue: Int {
        code.rawValue
    }

    public init?(rawValue: Int) {
        guard let resolved = Code(rawValue: rawValue) else {
            return nil
        }
        self.code = resolved
        self.message = Self.defaultMessage(for: resolved)
        self.brokerStatus = nil
        self.envelope = nil
    }

    public init(
        code: Code,
        message: String,
        brokerStatus: String? = nil,
        envelope: AnySendable? = nil
    ) {
        self.code = code
        self.message = message
        self.brokerStatus = brokerStatus
        self.envelope = envelope
    }

    public static var errorDomain: String {
        MessagingErrorDomain
    }

    public var errorCode: Int {
        code.rawValue
    }

    public var errorUserInfo: [String: Any] {
        var info: [String: Any] = [
            NSLocalizedDescriptionKey: message,
            NSLocalizedFailureReasonErrorKey: message,
        ]
        if let brokerStatus {
            info["status"] = brokerStatus
        }
        if let envelope {
            info["envelope"] = envelope.toAny()
        }
        return info
    }

    public var errorDescription: String? {
        message
    }

    public var failureReason: String? {
        message
    }

    public var description: String {
        if let brokerStatus {
            return "MessagingError(code: \(code.rawValue), status: \(brokerStatus), message: \(message))"
        }
        return "MessagingError(code: \(code.rawValue), message: \(message))"
    }

    public static func == (lhs: MessagingError, rhs: MessagingError) -> Bool {
        lhs.code == rhs.code
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(code)
    }

    package static func fromWireError(_ errorObj: AnySendable) -> MessagingError {
        let rawCode = errorObj["code"]?.stringValue ?? "unknown"
        let message = errorObj["message"]?.stringValue ?? "Firebase Messaging bridge operation failed."
        let envelope = errorObj["envelope"]
        let mapped = mapWireCode(rawCode, message: message)
        return MessagingError(
            code: mapped,
            message: message,
            brokerStatus: rawCode,
            envelope: envelope
        )
    }

    public static func from(_ error: any Error) -> MessagingError {
        if let existing = error as? MessagingError {
            return existing
        }
        if error is CancellationError {
            return MessagingError(code: .unknown, message: "Firebase Messaging operation was cancelled.")
        }
        if let bridgeError = error as? PyricBridgeError {
            let mapped = mapWireCode(bridgeError.rawCode, message: bridgeError.message)
            return MessagingError(
                code: mapped,
                message: bridgeError.message,
                brokerStatus: bridgeError.rawCode
            )
        }
        let nsError = error as NSError
        if nsError.domain == MessagingErrorDomain,
           let mapped = Code(rawValue: nsError.code) {
            return MessagingError(
                code: mapped,
                message: nsError.localizedDescription,
                brokerStatus: nsError.userInfo["status"] as? String
            )
        }
        return MessagingError(code: .unknown, message: error.localizedDescription)
    }

    package static func mapWireCode(_ rawCode: String, message: String) -> Code {
        let trimmed = rawCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.lowercased().replacingOccurrences(of: "_", with: "-")
        let stripped = normalized.hasPrefix("messaging/")
            ? String(normalized.dropFirst("messaging/".count))
            : normalized

        switch stripped {
        case "disabled":
            return .disabled
        case "invalid-topic-name":
            return .invalidTopicName
        case "invalid-argument", "failed-precondition", "out-of-range":
            if message.lowercased().contains("topic") {
                return .invalidTopicName
            }
            return .invalidRequest
        case "not-found", "unregistered", "unregistered-token", "invalid-token":
            return .invalidRequest
        case "unauthenticated", "authentication":
            return .authentication
        case "permission-denied", "unauthorized", "no-access":
            return .noAccess
        case "deadline-exceeded", "timeout":
            return .timeout
        case "unavailable", "network":
            return .network
        case "aborted", "already-exists", "operation-in-progress":
            return .operationInProgress
        default:
            return .unknown
        }
    }

    private static func defaultMessage(for code: Code) -> String {
        switch code {
        case .unknown: return Self.unknown.message
        case .authentication: return Self.authentication.message
        case .noAccess: return Self.noAccess.message
        case .timeout: return Self.timeout.message
        case .network: return Self.network.message
        case .operationInProgress: return Self.operationInProgress.message
        case .invalidRequest: return Self.invalidRequest.message
        case .invalidTopicName: return Self.invalidTopicName.message
        case .disabled: return Self.disabled.message
        }
    }
}

public typealias MessagingErrorCode = MessagingError.Code

public func ~= (lhs: MessagingError, rhs: any Error) -> Bool {
    if let structured = rhs as? MessagingError {
        return lhs.code == structured.code
    }
    let nsError = rhs as NSError
    return nsError.domain == MessagingErrorDomain && nsError.code == lhs.rawValue
}
