package com.google.firebase.firestore

import com.google.firebase.Timestamp
import java.util.Date

internal data class CachedDocState(
    val exists: Boolean,
    val data: Map<String, Any?>?,
    val rawWireData: Map<String, Any?>?
)

internal sealed class OfflineDocMutation(val path: String) {
    class SetOverwrite(
        path: String,
        val data: Map<String, Any?>
    ) : OfflineDocMutation(path)

    class SetMerge(
        path: String,
        val data: Map<String, Any?>,
        val mergeFields: List<FieldPath>?
    ) : OfflineDocMutation(path)

    class UpdateMap(
        path: String,
        val data: Map<String, Any?>
    ) : OfflineDocMutation(path)

    class UpdateFields(
        path: String,
        val fields: List<Pair<FieldPath, Any?>>
    ) : OfflineDocMutation(path)

    class Delete(path: String) : OfflineDocMutation(path)
}

internal data class ProjectedDocState(
    val known: Boolean,
    val exists: Boolean,
    val data: Map<String, Any?>?,
    val rawWireData: Map<String, Any?>?,
    val hasPendingWrites: Boolean
)

internal object FirestoreOfflineProjection {

    fun projectDocument(
        path: String,
        base: CachedDocState?,
        stagedMutations: List<OfflineDocMutation>,
        resolveRef: (String) -> DocumentReference
    ): ProjectedDocState {
        val matching = stagedMutations.filter { it.path == path }
        if (matching.isEmpty()) {
            if (base == null) {
                return ProjectedDocState(
                    known = false,
                    exists = false,
                    data = null,
                    rawWireData = null,
                    hasPendingWrites = false
                )
            }
            val copied = if (base.exists && base.data != null) deepCopyMap(base.data, resolveRef) else null
            return ProjectedDocState(
                known = true,
                exists = base.exists,
                data = copied,
                rawWireData = if (base.exists) base.rawWireData else null,
                hasPendingWrites = false
            )
        }

        var exists = base?.exists == true
        var current: MutableMap<String, Any?>? =
            if (exists && base?.data != null) deepCopyMap(base.data, resolveRef) else null

        for (mutation in matching) {
            val next = applySingleMutation(exists, current, mutation, resolveRef)
            exists = next.first
            current = next.second
        }

        return ProjectedDocState(
            known = true,
            exists = exists,
            data = if (exists) current else null,
            rawWireData = null,
            hasPendingWrites = true
        )
    }

    fun applyCommittedMutation(
        base: CachedDocState?,
        mutation: OfflineDocMutation,
        resolveRef: (String) -> DocumentReference
    ): CachedDocState {
        val startExists = base?.exists == true
        val startMap = if (startExists && base?.data != null) deepCopyMap(base.data) else null
        val (exists, updated) = applySingleMutation(startExists, startMap, mutation, resolveRef)
        return CachedDocState(
            exists = exists,
            data = if (exists) updated else null,
            rawWireData = null
        )
    }

    private fun applySingleMutation(
        exists: Boolean,
        current: MutableMap<String, Any?>?,
        mutation: OfflineDocMutation,
        resolveRef: (String) -> DocumentReference
    ): Pair<Boolean, MutableMap<String, Any?>?> {
        return when (mutation) {
            is OfflineDocMutation.SetOverwrite -> {
                val target = LinkedHashMap<String, Any?>()
                applyFullMapOverwrite(target, mutation.data, resolveRef)
                true to target
            }
            is OfflineDocMutation.SetMerge -> {
                val target = if (exists && current != null) deepCopyMap(current) else LinkedHashMap()
                val mask = mutation.mergeFields
                if (mask == null) {
                    mergeMapRecursive(target, mutation.data, resolveRef)
                } else {
                    for (fp in mask) {
                        applyMaskedField(target, mutation.data, fp.segments, resolveRef)
                    }
                }
                true to target
            }
            is OfflineDocMutation.UpdateMap -> {
                if (!exists || current == null) {
                    false to null
                } else {
                    val target = deepCopyMap(current)
                    for ((rawKey, rawVal) in mutation.data) {
                        val segments = rawKey.split(".")
                        applySegmentMutation(target, segments, rawVal, resolveRef)
                    }
                    true to target
                }
            }
            is OfflineDocMutation.UpdateFields -> {
                if (!exists || current == null) {
                    false to null
                } else {
                    val target = deepCopyMap(current)
                    for ((fp, rawVal) in mutation.fields) {
                        applySegmentMutation(target, fp.segments, rawVal, resolveRef)
                    }
                    true to target
                }
            }
            is OfflineDocMutation.Delete -> false to null
        }
    }

    private fun applyFullMapOverwrite(
        target: MutableMap<String, Any?>,
        source: Map<*, *>,
        resolveRef: (String) -> DocumentReference
    ) {
        for ((k, v) in source) {
            val key = k?.toString() ?: continue
            if (v is FieldValue.DeleteSentinel) continue
            target[key] = transformValue(null, v, resolveRef)
        }
    }

    private fun mergeMapRecursive(
        target: MutableMap<String, Any?>,
        patch: Map<*, *>,
        resolveRef: (String) -> DocumentReference
    ) {
        for ((k, v) in patch) {
            val key = k?.toString() ?: continue
            when {
                v is FieldValue.DeleteSentinel -> target.remove(key)
                v is Map<*, *> -> {
                    val existingSub = target[key]
                    if (v.isEmpty()) {
                        target[key] = LinkedHashMap<String, Any?>()
                    } else if (existingSub is Map<*, *>) {
                        val subCopy = deepCopyMap(existingSub)
                        mergeMapRecursive(subCopy, v, resolveRef)
                        target[key] = subCopy
                    } else {
                        val subNew = LinkedHashMap<String, Any?>()
                        mergeMapRecursive(subNew, v, resolveRef)
                        target[key] = subNew
                    }
                }
                else -> target[key] = transformValue(target[key], v, resolveRef)
            }
        }
    }

    private fun applyMaskedField(
        target: MutableMap<String, Any?>,
        source: Map<String, Any?>,
        segments: List<String>,
        resolveRef: (String) -> DocumentReference
    ) {
        if (segments.isEmpty()) return
        var cursor: Any? = source
        var found = true
        for (seg in segments) {
            if (cursor !is Map<*, *> || !cursor.containsKey(seg)) {
                found = false
                break
            }
            cursor = cursor[seg]
        }
        if (found) {
            applySegmentMutation(target, segments, cursor, resolveRef)
        }
    }

    private fun applySegmentMutation(
        root: MutableMap<String, Any?>,
        segments: List<String>,
        rawValue: Any?,
        resolveRef: (String) -> DocumentReference
    ) {
        if (segments.isEmpty()) return
        var current = root
        for (i in 0 until segments.size - 1) {
            val seg = segments[i]
            val existing = current[seg]
            val child = if (existing is Map<*, *>) {
                deepCopyMap(existing)
            } else {
                LinkedHashMap()
            }
            current[seg] = child
            current = child
        }
        val leaf = segments.last()
        if (rawValue is FieldValue.DeleteSentinel) {
            current.remove(leaf)
        } else {
            current[leaf] = transformValue(current[leaf], rawValue, resolveRef)
        }
    }

    private fun transformValue(
        existing: Any?,
        incoming: Any?,
        resolveRef: (String) -> DocumentReference
    ): Any? {
        return when (incoming) {
            null -> null
            is Boolean, is String -> incoming
            is Int -> incoming.toLong()
            is Long, is Double -> incoming
            is Float -> incoming.toDouble()
            is Number -> incoming.toLong()
            is Timestamp, is GeoPoint, is Blob -> incoming
            is Date -> Timestamp(incoming)
            is ByteArray -> Blob.fromBytes(incoming)
            is DocumentReference -> resolveRef(incoming.path)
            is FieldValue.ServerTimestampSentinel -> Timestamp.now()
            is FieldValue.IncrementSentinel -> applyIncrement(existing, incoming.operand)
            is FieldValue.ArrayUnionSentinel -> {
                val baseList = (existing as? List<*>)?.map { normalizeElement(it, resolveRef) }?.toMutableList()
                    ?: mutableListOf()
                for (elem in incoming.elements) {
                    val norm = normalizeElement(elem, resolveRef)
                    if (!baseList.any { valuesEqual(it, norm) }) {
                        baseList.add(norm)
                    }
                }
                baseList
            }
            is FieldValue.ArrayRemoveSentinel -> {
                val baseList = (existing as? List<*>)?.map { normalizeElement(it, resolveRef) }?.toMutableList()
                    ?: mutableListOf()
                val removals = incoming.elements.map { normalizeElement(it, resolveRef) }
                baseList.removeAll { candidate -> removals.any { rem -> valuesEqual(candidate, rem) } }
                baseList
            }
            is List<*> -> incoming.map { normalizeElement(it, resolveRef) }
            is Array<*> -> incoming.map { normalizeElement(it, resolveRef) }
            is Map<*, *> -> {
                val out = LinkedHashMap<String, Any?>()
                applyFullMapOverwrite(out, incoming, resolveRef)
                out
            }
            else -> incoming
        }
    }

    private fun normalizeElement(value: Any?, resolveRef: (String) -> DocumentReference): Any? =
        transformValue(null, value, resolveRef)

    private fun applyIncrement(existing: Any?, operand: Number): Number {
        val opIsFloating = operand is Double || operand is Float
        if (existing is Number) {
            val exIsFloating = existing is Double || existing is Float
            return if (opIsFloating || exIsFloating) {
                existing.toDouble() + operand.toDouble()
            } else {
                existing.toLong() + operand.toLong()
            }
        }
        return if (opIsFloating) operand.toDouble() else operand.toLong()
    }

    fun valuesEqual(a: Any?, b: Any?): Boolean {
        if (a === b) return true
        if (a is Number && b is Number) {
            if (a is Double || a is Float || b is Double || b is Float) {
                return a.toDouble().compareTo(b.toDouble()) == 0
            }
            return a.toLong() == b.toLong()
        }
        if (a is Map<*, *> && b is Map<*, *>) {
            if (a.size != b.size) return false
            for ((k, av) in a) {
                if (!b.containsKey(k) || !valuesEqual(av, b[k])) return false
            }
            return true
        }
        if (a is List<*> && b is List<*>) {
            if (a.size != b.size) return false
            for (i in a.indices) {
                if (!valuesEqual(a[i], b[i])) return false
            }
            return true
        }
        return a == b
    }

    fun deepCopyMap(
        source: Map<*, *>,
        resolveRef: ((String) -> DocumentReference)? = null
    ): MutableMap<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in source) {
            val key = k?.toString() ?: continue
            out[key] = deepCopyValue(v, resolveRef)
        }
        return out
    }

    private fun deepCopyValue(
        value: Any?,
        resolveRef: ((String) -> DocumentReference)? = null
    ): Any? = when (value) {
        is Map<*, *> -> deepCopyMap(value, resolveRef)
        is List<*> -> value.map { deepCopyValue(it, resolveRef) }
        is DocumentReference -> if (resolveRef != null) resolveRef(value.path) else value
        else -> value
    }
}
