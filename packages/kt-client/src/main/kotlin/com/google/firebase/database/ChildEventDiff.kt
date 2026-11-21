package com.google.firebase.database

import java.math.BigDecimal

internal fun diffChildSnapshots(
    previousChildren: Map<String, DataSnapshot>?,
    currentList: List<DataSnapshot>,
    querySpec: RtdbQuerySpec
): List<ChildEvent> {
    val prevKeyByChild = LinkedHashMap<String, String?>(currentList.size)
    var runningPrevKey: String? = null
    for (child in currentList) {
        val childKey = child.key ?: ""
        prevKeyByChild[childKey] = runningPrevKey
        runningPrevKey = child.key
    }

    if (previousChildren == null) {
        return currentList.map { child ->
            val childKey = child.key ?: ""
            ChildEvent.Added(child, prevKeyByChild[childKey])
        }
    }

    val currentMap = currentList.associateBy { it.key ?: "" }
    val events = ArrayList<ChildEvent>()

    // Phase 1: CHILD_REMOVED (in previous index order)
    for ((oldKey, oldSnap) in previousChildren) {
        if (!currentMap.containsKey(oldKey)) {
            events.add(ChildEvent.Removed(oldSnap))
        }
    }

    // Phase 2: CHILD_ADDED (in new index order)
    for (child in currentList) {
        val childKey = child.key ?: ""
        if (!previousChildren.containsKey(childKey)) {
            events.add(ChildEvent.Added(child, prevKeyByChild[childKey]))
        }
    }

    // Phase 3: CHILD_MOVED (in new index order, before CHILD_CHANGED, only when indexed value changed)
    for (child in currentList) {
        val childKey = child.key ?: ""
        val oldSnap = previousChildren[childKey]
        if (oldSnap != null && childNodeChanged(oldSnap, child) && indexedSortValueChanged(oldSnap, child, querySpec)) {
            events.add(ChildEvent.Moved(child, prevKeyByChild[childKey]))
        }
    }

    // Phase 4: CHILD_CHANGED (in new index order, after CHILD_MOVED)
    for (child in currentList) {
        val childKey = child.key ?: ""
        val oldSnap = previousChildren[childKey]
        if (oldSnap != null && childNodeChanged(oldSnap, child)) {
            events.add(ChildEvent.Changed(child, prevKeyByChild[childKey]))
        }
    }

    return events
}

private fun childNodeChanged(oldSnap: DataSnapshot, newSnap: DataSnapshot): Boolean {
    return oldSnap.value != newSnap.value || oldSnap.priority != newSnap.priority
}

private fun indexedSortValueChanged(
    oldSnap: DataSnapshot,
    newSnap: DataSnapshot,
    querySpec: RtdbQuerySpec
): Boolean {
    val orderKind = querySpec.orderBy?.get("kind") as? String
    return when (orderKind) {
        "key" -> false
        "value" -> !rtdbSortValuesEqual(oldSnap.value, newSnap.value)
        "child" -> {
            val childPath = querySpec.orderBy["path"] as? String ?: return false
            !rtdbSortValuesEqual(oldSnap.child(childPath).value, newSnap.child(childPath).value)
        }
        "priority", null -> !rtdbSortValuesEqual(oldSnap.priority, newSnap.priority)
        else -> !rtdbSortValuesEqual(oldSnap.priority, newSnap.priority)
    }
}

private fun rtdbSortValuesEqual(left: Any?, right: Any?): Boolean {
    if (left == right) {
        return true
    }
    if (left is Long && right is Double) {
        if (right.isNaN() || right.isInfinite()) {
            return false
        }
        return BigDecimal.valueOf(left).compareTo(BigDecimal.valueOf(right)) == 0
    }
    if (left is Double && right is Long) {
        if (left.isNaN() || left.isInfinite()) {
            return false
        }
        return BigDecimal.valueOf(left).compareTo(BigDecimal.valueOf(right)) == 0
    }
    return false
}
