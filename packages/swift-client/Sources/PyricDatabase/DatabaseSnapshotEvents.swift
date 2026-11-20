import Foundation
import PyricFirestore

/// Turns each snapshot a listener receives into its value and child events,
/// diffing the children against the previous snapshot.
internal final class SnapshotEvents {
    private let eventTypes: Set<DataEventType>
    private let onEvent: @Sendable (DatabaseChildEvent) -> Void
    private var previousChildren: [DataSnapshot] = []
    private var isFirstSnapshot = true

    internal init(eventTypes: Set<DataEventType>, onEvent: @escaping @Sendable (DatabaseChildEvent) -> Void) {
        self.eventTypes = eventTypes
        self.onEvent = onEvent
    }

    internal func deliver(_ snap: DataSnapshot) {
        if eventTypes.contains(.value) {
            onEvent(DatabaseChildEvent(type: .value, snapshot: snap, previousSiblingKey: nil))
        }
        let newChildren = snap.childrenSnapshots
        if isFirstSnapshot {
            isFirstSnapshot = false
            deliverInitialChildren(newChildren)
        } else {
            deliverChildChanges(from: previousChildren, to: newChildren)
        }
        previousChildren = newChildren
    }

    private func deliverInitialChildren(_ children: [DataSnapshot]) {
        guard eventTypes.contains(.childAdded) else { return }
        var prevKey: String? = nil
        for child in children {
            onEvent(DatabaseChildEvent(type: .childAdded, snapshot: child, previousSiblingKey: prevKey))
            prevKey = child.key
        }
    }

    private func deliverChildChanges(from oldChildren: [DataSnapshot], to newChildren: [DataSnapshot]) {
        let oldByKey = Dictionary(uniqueKeysWithValues: oldChildren.compactMap { c in c.key.map { ($0, c) } })
        let newByKey = Dictionary(uniqueKeysWithValues: newChildren.compactMap { c in c.key.map { ($0, c) } })

        if eventTypes.contains(.childRemoved) {
            for oldChild in oldChildren {
                if let key = oldChild.key, newByKey[key] == nil {
                    onEvent(DatabaseChildEvent(type: .childRemoved, snapshot: oldChild, previousSiblingKey: nil))
                }
            }
        }

        let survivingOldOrder = oldChildren.compactMap { $0.key }.filter { newByKey[$0] != nil }
        let survivingNewOrder = newChildren.compactMap { $0.key }.filter { oldByKey[$0] != nil }
        let orderChanged = survivingOldOrder != survivingNewOrder
        let oldIndexByKey = Dictionary(
            uniqueKeysWithValues: survivingOldOrder.enumerated().map { ($0.element, $0.offset) }
        )
        let newIndexByKey = Dictionary(
            uniqueKeysWithValues: survivingNewOrder.enumerated().map { ($0.element, $0.offset) }
        )

        var changedKeys = Set<String>()
        for (key, newChild) in newByKey {
            if let oldChild = oldByKey[key], hasChildMutated(old: oldChild, new: newChild) {
                changedKeys.insert(key)
            }
        }

        var prevKey: String? = nil
        for newChild in newChildren {
            guard let key = newChild.key else { continue }
            if oldByKey[key] != nil {
                let mutated = changedKeys.contains(key)
                if mutated && eventTypes.contains(.childChanged) {
                    onEvent(DatabaseChildEvent(type: .childChanged, snapshot: newChild, previousSiblingKey: prevKey))
                }
                if mutated,
                   eventTypes.contains(.childMoved),
                   orderChanged,
                   didMutatedChildMove(
                       key: key,
                       survivingOldOrder: survivingOldOrder,
                       oldIndexByKey: oldIndexByKey,
                       newIndexByKey: newIndexByKey,
                       changedKeys: changedKeys
                   ) {
                    onEvent(DatabaseChildEvent(type: .childMoved, snapshot: newChild, previousSiblingKey: prevKey))
                }
            } else if eventTypes.contains(.childAdded) {
                onEvent(DatabaseChildEvent(type: .childAdded, snapshot: newChild, previousSiblingKey: prevKey))
            }
            prevKey = key
        }
    }

    private func hasChildMutated(old: DataSnapshot, new: DataSnapshot) -> Bool {
        let oldVal = RtdbValueCodec.toAnySendable(old.value)
        let newVal = RtdbValueCodec.toAnySendable(new.value)
        let oldPrio = RtdbValueCodec.toAnySendable(old.priority)
        let newPrio = RtdbValueCodec.toAnySendable(new.priority)
        return oldVal != newVal || oldPrio != newPrio
    }

    private func didMutatedChildMove(
        key: String,
        survivingOldOrder: [String],
        oldIndexByKey: [String: Int],
        newIndexByKey: [String: Int],
        changedKeys: Set<String>
    ) -> Bool {
        guard let oldIdx = oldIndexByKey[key], let newIdx = newIndexByKey[key] else {
            return false
        }
        let unchangedSurvivors = survivingOldOrder.filter { !changedKeys.contains($0) }
        if !unchangedSurvivors.isEmpty {
            return unchangedSurvivors.contains { other in
                guard let otherOld = oldIndexByKey[other], let otherNew = newIndexByKey[other] else {
                    return false
                }
                return (oldIdx < otherOld) != (newIdx < otherNew)
            }
        }
        return oldIdx != newIdx
    }
}
