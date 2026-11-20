package com.google.firebase.database

class DataSnapshot(
    val ref: DatabaseReference,
    val value: Any?,
    val priority: Any? = null,
    private val orderedEntries: List<ChildEntry>? = null,
    private val exportValue: Any? = null
) {
    data class ChildEntry(
        val key: String,
        val value: Any?,
        val priority: Any? = null,
        val exportValue: Any? = null
    )

    val key: String?
        get() = ref.key

    fun exists(): Boolean = value != null

    fun getValue(useExportFormat: Boolean): Any? =
        if (useExportFormat) (exportValue ?: value) else value

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
                        priority = entry.priority,
                        orderedEntries = null,
                        exportValue = entry.exportValue
                    )
                }
            }
            return when (val v = value) {
                is Map<*, *> -> v.entries
                    .sortedWith { left, right -> compareRtdbKeys(left.key.toString(), right.key.toString()) }
                    .map { (k, childVal) ->
                        val childKey = k.toString()
                        val childExport = exportValueAt(exportValue, listOf(childKey))
                        DataSnapshot(
                            ref = ref.child(childKey),
                            value = childVal,
                            priority = priorityFromExport(childExport),
                            orderedEntries = null,
                            exportValue = childExport
                        )
                    }
                is List<*> -> v.mapIndexedNotNull { index, item ->
                    if (item == null) {
                        null
                    } else {
                        val childKey = index.toString()
                        val childExport = exportValueAt(exportValue, listOf(childKey))
                        DataSnapshot(
                            ref = ref.child(childKey),
                            value = item,
                            priority = priorityFromExport(childExport),
                            orderedEntries = null,
                            exportValue = childExport
                        )
                    }
                }
                else -> emptyList()
            }
        }

    fun hasChildren(): Boolean = childrenCount > 0L

    fun hasChild(path: String): Boolean = child(path).exists()

    fun child(path: String): DataSnapshot {
        val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
        if (segments.isEmpty()) return this

        if (orderedEntries != null) {
            val matched = orderedEntries.find { it.key == segments[0] }
                ?: return DataSnapshot(
                    ref = ref.child(path),
                    value = null,
                    priority = null,
                    orderedEntries = null,
                    exportValue = null
                )
            val firstExport = matched.exportValue ?: exportValueAt(exportValue, listOf(segments[0]))
            if (segments.size == 1) {
                val childPriority = matched.priority ?: priorityFromExport(firstExport)
                return DataSnapshot(
                    ref = ref.child(path),
                    value = matched.value,
                    priority = childPriority,
                    orderedEntries = null,
                    exportValue = firstExport
                )
            }
            var subVal: Any? = matched.value
            for (segment in segments.drop(1)) {
                subVal = when (val v = subVal) {
                    is Map<*, *> -> v[segment]
                    is List<*> -> {
                        val idx = segment.toIntOrNull()
                        if (idx != null && idx in v.indices) v[idx] else null
                    }
                    else -> null
                }
            }
            val subExport = exportValueAt(firstExport, segments.drop(1))
            val subPriority = if (subVal != null) priorityFromExport(subExport) else null
            return DataSnapshot(
                ref = ref.child(path),
                value = subVal,
                priority = subPriority,
                orderedEntries = null,
                exportValue = subExport
            )
        }

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

        val childExport = exportValueAt(exportValue, segments)
        val childPriority = if (currentVal != null) priorityFromExport(childExport) else null

        return DataSnapshot(
            ref = ref.child(path),
            value = currentVal,
            priority = childPriority,
            orderedEntries = null,
            exportValue = childExport
        )
    }

    override fun toString(): String = "DataSnapshot { key = $key, value = $value }"

    companion object {
        private val RTDB_INT_KEY_REGEX = Regex("^-?0*\\d{1,10}$")

        private fun tryParseRtdbIntKey(key: String): Int? {
            if (!RTDB_INT_KEY_REGEX.matches(key)) return null
            val parsed = key.toLongOrNull() ?: return null
            if (parsed < Int.MIN_VALUE.toLong() || parsed > Int.MAX_VALUE.toLong()) return null
            return parsed.toInt()
        }

        internal fun compareRtdbKeys(a: String, b: String): Int {
            if (a == b) return 0
            val aInt = tryParseRtdbIntKey(a)
            val bInt = tryParseRtdbIntKey(b)
            if (aInt != null) {
                if (bInt != null) {
                    val diff = aInt.compareTo(bInt)
                    return if (diff == 0) a.length.compareTo(b.length) else diff
                }
                return -1
            }
            if (bInt != null) return 1
            return a.compareTo(b)
        }

        private fun priorityFromExport(exported: Any?): Any? {
            val map = exported as? Map<*, *> ?: return null
            return map[".priority"]
        }

        private fun exportValueAt(root: Any?, segments: List<String>): Any? {
            var current: Any? = root
            for (segment in segments) {
                if (segment == ".priority" || segment == ".value") return null
                val map = current as? Map<*, *>
                val container: Any? = if (
                    map != null &&
                    map.containsKey(".value") &&
                    map.keys.all { it == ".value" || it == ".priority" }
                ) {
                    map[".value"]
                } else {
                    current
                }
                current = when (container) {
                    is Map<*, *> -> container[segment]
                    is List<*> -> {
                        val idx = segment.toIntOrNull()
                        if (idx != null && idx in container.indices) container[idx] else null
                    }
                    else -> null
                }
            }
            return current
        }

        @Suppress("UNCHECKED_CAST")
        fun fromWire(ref: DatabaseReference, wire: Map<String, Any?>?): DataSnapshot {
            if (wire == null) {
                return DataSnapshot(ref, null, null, null, null)
            }
            val exists = wire["exists"] as? Boolean ?: (wire["value"] != null)
            val value = if (exists) wire["value"] else null
            val priority = wire["priority"]
            val exportValue = wire["exportValue"]
            val entriesRaw = wire["entries"] as? List<Map<String, Any?>>
            val orderedEntries = entriesRaw?.mapNotNull { entryMap ->
                val key = entryMap["key"] as? String ?: return@mapNotNull null
                ChildEntry(
                    key = key,
                    value = entryMap["value"],
                    priority = entryMap["priority"],
                    exportValue = entryMap["exportValue"]
                )
            }
            return DataSnapshot(
                ref = ref,
                value = value,
                priority = priority,
                orderedEntries = orderedEntries,
                exportValue = exportValue
            )
        }
    }
}
