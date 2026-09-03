import Foundation

/// A Timestamp represents a point in time independent of any time zone or calendar,
/// represented as seconds and fractions of seconds at nanosecond resolution in UTC Epoch time.
public struct Timestamp: Equatable, Hashable, Comparable, Sendable {
    public let seconds: Int64
    public let nanoseconds: Int32

    private static let minSeconds: Int64 = -62_135_596_800 // 0001-01-01T00:00:00Z
    private static let maxSeconds: Int64 = 253_402_300_799 // 9999-12-31T23:59:59Z

    public init(seconds: Int64, nanoseconds: Int32) {
        precondition(
            nanoseconds >= 0 && nanoseconds < 1_000_000_000,
            "Timestamp nanoseconds out of range: \(nanoseconds)"
        )
        precondition(
            seconds >= Self.minSeconds && seconds <= Self.maxSeconds,
            "Timestamp seconds out of range: \(seconds)"
        )
        self.seconds = seconds
        self.nanoseconds = nanoseconds
    }

    public init(date: Date) {
        let interval = date.timeIntervalSince1970
        var secondsDouble: Double = 0
        var fraction = modf(interval, &secondsDouble)
        if fraction < 0 {
            fraction += 1.0
            secondsDouble -= 1.0
        }
        var sec = Int64(secondsDouble)
        var nanos = Int32(round(fraction * 1_000_000_000.0))
        if nanos >= 1_000_000_000 {
            nanos = 0
            sec += 1
        }
        self.init(seconds: sec, nanoseconds: nanos)
    }

    public init() {
        self.init(date: Date())
    }

    public func dateValue() -> Date {
        let interval = TimeInterval(seconds) + (TimeInterval(nanoseconds) / 1_000_000_000.0)
        return Date(timeIntervalSince1970: interval)
    }

    public func compare(_ other: Timestamp) -> ComparisonResult {
        if seconds < other.seconds { return .orderedAscending }
        if seconds > other.seconds { return .orderedDescending }
        if nanoseconds < other.nanoseconds { return .orderedAscending }
        if nanoseconds > other.nanoseconds { return .orderedDescending }
        return .orderedSame
    }

    public static func < (lhs: Timestamp, rhs: Timestamp) -> Bool {
        if lhs.seconds != rhs.seconds {
            return lhs.seconds < rhs.seconds
        }
        return lhs.nanoseconds < rhs.nanoseconds
    }
}

extension Timestamp: CustomStringConvertible {
    public var description: String {
        "<Timestamp: seconds=\(seconds) nanoseconds=\(nanoseconds)>"
    }
}

extension Timestamp: Codable {
    private enum CodingKeys: String, CodingKey {
        case seconds
        case nanoseconds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let sec = try container.decode(Int64.self, forKey: .seconds)
        let nano = try container.decode(Int32.self, forKey: .nanoseconds)
        self.init(seconds: sec, nanoseconds: nano)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seconds, forKey: .seconds)
        try container.encode(nanoseconds, forKey: .nanoseconds)
    }
}
