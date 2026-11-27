import Foundation
import PyricFirestore

/// A mutable snapshot of data at a Realtime Database location used in transactions.
public final class MutableData: NSObject, @unchecked Sendable {
    private var _value: Any?
    private var _priority: Any?
    private var nestedPriorities: [[String]: Any] = [:]
    private let onValueMutated: (@Sendable (Any?) -> Void)?
    private let onPriorityMutated: (@Sendable ([String], Any?) -> Void)?

    public var value: Any? {
        get { _value }
        set {
            let normalized: Any? = (newValue is NSNull) ? nil : newValue
            _value = normalized
            if normalized == nil {
                nestedPriorities.removeAll()
            }
            onValueMutated?(normalized)
        }
    }

    public var priority: Any? {
        get { _priority }
        set {
            let normalized: Any? = (newValue is NSNull) ? nil : newValue
            _priority = normalized
            onPriorityMutated?([], normalized)
        }
    }
    public let key: String?

    internal init(
        key: String? = nil,
        value: Any? = nil,
        priority: Any? = nil,
        onValueMutated: (@Sendable (Any?) -> Void)?,
        onPriorityMutated: (@Sendable ([String], Any?) -> Void)? = nil
    ) {
        self.key = key
        self._value = (value is NSNull) ? nil : value
        self._priority = (priority is NSNull) ? nil : priority
        self.onValueMutated = onValueMutated
        self.onPriorityMutated = onPriorityMutated
        super.init()
    }

    public convenience init(key: String? = nil, value: Any? = nil, priority: Any? = nil) {
        self.init(key: key, value: value, priority: priority, onValueMutated: nil, onPriorityMutated: nil)
    }

    private func storedPriority(for segments: [String]) -> Any? {
        guard let raw = nestedPriorities[segments] else { return nil }
        return (raw is NSNull) ? nil : raw
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
        return MutableData(
            key: segments.last,
            value: curVal,
            priority: storedPriority(for: segments),
            onValueMutated: { [weak self] updated in
                self?.updateNestedChild(segments: segments, updated: updated)
            },
            onPriorityMutated: { [weak self] sub, prio in
                self?.recordNestedPriority(segments: segments + sub, priority: prio)
            }
        )
    }

    public var children: NSEnumerator {
        if let dict = _value as? [String: Any] {
            let sortedKeys = dict.keys.sorted { DataSnapshot.compareRtdbKeys($0, $1) == .orderedAscending }
            var items: [MutableData] = []
            for k in sortedKeys {
                guard let childVal = dict[k], !(childVal is NSNull) else { continue }
                let segs = [k]
                let child = MutableData(
                    key: k,
                    value: childVal,
                    priority: storedPriority(for: segs),
                    onValueMutated: { [weak self] updated in
                        self?.updateNestedChild(segments: segs, updated: updated)
                    },
                    onPriorityMutated: { [weak self] sub, prio in
                        self?.recordNestedPriority(segments: segs + sub, priority: prio)
                    }
                )
                items.append(child)
            }
            return NSArray(array: items).objectEnumerator()
        }
        if let arr = _value as? [Any] {
            var items: [MutableData] = []
            for (idx, elem) in arr.enumerated() where !(elem is NSNull) {
                let k = String(idx)
                let segs = [k]
                let child = MutableData(
                    key: k,
                    value: elem,
                    priority: storedPriority(for: segs),
                    onValueMutated: { [weak self] updated in
                        self?.updateNestedChild(segments: segs, updated: updated)
                    },
                    onPriorityMutated: { [weak self] sub, prio in
                        self?.recordNestedPriority(segments: segs + sub, priority: prio)
                    }
                )
                items.append(child)
            }
            return NSArray(array: items).objectEnumerator()
        }
        return NSArray().objectEnumerator()
    }

    private func recordNestedPriority(segments: [String], priority: Any?) {
        if segments.isEmpty {
            self.priority = priority
            return
        }
        nestedPriorities[segments] = priority ?? NSNull()
        onPriorityMutated?(segments, priority)
    }

    private func clearPrioritiesUnder(prefix: [String]) {
        nestedPriorities = nestedPriorities.filter { key, _ in
            !(key.count >= prefix.count && Array(key.prefix(prefix.count)) == prefix)
        }
    }

    private func updateNestedChild(segments: [String], updated: Any?) {
        if segments.isEmpty {
            self.value = updated
            return
        }
        if updated == nil || updated is NSNull {
            clearPrioritiesUnder(prefix: segments)
        }
        self.value = Self.writeNested(current: _value, segments: segments, index: 0, leaf: updated)
    }

    internal func encodeWireValue(priorRootPriority: Any?) -> AnySendable {
        var base = RtdbValueCodec.toAnySendable(_value)
        if case .null = base {
            return .null
        }
        if !nestedPriorities.isEmpty {
            let sorted = nestedPriorities.sorted { $0.key.count > $1.key.count }
            for (segs, rawPrio) in sorted {
                let encodedPrio = (rawPrio is NSNull) ? AnySendable.null : RtdbValueCodec.toAnySendable(rawPrio)
                base = Self.applyPriority(to: base, segments: segs, index: 0, priority: encodedPrio)
            }
        }
        let encodedRootPrio = RtdbValueCodec.toAnySendable(_priority)
        let encodedPriorPrio = RtdbValueCodec.toAnySendable(priorRootPriority)
        if case .null = encodedRootPrio {
            if encodedRootPrio != encodedPriorPrio {
                return Self.wrapNode(base, priority: .null)
            }
            return base
        }
        return Self.wrapNode(base, priority: encodedRootPrio)
    }

    private static func applyPriority(
        to node: AnySendable,
        segments: [String],
        index: Int,
        priority: AnySendable
    ) -> AnySendable {
        let seg = segments[index]
        var dict: [String: AnySendable] = [:]
        switch node {
        case .dictionary(let existing):
            dict = existing
        case .array(let arr):
            for (idx, elem) in arr.enumerated() where elem != .null {
                dict[String(idx)] = elem
            }
        default:
            return node
        }
        guard let child = dict[seg], child != .null else {
            return .dictionary(dict)
        }
        if index == segments.count - 1 {
            dict[seg] = wrapNode(child, priority: priority)
        } else {
            dict[seg] = applyPriority(to: child, segments: segments, index: index + 1, priority: priority)
        }
        return .dictionary(dict)
    }

    private static func wrapNode(_ node: AnySendable, priority: AnySendable) -> AnySendable {
        if case .dictionary(var dict) = node, dict[".value"] == nil {
            dict[".priority"] = priority
            return .dictionary(dict)
        }
        return .dictionary([
            ".value": node,
            ".priority": priority,
        ])
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
