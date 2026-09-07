package dev.pyric.database

class MutableData(
    var value: Any?,
    var priority: Any? = null,
    val key: String? = null
) {
    val childrenCount: Long
        get() = when (val v = value) {
            is Map<*, *> -> v.size.toLong()
            is List<*> -> v.count { it != null }.toLong()
            else -> 0L
        }

    val children: Iterable<MutableData>
        get() = when (val v = value) {
            is Map<*, *> -> v.entries.map { (k, childVal) ->
                MutableData(childVal, null, k.toString())
            }
            is List<*> -> v.mapIndexedNotNull { idx, item ->
                if (item == null) null else MutableData(item, null, idx.toString())
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
        return MutableData(currentVal, null, segments.last())
    }
}
