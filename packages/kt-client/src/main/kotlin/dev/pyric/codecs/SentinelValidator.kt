package dev.pyric.codecs

import com.google.firebase.firestore.FieldValue

/**
 * Validates document mutation payloads and sentinel arguments against Firestore constraints.
 */
object SentinelValidator {

    /**
     * Validates that [FieldValue.delete] does not appear anywhere inside [data] when [isMerge] is false.
     *
     * @throws IllegalArgumentException if [isMerge] is false and a delete sentinel is detected.
     */
    fun validateNoDelete(data: Any?, isMerge: Boolean) {
        if (!isMerge && containsDeleteSentinel(data)) {
            throw IllegalArgumentException(
                "FieldValue.delete() can only appear in update() or set() with merge"
            )
        }
    }

    /**
     * Recursively traverses [value] to detect any occurrence of [FieldValue.DeleteSentinel].
     * Inspects Maps (both keys and values), Iterables (Lists, Sets), Arrays, and nested transform sentinels.
     */
    fun containsDeleteSentinel(value: Any?): Boolean {
        return when (value) {
            is FieldValue.DeleteSentinel -> true
            is Map<*, *> -> value.entries.any { containsDeleteSentinel(it.key) || containsDeleteSentinel(it.value) }
            is Iterable<*> -> value.any { containsDeleteSentinel(it) }
            is Array<*> -> value.any { containsDeleteSentinel(it) }
            is FieldValue.ArrayUnionSentinel -> value.elements.any { containsDeleteSentinel(it) }
            is FieldValue.ArrayRemoveSentinel -> value.elements.any { containsDeleteSentinel(it) }
            else -> false
        }
    }

    /**
     * Recursively validates that no [FieldValue] sentinels (delete, serverTimestamp,
     * increment, arrayUnion, arrayRemove) appear inside [elements] passed to an array transform.
     *
     * @param elements The elements passed to the array transform as an Array
     * @param operationName Name of the array transform method ("arrayUnion", "arrayRemove", or "arrayUnion/arrayRemove")
     * @throws IllegalArgumentException if any sentinel is found inside elements
     */
    fun validateNoArraySentinels(elements: Array<out Any?>, operationName: String = "arrayUnion/arrayRemove") {
        for (element in elements) {
            validateNoArraySentinels(element, operationName)
        }
    }

    /**
     * Recursively validates that no [FieldValue] sentinels appear inside [elements] passed as an Iterable.
     */
    fun validateNoArraySentinels(elements: Iterable<Any?>, operationName: String = "arrayUnion/arrayRemove") {
        for (element in elements) {
            validateNoArraySentinels(element, operationName)
        }
    }

    /**
     * Recursively validates that [value] is not and does not contain any [FieldValue] sentinel.
     */
    fun validateNoArraySentinels(value: Any?, operationName: String = "arrayUnion/arrayRemove") {
        if (containsAnySentinel(value)) {
            throw IllegalArgumentException("FieldValue sentinels cannot be nested inside $operationName")
        }
    }

    /**
     * Recursively traverses [value] to detect any occurrence of any [FieldValue] sentinel.
     * Returns true if [value] is a [FieldValue] or contains one inside any nested Map,
     * Iterable, or Array.
     */
    fun containsAnySentinel(value: Any?): Boolean {
        return when (value) {
            is FieldValue -> true
            is Map<*, *> -> value.entries.any { containsAnySentinel(it.key) || containsAnySentinel(it.value) }
            is Iterable<*> -> value.any { containsAnySentinel(it) }
            is Array<*> -> value.any { containsAnySentinel(it) }
            else -> false
        }
    }
}
