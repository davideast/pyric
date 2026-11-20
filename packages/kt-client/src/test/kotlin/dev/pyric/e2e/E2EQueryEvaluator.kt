package dev.pyric.e2e

import dev.pyric.codecs.PyricDocumentReferenceHolder
import dev.pyric.codecs.ValueCodec

/**
 * Genuine in-memory query evaluation engine for E2E test harness.
 * Evaluates filter constraints, composite filters, ordering, cursors, and limits.
 */
object E2EQueryEvaluator {

    data class DocEntry(val id: String, val path: String, val data: Map<String, Any?>)

    fun evaluate(docs: List<DocEntry>, target: Map<String, Any?>): List<DocEntry> {
        @Suppress("UNCHECKED_CAST")
        val constraints = (target["constraints"] as? List<Map<String, Any?>>) ?: emptyList()

        // 1. Filter
        var filtered = docs.filter { doc -> matchesConstraints(doc, constraints) }

        // 2. Order
        val orderBys = constraints.filter { it["kind"] == "orderBy" }
        if (orderBys.isNotEmpty()) {
            filtered = filtered.sortedWith { a, b -> compareDocs(a, b, orderBys) }
        }

        // 3. Cursors
        val cursors = constraints.filter {
            val k = it["kind"] as? String
            k == "startAt" || k == "startAfter" || k == "endBefore" || k == "endAt"
        }
        for (cursor in cursors) {
            filtered = applyCursor(filtered, cursor, orderBys)
        }

        // 4. Limit / LimitToLast
        val limitConstraint = constraints.find { it["kind"] == "limit" }
        val limitToLastConstraint = constraints.find { it["kind"] == "limitToLast" }

        if (limitConstraint != null) {
            val n = (limitConstraint["n"] as Number).toInt()
            filtered = filtered.take(n)
        } else if (limitToLastConstraint != null) {
            val n = (limitToLastConstraint["n"] as Number).toInt()
            filtered = filtered.takeLast(n)
        }

        return filtered
    }

    private fun matchesConstraints(doc: DocEntry, constraints: List<Map<String, Any?>>): Boolean {
        for (c in constraints) {
            val kind = c["kind"] as? String
            if (kind == "where") {
                if (!matchesUnary(doc, c)) return false
            } else if (kind == "and" || kind == "or" || kind == "whereComposite") {
                if (!matchesComposite(doc, c)) return false
            }
        }
        return true
    }

    private fun matchesComposite(doc: DocEntry, composite: Map<String, Any?>): Boolean {
        val kind = composite["kind"] as? String
        val op = if (kind == "and" || kind == "or") kind else composite["op"] as? String ?: "and"
        @Suppress("UNCHECKED_CAST")
        val filters = (composite["filters"] as? List<Map<String, Any?>>) ?: emptyList()

        return when (op) {
            "and" -> filters.all { matchesFilterMap(doc, it) }
            "or" -> filters.any { matchesFilterMap(doc, it) }
            else -> true
        }
    }

    private fun matchesFilterMap(doc: DocEntry, filter: Map<String, Any?>): Boolean {
        return when (filter["kind"] as? String) {
            "where" -> matchesUnary(doc, filter)
            "and", "or", "whereComposite" -> matchesComposite(doc, filter)
            else -> true
        }
    }

    private fun matchesUnary(doc: DocEntry, filter: Map<String, Any?>): Boolean {
        val field = filter["field"] as String
        @Suppress("UNCHECKED_CAST")
        val fieldSegments = filter["fieldSegments"] as? List<String>
        val op = filter["op"] as String
        val rawWireValue = filter["value"]
        val allowEscapedMaps = filter["valueEncoding"] == ValueCodec.DOC_VALUE_ENCODING_V1
        val expected = ValueCodec.decodeValue(rawWireValue, null, allowEscapedMaps)
        val actual = extractField(doc, field, fieldSegments)

        return when (op) {
            "==" -> valuesEqual(actual, expected)
            "!=" -> !valuesEqual(actual, expected)
            "<" -> compareValues(actual, expected) < 0
            "<=" -> compareValues(actual, expected) <= 0
            ">" -> compareValues(actual, expected) > 0
            ">=" -> compareValues(actual, expected) >= 0
            "in" -> {
                val list = toList(expected)
                list.any { valuesEqual(actual, it) }
            }
            "not-in" -> {
                val list = toList(expected)
                list.none { valuesEqual(actual, it) }
            }
            "array-contains" -> {
                val list = toList(actual)
                list.any { valuesEqual(it, expected) }
            }
            "array-contains-any" -> {
                val actList = toList(actual)
                val expList = toList(expected)
                expList.any { exp -> actList.any { act -> valuesEqual(act, exp) } }
            }
            else -> true
        }
    }

    private fun extractField(doc: DocEntry, field: String, fieldSegments: List<String>? = null): Any? {
        if (field == "__name__") return doc.path
        val segments = fieldSegments ?: field.split('.')
        var current: Any? = doc.data
        for (seg in segments) {
            if (current !is Map<*, *>) return null
            current = current[seg]
        }
        return current
    }

    private fun toList(v: Any?): List<Any?> {
        return when (v) {
            is List<*> -> v
            is Array<*> -> v.toList()
            else -> emptyList()
        }
    }

    private fun valuesEqual(a: Any?, b: Any?): Boolean {
        if (a == null && b == null) return true
        if (a == null || b == null) return false
        if (a is Number && b is Number) {
            return a.toDouble() == b.toDouble()
        }
        return a == b
    }

    @Suppress("UNCHECKED_CAST")
    private fun compareValues(a: Any?, b: Any?): Int {
        if (a == null && b == null) return 0
        if (a == null) return -1
        if (b == null) return 1

        if (a is Number && b is Number) {
            return a.toDouble().compareTo(b.toDouble())
        }
        if (a is Comparable<*> && b is Comparable<*>) {
            return try {
                (a as Comparable<Any>).compareTo(b)
            } catch (_: Exception) {
                a.toString().compareTo(b.toString())
            }
        }
        return a.toString().compareTo(b.toString())
    }

    private fun compareDocs(a: DocEntry, b: DocEntry, orderBys: List<Map<String, Any?>>): Int {
        for (ob in orderBys) {
            val field = ob["field"] as String
            @Suppress("UNCHECKED_CAST")
            val fieldSegments = ob["fieldSegments"] as? List<String>
            val dir = ob["direction"] as? String ?: "asc"
            val valA = extractField(a, field, fieldSegments)
            val valB = extractField(b, field, fieldSegments)
            var cmp = compareValues(valA, valB)
            if (dir == "desc") cmp = -cmp
            if (cmp != 0) return cmp
        }
        return a.id.compareTo(b.id)
    }

    private fun applyCursor(
        docs: List<DocEntry>,
        cursor: Map<String, Any?>,
        orderBys: List<Map<String, Any?>>
    ): List<DocEntry> {
        val kind = cursor["kind"] as String
        val fromSnapshot = cursor["fromSnapshot"] == true
        @Suppress("UNCHECKED_CAST")
        val rawValues = cursor["values"] as? List<Any?> ?: emptyList()
        val cursorValues = rawValues.map {
            when (val decoded = ValueCodec.decodeValue(it)) {
                is PyricDocumentReferenceHolder -> decoded.path
                else -> decoded
            }
        }
        val effectiveOrders = if (fromSnapshot && orderBys.none { it["field"] == "__name__" }) {
            val lastDir = orderBys.lastOrNull()?.get("direction") as? String ?: "asc"
            orderBys + mapOf("kind" to "orderBy", "field" to "__name__", "direction" to lastDir)
        } else {
            orderBys
        }

        return docs.filter { doc ->
            val cmp = compareDocToCursor(doc, cursorValues, effectiveOrders)
            when (kind) {
                "startAt" -> cmp >= 0
                "startAfter" -> cmp > 0
                "endBefore" -> cmp < 0
                "endAt" -> cmp <= 0
                else -> true
            }
        }
    }

    private fun compareDocToCursor(
        doc: DocEntry,
        cursorValues: List<Any?>,
        orderBys: List<Map<String, Any?>>
    ): Int {
        for (i in cursorValues.indices) {
            if (i >= orderBys.size) break
            val ob = orderBys[i]
            val field = ob["field"] as String
            @Suppress("UNCHECKED_CAST")
            val fieldSegments = ob["fieldSegments"] as? List<String>
            val dir = ob["direction"] as? String ?: "asc"
            val docVal = extractField(doc, field, fieldSegments)
            val cursorVal = if (field == "__name__" && cursorValIsRelativeId(cursorValues[i], doc.path)) {
                doc.path.substringBeforeLast('/') + "/" + cursorValues[i]
            } else {
                cursorValues[i]
            }
            var cmp = compareValues(docVal, cursorVal)
            if (dir == "desc") cmp = -cmp
            if (cmp != 0) return cmp
        }
        return 0
    }

    private fun cursorValIsRelativeId(v: Any?, docPath: String): Boolean =
        v is String && !v.contains('/') && docPath.contains('/')
}
