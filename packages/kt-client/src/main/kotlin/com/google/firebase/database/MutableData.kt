package com.google.firebase.database

class MutableData(
    initialValue: Any?,
    var priority: Any? = null,
    val key: String? = null,
    private val onValueMutated: ((Any?) -> Unit)? = null
) {
    constructor(
        value: Any?,
        priority: Any? = null,
        key: String? = null
    ) : this(value, priority, key, null)

    var value: Any? = initialValue
        set(newValue) {
            field = newValue
            onValueMutated?.invoke(newValue)
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
            else -> raw as? T
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
                    MutableData(childVal, null, childKey) { updated ->
                        updateNestedChild(listOf(childKey), updated)
                    }
                }
            is List<*> -> v.mapIndexedNotNull { idx, item ->
                if (item == null) {
                    null
                } else {
                    val childKey = idx.toString()
                    MutableData(item, null, childKey) { updated ->
                        updateNestedChild(listOf(childKey), updated)
                    }
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
        return MutableData(currentVal, null, segments.last()) { updated ->
            updateNestedChild(segments, updated)
        }
    }

    private fun updateNestedChild(segments: List<String>, updated: Any?) {
        if (segments.isEmpty()) {
            value = updated
            return
        }
        value = writeNested(value, segments, 0, updated)
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
