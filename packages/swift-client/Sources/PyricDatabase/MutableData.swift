import Foundation
import PyricFirestore

/// A mutable snapshot of data at a Realtime Database location used in transactions.
public final class MutableData: NSObject, @unchecked Sendable {
    private var _value: Any?
    private let onValueMutated: (@Sendable (Any?) -> Void)?

    public var value: Any? {
        get { _value }
        set {
            let normalized: Any? = (newValue is NSNull) ? nil : newValue
            _value = normalized
            onValueMutated?(normalized)
        }
    }

    public var priority: Any?
    public let key: String?

    internal init(
        key: String? = nil,
        value: Any? = nil,
        priority: Any? = nil,
        onValueMutated: (@Sendable (Any?) -> Void)?
    ) {
        self.key = key
        self._value = (value is NSNull) ? nil : value
        self.priority = (priority is NSNull) ? nil : priority
        self.onValueMutated = onValueMutated
        super.init()
    }

    public convenience init(key: String? = nil, value: Any? = nil, priority: Any? = nil) {
        self.init(key: key, value: value, priority: priority, onValueMutated: nil)
    }

    public var childrenCount: UInt {
        if let dict = _value as? [String: Any] {
            return UInt(dict.values.filter { !($0 is NSNull) }.count)
        }
        if let arr = _value as? [Any] {
            return UInt(arr.filter { !($0 is NSNull) }.count)
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

        var curVal = _value
        for seg in segments {
            if let dict = curVal as? [String: Any] {
                let candidate = dict[seg]
                curVal = (candidate is NSNull) ? nil : candidate
            } else if let arr = curVal as? [Any], let idx = Int(seg), idx >= 0, idx < arr.count {
                let candidate = arr[idx]
                curVal = (candidate is NSNull) ? nil : candidate
            } else {
                curVal = nil
            }
        }
        return MutableData(key: segments.last, value: curVal, priority: nil) { [weak self] updated in
            self?.updateNestedChild(segments: segments, updated: updated)
        }
    }

    public var children: NSEnumerator {
        if let dict = _value as? [String: Any] {
            let sortedKeys = dict.keys.sorted { DataSnapshot.compareRtdbKeys($0, $1) == .orderedAscending }
            var items: [MutableData] = []
            for k in sortedKeys {
                guard let childVal = dict[k], !(childVal is NSNull) else { continue }
                let child = MutableData(key: k, value: childVal, priority: nil) { [weak self] updated in
                    self?.updateNestedChild(segments: [k], updated: updated)
                }
                items.append(child)
            }
            return NSArray(array: items).objectEnumerator()
        }
        if let arr = _value as? [Any] {
            var items: [MutableData] = []
            for (idx, elem) in arr.enumerated() where !(elem is NSNull) {
                let k = String(idx)
                let child = MutableData(key: k, value: elem, priority: nil) { [weak self] updated in
                    self?.updateNestedChild(segments: [k], updated: updated)
                }
                items.append(child)
            }
            return NSArray(array: items).objectEnumerator()
        }
        return NSArray().objectEnumerator()
    }

    private func updateNestedChild(segments: [String], updated: Any?) {
        if segments.isEmpty {
            self.value = updated
            return
        }
        self.value = Self.writeNested(current: _value, segments: segments, index: 0, leaf: updated)
    }

    private static func writeNested(
        current: Any?,
        segments: [String],
        index: Int,
        leaf: Any?
    ) -> Any? {
        let keySegment = segments[index]
        var baseMap: [String: Any] = [:]
        if let dict = current as? [String: Any] {
            for (k, v) in dict where !(v is NSNull) {
                baseMap[k] = v
            }
        } else if let arr = current as? [Any] {
            for (idx, elem) in arr.enumerated() where !(elem is NSNull) {
                baseMap[String(idx)] = elem
            }
        }

        if index == segments.count - 1 {
            if let leaf, !(leaf is NSNull) {
                baseMap[keySegment] = leaf
            } else {
                baseMap.removeValue(forKey: keySegment)
            }
        } else {
            let nextChild = writeNested(
                current: baseMap[keySegment],
                segments: segments,
                index: index + 1,
                leaf: leaf
            )
            if let nextChild, !(nextChild is NSNull) {
                baseMap[keySegment] = nextChild
            } else {
                baseMap.removeValue(forKey: keySegment)
            }
        }

        return baseMap.isEmpty ? nil : baseMap
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
