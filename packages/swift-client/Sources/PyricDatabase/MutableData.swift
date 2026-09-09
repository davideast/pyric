import Foundation
import PyricFirestore

/// A mutable snapshot of data at a Realtime Database location used in transactions.
public final class MutableData: NSObject, @unchecked Sendable {
    public var value: Any?
    public var priority: Any?
    public let key: String?

    public init(key: String? = nil, value: Any? = nil, priority: Any? = nil) {
        self.key = key
        self.value = value
        self.priority = priority
        super.init()
    }

    public var childrenCount: UInt {
        if let dict = value as? [String: Any] {
            return UInt(dict.count)
        }
        return 0
    }

    public func hasChildren() -> Bool {
        return childrenCount > 0
    }

    public func hasChild(atPath path: String) -> Bool {
        let child = childData(byAppendingPath: path)
        return child.value != nil && !(child.value is NSNull)
    }

    public func childData(byAppendingPath path: String) -> MutableData {
        let segments = path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard !segments.isEmpty else { return self }

        var curVal = value
        for seg in segments {
            if let dict = curVal as? [String: Any] {
                curVal = dict[seg]
            } else {
                curVal = nil
            }
        }
        return MutableData(key: segments.last, value: curVal, priority: nil)
    }

    public var children: NSEnumerator {
        guard let dict = value as? [String: Any] else {
            return ([] as NSArray).objectEnumerator()
        }
        let sortedKeys = dict.keys.sorted()
        let items = sortedKeys.map { k in
            MutableData(key: k, value: dict[k], priority: nil)
        }
        return (items as NSArray).objectEnumerator()
    }
}

/// The result of a Realtime Database transaction block.
public final class TransactionResult: NSObject, @unchecked Sendable {
    public let isAborted: Bool
    public let mutableData: MutableData?

    private init(isAborted: Bool, mutableData: MutableData?) {
        self.isAborted = isAborted
        self.mutableData = mutableData
        super.init()
    }

    /// Commits the transaction with the updated MutableData value.
    public static func success(withValue value: MutableData) -> TransactionResult {
        return TransactionResult(isAborted: false, mutableData: value)
    }

    /// Aborts the transaction without saving any changes.
    public static func abort() -> TransactionResult {
        return TransactionResult(isAborted: true, mutableData: nil)
    }
}
