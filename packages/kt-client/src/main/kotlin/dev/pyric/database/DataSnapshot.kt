package dev.pyric.database

class DataSnapshot(
    val ref: DatabaseReference,
    val value: Any?,
    val priority: Any? = null,
    private val orderedEntries: List<ChildEntry>? = null
) {
    data class ChildEntry(
        val key: String,
        val value: Any?,
        val priority: Any? = null
    )

    val key: String?
        get() = ref.key

    fun exists(): Boolean = value != null

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
        get() {
            if (orderedEntries != null) return orderedEntries.size.toLong()
            return when (val v = value) {
                is Map<*, *> -> v.size.toLong()
                is List<*> -> v.count { it != null }.toLong()
                else -> 0L
            }
        }

    val children: Iterable<DataSnapshot>
        get() {
            if (orderedEntries != null) {
                return orderedEntries.map { entry ->
                    DataSnapshot(
                        ref = ref.child(entry.key),
                        value = entry.value,
                        priority = entry.priority
                    )
                }
            }
            return when (val v = value) {
                is Map<*, *> -> v.entries
                    .sortedBy { it.key.toString() }
                    .map { (k, childVal) ->
                        DataSnapshot(
                            ref = ref.child(k.toString()),
                            value = childVal,
                            priority = null
                        )
                    }
                is List<*> -> v.mapIndexedNotNull { index, item ->
                    if (item == null) null
                    else DataSnapshot(
                        ref = ref.child(index.toString()),
                        value = item,
                        priority = null
                    )
                }
                else -> emptyList()
            }
        }

    fun hasChildren(): Boolean = childrenCount > 0L

    fun hasChild(path: String): Boolean = child(path).exists()

    fun child(path: String): DataSnapshot {
        val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
        if (segments.isEmpty()) return this

        var currentVal: Any? = value
        var currentEntries: List<ChildEntry>? = orderedEntries

        for (segment in segments) {
            if (currentEntries != null) {
                val matched = currentEntries.find { it.key == segment }
                if (matched != null) {
                    currentVal = matched.value
                    currentEntries = null
                    continue
                }
            }
            currentVal = when (val v = currentVal) {
                is Map<*, *> -> v[segment]
                is List<*> -> {
                    val idx = segment.toIntOrNull()
                    if (idx != null && idx in v.indices) v[idx] else null
                }
                else -> null
            }
            currentEntries = null
        }

        return DataSnapshot(
            ref = ref.child(path),
            value = currentVal,
            priority = null
        )
    }

    override fun toString(): String = "DataSnapshot { key = $key, value = $value }"

    companion object {
        @Suppress("UNCHECKED_CAST")
        fun fromWire(ref: DatabaseReference, wire: Map<String, Any?>?): DataSnapshot {
            if (wire == null) {
                return DataSnapshot(ref, null, null, null)
            }
            val exists = wire["exists"] as? Boolean ?: (wire["value"] != null)
            val value = if (exists) wire["value"] else null
            val priority = wire["priority"]
            val entriesRaw = wire["entries"] as? List<Map<String, Any?>>
            val orderedEntries = entriesRaw?.mapNotNull { entryMap ->
                val key = entryMap["key"] as? String ?: return@mapNotNull null
                ChildEntry(
                    key = key,
                    value = entryMap["value"],
                    priority = entryMap["priority"]
                )
            }
            return DataSnapshot(
                ref = ref,
                value = value,
                priority = priority,
                orderedEntries = orderedEntries
            )
        }
    }
}
