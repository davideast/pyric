import Foundation
import PyricFirestore

/// Turns each snapshot a listener receives into its child and value events in
/// Firebase RTDB `EventGenerator` order (`childRemoved` -> `childAdded` ->
/// `childMoved` -> `childChanged` -> `value`).
internal final class SnapshotEvents {
    internal static let canonicalEventOrder: [DataEventType] = [
        .childRemoved,
        .childAdded,
        .childMoved,
        .childChanged,
        .value,
    ]

    private let eventTypes: Set<DataEventType>
    private let orderBySpec: [String: AnySendable]?
    private let onEvent: (@Sendable (DatabaseChildEvent) -> Void)?
    private var previousChildren: [DataSnapshot] = []
    private var isFirstSnapshot = true

    internal init(
        eventTypes: Set<DataEventType>,
        orderBySpec: [String: AnySendable]? = nil,
        onEvent: (@Sendable (DatabaseChildEvent) -> Void)? = nil
    ) {
        self.eventTypes = eventTypes
        self.orderBySpec = orderBySpec
        self.onEvent = onEvent
    }

    internal func deliver(_ snap: DataSnapshot) {
        let collected = collectEvents(for: snap)
        guard let onEvent else { return }
        for event in collected {
            onEvent(event)
        }
    }

    internal func collectEvents(for snap: DataSnapshot) -> [DatabaseChildEvent] {
        var events: [DatabaseChildEvent] = []
        let newChildren = snap.childrenSnapshots
        if isFirstSnapshot {
            isFirstSnapshot = false
            appendInitialChildren(newChildren, into: &events)
        } else {
            appendChildChanges(from: previousChildren, to: newChildren, into: &events)
        }
        previousChildren = newChildren
        if eventTypes.contains(.value) {
            events.append(DatabaseChildEvent(type: .value, snapshot: snap, previousSiblingKey: nil))
        }
        return events
    }

    private func appendInitialChildren(_ children: [DataSnapshot], into events: inout [DatabaseChildEvent]) {
        guard eventTypes.contains(.childAdded) else { return }
        var prevKey: String? = nil
        for child in children {
            events.append(DatabaseChildEvent(type: .childAdded, snapshot: child, previousSiblingKey: prevKey))
            prevKey = child.key
        }
    }

    private func appendChildChanges(
        from oldChildren: [DataSnapshot],
        to newChildren: [DataSnapshot],
        into events: inout [DatabaseChildEvent]
    ) {
        let oldByKey = Dictionary(uniqueKeysWithValues: oldChildren.compactMap { c in c.key.map { ($0, c) } })
        let newByKey = Dictionary(uniqueKeysWithValues: newChildren.compactMap { c in c.key.map { ($0, c) } })

        var prevKeyByChild: [String: String?] = [:]
        var runningPrevKey: String? = nil
        for newChild in newChildren {
            if let key = newChild.key {
                prevKeyByChild[key] = runningPrevKey
                runningPrevKey = key
            }
        }

        // Phase 1: childRemoved (in previous child order).
        if eventTypes.contains(.childRemoved) {
            for oldChild in oldChildren {
                if let key = oldChild.key, newByKey[key] == nil {
                    events.append(
                        DatabaseChildEvent(type: .childRemoved, snapshot: oldChild, previousSiblingKey: nil)
                    )
                }
            }
        }

        // Phase 2: childAdded (in new query order).
        if eventTypes.contains(.childAdded) {
            for newChild in newChildren {
                guard let key = newChild.key else { continue }
                if oldByKey[key] == nil {
                    let prevKey = prevKeyByChild[key] ?? nil
                    events.append(
                        DatabaseChildEvent(type: .childAdded, snapshot: newChild, previousSiblingKey: prevKey)
                    )
                }
            }
        }

        var mutatedKeys = Set<String>()
        for (key, newChild) in newByKey {
            if let oldChild = oldByKey[key], hasChildMutated(old: oldChild, new: newChild) {
                mutatedKeys.insert(key)
            }
        }

        // Phase 3: childMoved (in new query order, before childChanged, when indexed sort value changed).
        if eventTypes.contains(.childMoved) {
            for newChild in newChildren {
                guard let key = newChild.key,
                      mutatedKeys.contains(key),
                      let oldChild = oldByKey[key],
                      didIndexedSortValueChange(old: oldChild, new: newChild) else {
                    continue
                }
                let prevKey = prevKeyByChild[key] ?? nil
                events.append(
                    DatabaseChildEvent(type: .childMoved, snapshot: newChild, previousSiblingKey: prevKey)
                )
            }
        }

        // Phase 4: childChanged (in new query order, after childMoved).
        if eventTypes.contains(.childChanged) {
            for newChild in newChildren {
                guard let key = newChild.key, mutatedKeys.contains(key) else { continue }
                let prevKey = prevKeyByChild[key] ?? nil
                events.append(
                    DatabaseChildEvent(type: .childChanged, snapshot: newChild, previousSiblingKey: prevKey)
                )
            }
        }
    }

    private func hasChildMutated(old: DataSnapshot, new: DataSnapshot) -> Bool {
        let oldVal = RtdbValueCodec.toAnySendable(old.value)
        let newVal = RtdbValueCodec.toAnySendable(new.value)
        let oldPrio = RtdbValueCodec.toAnySendable(old.priority)
        let newPrio = RtdbValueCodec.toAnySendable(new.priority)
        return !Self.rtdbValuesEqual(oldVal, newVal) || !Self.rtdbScalarsEqual(oldPrio, newPrio)
    }

    private func didIndexedSortValueChange(old: DataSnapshot, new: DataSnapshot) -> Bool {
        let orderKind = orderBySpec?["kind"]?.stringValue ?? "priority"
        switch orderKind {
        case "key":
            return false
        case "priority":
            let oldPrio = RtdbValueCodec.toAnySendable(old.priority)
            let newPrio = RtdbValueCodec.toAnySendable(new.priority)
            return !Self.rtdbScalarsEqual(oldPrio, newPrio)
        case "value":
            let oldVal = RtdbValueCodec.toAnySendable(old.value)
            let newVal = RtdbValueCodec.toAnySendable(new.value)
            if !Self.rtdbValuesEqual(oldVal, newVal) {
                return true
            }
            let oldPrio = RtdbValueCodec.toAnySendable(old.priority)
            let newPrio = RtdbValueCodec.toAnySendable(new.priority)
            return !Self.rtdbScalarsEqual(oldPrio, newPrio)
        case "child":
            guard let childPath = orderBySpec?["path"]?.stringValue, !childPath.isEmpty else {
                return false
            }
            let oldLeaf = Self.pathIndexLeaf(RtdbValueCodec.toAnySendable(old.childSnapshot(forPath: childPath).value))
            let newLeaf = Self.pathIndexLeaf(RtdbValueCodec.toAnySendable(new.childSnapshot(forPath: childPath).value))
            return !Self.rtdbScalarsEqual(oldLeaf, newLeaf)
        default:
            let oldPrio = RtdbValueCodec.toAnySendable(old.priority)
            let newPrio = RtdbValueCodec.toAnySendable(new.priority)
            return !Self.rtdbScalarsEqual(oldPrio, newPrio)
        }
    }

    private static func pathIndexLeaf(_ value: AnySendable) -> AnySendable {
        switch value {
        case .dictionary, .array:
            return .null
        case .null, .bool, .int, .double, .string:
            return value
        }
    }

    private static func rtdbScalarsEqual(_ left: AnySendable, _ right: AnySendable) -> Bool {
        switch (left, right) {
        case (.null, .null):
            return true
        case let (.bool(a), .bool(b)):
            return a == b
        case let (.int(a), .int(b)):
            return a == b
        case let (.double(a), .double(b)):
            return a == b
        case let (.int(i), .double(d)):
            guard d.isFinite, let exact = Int64(exactly: d) else { return false }
            return exact == i
        case let (.double(d), .int(i)):
            guard d.isFinite, let exact = Int64(exactly: d) else { return false }
            return exact == i
        case let (.string(a), .string(b)):
            return a == b
        default:
            return false
        }
    }

    private static func rtdbValuesEqual(_ left: AnySendable, _ right: AnySendable) -> Bool {
        switch (left, right) {
        case let (.array(a), .array(b)):
            guard a.count == b.count else { return false }
            for idx in a.indices where !rtdbValuesEqual(a[idx], b[idx]) {
                return false
            }
            return true
        case let (.dictionary(a), .dictionary(b)):
            guard a.count == b.count else { return false }
            for (key, aVal) in a {
                guard let bVal = b[key], rtdbValuesEqual(aVal, bVal) else {
                    return false
                }
            }
            return true
        default:
            return rtdbScalarsEqual(left, right)
        }
    }
}
