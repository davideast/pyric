import Foundation
import PyricFirestore

/// Generates chronologically ordered Firebase push IDs and provides value conversion utilities.
public enum PushIdGenerator {
    private static let pushChars = Array("-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz")
    private static let lock = NSLock()
    nonisolated(unsafe) private static var lastPushTime: Int64 = 0
    nonisolated(unsafe) private static var lastRandChars = [Int](repeating: 0, count: 12)

    /// Generates a 20-character chronologically ordered unique push ID.
    public static func generatePushId() -> String {
        lock.lock()
        defer { lock.unlock() }

        var now = Int64(Date().timeIntervalSince1970 * 1000)
        let duplicateTime = (now == lastPushTime)
        lastPushTime = now

        var timeStampChars = [Character](repeating: " ", count: 8)
        for i in stride(from: 7, through: 0, by: -1) {
            timeStampChars[i] = pushChars[Int(now % 64)]
            now /= 64
        }

        var id = String(timeStampChars)

        if !duplicateTime {
            for i in 0..<12 {
                lastRandChars[i] = Int.random(in: 0..<64)
            }
        } else {
            var i = 11
            while i >= 0 && lastRandChars[i] == 63 {
                lastRandChars[i] = 0
                i -= 1
            }
            if i >= 0 {
                lastRandChars[i] += 1
            }
        }

        for i in 0..<12 {
            id.append(pushChars[lastRandChars[i]])
        }

        return id
    }
}

/// Converts between native Swift RTDB values and AnySendable wire payloads.
public enum RtdbValueCodec {
    public static func toAnySendable(_ value: Any?) -> AnySendable {
        guard let value else { return .null }
        if value is NSNull { return .null }
        if let sendable = value as? AnySendable { return sendable }
        if let str = value as? String { return .string(str) }
        if let boolVal = value as? Bool { return .bool(boolVal) }
        if let intVal = value as? Int { return .int(Int64(intVal)) }
        if let int64Val = value as? Int64 { return .int(int64Val) }
        if let uintVal = value as? UInt { return .int(Int64(uintVal)) }
        if let doubleVal = value as? Double { return .double(doubleVal) }
        if let floatVal = value as? Float { return .double(Double(floatVal)) }
        if let num = value as? NSNumber {
            if CFGetTypeID(num) == CFBooleanGetTypeID() {
                return .bool(num.boolValue)
            }
            let objCType = String(cString: num.objCType)
            if objCType == "d" || objCType == "f" {
                return .double(num.doubleValue)
            }
            return .int(num.int64Value)
        }
        if let dict = value as? [String: Any] {
            var mapped: [String: AnySendable] = [:]
            for (k, v) in dict {
                mapped[k] = toAnySendable(v)
            }
            return .dictionary(mapped)
        }
        if let dict = value as? [AnyHashable: Any] {
            var mapped: [String: AnySendable] = [:]
            for (k, v) in dict {
                if let kStr = k as? String {
                    mapped[kStr] = toAnySendable(v)
                }
            }
            return .dictionary(mapped)
        }
        if let arr = value as? [Any] {
            return .array(arr.map { toAnySendable($0) })
        }
        return AnySendable.from(value)
    }

    public static func fromAnySendable(_ sendable: AnySendable?) -> Any? {
        guard let sendable else { return nil }
        switch sendable {
        case .null:
            return nil
        case .bool(let b):
            return b
        case .int(let i):
            return i
        case .double(let d):
            return d
        case .string(let s):
            return s
        case .array(let arr):
            return arr.map { fromAnySendable($0) ?? NSNull() }
        case .dictionary(let dict):
            var out: [String: Any] = [:]
            for (k, v) in dict {
                if let val = fromAnySendable(v) {
                    out[k] = val
                }
            }
            return out
        }
    }
}
