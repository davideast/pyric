import Foundation

/// Validates and normalizes FCM topic names against `[a-zA-Z0-9-_.~%]{1,900}`
/// with an optional leading `"/topics/"` prefix, matching `FIRMessagingPubSub`
/// and `packages/pyric/src/messaging/broker/validate.ts`.
package enum MessagingTopicValidator {
    private static let topicPrefix = "/topics/"
    private static let maxTopicLength = 900

    package static func normalize(_ rawTopic: String) throws -> String {
        let stripped: String
        if rawTopic.hasPrefix(topicPrefix) {
            stripped = String(rawTopic.dropFirst(topicPrefix.count))
        } else {
            stripped = rawTopic
        }

        let utf8Count = stripped.utf8.count
        guard utf8Count >= 1, utf8Count <= maxTopicLength, stripped.unicodeScalars.count == utf8Count else {
            throw MessagingError(
                code: .invalidTopicName,
                message: "Invalid topic name '\(rawTopic)': must match [a-zA-Z0-9-_.~%]{1,900} (with optional /topics/ prefix)."
            )
        }

        for byte in stripped.utf8 {
            if !isAllowedTopicByte(byte) {
                throw MessagingError(
                    code: .invalidTopicName,
                    message: "Invalid topic name '\(rawTopic)': must match [a-zA-Z0-9-_.~%]{1,900} (with optional /topics/ prefix)."
                )
            }
        }
        return stripped
    }

    private static func isAllowedTopicByte(_ byte: UInt8) -> Bool {
        // 'a'...'z' (97...122), 'A'...'Z' (65...90), '0'...'9' (48...57)
        if (byte >= 97 && byte <= 122) || (byte >= 65 && byte <= 90) || (byte >= 48 && byte <= 57) {
            return true
        }
        // '-' (45), '_' (95), '.' (46), '~' (126), '%' (37)
        switch byte {
        case 45, 95, 46, 126, 37:
            return true
        default:
            return false
        }
    }
}
