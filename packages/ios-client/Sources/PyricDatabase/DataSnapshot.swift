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

    public init(
        key: String?,
        value: Any?,
        priority: Any?,
        exists: Bool,
        entries: [(key: String, value: Any?, priority: Any?)],
        ref: DatabaseReference
    ) {
        self.key = key
        self.value = value
        self.priority = priority
        self.existsFlag = exists
        self.childEntries = entries
        self.ref = ref
        super.init()
    }

    public convenience init(wire: AnySendable, ref: DatabaseReference) {
        let key = wire["key"]?.stringValue ?? ref.key
        let exists = wire["exists"]?.boolValue ?? false
        let rawVal = RtdbValueCodec.fromAnySendable(wire["value"])
        let priority = RtdbValueCodec.fromAnySendable(wire["priority"])

        var entries: [(key: String, value: Any?, priority: Any?)] = []
        if let wireEntries = wire["entries"]?.arrayValue {
            for item in wireEntries {
                if let entryKey = item["key"]?.stringValue {
                    let entryVal = RtdbValueCodec.fromAnySendable(item["value"])
                    let entryPrio = RtdbValueCodec.fromAnySendable(item["priority"])
                    entries.append((key: entryKey, value: entryVal, priority: entryPrio))
                }
            }
        } else if let dict = rawVal as? [String: Any] {
            for k in dict.keys.sorted() {
                entries.append((key: k, value: dict[k], priority: nil))
            }
        }

        self.init(
            key: key,
            value: rawVal,
            priority: priority,
            exists: exists,
            entries: entries,
            ref: ref
        )
    }

    /// Returns true if the DataSnapshot contains non-null data.
    public func exists() -> Bool {
        return existsFlag && value != nil && !(value is NSNull)
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
            var subEntries: [(key: String, value: Any?, priority: Any?)] = []
            if let dict = childVal as? [String: Any] {
                for k in dict.keys.sorted() {
                    subEntries.append((key: k, value: dict[k], priority: nil))
                }
            }
            return DataSnapshot(
                key: entry.key,
                value: childVal,
                priority: entry.priority,
                exists: childExists,
                entries: subEntries,
                ref: childRef
            )
        }
    }

    /// Returns an NSEnumerator of immediate child DataSnapshots.
    public var children: NSEnumerator {
        return (childrenSnapshots as NSArray).objectEnumerator()
    }

    /// Returns a DataSnapshot for the relative descendant path within the snapshot.
    public func childSnapshot(forPath childPathString: String) -> DataSnapshot {
        let segments = childPathString.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard !segments.isEmpty else { return self }

        var currentVal: Any? = value
        var currentPrio: Any? = priority
        let currentEntries = childEntries
        var currentRef = ref

        for (index, seg) in segments.enumerated() {
            currentRef = currentRef.child(seg)
            if index == 0, let found = currentEntries.first(where: { $0.key == seg }) {
                currentVal = found.value
                currentPrio = found.priority
            } else if let dict = currentVal as? [String: Any], let subVal = dict[seg] {
                currentVal = subVal
                currentPrio = nil
            } else {
                currentVal = nil
                currentPrio = nil
            }
        }

        let exists = (currentVal != nil && !(currentVal is NSNull))
        var subEntries: [(key: String, value: Any?, priority: Any?)] = []
        if let dict = currentVal as? [String: Any] {
            for k in dict.keys.sorted() {
                subEntries.append((key: k, value: dict[k], priority: nil))
            }
        }

        return DataSnapshot(
            key: segments.last,
            value: currentVal,
            priority: currentPrio,
            exists: exists,
            entries: subEntries,
            ref: currentRef
        )
    }
}
