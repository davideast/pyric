import Foundation

/// Internal protocol for all FieldValue sentinels serialized across the Pyric wire.
public protocol PyricSentinel: Sendable {
    func toWireSentinel() throws -> [String: Any]
    func isEqual(to other: any PyricSentinel) -> Bool
}

public final class PyricServerTimestampSentinel: PyricSentinel, Equatable, @unchecked Sendable {
    public init() {}

    public func toWireSentinel() throws -> [String: Any] {
        ["__sentinel": "serverTimestamp"]
    }

    public func isEqual(to other: any PyricSentinel) -> Bool {
        other is PyricServerTimestampSentinel
    }

    public static func == (lhs: PyricServerTimestampSentinel, rhs: PyricServerTimestampSentinel) -> Bool {
        true
    }
}

public final class PyricDeleteFieldSentinel: PyricSentinel, Equatable, @unchecked Sendable {
    public init() {}

    public func toWireSentinel() throws -> [String: Any] {
        ["__sentinel": "deleteField"]
    }

    public func isEqual(to other: any PyricSentinel) -> Bool {
        other is PyricDeleteFieldSentinel
    }

    public static func == (lhs: PyricDeleteFieldSentinel, rhs: PyricDeleteFieldSentinel) -> Bool {
        true
    }
}

public final class PyricIncrementSentinel: PyricSentinel, Equatable, @unchecked Sendable {
    public let value: NSNumber

    public init(_ value: Double) {
        self.value = NSNumber(value: value)
    }

    public init(_ value: Int64) {
        self.value = NSNumber(value: value)
    }

    public init(number: NSNumber) {
        self.value = number
    }

    public func toWireSentinel() throws -> [String: Any] {
        ["__sentinel": "increment", "n": value]
    }

    public func isEqual(to other: any PyricSentinel) -> Bool {
        guard let rhs = other as? PyricIncrementSentinel else { return false }
        return self == rhs
    }

    public static func == (lhs: PyricIncrementSentinel, rhs: PyricIncrementSentinel) -> Bool {
        lhs.value.isEqual(to: rhs.value)
    }
}

public final class PyricArrayUnionSentinel: PyricSentinel, Equatable, @unchecked Sendable {
    public let values: [Any]

    public init(_ values: [Any]) {
        self.values = values
    }

    public func toWireSentinel() throws -> [String: Any] {
        let encoded = try values.map { try ValueCodec.encodeValue($0) }
        return ["__sentinel": "arrayUnion", "values": encoded]
    }

    public func isEqual(to other: any PyricSentinel) -> Bool {
        guard let rhs = other as? PyricArrayUnionSentinel else { return false }
        return self == rhs
    }

    public static func == (lhs: PyricArrayUnionSentinel, rhs: PyricArrayUnionSentinel) -> Bool {
        anyArraysEqual(lhs.values, rhs.values)
    }
}

public final class PyricArrayRemoveSentinel: PyricSentinel, Equatable, @unchecked Sendable {
    public let values: [Any]

    public init(_ values: [Any]) {
        self.values = values
    }

    public func toWireSentinel() throws -> [String: Any] {
        let encoded = try values.map { try ValueCodec.encodeValue($0) }
        return ["__sentinel": "arrayRemove", "values": encoded]
    }

    public func isEqual(to other: any PyricSentinel) -> Bool {
        guard let rhs = other as? PyricArrayRemoveSentinel else { return false }
        return self == rhs
    }

    public static func == (lhs: PyricArrayRemoveSentinel, rhs: PyricArrayRemoveSentinel) -> Bool {
        anyArraysEqual(lhs.values, rhs.values)
    }
}

public final class PyricVectorSentinel: PyricSentinel, Equatable, @unchecked Sendable {
    public let values: [Double]

    public init(_ values: [Double]) {
        self.values = values
    }

    public func toWireSentinel() throws -> [String: Any] {
        ["__sentinel": "vector", "values": values]
    }

    public func isEqual(to other: any PyricSentinel) -> Bool {
        guard let rhs = other as? PyricVectorSentinel else { return false }
        return self == rhs
    }

    public static func == (lhs: PyricVectorSentinel, rhs: PyricVectorSentinel) -> Bool {
        lhs.values == rhs.values
    }
}

// MARK: - Heterogeneous Equality Helpers

internal func isBooleanValue(_ value: Any) -> Bool {
    if let num = value as? NSNumber {
        return CFGetTypeID(num) == CFBooleanGetTypeID()
    }
    if value is Bool {
        return true
    }
    return false
}

internal func anyValuesEqual(_ lhs: Any, _ rhs: Any) -> Bool {
    let lhsIsBool = isBooleanValue(lhs)
    let rhsIsBool = isBooleanValue(rhs)
    if lhsIsBool || rhsIsBool {
        guard lhsIsBool && rhsIsBool else { return false }
        let lBool = (lhs as? Bool) ?? (lhs as? NSNumber)?.boolValue ?? false
        let rBool = (rhs as? Bool) ?? (rhs as? NSNumber)?.boolValue ?? false
        return lBool == rBool
    }

    if let lNum = lhs as? NSNumber, let rNum = rhs as? NSNumber {
        return lNum.isEqual(to: rNum)
    }
    if let lStr = lhs as? String, let rStr = rhs as? String {
        return lStr == rStr
    }
    if let lTs = lhs as? Timestamp, let rTs = rhs as? Timestamp {
        return lTs == rTs
    }
    if let lGp = lhs as? GeoPoint, let rGp = rhs as? GeoPoint {
        return lGp == rGp
    }
    if let lData = lhs as? Data, let rData = rhs as? Data {
        return lData == rData
    }
    if let lVec = lhs as? VectorValue, let rVec = rhs as? VectorValue {
        return lVec == rVec
    }
    if let lFv = lhs as? FieldValue, let rFv = rhs as? FieldValue {
        return lFv == rFv
    }
    if let lSentinel = lhs as? any PyricSentinel, let rSentinel = rhs as? any PyricSentinel {
        return lSentinel.isEqual(to: rSentinel)
    }
    if let lRef = lhs as? PathReferenceable, let rRef = rhs as? PathReferenceable {
        return lRef.path == rRef.path
    }
    if let lArr = lhs as? [Any], let rArr = rhs as? [Any] {
        return anyArraysEqual(lArr, rArr)
    }
    if let lDict = lhs as? [String: Any], let rDict = rhs as? [String: Any] {
        return anyDictionariesEqual(lDict, rDict)
    }
    if let lHash = lhs as? AnyHashable, let rHash = rhs as? AnyHashable {
        return lHash == rHash
    }
    return false
}

internal func anyArraysEqual(_ lhs: [Any], _ rhs: [Any]) -> Bool {
    guard lhs.count == rhs.count else { return false }
    for i in 0..<lhs.count {
        if !anyValuesEqual(lhs[i], rhs[i]) {
            return false
        }
    }
    return true
}

internal func anyDictionariesEqual(_ lhs: [String: Any], _ rhs: [String: Any]) -> Bool {
    guard lhs.count == rhs.count else { return false }
    for (k, lv) in lhs {
        guard let rv = rhs[k] else { return false }
        if !anyValuesEqual(lv, rv) {
            return false
        }
    }
    return true
}
