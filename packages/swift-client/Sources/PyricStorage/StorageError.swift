import Foundation
import PyricFirestore

/// Error domain matching `FIRStorageErrorDomain` (`StorageErrorDomain`) in `FirebaseStorage`.
public let StorageErrorDomain = "FIRStorageErrorDomain"

/// Error type matching `FIRStorageErrorCode` (`StorageErrorCode`) in `FirebaseStorage 13.2.0`.
///
/// Mirrors Swift's `NS_ERROR_ENUM` import shape so callers can match `catch StorageErrorCode.unauthorized`,
/// `switch error { case StorageErrorCode.objectNotFound: ... }`, construct `StorageErrorCode(rawValue:)`,
/// and inspect `NSError` `domain` and `code` identically across Darwin and Linux.
public struct StorageErrorCode: Error, LocalizedError, CustomNSError, CustomStringConvertible, Sendable, Hashable {
    public enum Code: Int, Sendable, Equatable, Hashable, CaseIterable {
        case unknown = -13000
        case objectNotFound = -13010
        case bucketNotFound = -13011
        case projectNotFound = -13012
        case quotaExceeded = -13013
        case unauthenticated = -13020
        case unauthorized = -13021
        case retryLimitExceeded = -13030
        case nonMatchingChecksum = -13031
        case downloadSizeExceeded = -13032
        case cancelled = -13040
        case invalidArgument = -13050
        case bucketMismatch = -13051
        case internalError = -13052
        case pathError = -13053
    }

    public static let unknown = StorageErrorCode(code: .unknown, message: "An unknown error occurred, please check the server response.")
    public static let objectNotFound = StorageErrorCode(code: .objectNotFound, message: "Object does not exist.")
    public static let bucketNotFound = StorageErrorCode(code: .bucketNotFound, message: "Bucket does not exist.")
    public static let projectNotFound = StorageErrorCode(code: .projectNotFound, message: "Project does not exist.")
    public static let quotaExceeded = StorageErrorCode(code: .quotaExceeded, message: "Quota for bucket exceeded.")
    public static let unauthenticated = StorageErrorCode(code: .unauthenticated, message: "User is not authenticated, please authenticate using Firebase Authentication and try again.")
    public static let unauthorized = StorageErrorCode(code: .unauthorized, message: "User does not have permission to access this object.")
    public static let retryLimitExceeded = StorageErrorCode(code: .retryLimitExceeded, message: "Max retry time for operation exceeded, please try again.")
    public static let nonMatchingChecksum = StorageErrorCode(code: .nonMatchingChecksum, message: "Uploaded/downloaded object checksum does not match server checksum.")
    public static let downloadSizeExceeded = StorageErrorCode(code: .downloadSizeExceeded, message: "Attempted to download object exceeding maximum allowed size.")
    public static let cancelled = StorageErrorCode(code: .cancelled, message: "User cancelled the upload/download.")
    public static let invalidArgument = StorageErrorCode(code: .invalidArgument, message: "Invalid argument provided to Storage operation.")
    public static let bucketMismatch = StorageErrorCode(code: .bucketMismatch, message: "Provided bucket does not match the Storage bucket of the current instance.")
    public static let internalError = StorageErrorCode(code: .internalError, message: "Internal Storage error.")
    public static let pathError = StorageErrorCode(code: .pathError, message: "Invalid Storage path or URL.")

    public let code: Code
    public let message: String
    public let underlyingDescription: String?
    package let totalSize: Int64?
    package let maxAllowedSize: Int64?

    public var rawValue: Int {
        code.rawValue
    }

    public init?(rawValue: Int) {
        guard let resolved = Code(rawValue: rawValue) else {
            return nil
        }
        self.code = resolved
        self.message = Self.defaultMessage(for: resolved)
        self.underlyingDescription = nil
        self.totalSize = nil
        self.maxAllowedSize = nil
    }

    public init(
        code: Code,
        message: String,
        underlyingDescription: String? = nil,
        totalSize: Int64? = nil,
        maxAllowedSize: Int64? = nil
    ) {
        self.code = code
        self.message = message
        self.underlyingDescription = underlyingDescription
        self.totalSize = totalSize
        self.maxAllowedSize = maxAllowedSize
    }

    package static func downloadSizeExceeded(total: Int64, maxSize: Int64) -> StorageErrorCode {
        StorageErrorCode(
            code: .downloadSizeExceeded,
            message: "Attempted to download object with size of \(total) bytes, which exceeds the maximum size of \(maxSize) bytes. Consider raising the maximum download maxSize, or using StorageReference.write",
            totalSize: total,
            maxAllowedSize: maxSize
        )
    }

    public static var errorDomain: String {
        StorageErrorDomain
    }

    public var errorCode: Int {
        code.rawValue
    }

    public var errorUserInfo: [String: Any] {
        var info: [String: Any] = [
            NSLocalizedDescriptionKey: message,
            NSLocalizedFailureReasonErrorKey: message
        ]
        if let underlyingDescription {
            info["PyricUnderlyingErrorDescription"] = underlyingDescription
        }
        if let totalSize {
            info["totalSize"] = totalSize
        }
        if let maxAllowedSize {
            info["maxAllowedSize"] = maxAllowedSize
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
        "StorageError(code: \(code.rawValue), message: \(message))"
    }

    public static func == (lhs: StorageErrorCode, rhs: StorageErrorCode) -> Bool {
        lhs.code == rhs.code
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(code)
    }

    public static func from(_ error: Error) -> StorageErrorCode {
        if let existing = error as? StorageErrorCode {
            return existing
        }
        if error is CancellationError {
            return .cancelled
        }
        if let bridgeError = error as? PyricBridgeError {
            let mapped = mapBridgeError(bridgeError)
            return StorageErrorCode(
                code: mapped,
                message: bridgeError.message,
                underlyingDescription: bridgeError.description
            )
        }
        let nsError = error as NSError
        if nsError.domain == StorageErrorDomain,
           let mapped = Code(rawValue: nsError.code) {
            return StorageErrorCode(
                code: mapped,
                message: nsError.localizedDescription
            )
        }
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return .cancelled
        }
        return StorageErrorCode(
            code: .unknown,
            message: error.localizedDescription,
            underlyingDescription: String(describing: error)
        )
    }

    package static func mapWireCode(_ rawCode: String) -> Code? {
        let normalized = rawCode
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
        let stripped = normalized.hasPrefix("storage/")
            ? String(normalized.dropFirst("storage/".count))
            : normalized

        switch stripped {
        case "unknown":
            return .unknown
        case "object-not-found", "not-found":
            return .objectNotFound
        case "bucket-not-found":
            return .bucketNotFound
        case "project-not-found":
            return .projectNotFound
        case "quota-exceeded", "payload-too-large", "resource-exhausted":
            return .quotaExceeded
        case "unauthenticated":
            return .unauthenticated
        case "unauthorized", "permission-denied":
            return .unauthorized
        case "retry-limit-exceeded", "object-changed", "deadline-exceeded", "unavailable":
            return .retryLimitExceeded
        case "non-matching-checksum", "data-loss":
            return .nonMatchingChecksum
        case "download-size-exceeded":
            return .downloadSizeExceeded
        case "canceled", "cancelled":
            return .cancelled
        case "invalid-argument", "invalid-root-operation", "invalid-url", "invalid-checksum", "invalid-event-name", "invalid-format":
            return .invalidArgument
        case "bucket-mismatch":
            return .bucketMismatch
        case "internal-error", "internal":
            return .internalError
        case "path-error":
            return .pathError
        default:
            return nil
        }
    }

    private static func mapBridgeError(_ error: PyricBridgeError) -> Code {
        if let fromRaw = mapWireCode(error.rawCode) {
            return fromRaw
        }
        switch error.code {
        case .notFound:
            return .objectNotFound
        case .permissionDenied:
            return .unauthorized
        case .unauthenticated:
            return .unauthenticated
        case .resourceExhausted:
            return .quotaExceeded
        case .cancelled:
            return .cancelled
        case .invalidArgument:
            return .invalidArgument
        case .deadlineExceeded, .unavailable, .aborted:
            return .retryLimitExceeded
        case .dataLoss:
            return .nonMatchingChecksum
        case .internalError:
            return .internalError
        default:
            return .unknown
        }
    }

    private static func defaultMessage(for code: Code) -> String {
        switch code {
        case .unknown: return Self.unknown.message
        case .objectNotFound: return Self.objectNotFound.message
        case .bucketNotFound: return Self.bucketNotFound.message
        case .projectNotFound: return Self.projectNotFound.message
        case .quotaExceeded: return Self.quotaExceeded.message
        case .unauthenticated: return Self.unauthenticated.message
        case .unauthorized: return Self.unauthorized.message
        case .retryLimitExceeded: return Self.retryLimitExceeded.message
        case .nonMatchingChecksum: return Self.nonMatchingChecksum.message
        case .downloadSizeExceeded: return Self.downloadSizeExceeded.message
        case .cancelled: return Self.cancelled.message
        case .invalidArgument: return Self.invalidArgument.message
        case .bucketMismatch: return Self.bucketMismatch.message
        case .internalError: return Self.internalError.message
        case .pathError: return Self.pathError.message
        }
    }
}

public typealias StorageError = StorageErrorCode

public func ~= (lhs: StorageErrorCode, rhs: any Error) -> Bool {
    if let structured = rhs as? StorageErrorCode {
        return lhs.code == structured.code
    }
    let nsError = rhs as NSError
    return nsError.domain == StorageErrorDomain && nsError.code == lhs.rawValue
}
