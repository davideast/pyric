import Foundation
import PyricFirestore

/// The event types that can be observed on a Realtime Database query or reference.
public enum DataEventType: Int, Sendable {
    case childAdded = 0
    case childRemoved = 1
    case childChanged = 2
    case childMoved = 3
    case value = 4
}

/// Event emitted for child events (`childAdded`, `childChanged`, `childRemoved`, `childMoved`).
public struct DatabaseChildEvent: Sendable {
    public let type: DataEventType
    public let snapshot: DataSnapshot
    public let previousSiblingKey: String?

    public init(type: DataEventType, snapshot: DataSnapshot, previousSiblingKey: String? = nil) {
        self.type = type
        self.snapshot = snapshot
        self.previousSiblingKey = previousSiblingKey
    }
}

/// An immutable snapshot of data at a Realtime Database location.
public final class DataSnapshot: NSObject, @unchecked Sendable {
    public let ref: DatabaseReference
    public let key: String?
    public let value: Any?
    public let priority: Any?
    public let existsFlag: Bool
    public let childEntries: [(key: String, value: Any?, priority: Any?)]

    private let hasOrderedWireEntries: Bool
    private let childExportValues: [String: Any]
    private let exportValue: Any?

    internal init(
        key: String?,
        value: Any?,
        priority: Any?,
        exists: Bool,
        entries: [(key: String, value: Any?, priority: Any?)],
        ref: DatabaseReference,
        hasOrderedWireEntries: Bool,
        childExportValues: [String: Any],
        exportValue: Any?
    ) {
        self.key = key
        self.value = value
        self.priority = priority
        self.existsFlag = exists
        self.childEntries = entries
        self.ref = ref
        self.hasOrderedWireEntries = hasOrderedWireEntries
        self.childExportValues = childExportValues
        self.exportValue = exportValue
        super.init()
    }

    public convenience init(
        key: String?,
        value: Any?,
        priority: Any?,
        exists: Bool,
        entries: [(key: String, value: Any?, priority: Any?)],
        ref: DatabaseReference
    ) {
        self.init(
            key: key,
            value: value,
            priority: priority,
            exists: exists,
            entries: entries,
            ref: ref,
            hasOrderedWireEntries: false,
            childExportValues: [:],
            exportValue: nil
        )
    }

    public convenience init(wire: AnySendable, ref: DatabaseReference) {
        let key = wire["key"]?.stringValue ?? ref.key
        let rawVal = RtdbValueCodec.fromAnySendable(wire["value"])
        let exists = wire["exists"]?.boolValue ?? (rawVal != nil && !(rawVal is NSNull))
        let effectiveVal: Any? = exists ? rawVal : nil
        let priority = RtdbValueCodec.fromAnySendable(wire["priority"])
        let exportVal = RtdbValueCodec.fromAnySendable(wire["exportValue"])

        var entries: [(key: String, value: Any?, priority: Any?)] = []
        var entryExports: [String: Any] = [:]
        let hasOrdered: Bool

        if let wireEntries = wire["entries"]?.arrayValue {
            hasOrdered = true
            for item in wireEntries {
                if let entryKey = item["key"]?.stringValue {
                    let entryVal = RtdbValueCodec.fromAnySendable(item["value"])
                    let entryPrio = RtdbValueCodec.fromAnySendable(item["priority"])
                    if let entryExport = RtdbValueCodec.fromAnySendable(item["exportValue"]) {
                        entryExports[entryKey] = entryExport
                    }
                    entries.append((key: entryKey, value: entryVal, priority: entryPrio))
                }
            }
        } else {
            hasOrdered = false
            let built = Self.buildFallbackEntries(from: effectiveVal, exportRoot: exportVal)
            entries = built.entries
            entryExports = built.exports
        }

        self.init(
            key: key,
            value: effectiveVal,
            priority: priority,
            exists: exists,
            entries: entries,
            ref: ref,
            hasOrderedWireEntries: hasOrdered,
            childExportValues: entryExports,
            exportValue: exportVal
        )
    }

    /// Returns true if the DataSnapshot contains non-null data.
    public func exists() -> Bool {
        return existsFlag && value != nil && !(value is NSNull)
    }

    /// Returns the snapshot data in Firebase export format (including `.priority` and `.value`).
    public func valueInExportFormat() -> Any? {
        guard exists() else {
            return nil
        }
        return exportValue ?? value
    }

    /// Returns the number of immediate children in this DataSnapshot.
    public var childrenCount: UInt {
        return UInt(childEntries.count)
    }

    /// Returns true if the DataSnapshot has any child nodes.
    public func hasChildren() -> Bool {
        return !childEntries.isEmpty
    }

    /// Returns true if the specified relative path exists in this snapshot.
    public func hasChild(_ childPathString: String) -> Bool {
        return childSnapshot(forPath: childPathString).exists()
    }

    /// Returns an ordered array of immediate child DataSnapshots.
    public var childrenSnapshots: [DataSnapshot] {
        return childEntries.map { entry in
            let childRef = ref.child(entry.key)
            let childVal = entry.value
            let childExists = (childVal != nil && !(childVal is NSNull))
            let childExport = childExportValues[entry.key]
                ?? Self.exportValueAt(root: exportValue, segments: [entry.key])
            let built = Self.buildFallbackEntries(from: childVal, exportRoot: childExport)
            return DataSnapshot(
                key: entry.key,
                value: childExists ? childVal : nil,
                priority: entry.priority ?? Self.priorityFromExport(childExport),
                exists: childExists,
                entries: built.entries,
                ref: childRef,
                hasOrderedWireEntries: false,
                childExportValues: built.exports,
                exportValue: childExport
            )
        }
    }

    /// Returns an NSEnumerator of immediate child DataSnapshots.
    public var children: NSEnumerator {
        return NSArray(array: childrenSnapshots).objectEnumerator()
    }

    /// Returns a DataSnapshot for the relative descendant path within the snapshot.
    public func childSnapshot(forPath childPathString: String) -> DataSnapshot {
        let segments = childPathString.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard !segments.isEmpty else { return self }

        var targetRef = ref
        for seg in segments {
            targetRef = targetRef.child(seg)
        }

        if hasOrderedWireEntries {
            guard let matched = childEntries.first(where: { $0.key == segments[0] }) else {
                return DataSnapshot(
                    key: segments.last,
                    value: nil,
                    priority: nil,
                    exists: false,
                    entries: [],
                    ref: targetRef,
                    hasOrderedWireEntries: false,
                    childExportValues: [:],
                    exportValue: nil
                )
            }
            let firstExport = childExportValues[segments[0]]
                ?? Self.exportValueAt(root: exportValue, segments: [segments[0]])

            if segments.count == 1 {
                let childVal = matched.value
                let childExists = (childVal != nil && !(childVal is NSNull))
                let childPrio = matched.priority ?? Self.priorityFromExport(firstExport)
                let built = Self.buildFallbackEntries(from: childVal, exportRoot: firstExport)
                return DataSnapshot(
                    key: segments[0],
                    value: childExists ? childVal : nil,
                    priority: childExists ? childPrio : nil,
                    exists: childExists,
                    entries: built.entries,
                    ref: targetRef,
                    hasOrderedWireEntries: false,
                    childExportValues: built.exports,
                    exportValue: firstExport
                )
            }

            let tail = Array(segments.dropFirst())
            let subVal = Self.descendValue(from: matched.value, segments: tail)
            let subExport = Self.exportValueAt(root: firstExport, segments: tail)
            let subExists = (subVal != nil && !(subVal is NSNull))
            let subPrio = subExists ? Self.priorityFromExport(subExport) : nil
            let built = Self.buildFallbackEntries(from: subVal, exportRoot: subExport)
            return DataSnapshot(
                key: segments.last,
                value: subExists ? subVal : nil,
                priority: subPrio,
                exists: subExists,
                entries: built.entries,
                ref: targetRef,
                hasOrderedWireEntries: false,
                childExportValues: built.exports,
                exportValue: subExport
            )
        }

        var currentVal: Any? = value
        var matchedFirstPriority: Any? = nil
        if let firstEntry = childEntries.first(where: { $0.key == segments[0] }) {
            currentVal = firstEntry.value
            matchedFirstPriority = firstEntry.priority
            if segments.count > 1 {
                currentVal = Self.descendValue(from: currentVal, segments: Array(segments.dropFirst()))
                matchedFirstPriority = nil
            }
        } else {
            currentVal = Self.descendValue(from: value, segments: segments)
        }

        let subExport = Self.exportValueAt(root: exportValue, segments: segments)
        let subExists = (currentVal != nil && !(currentVal is NSNull))
        let subPrio = subExists ? (matchedFirstPriority ?? Self.priorityFromExport(subExport)) : nil
        let built = Self.buildFallbackEntries(from: currentVal, exportRoot: subExport)

        return DataSnapshot(
            key: segments.last,
            value: subExists ? currentVal : nil,
            priority: subPrio,
            exists: subExists,
            entries: built.entries,
            ref: targetRef,
            hasOrderedWireEntries: false,
            childExportValues: built.exports,
            exportValue: subExport
        )
    }

    // -- RTDB Key Ordering & Export Traversal Helpers --

    package static func compareRtdbKeys(_ a: String, _ b: String) -> ComparisonResult {
        if a == b {
            return .orderedSame
        }
        let aInt = tryParseRtdbInt32Key(a)
        let bInt = tryParseRtdbInt32Key(b)
        if let aInt {
            if let bInt {
                if aInt < bInt { return .orderedAscending }
                if aInt > bInt { return .orderedDescending }
                if a.count < b.count { return .orderedAscending }
                if a.count > b.count { return .orderedDescending }
                return .orderedSame
            }
            return .orderedAscending
        }
        if bInt != nil {
            return .orderedDescending
        }
        return a.utf16.lexicographicallyPrecedes(b.utf16) ? .orderedAscending : .orderedDescending
    }

    private static func tryParseRtdbInt32Key(_ key: String) -> Int32? {
        guard !key.isEmpty else { return nil }
        var index = key.startIndex
        if key[index] == "-" {
            index = key.index(after: index)
            guard index < key.endIndex else { return nil }
        }
        while index < key.endIndex && key[index] == "0" {
            let next = key.index(after: index)
            if next == key.endIndex {
                break
            }
            index = next
        }
        var digitCount = 0
        var scan = index
        while scan < key.endIndex {
            let ch = key[scan]
            guard ch >= "0" && ch <= "9" else { return nil }
            digitCount += 1
            if digitCount > 10 { return nil }
            scan = key.index(after: scan)
        }
        guard let parsed = Int64(key),
              parsed >= Int64(Int32.min),
              parsed <= Int64(Int32.max) else {
            return nil
        }
        return Int32(parsed)
    }

    private static func descendValue(from root: Any?, segments: [String]) -> Any? {
        var cur: Any? = root
        for seg in segments {
            if let dict = cur as? [String: Any] {
                cur = dict[seg]
            } else if let arr = cur as? [Any], let idx = Int(seg), idx >= 0, idx < arr.count {
                let candidate = arr[idx]
                cur = (candidate is NSNull) ? nil : candidate
            } else {
                return nil
            }
        }
        if cur is NSNull {
            return nil
        }
        return cur
    }

    private static func buildFallbackEntries(
        from raw: Any?,
        exportRoot: Any?
    ) -> (entries: [(key: String, value: Any?, priority: Any?)], exports: [String: Any]) {
        guard let raw, !(raw is NSNull) else {
            return ([], [:])
        }
        var entries: [(key: String, value: Any?, priority: Any?)] = []
        var exports: [String: Any] = [:]

        if let dict = raw as? [String: Any] {
            let sortedKeys = dict.keys.sorted { compareRtdbKeys($0, $1) == .orderedAscending }
            for k in sortedKeys {
                guard let childVal = dict[k], !(childVal is NSNull) else { continue }
                let childExport = exportValueAt(root: exportRoot, segments: [k])
                if let childExport {
                    exports[k] = childExport
                }
                entries.append((key: k, value: childVal, priority: priorityFromExport(childExport)))
            }
        } else if let arr = raw as? [Any] {
            for (idx, item) in arr.enumerated() where !(item is NSNull) {
                let k = String(idx)
                let childExport = exportValueAt(root: exportRoot, segments: [k])
                if let childExport {
                    exports[k] = childExport
                }
                entries.append((key: k, value: item, priority: priorityFromExport(childExport)))
            }
        }
        return (entries, exports)
    }

    private static func priorityFromExport(_ exported: Any?) -> Any? {
        guard let dict = exported as? [String: Any] else { return nil }
        let prio = dict[".priority"]
        if prio is NSNull { return nil }
        return prio
    }

    private static func exportValueAt(root: Any?, segments: [String]) -> Any? {
        var current: Any? = root
        for segment in segments {
            if segment == ".priority" || segment == ".value" {
                return nil
            }
            let container: Any?
            if let dict = current as? [String: Any],
               dict[".value"] != nil,
               dict.keys.allSatisfy({ $0 == ".value" || $0 == ".priority" }) {
                container = dict[".value"]
            } else {
                container = current
            }

            if let dict = container as? [String: Any] {
                current = dict[segment]
            } else if let arr = container as? [Any], let idx = Int(segment), idx >= 0, idx < arr.count {
                let elem = arr[idx]
                current = (elem is NSNull) ? nil : elem
            } else {
                return nil
            }
        }
        if current is NSNull {
            return nil
        }
        return current
    }
}
