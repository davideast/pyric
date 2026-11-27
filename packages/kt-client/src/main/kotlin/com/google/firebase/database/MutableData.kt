package com.google.firebase.database

import dev.pyric.codecs.PojoCodec

class MutableData(
    initialValue: Any?,
    initialPriority: Any? = null,
    val key: String? = null,
    private val onValueMutated: ((Any?) -> Unit)? = null,
    private val onPriorityMutated: ((List<String>, Any?) -> Unit)? = null
) {
    constructor(
        value: Any?,
        priority: Any? = null,
        key: String? = null
    ) : this(value, priority, key, null, null)

    private val nestedPriorities = mutableMapOf<List<String>, Any?>()

    var priority: Any? = DataSnapshot.normalizeRtdbPriority(initialPriority)
        set(newPriority) {
            val normalized = DataSnapshot.normalizeRtdbPriority(newPriority)
            field = normalized
            onPriorityMutated?.invoke(emptyList(), normalized)
        }

    var value: Any? = DataSnapshot.normalizeRtdbValue(initialValue)
        set(newValue) {
            val normalized = DataSnapshot.normalizeRtdbValue(newValue)
            field = normalized
            if (normalized == null) {
                nestedPriorities.clear()
            }
            onValueMutated?.invoke(normalized)
        }

    @Suppress("UNCHECKED_CAST")
    fun <T> getValue(valueType: Class<T>): T? {
        val raw = value ?: return null
        if (valueType.isInstance(raw)) {
            return raw as T
        }
        return when (valueType) {
            java.lang.Long::class.java, Long::class.java -> (raw as? Number)?.toLong() as? T
            java.lang.Integer::class.java, Int::class.java -> (raw as? Number)?.toInt() as? T
            java.lang.Double::class.java, Double::class.java -> (raw as? Number)?.toDouble() as? T
            java.lang.Float::class.java, Float::class.java -> (raw as? Number)?.toFloat() as? T
            java.lang.Boolean::class.java, Boolean::class.java -> raw as? T
            String::class.java -> raw.toString() as? T
            else -> if (raw is Map<*, *> && !Map::class.java.isAssignableFrom(valueType) && valueType != Any::class.java) {
                PojoCodec.deserialize(raw as Map<String, Any?>, valueType)
            } else {
                raw as? T
            }
        }
    }

    val childrenCount: Long
        get() = when (val v = value) {
            is Map<*, *> -> v.size.toLong()
            is List<*> -> v.count { it != null }.toLong()
            else -> 0L
        }

    val children: Iterable<MutableData>
        get() = when (val v = value) {
            is Map<*, *> -> v.entries
                .sortedWith { left, right -> DataSnapshot.compareRtdbKeys(left.key.toString(), right.key.toString()) }
                .map { (k, childVal) ->
                    val childKey = k.toString()
                    val segs = listOf(childKey)
                    MutableData(
                        initialValue = childVal,
                        initialPriority = nestedPriorities[segs],
                        key = childKey,
                        onValueMutated = { updated -> updateNestedChild(segs, updated) },
                        onPriorityMutated = { sub, prio -> recordNestedPriority(segs + sub, prio) }
                    )
                }
            is List<*> -> v.mapIndexedNotNull { idx, item ->
                if (item == null) {
                    null
                } else {
                    val childKey = idx.toString()
                    val segs = listOf(childKey)
                    MutableData(
                        initialValue = item,
                        initialPriority = nestedPriorities[segs],
                        key = childKey,
                        onValueMutated = { updated -> updateNestedChild(segs, updated) },
                        onPriorityMutated = { sub, prio -> recordNestedPriority(segs + sub, prio) }
                    )
                }
            }
            else -> emptyList()
        }

    fun hasChildren(): Boolean = childrenCount > 0L

    fun hasChild(path: String): Boolean = child(path).value != null

    fun child(path: String): MutableData {
        val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
        if (segments.isEmpty()) return this

        var currentVal = value
        for (segment in segments) {
            currentVal = when (val v = currentVal) {
                is Map<*, *> -> v[segment]
                is List<*> -> {
                    val idx = segment.toIntOrNull()
                    if (idx != null && idx in v.indices) v[idx] else null
                }
                else -> null
            }
        }
        return MutableData(
            initialValue = currentVal,
            initialPriority = nestedPriorities[segments],
            key = segments.last(),
            onValueMutated = { updated -> updateNestedChild(segments, updated) },
            onPriorityMutated = { sub, prio -> recordNestedPriority(segments + sub, prio) }
        )
    }

    private fun recordNestedPriority(segments: List<String>, prio: Any?) {
        if (segments.isEmpty()) {
            priority = prio
            return
        }
        nestedPriorities[segments] = prio
        onPriorityMutated?.invoke(segments, prio)
    }

    private fun clearPrioritiesUnder(prefix: List<String>) {
        val iter = nestedPriorities.keys.iterator()
        while (iter.hasNext()) {
            val k = iter.next()
            if (k.size >= prefix.size && k.subList(0, prefix.size) == prefix) {
                iter.remove()
            }
        }
    }

    private fun updateNestedChild(segments: List<String>, updated: Any?) {
        if (segments.isEmpty()) {
            value = updated
            return
        }
        if (updated == null) {
            clearPrioritiesUnder(segments)
        }
        value = writeNested(value, segments, 0, updated)
    }

    internal fun encodeWireValue(priorRootPriority: Any?): Any? {
        var encoded = value ?: return null
        if (nestedPriorities.isNotEmpty()) {
            val sortedEntries = nestedPriorities.entries.sortedByDescending { it.key.size }
            for ((segs, childPrio) in sortedEntries) {
                encoded = applyPriorityAtPath(encoded, segs, 0, childPrio) ?: return null
            }
        }
        val normalizedPrior = DataSnapshot.normalizeRtdbPriority(priorRootPriority)
        if (priority != normalizedPrior) {
            encoded = wrapWithPriority(encoded, priority)
        }
        return encoded
    }

    private fun applyPriorityAtPath(
        current: Any?,
        segments: List<String>,
        index: Int,
        prio: Any?
    ): Any? {
        if (current == null) return null
        val seg = segments[index]
        val baseMap = mutableMapOf<String, Any?>()
        if (current is Map<*, *>) {
            for ((k, v) in current) {
                if (k != null && v != null) {
                    baseMap[k.toString()] = v
                }
            }
        } else if (current is List<*>) {
            current.forEachIndexed { idx, elem ->
                if (elem != null) {
                    baseMap[idx.toString()] = elem
                }
            }
        } else {
            return current
        }
        val existing = baseMap[seg] ?: return baseMap
        baseMap[seg] = if (index == segments.lastIndex) {
            wrapWithPriority(existing, prio)
        } else {
            applyPriorityAtPath(existing, segments, index + 1, prio)
        }
        return baseMap
    }

    private fun wrapWithPriority(node: Any, prio: Any?): Any {
        if (node is Map<*, *> && !node.containsKey(".value")) {
            val copy = mutableMapOf<String, Any?>()
            for ((k, v) in node) {
                if (k != null) copy[k.toString()] = v
            }
            copy[".priority"] = prio
            return copy
        }
        return mapOf(".value" to node, ".priority" to prio)
    }

    private fun writeNested(current: Any?, segments: List<String>, index: Int, leaf: Any?): Any? {
        val keySegment = segments[index]
        val baseMap = mutableMapOf<String, Any?>()
        if (current is Map<*, *>) {
            for ((k, v) in current) {
                if (k != null && v != null) {
                    baseMap[k.toString()] = v
                }
            }
        } else if (current is List<*>) {
            current.forEachIndexed { idx, elem ->
                if (elem != null) {
                    baseMap[idx.toString()] = elem
                }
            }
        }
        if (index == segments.lastIndex) {
            if (leaf == null) {
                baseMap.remove(keySegment)
            } else {
                baseMap[keySegment] = leaf
            }
        } else {
            val childResult = writeNested(baseMap[keySegment], segments, index + 1, leaf)
            if (childResult == null) {
                baseMap.remove(keySegment)
            } else {
                baseMap[keySegment] = childResult
            }
        }
        return if (baseMap.isEmpty()) null else baseMap
    }
}
